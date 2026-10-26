/**
 * Session rules (auth/sessions.ts), against an in-memory store, so the
 * time-based ones can be checked without waiting 30 days:
 *   - a visit renews an older session to a full 30 days (and its cookie);
 *   - a recent session isn't rewritten on every request;
 *   - expired sessions, blocked people and unknown keys get nothing;
 *   - the database holds a hash, never the cookie's key.
 *
 * Run: npm test.
 */
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL = "error";
process.env.SESSION_TTL_SEC = String(30 * 24 * 3600); // the default, whatever .env says

import type { Request, Response } from "express";
import type { SessionRecord, UserRecord } from "../db/index.js";

const { authenticate, sessionIdFor, setSessionStore, startSession } = await import("../auth/sessions.js");
const { env } = await import("../env.js");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

const DAY = 24 * 3600 * 1000;
const user: UserRecord = {
  id: "u1", provider: "github", providerId: "1", email: "a@example.com", name: "A", picture: "", avatar: "",
  createdAt: "", lastSeenAt: "", blocked: false,
};
const sessions = new Map<string, SessionRecord>();
let writes = 0;
setSessionStore({
  getUser: async (id) => (id === user.id ? user : null),
  createSession: async (s) => void sessions.set(s.id, { ...s }),
  getSession: async (id) => sessions.get(id) ?? null,
  extendSession: async (id, expiresAt) => {
    writes++;
    sessions.get(id)!.expiresAt = expiresAt;
  },
  deleteSession: async (id) => void sessions.delete(id),
  deleteUserSessions: async () => 0,
  liveSessions: async () => new Set(),
  setBlocked: async () => {},
  findUserByEmail: async () => null,
});

/** A fake request/response pair; `cookies` records what the response set. */
function exchange(key?: string) {
  const cookies: Array<{ name: string; maxAge?: number }> = [];
  const req = { headers: {}, cookies: key ? { vo_session: key } : {} } as unknown as Request;
  const res = { cookie: (name: string, _v: string, o: { maxAge?: number }) => cookies.push({ name, maxAge: o.maxAge }) } as unknown as Response;
  return { req, res, cookies };
}

console.log("\nsessions\n");
const start = exchange();
const key = await startSession(start.res, user);
const id = sessionIdFor(key);
check("signing in sets a 30-day cookie", start.cookies[0]?.maxAge === env.sessionTtlSec * 1000, JSON.stringify(start.cookies));
check("the store holds a hash of the key, never the key", sessions.has(id) && !sessions.has(key) && id !== key);

const fresh = exchange(key);
check("a recent session is accepted", (await authenticate(fresh.req, fresh.res))?.user.id === "u1");
check("…without rewriting it on every request", writes === 0 && fresh.cookies.length === 0);

sessions.get(id)!.expiresAt = Date.now() + 3 * DAY; // last seen ~27 days ago
const visit = exchange(key);
await authenticate(visit.req, visit.res);
const renewedTo = sessions.get(id)!.expiresAt - Date.now();
check("a visit renews an older session to a full 30 days", renewedTo > 29.9 * DAY && writes === 1, `${(renewedTo / DAY).toFixed(2)} days`);
check("…and refreshes the cookie", visit.cookies[0]?.name === "vo_session");

sessions.get(id)!.expiresAt = Date.now() - 1000;
const late = exchange(key);
check("an expired session is refused", (await authenticate(late.req, late.res)) === null);

sessions.get(id)!.expiresAt = Date.now() + DAY;
user.blocked = true;
const blocked = exchange(key);
check("a removed person's session is refused", (await authenticate(blocked.req, blocked.res)) === null);
user.blocked = false;

const unknown = exchange("made-up-key");
check("an unknown key is refused", (await authenticate(unknown.req, unknown.res)) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
