import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(repoRoot, ".env"), quiet: true });

const str = (v: string | undefined, d: string) => (v && v.length ? v : d);
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? +v : d);
const bool = (v: string | undefined, d = false) =>
  v === undefined ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());
const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const DEV_JWT_SECRET = "dev-only-insecure-secret-change-me";

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
  nodeEnv: str(process.env.NODE_ENV, "development"),
  get isProd() { return this.nodeEnv === "production"; },

  port: num(process.env.PORT, 2567),
  publicUrl: str(process.env.PUBLIC_URL, "http://localhost:2567"),
  clientOrigin: str(process.env.CLIENT_ORIGIN, "http://localhost:5173"),

  jwtSecret: str(process.env.JWT_SECRET, DEV_JWT_SECRET),
  sessionTtlSec: num(process.env.SESSION_TTL_SEC, 7 * 24 * 3600),
  /** Realtime tokens are short-lived on purpose: they are handed to the WS
   *  handshake and are useless if they leak from a log a minute later. */
  realtimeTtlSec: num(process.env.REALTIME_TTL_SEC, 120),

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

  devAuth: bool(process.env.DEV_AUTH, true),
  databaseUrl: process.env.DATABASE_URL ?? "",
  logLevel: str(process.env.LOG_LEVEL, "info"),

  iceServers: buildIceServers(),
};

export function assertSafeConfig(): void {
  if (!env.isProd) return;
  const problems: string[] = [];
  if (env.devAuth) problems.push("DEV_AUTH must be disabled in production");
  if (env.jwtSecret === DEV_JWT_SECRET) problems.push("JWT_SECRET must be set in production");
  // At least one real identity provider must be configured, otherwise a
  // production deploy would have no way for anyone to sign in at all.
  if (!microsoftConfigured() && !githubConfigured()) {
    problems.push(
      "configure at least one sign-in provider: MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET or GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET",
    );
  }
  if (microsoftConfigured() && env.microsoftTenant === "common") {
    problems.push(
      'MICROSOFT_TENANT_ID must be your tenant GUID in production; "common" lets any Microsoft account sign in',
    );
  }
  if (problems.length) {
    throw new Error(`Refusing to start in production:\n  - ${problems.join("\n  - ")}`);
  }
}

export const microsoftConfigured = () =>
  Boolean(env.microsoftClientId && env.microsoftClientSecret);
export const githubConfigured = () => Boolean(env.githubClientId && env.githubClientSecret);
