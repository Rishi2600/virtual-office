import { Router, type Request, type Response } from "express";
import passport from "passport";
import { Strategy as MicrosoftStrategy } from "passport-microsoft";
import { Strategy as GitHubStrategy } from "passport-github2";
import { env, githubConfigured, microsoftConfigured } from "../env.js";
import { authLog } from "../log.js";
import type { Repository, UserRecord } from "../db/index.js";
import { signRealtimeToken, signSessionToken, verifyToken } from "./jwt.js";
import { iceServersFor } from "./turn.js";
import { parseLook } from "@vo/shared";

const COOKIE = "vo_session";

function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    maxAge: env.sessionTtlSec * 1000,
    path: "/",
  });
}

/**
 * Resolves the caller from the session cookie, or from an Authorization bearer
 * token. The bearer path exists so two tabs in ONE browser can be two different
 * people during local testing: a cookie is shared across tabs of the same
 * origin, a sessionStorage token is not. Both carry the same signed JWT, so
 * neither is weaker than the other.
 */
export function currentUser(req: Request) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  return verifyToken(bearer, "session") ?? verifyToken(req.cookies?.[COOKIE], "session");
}

type ProviderName = "microsoft" | "github";

type DoneFn = (err: Error | null, user?: UserRecord | false, info?: { message: string }) => void;

/** The profile fields we read. Both strategies hand us a superset of this. */
interface OAuthProfile {
  id: string | number;
  displayName?: string;
  username?: string;
  /** Microsoft only: the sign-in name, usually the work address. */
  userPrincipalName?: string;
  emails?: Array<{ value: string }>;
  photos?: Array<{ value: string }>;
}

