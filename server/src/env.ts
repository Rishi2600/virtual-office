import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(repoRoot, ".env"), quiet: true });

/**
 * Fail closed: the server is in development mode ONLY when NODE_ENV is exactly
 * "development" (`npm run dev` and the tests set it, see src/dev.ts). Anything
 * else, including NODE_ENV unset, is treated as production: dev sign-in is
 * off, a real JWT secret is required, and every startup guard applies.
 */
const isDev = process.env.NODE_ENV === "development";

/** Problems found while reading env. assertSafeConfig() refuses to start if any. */
const problems: string[] = [];

const str = (v: string | undefined, d: string) => (v && v.length ? v : d);
/** Empty counts as unset, like every other setting here. */
const bool = (v: string | undefined, d = false) =>
  v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());
const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** A positive whole number, or the default when unset. Garbage is a startup
 *  error rather than a silent fallback to the default. */
function int(name: string, d: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${name} must be a positive whole number (got "${v}")`);
    return d;
  }
  return n;
}

const DEV_JWT_SECRET = "dev-only-insecure-secret-change-me";
const MIN_JWT_SECRET_LENGTH = 32;

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * ICE configuration is assembled from env, never hardcoded, so a TURN server can
 * be added later (coturn or hosted) by setting TURN_URLS/TURN_USERNAME/
 * TURN_CREDENTIAL — no code change, no redeploy of the client bundle.
 */
function buildIceServers(): IceServer[] {
  const servers: IceServer[] = [];
  const stun = list(process.env.STUN_URLS);
  servers.push({
    urls: stun.length
      ? stun
      : ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  });
  const turn = list(process.env.TURN_URLS);
  if (turn.length) {
    servers.push({
      urls: turn,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

export const env = {
  nodeEnv: str(process.env.NODE_ENV, "production"),
  isDev,
  /** Everything that isn't development is production (see isDev above). */
  isProd: !isDev,

  port: int("PORT", 2567),

  /** The dev-only default is accepted in development and refused everywhere else. */
  jwtSecret: str(process.env.JWT_SECRET, DEV_JWT_SECRET),
  sessionTtlSec: int("SESSION_TTL_SEC", 7 * 24 * 3600),
  /** Realtime tokens are short-lived on purpose: they are handed to the WS
   *  handshake and are useless if they leak from a log a minute later. */
  realtimeTtlSec: int("REALTIME_TTL_SEC", 120),

  /** Microsoft Entra ID (formerly Azure AD) — covers Outlook / Microsoft 365
   *  work and school accounts. */
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID ?? "",
  microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
  microsoftCallbackUrl: str(
    process.env.MICROSOFT_CALLBACK_URL,
    "http://localhost:5173/auth/microsoft/callback",
  ),
  /**
   * Your Entra directory (tenant) ID. This is the real access control: Microsoft
   * will not issue a token for anyone outside the tenant, which is far stronger
   * than matching an email suffix after the fact.
   *
   * "common"        - any Microsoft account, personal included (testing only)
   * "organizations" - any work/school account, any tenant
   * "<tenant-guid>" - only your organisation   <- use this in production
   */
  microsoftTenant: str(process.env.MICROSOFT_TENANT_ID, "common"),

  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  githubCallbackUrl: str(process.env.GITHUB_CALLBACK_URL, "http://localhost:5173/auth/github/callback"),

  /** Restrict sign-in to your organisation's email domain, e.g. "acme.com".
   *  Applies to EVERY provider — see the README note about GitHub accounts
   *  whose primary email is a personal one. */
  allowedEmailDomain: process.env.ALLOWED_EMAIL_DOMAIN ?? "",

  /** Dev sign-in: on by default in development, impossible anywhere else. */
  devAuth: isDev && bool(process.env.DEV_AUTH, true),
  databaseUrl: process.env.DATABASE_URL ?? "",
  logLevel: str(process.env.LOG_LEVEL, "info"),

  iceServers: buildIceServers(),
};

export function assertSafeConfig(): void {
  const found = [...problems];

  if (env.isProd) {
    // Asking for dev sign-in outside development is a misconfiguration worth
    // stopping for, not something to silently ignore.
    if (bool(process.env.DEV_AUTH)) {
      found.push("DEV_AUTH=true is only allowed with NODE_ENV=development");
    }
    if (env.jwtSecret === DEV_JWT_SECRET) {
      found.push("JWT_SECRET must be set (generate one with: openssl rand -base64 48)");
    } else if (env.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
      found.push(
        `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (generate one with: openssl rand -base64 48)`,
      );
    }
    // At least one real identity provider must be configured, otherwise a
    // production deploy would have no way for anyone to sign in at all.
    if (!microsoftConfigured() && !githubConfigured()) {
      found.push(
        "configure at least one sign-in provider: MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET or GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET",
      );
    }
    if (microsoftConfigured() && env.microsoftTenant === "common") {
      found.push(
        'MICROSOFT_TENANT_ID must be your tenant GUID in production; "common" lets any Microsoft account sign in',
      );
    }
  }

  if (found.length) {
    const mode = env.isDev ? "development" : `production (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`;
    throw new Error(`Refusing to start in ${mode}:\n  - ${found.join("\n  - ")}`);
  }
}

export const microsoftConfigured = () =>
  Boolean(env.microsoftClientId && env.microsoftClientSecret);
export const githubConfigured = () => Boolean(env.githubClientId && env.githubClientSecret);
