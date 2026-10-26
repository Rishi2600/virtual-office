import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../env.js";
import type { Repository, UserRecord } from "../db/index.js";

/**
 * Server-side sessions (audit SEC-5; owner decision: 30 days while in use,
 * plus revocation).
 *
 * The cookie holds a random 32-byte key. The database holds only its SHA-256
 * (the session id), so whoever reads the database can't sign in as anyone.
 * Because every request looks the session up, signing out or removing
 * someone takes effect immediately, unlike the old self-contained JWT that
 * stayed valid for 7 days after "sign out".
 *
 * Sliding expiry: each visit pushes the expiry back to now + SESSION_TTL_SEC
 * (30 days), at most once an hour so a busy session isn't a write per request.
 */
export const SESSION_COOKIE = "vo_session";
const RENEW_EVERY_MS = 60 * 60 * 1000;

type SessionStore = Pick<
  Repository,
  "getUser" | "createSession" | "getSession" | "extendSession" | "deleteSession" | "deleteUserSessions" | "liveSessions" | "setBlocked" | "findUserByEmail"
>;

let store: SessionStore | null = null;

/** Called once at startup (and by tests and the admin command) with the repository. */
export function setSessionStore(s: SessionStore | null): void {
  store = s;
}

function repo(): SessionStore {
  if (!store) throw new Error("session store not initialised (setSessionStore)");
  return store;
}

/** The id a cookie key is stored under. */
export const sessionIdFor = (key: string) => createHash("sha256").update(key).digest("base64url");

const ttlMs = () => env.sessionTtlSec * 1000;

function setCookie(res: Response, key: string): void {
  res.cookie(SESSION_COOKIE, key, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    maxAge: ttlMs(),
    path: "/",
  });
}

/** Starts a session for a user who just signed in; returns the cookie key. */
export async function startSession(res: Response, user: UserRecord): Promise<string> {
  const key = randomBytes(32).toString("base64url");
  await repo().createSession({ id: sessionIdFor(key), userId: user.id, expiresAt: Date.now() + ttlMs() });
  setCookie(res, key);
  return key;
}

/**
 * The signed-in user behind a request, or null. Reads the session cookie, or
 * an Authorization bearer key (dev only: lets two tabs in one browser be two
 * people, see client/src/net/api.ts). Renews the session (and its cookie) as
 * it goes.
 */
export async function authenticate(req: Request, res: Response): Promise<{ user: UserRecord; sessionId: string } | null> {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const key = bearer ?? (req.cookies?.[SESSION_COOKIE] as string | undefined);
  if (!key || key.length > 200) return null;

  const id = sessionIdFor(key);
  const session = await repo().getSession(id);
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = await repo().getUser(session.userId);
  if (!user || user.blocked) return null;

  if (session.expiresAt - Date.now() < ttlMs() - RENEW_EVERY_MS) {
    await repo().extendSession(id, Date.now() + ttlMs());
    if (!bearer) setCookie(res, key);
  }
  return { user, sessionId: id };
}

/** "Sign out": ends this browser's session for good, not just its cookie. */
export async function endSession(req: Request, res: Response): Promise<void> {
  const header = req.headers.authorization;
  const key = header?.startsWith("Bearer ") ? header.slice(7) : (req.cookies?.[SESSION_COOKIE] as string | undefined);
  if (key) await repo().deleteSession(sessionIdFor(key));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Of these session ids, the ones still valid (used by the room to kick revoked people). */
export const liveSessions = (ids: string[]) => repo().liveSessions(ids);

/**
 * Removes someone from the office: blocked from signing in again, every
 * session ended at once, and (via the room's periodic check) disconnected
 * within seconds. `unblock` lets them back in.
 */
export async function blockUser(email: string): Promise<{ user: UserRecord; sessions: number } | null> {
  const user = await repo().findUserByEmail(email);
  if (!user) return null;
  await repo().setBlocked(user.id, true);
  return { user, sessions: await repo().deleteUserSessions(user.id) };
}

export async function unblockUser(email: string): Promise<UserRecord | null> {
  const user = await repo().findUserByEmail(email);
  if (!user) return null;
  await repo().setBlocked(user.id, false);
  return user;
}

/** Signs someone out everywhere without blocking them. */
export async function signOutEverywhere(email: string): Promise<{ user: UserRecord; sessions: number } | null> {
  const user = await repo().findUserByEmail(email);
  if (!user) return null;
  return { user, sessions: await repo().deleteUserSessions(user.id) };
}
