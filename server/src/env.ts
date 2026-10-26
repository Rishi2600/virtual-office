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

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

export const env = {
  nodeEnv: str(process.env.NODE_ENV, "production"),
  isDev,
  /** Everything that isn't development is production (see isDev above). */
  isProd: !isDev,

  port: int("PORT", 2567),

  /** The dev-only default is accepted in development and refused everywhere else. */
  jwtSecret: str(process.env.JWT_SECRET, DEV_JWT_SECRET),
  /** Sign-in sessions last this long, renewed by each visit (owner: 30 days while in use). */
  sessionTtlSec: int("SESSION_TTL_SEC", 30 * 24 * 3600),
  /** Realtime tokens are short-lived on purpose: they are handed to the WS
   *  handshake and are useless if they leak from a log a minute later. */
  realtimeTtlSec: int("REALTIME_TTL_SEC", 120),

  /** GitHub is the only sign-in provider (owner decision, 2026-10-26). */
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  githubCallbackUrl: str(process.env.GITHUB_CALLBACK_URL, "http://localhost:5173/auth/github/callback"),

  /** Optional: only people with a VERIFIED GitHub email in this domain may
   *  sign in, e.g. "acme.com". Unset = anyone with a GitHub account (the
   *  owner's choice while developing; a warning is logged in production). */
  allowedEmailDomain: process.env.ALLOWED_EMAIL_DOMAIN ?? "",

  /** Dev sign-in: on by default in development, impossible anywhere else. */
  devAuth: isDev && bool(process.env.DEV_AUTH, true),
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** The JSON store's file when there's no DATABASE_URL (default .data/dev.json);
   *  tests point it at a throwaway file. */
  dataFile: process.env.DATA_FILE ?? "",
  logLevel: str(process.env.LOG_LEVEL, "info"),

  /**
   * ICE: how browsers find a network path to each other (see docs). STUN is
   * public and harmless. TURN credentials are never static: when TURN_URLS is
   * set, each signed-in user gets short-lived ones signed with TURN_SECRET, the
   * secret coturn also holds (auth/turn.ts). No client rebuild to change these.
   */
  stunUrls: list(process.env.STUN_URLS).length ? list(process.env.STUN_URLS) : DEFAULT_STUN_URLS,
  turnUrls: list(process.env.TURN_URLS),
  turnSecret: process.env.TURN_SECRET ?? "",
  /** How long a TURN credential works. Clients refresh at half of this. */
  turnTtlSec: int("TURN_TTL_SEC", 24 * 3600),
};

export function assertSafeConfig(): void {
  const found = [...problems];

  // TURN: both halves or neither, and no leftovers from the old static scheme.
  if (env.turnUrls.length && !env.turnSecret) {
    found.push("TURN_URLS is set but TURN_SECRET isn't (the secret coturn uses to check credentials)");
  }
  if (env.turnSecret && !env.turnUrls.length) {
    found.push("TURN_SECRET is set but TURN_URLS isn't");
  }
  // The coturn image's entrypoint passes every argument through the shell's
  // `eval`, so a secret containing $, quotes or backticks would be mangled (or
  // run). Hex from `openssl rand -hex 32` is always safe.
  if (env.turnSecret && !/^[A-Za-z0-9._-]+$/.test(env.turnSecret)) {
    found.push("TURN_SECRET may only contain letters, digits, '.', '_' and '-' (use: openssl rand -hex 32)");
  }
  if (process.env.TURN_USERNAME || process.env.TURN_CREDENTIAL) {
    found.push("TURN_USERNAME/TURN_CREDENTIAL are no longer used: set TURN_SECRET instead (see .env.example)");
  }

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
    // GitHub is the only way in, so a production deploy without it would have
    // no way for anyone to sign in at all.
    if (!githubConfigured()) {
      found.push("configure GitHub sign-in: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET");
    }
    if (env.turnSecret && env.turnSecret.length < MIN_JWT_SECRET_LENGTH) {
      found.push(
        `TURN_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (generate one with: openssl rand -hex 32)`,
      );
    }
  }

  if (found.length) {
    const mode = env.isDev ? "development" : `production (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`;
    throw new Error(`Refusing to start in ${mode}:\n  - ${found.join("\n  - ")}`);
  }
}

export const githubConfigured = () => Boolean(env.githubClientId && env.githubClientSecret);
