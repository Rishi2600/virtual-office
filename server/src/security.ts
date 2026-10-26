import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import helmet from "helmet";
import { env } from "./env.js";

/**
 * Browser-facing security (audit SEC-10, SEC-11).
 *
 * Headers: a strict Content-Security-Policy (only our own scripts, styles,
 * fonts and connections; no framing; no plugins), plus helmet's other
 * defaults (nosniff, no referrer, same-origin opener/resources), HSTS in
 * production, and a Permissions-Policy that keeps camera, microphone and
 * screen capture to our own pages.
 *
 * Origins: only pages served from PUBLIC_URL may use the office's WebSocket
 * and matchmaker, so another site open in someone's browser can't connect to
 * the office as them (cross-site WebSocket hijacking). Development accepts
 * any origin so the office can be tested from a tablet on the local network.
 */
export function securityHeaders(): RequestHandler[] {
  const csp = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'"],
        mediaSrc: ["'self'", "blob:"],
        // 'self' covers ws:/wss: to the same host in current browsers.
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
      },
    },
    xFrameOptions: { action: "deny" },
    // Over plain http (local Docker testing) HSTS would be ignored anyway;
    // behind the production TLS proxy it pins https for a year.
    strictTransportSecurity: env.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  const permissions: RequestHandler = (_req, res, next) => {
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
    );
    next();
  };
  return [csp, permissions];
}

/**
 * Whether a request's Origin may use the office. Requests without an Origin
 * header (non-browser clients such as the test suites) are allowed: the
 * header only protects browsers, which always send it on WebSocket and
 * cross-origin requests, and anything else can set it to whatever it likes.
 */
export function originAllowed(origin: string | string[] | undefined): boolean {
  if (env.isDev || origin === undefined) return true;
  return origin === env.publicOrigin;
}

/** For the WebSocket server: refuse the upgrade from any other site. */
export const verifyWebSocketOrigin = (info: { origin: string; req: IncomingMessage }): boolean =>
  originAllowed(info.req.headers.origin);

/** For Colyseus's matchmaker: answer CORS only for our own origin (it used
 *  to echo back any origin, including https://evil.example). */
export function matchmakerCorsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin === "string" && originAllowed(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { Vary: "Origin" };
}
