import pino from "pino";
import { env } from "./env.js";

/** Minimal but real logging. The events we deliberately record are the three
 *  things you want first when someone says "movement feels laggy" or "calls
 *  don't connect": socket lifecycle, proximity transitions, and ICE failures. */
export const log = pino({
  level: env.logLevel,
  base: undefined,
  ...(env.isProd ? {} : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }),
});

export const wsLog = log.child({ mod: "ws" });
export const proximityLog = log.child({ mod: "proximity" });
export const rtcLog = log.child({ mod: "webrtc" });
export const authLog = log.child({ mod: "auth" });
