import pino from "pino";
import { env } from "./env.js";

/**
 * Minimal but real logging. The events we deliberately record are the three
 * things you want first when someone says "movement feels laggy" or "calls
 * don't connect": socket lifecycle, proximity transitions, and ICE failures.
 *
 * Privacy (owner decision, audit PRIV-1): people appear in logs only as their
 * opaque internal id (`userId`) or a connection id (`sessionId`), never by
 * name, email or IP address. Look an id up in the database when you need to
 * know who it was. `redact` is a safety net: if a personal field ever slips
 * into a log line, it's written as "[redacted]".
 */
export const log = pino({
  level: env.logLevel,
  base: undefined,
  redact: {
    paths: [
      "email", "name", "displayName", "ip", "picture", "token", "cookie", "authorization",
      "*.email", "*.name", "*.displayName", "*.ip", "*.picture", "*.token", "*.cookie", "*.authorization",
    ],
    censor: "[redacted]",
  },
  ...(env.isProd ? {} : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }),
});

export const wsLog = log.child({ mod: "ws" });
export const proximityLog = log.child({ mod: "proximity" });
export const rtcLog = log.child({ mod: "webrtc" });
export const authLog = log.child({ mod: "auth" });
