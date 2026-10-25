import { createHmac } from "node:crypto";
import { env } from "../env.js";

/** One entry of RTCConfiguration.iceServers, as the browser expects it. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * Short-lived TURN credentials in coturn's "TURN REST API" format
 * (coturn: --use-auth-secret --static-auth-secret=TURN_SECRET):
 *
 *   username   = "<expiry, unix seconds>:<user id>"
 *   credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
 *
 * coturn recomputes the HMAC with the same secret and checks the expiry, so
 * nothing is stored on either side and there is no account to manage. A
 * credential that leaks stops working on its own once it expires.
 */
export function turnCredentials(userId: string, nowMs = Date.now()): { username: string; credential: string } {
  const expiresAt = Math.floor(nowMs / 1000) + env.turnTtlSec;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac("sha1", env.turnSecret).update(username).digest("base64");
  return { username, credential };
}

/** Everything a signed-in user's browser needs to find a path to a peer. */
export function iceServersFor(userId: string): { iceServers: IceServer[]; ttlSec: number } {
  const iceServers: IceServer[] = [{ urls: env.stunUrls }];
  if (env.turnUrls.length && env.turnSecret) {
    iceServers.push({ urls: env.turnUrls, ...turnCredentials(userId) });
  }
  return { iceServers, ttlSec: env.turnTtlSec };
}
