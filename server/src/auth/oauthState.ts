import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { StateStore } from "passport-oauth2";
import { env } from "../env.js";

/**
 * OAuth `state` + PKCE without server-side sessions (audit SEC-3).
 *
 * When a sign-in starts, we make a random `state` and a PKCE code verifier
 * and put both in a short-lived, HMAC-signed, httpOnly cookie in *this*
 * browser. The provider sends the user back with `state` in the URL; we only
 * accept the callback if it matches the cookie, and the token exchange only
 * works with the verifier from the cookie. So:
 *   - a sign-in link or callback crafted by someone else can't log your
 *     browser into their account (login CSRF): your browser has no matching cookie;
 *   - a stolen authorization code is useless without the verifier (PKCE).
 *
 * The cookie is single-use (cleared on the callback) and expires in 10 minutes.
 * Implements passport-oauth2's state-store interface (store/verify).
 */
const COOKIE = "vo_oauth";
const TTL_MS = 10 * 60 * 1000;

interface Pending {
  /** Which provider this sign-in is for; a callback for another one is refused. */
  p: string;
  s: string;
  v: string;
  exp: number;
}

const sign = (payload: string) => createHmac("sha256", env.jwtSecret).update(`oauth:${payload}`).digest("base64url");

function encode(pending: Pending): string {
  const payload = Buffer.from(JSON.stringify(pending)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decode(cookie: unknown): Pending | null {
  if (typeof cookie !== "string") return null;
  const [payload, mac] = cookie.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString()) as Pending;
    return typeof p.s === "string" && typeof p.v === "string" && typeof p.p === "string" && p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type StoreCallback = (err: Error | null, state?: string) => void;
type VerifyCallback = (err: Error | null, ok: string | false, info?: { message: string }) => void;

export function cookieStateStore(provider: string): StateStore {
  const store = {
    // passport-oauth2 picks the PKCE call shape from the arity (5 arguments).
    store(req: Request, verifier: string, _state: unknown, _meta: unknown, callback: StoreCallback): void {
      const state = randomBytes(24).toString("base64url");
      (req.res as Response).cookie(COOKIE, encode({ p: provider, s: state, v: verifier, exp: Date.now() + TTL_MS }), {
        httpOnly: true,
        // "lax" is sent on the provider's top-level redirect back to us, and
        // not on cross-site subrequests.
        sameSite: "lax",
        secure: env.isProd,
        maxAge: TTL_MS,
        path: "/auth",
      });
      callback(null, state);
    },

    verify(req: Request, providedState: unknown, callback: VerifyCallback): void {
      const pending = decode(req.cookies?.[COOKIE]);
      // Single use, whatever the outcome.
      (req.res as Response).clearCookie(COOKIE, { path: "/auth" });
      if (!pending || pending.p !== provider || typeof providedState !== "string" || !sameString(pending.s, providedState)) {
        return callback(null, false, { message: "sign-in state didn't match (expired, or not started in this browser)" });
      }
      // For PKCE, passport-oauth2 expects the code verifier as the "ok" value.
      callback(null, pending.v);
    },
  };
  // @types/passport-oauth2 predates the PKCE store shape (store with 5
  // arguments, verify answering with the verifier) that the library itself
  // implements and calls (passport-oauth2/lib/strategy.js), hence the cast.
  return store as unknown as StateStore;
}
