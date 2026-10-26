import jwt from "jsonwebtoken";
import { env } from "../env.js";
import type { UserRecord } from "../db/index.js";

/** Only realtime tokens are JWTs now; sign-in sessions are server-side
 *  (auth/sessions.ts). The kind is still checked, so an old session JWT from
 *  before that change can't be used as a realtime token. */
export type TokenKind = "realtime";

export interface Claims {
  sub: string;
  email: string;
  name: string;
  picture: string;
  /** The saved avatar look ("" if none), minted fresh for every join so it's never stale. */
  avatar?: string;
  /** The sign-in session this token was minted from; the room checks it's
   *  still alive, so signing out or removal disconnects within seconds. */
  sid: string;
  typ: TokenKind;
}

/**
 * Short-lived token handed to the Colyseus WebSocket handshake. It travels in a
 * join payload (through client-side JS), so it's scoped tightly: it expires in
 * minutes and is tied to the sign-in session it was minted from.
 */
export function signRealtimeToken(user: UserRecord, sessionId: string): string {
  const claims: Claims = {
    sub: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    avatar: user.avatar,
    sid: sessionId,
    typ: "realtime",
  };
  return jwt.sign(claims, env.jwtSecret, { expiresIn: env.realtimeTtlSec, algorithm: "HS256" });
}

/** Returns null on any failure: bad signature, expiry, or wrong token kind. */
export function verifyToken(token: string | undefined | null, expected: TokenKind): Claims | null {
  if (!token) return null;
  try {
    const claims = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as Claims;
    if (claims.typ !== expected || typeof claims.sid !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}