/**
 * Shared identity resolution for every OAuth provider: require an email,
 * enforce the domain allow-list, then upsert.
 *
 * Email is the identity anchor, so the same person signing in with Microsoft and
 * with GitHub on the same address resolves to one account rather than two.
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
      authLog.warn({ provider }, "sign-in rejected: account exposed no email address");
      return done(null, false, { message: `${provider} account has no usable email` });
    }

    // Organisation restriction: only let your own domain in.
    if (env.allowedEmailDomain && !email.endsWith("@" + env.allowedEmailDomain)) {
      authLog.warn({ provider, email }, "sign-in rejected: email domain not allowed");
      return done(null, false, { message: "domain not allowed" });
    }

    const user = await repo.upsertUser({
      provider,
      providerId: input.id,
      email,
      name: input.name || email.split("@")[0]!,
      picture: input.picture ?? "",
    });
    authLog.info({ provider, userId: user.id, email: user.email }, "oauth sign-in");
    return done(null, user);
  } catch (err) {
    return done(err as Error);
  }
}

export function createAuthRouter(repo: Repository): Router {
  const router = Router();

  /** Registers /auth/<name> and /auth/<name>/callback for a passport strategy. */
  function mountProvider(name: ProviderName, scope: string[]): void {
    router.get(`/auth/${name}`, passport.authenticate(name, { scope, session: false }));
    router.get(
      `/auth/${name}/callback`,
      passport.authenticate(name, { session: false, failureRedirect: "/?error=auth" }),
      (req: Request, res: Response) => {
        setSessionCookie(res, signSessionToken(req.user as UserRecord));
        res.redirect("/");
      },
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

  // ------------------------------------------------- Microsoft (Entra ID)
  // Covers Outlook / Microsoft 365 work and school accounts.
  if (microsoftConfigured()) {
    // Hoisted rather than inlined: `addUPNAsEmail` is supported by
    // passport-microsoft at runtime but missing from @types/passport-microsoft,
    // and TypeScript's excess-property check only fires on fresh object
    // literals passed directly to a call.
    const microsoftOptions = {
      clientID: env.microsoftClientId,
      clientSecret: env.microsoftClientSecret,
      callbackURL: env.microsoftCallbackUrl,
      // Restricting to your tenant here is the real access control:
      // Microsoft won't issue a token for anyone outside it.
      tenant: env.microsoftTenant,
      scope: ["user.read"],
      // Many Entra accounts leave Graph's `mail` field empty while their
      // userPrincipalName IS the work address. Without this, sign-in fails
      // for those users with a confusing "no email" error.
      addUPNAsEmail: true,
    };

    passport.use(
      new MicrosoftStrategy(
        microsoftOptions,
        (_accessToken: string, _refreshToken: string, profile: OAuthProfile, done: DoneFn) => {
          void upsertFromProvider(
            repo,
            "microsoft",
            {
              id: String(profile.id),
              email: profile.emails?.[0]?.value ?? profile.userPrincipalName,
              name: profile.displayName,
              picture: undefined, // Graph serves photos as binary, not a URL
            },
            done,
          );
        },
      ),
    );
    mountProvider("microsoft", ["user.read"]);
  } else {
    mountUnconfigured("microsoft", "MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET");
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
        },
        (_accessToken: string, _refreshToken: string, profile: OAuthProfile, done: DoneFn) => {
          void upsertFromProvider(
            repo,
            "github",
            {
              id: String(profile.id),
              // passport-github2 fills `emails` from /user/emails when the
              // user:email scope is granted; it prefers the primary address.
              email: profile.emails?.[0]?.value,
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
    router.post("/auth/dev", async (req: Request, res: Response) => {
      const raw = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const name = raw.slice(0, 32);
      if (!name) return res.status(400).json({ error: "name_required" });

      const user = await repo.upsertUser({
        email: name.toLowerCase().replace(/[^a-z0-9]+/g, ".") + "@dev.local",
        name,
      });
      const token = signSessionToken(user);
      setSessionCookie(res, token);
      authLog.info({ userId: user.id, name }, "dev sign-in");
      // `token` is returned so a tab can hold its own identity in sessionStorage
      // and not be overwritten by another tab's cookie. Dev-only route.
      res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        token,
      });
    });
  }

  // ----------------------------------------------------------------- Session
  router.post("/auth/logout", (_req, res) => {
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  router.get("/api/me", async (req, res) => {
    const claims = currentUser(req);
    if (!claims) return res.status(401).json({ error: "unauthenticated" });
    const user = await repo.getUser(claims.sub);
    if (!user) return res.status(401).json({ error: "unknown_user" });
    res.json({ id: user.id, name: user.name, email: user.email, picture: user.picture, avatar: user.avatar });
  });

  /** Saves the look built in the avatar builder. The room is told separately
   *  (C2S.SetAvatar) so it updates live; this makes it stick. */
  router.put("/api/me/avatar", async (req, res) => {
    const claims = currentUser(req);
    if (!claims) return res.status(401).json({ error: "unauthenticated" });
    const look: unknown = req.body?.look;
    if (!parseLook(look)) return res.status(400).json({ error: "invalid_look" });
    try {
      const user = await repo.getUser(claims.sub);
      if (!user) return res.status(401).json({ error: "unknown_user" });
      await repo.setAvatar(user.id, look as string);
      res.json({ avatar: look });
    } catch (err) {
      authLog.error({ err: (err as Error).message }, "saving avatar failed");
      res.status(500).json({ error: "save_failed" });
    }
  });

  /** Mints the short-lived token the client passes to the Colyseus handshake. */
  router.get("/api/rt-token", async (req, res) => {
    const claims = currentUser(req);
    if (!claims) return res.status(401).json({ error: "unauthenticated" });
    const user = await repo.getUser(claims.sub);
    if (!user) return res.status(401).json({ error: "unknown_user" });
    res.json({ token: signRealtimeToken(user), expiresIn: env.realtimeTtlSec });
  });

  /** ICE servers for the signed-in user, with fresh short-lived TURN
   *  credentials when a TURN server is configured. Behind sign-in so nobody can
   *  use the relay anonymously (it would otherwise be a free open relay). */
  router.get("/api/ice", async (req, res) => {
    const claims = currentUser(req);
    if (!claims) return res.status(401).json({ error: "unauthenticated" });
    const user = await repo.getUser(claims.sub);
    if (!user) return res.status(401).json({ error: "unknown_user" });
    res.set("Cache-Control", "no-store").json(iceServersFor(user.id));
  });

  /** Public client bootstrap (what the sign-in screen needs). No ICE servers
   *  here: those come from /api/ice after sign-in. */
  router.get("/api/config", async (_req, res) => {
    res.json({
      microsoftEnabled: microsoftConfigured(),
      githubEnabled: githubConfigured(),
      devAuthEnabled: env.devAuth,
      spaces: await repo.listSpaces(),
    });
  });

  return router;
}
