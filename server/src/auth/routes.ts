import { Router, type Request, type Response } from "express";
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import { env, githubConfigured } from "../env.js";
import { authLog } from "../log.js";
import { IdentityConflictError, type Repository, type UserRecord } from "../db/index.js";
import { signRealtimeToken } from "./jwt.js";
import { authenticate, endSession, startSession } from "./sessions.js";
import { iceServersFor } from "./turn.js";
import { cookieStateStore } from "./oauthState.js";
import { parseLook } from "@vo/shared";

/**
 * Express 4 doesn't catch errors from async handlers, and an unhandled
 * rejection stops the server (index.ts). This turns them into a 500 instead,
 * e.g. when the database is briefly unreachable.
 */
const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response): void => {
    fn(req, res).catch((err: Error) => {
      authLog.error({ err: err.message, path: req.path }, "request failed");
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
  };

type ProviderName = "github";

type DoneFn = (err: Error | null, user?: UserRecord | false, info?: { message: string }) => void;

/** The profile fields we read; passport-github2 hands us a superset of this.
 *  With `allRawEmails`, every address comes with GitHub's own flags. */
interface OAuthProfile {
  id: string | number;
  displayName?: string;
  username?: string;
  emails?: Array<{ value: string; primary?: boolean; verified?: boolean }>;
  photos?: Array<{ value: string }>;
}

/** The address to use: the primary one if verified, else any verified one.
 *  Unverified addresses are never trusted: anyone can add one to a GitHub
 *  account, including a colleague's (audit SEC-4). */
function verifiedEmail(profile: OAuthProfile): string | undefined {
  const verified = (profile.emails ?? []).filter((e) => e.verified === true);
  return (verified.find((e) => e.primary) ?? verified[0])?.value;
}

/**
 * Identity resolution for a GitHub sign-in: require a verified email, enforce
 * the optional domain allow-list, then find or create the account.
 *
 * The account is anchored on the GitHub account id, not on the email, so
 * changing your email on GitHub keeps your account, and an email can't be
 * used to slip into someone else's account (see Repository.upsertUser).
 */
async function upsertFromProvider(
  repo: Repository,
  provider: ProviderName,
  input: { id: string; email?: string; name?: string; picture?: string },
  done: DoneFn,
): Promise<void> {
  try {
    const email = input.email?.toLowerCase();
    if (!email) {
      authLog.warn({ provider }, "sign-in rejected: no verified email on the account");
      return done(null, false, { message: `${provider} account has no verified email` });
    }

    // Optional organisation restriction, on the verified address only.
    if (env.allowedEmailDomain && !email.endsWith("@" + env.allowedEmailDomain)) {
      authLog.warn({ provider, providerId: input.id }, "sign-in rejected: email domain not allowed");
      return done(null, false, { message: "domain not allowed" });
    }

    const user = await repo.upsertUser({
      provider,
      providerId: input.id,
      email,
      name: input.name || email.split("@")[0]!,
      picture: input.picture ?? "",
    });
    if (user.blocked) {
      authLog.warn({ provider, userId: user.id }, "sign-in rejected: removed from the office");
      return done(null, false, { message: "removed" });
    }
    authLog.info({ provider, userId: user.id }, "oauth sign-in");
    return done(null, user);
  } catch (err) {
    if (err instanceof IdentityConflictError) {
      authLog.warn({ provider, providerId: input.id }, `sign-in rejected: ${err.message}`);
      return done(null, false, { message: err.message });
    }
    return done(err as Error);
  }
}

export interface AuthRouterOptions {
  /** Tests only: point the GitHub strategy at a fake provider. */
  githubEndpoints?: { authorizationURL: string; tokenURL: string; userProfileURL: string; userEmailURL: string };
}

export function createAuthRouter(repo: Repository, options: AuthRouterOptions = {}): Router {
  const router = Router();

  /** Registers /auth/<name> and /auth/<name>/callback for a passport strategy. */
  function mountProvider(name: ProviderName, scope: string[]): void {
    router.get(`/auth/${name}`, passport.authenticate(name, { scope, session: false }));
    router.get(
      `/auth/${name}/callback`,
      passport.authenticate(name, { session: false, failureRedirect: "/?error=auth" }),
      handle(async (req, res) => {
        await startSession(res, req.user as UserRecord);
        res.redirect("/");
      }),
    );
  }

  /** Explains itself instead of 404ing when credentials aren't set. */
  function mountUnconfigured(name: ProviderName, vars: string): void {
    router.get(`/auth/${name}`, (_req, res) => {
      res.status(503).json({
        error: `${name}_not_configured`,
        message: `Set ${vars} in .env (see README).`,
      });
    });
  }

  // ---------------------------------------------------------------- GitHub
  if (githubConfigured()) {
    passport.use(
      new GitHubStrategy(
        {
          clientID: env.githubClientId,
          clientSecret: env.githubClientSecret,
          callbackURL: env.githubCallbackUrl,
          // Without this scope GitHub returns no email at all for accounts that
          // keep it private, and sign-in would fail for them.
          scope: ["user:email"],
          // Every address with its `verified` flag, not just the primary one.
          allRawEmails: true,
          // state + PKCE (S256) in a signed cookie (oauthState.ts): no login CSRF.
          // A custom store turns state handling on by itself.
          pkce: true,
          store: cookieStateStore("github"),
          // Only for the OAuth test (smoke/oauth.ts), which runs a fake GitHub.
          ...options.githubEndpoints,
        },
        (_accessToken: string, _refreshToken: string, profile: OAuthProfile, done: DoneFn) => {
          void upsertFromProvider(
            repo,
            "github",
            {
              id: String(profile.id),
              email: verifiedEmail(profile),
              name: profile.displayName || profile.username,
              picture: profile.photos?.[0]?.value,
            },
            done,
          );
        },
      ),
    );
    mountProvider("github", ["user:email"]);
  } else {
    mountUnconfigured("github", "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET");
  }

  // ------------------------------------------------------------- Dev bypass
  // Lets you open two tabs as two different users without two real accounts.
  // Only exists with NODE_ENV=development (env.devAuth); outside development it
  // cannot be enabled, and asking for it makes the server refuse to start.
  if (env.devAuth) {
    router.post("/auth/dev", handle(async (req: Request, res: Response) => {
      const raw = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const name = raw.slice(0, 32);
      if (!name) return res.status(400).json({ error: "name_required" });

      const user = await repo.upsertUser({
        email: name.toLowerCase().replace(/[^a-z0-9]+/g, ".") + "@dev.local",
        name,
      });
      if (user.blocked) return res.status(403).json({ error: "removed" });
      const token = await startSession(res, user);
      authLog.info({ userId: user.id }, "dev sign-in");
      // `token` is returned so a tab can hold its own identity in sessionStorage
      // and not be overwritten by another tab's cookie. Dev-only route.
      res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        token,
      });
    }));
  }

  // ----------------------------------------------------------------- Session
  /** Ends this browser's session on the server, not just its cookie. */
  router.post(
    "/auth/logout",
    handle(async (req, res) => {
      await endSession(req, res);
      res.json({ ok: true });
    }),
  );

  router.get("/api/me", handle(async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return res.status(401).json({ error: "unauthenticated" });
    const { user } = auth;
    res.json({ id: user.id, name: user.name, email: user.email, picture: user.picture, avatar: user.avatar });
  }));

  /** Saves the look built in the avatar builder. The room is told separately
   *  (C2S.SetAvatar) so it updates live; this makes it stick. */
  router.put("/api/me/avatar", handle(async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return res.status(401).json({ error: "unauthenticated" });
    const look: unknown = req.body?.look;
    if (!parseLook(look)) return res.status(400).json({ error: "invalid_look" });
    await repo.setAvatar(auth.user.id, look as string);
    res.json({ avatar: look });
  }));

  /** Mints the short-lived token the client passes to the Colyseus handshake. */
  router.get("/api/rt-token", handle(async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return res.status(401).json({ error: "unauthenticated" });
    res.json({ token: signRealtimeToken(auth.user, auth.sessionId), expiresIn: env.realtimeTtlSec });
  }));

  /** ICE servers for the signed-in user, with fresh short-lived TURN
   *  credentials when a TURN server is configured. Behind sign-in so nobody can
   *  use the relay anonymously (it would otherwise be a free open relay). */
  router.get("/api/ice", handle(async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return res.status(401).json({ error: "unauthenticated" });
    res.set("Cache-Control", "no-store").json(iceServersFor(auth.user.id));
  }));

  /** Public client bootstrap (what the sign-in screen needs). No ICE servers
   *  here: those come from /api/ice after sign-in. */
  router.get("/api/config", handle(async (_req, res) => {
    res.json({
      githubEnabled: githubConfigured(),
      devAuthEnabled: env.devAuth,
      spaces: await repo.listSpaces(),
    });
  }));

  return router;
}
