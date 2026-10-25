import jwt from "jsonwebtoken";
import { env } from "../env.js";
import type { UserRecord } from "../db/index.js";

export type TokenKind = "session" | "realtime";

export interface Claims {
  sub: string;
  email: string;
  name: string;
  picture: string;
  /** The saved avatar look ("" if none); only in realtime tokens, which are
   *  minted fresh for every join so it's never stale. */
  avatar?: string;
  typ: TokenKind;
}

function sign(user: UserRecord, typ: TokenKind, ttlSec: number): string {
  const claims: Claims = {
    sub: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    ...(typ === "realtime" ? { avatar: user.avatar } : {}),
    typ,
  };
  return jwt.sign(claims, env.jwtSecret, { expiresIn: ttlSec, algorithm: "HS256" });
}

/** Long-lived, stored in an httpOnly cookie. Never leaves the browser's cookie jar. */
export const signSessionToken = (user: UserRecord) => sign(user, "session", env.sessionTtlSec);

/**
 * Short-lived token handed to the Colyseus WebSocket handshake. Separate from
 * the session cookie because it travels in a join payload (and therefore through
 * client-side JS), so it is scoped tightly and expires in minutes.
 */
export const signRealtimeToken = (user: UserRecord) => sign(user, "realtime", env.realtimeTtlSec);

/** Returns null on any failure: bad signature, expiry, or wrong token kind. */
export function verifyToken(token: string | undefined | null, expected: TokenKind): Claims | null {
  if (!token) return null;
  try {
    const claims = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] }) as Claims;
    if (claims.typ !== expected) return null;
    return claims;
  } catch {
    return null;
  }
}
