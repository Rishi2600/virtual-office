import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { assertSafeConfig, env, githubConfigured } from "./env.js";
import { log } from "./log.js";
import { createRepository } from "./db/index.js";
import { createAuthRouter } from "./auth/routes.js";
import { OfficeRoom } from "./rooms/OfficeRoom.js";
import { drainSpotSaves, setSpotStore } from "./rooms/spots.js";
import { setSessionStore } from "./auth/sessions.js";
import { matchmakerCorsHeaders, securityHeaders, verifyWebSocketOrigin } from "./security.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface RunningServer { close: () => Promise<void>; port: number; }

export async function startServer(): Promise<RunningServer> {
  // Fails fast on a bad or unsafe config (see env.ts: anything but
  // NODE_ENV=development is production, with every guard on).
  assertSafeConfig();

  const repo = createRepository();
  await repo.init();
  setSpotStore(repo);
  setSessionStore(repo);

  const app = express();
  // Behind a reverse proxy, read the client address from X-Forwarded-For.
  if (env.trustProxy > 0) app.set("trust proxy", env.trustProxy);
  app.use(...securityHeaders());
  // inflate: false: no client of ours sends compressed bodies, and refusing
  // them removes a whole class of decompression attacks (audit SEC-13).
  app.use(express.json({ limit: "64kb", inflate: false }));
  app.use(cookieParser());
  app.use(createAuthRouter(repo));

  /** Set when shutdown starts, so /ready turns away new traffic while we drain. */
  let shuttingDown = false;

  /** Liveness: the process is up and its event loop answers. */
  app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  /** Readiness: able to serve right now. 503 while shutting down or if the
   *  database is unreachable. Details go to the log, not to the caller. */
  app.get("/ready", async (_req, res) => {
    let database: "ok" | "error" = "ok";
    try {
      await repo.ping?.();
    } catch (err) {
      database = "error";
      log.error({ err: (err as Error).message }, "readiness: database check failed");
    }
    const ready = database === "ok" && !shuttingDown;
    res.status(ready ? 200 : 503).json({ ready, database, shuttingDown });
  });

  // In production the API and the built client are the same origin, so the
  // session cookie just works. In dev, Vite proxies /api and /auth here instead.
  if (env.isProd) {
    const clientDist = path.join(repoRoot, "client", "dist");
    app.use(express.static(clientDist));
    app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
  }

  const httpServer = http.createServer(app);
  const gameServer = new Server({
    // No ASCII banner in the logs on every start (audit OBS-2).
    greet: false,
    transport: new WebSocketTransport({
      server: httpServer,
      // Colyseus defaults maxPayload to 4KB, far too small for WebRTC
      // signaling: an SDP offer is 5-20KB once codecs and ICE parameters are
      // listed (and `ws` closes the socket with 1009 when it's exceeded, which
      // looks like a reconnect loop). 64KB fits any real SDP (validate.ts caps
      // it at 48KB) while keeping each message small (audit SEC-7).
      maxPayload: 64 * 1024,
      // Only our own pages may open the office's WebSocket (audit SEC-11).
      verifyClient: verifyWebSocketOrigin,
    }),
    // TODO(scale): single process today. To shard rooms across processes, pass
    // `presence: new RedisPresence(...)` and `driver: new RedisDriver(...)` here
    // (@colyseus/redis-presence, @colyseus/redis-driver). Nothing in OfficeRoom
    // reaches outside its own instance, so no room code changes.

    // We own the process signals (see shutdown below). With Colyseus's own
    // handler also installed, whichever ran first exited the process in the
    // middle of the other's shutdown: clients were never told, rooms never
    // disposed, and the last log lines were lost.
    gracefullyShutdown: false,
  });

  // The matchmaker used to answer CORS for any origin, with credentials.
  // Ours only (audit SEC-11): drop the "*" default and decide per request.
  delete (matchMaker.controller.DEFAULT_CORS_HEADERS as Record<string, string>)["Access-Control-Allow-Origin"];
  matchMaker.controller.getCorsHeaders = matchmakerCorsHeaders;

  gameServer.define("office", OfficeRoom);

  await gameServer.listen(env.port);
  log.info(
    {
      port: env.port,
      env: env.nodeEnv,
      githubAuth: githubConfigured(),
      devAuth: env.devAuth,
      stun: env.stunUrls,
      turn: env.turnUrls.length ? env.turnUrls : "off",
    },
    "virtual office server listening",
  );
  if (!env.isDev && !env.allowedEmailDomain) {
    // Owner decision (2026-10-26): open while the product is being developed.
    // Said loudly so it's never forgotten once real people use it.
    log.warn(
      "sign-in is open to ANYONE with a GitHub account; set ALLOWED_EMAIL_DOMAIN to restrict it to your organisation",
    );
  }

  // Idempotent: a second signal (or a test calling close()) joins the same shutdown.
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      shuttingDown = true;
      // Disconnects every client (consented, so no 30s reconnect hold) and
      // disposes the rooms, then stops the HTTP/WS listener.
      await gameServer.gracefullyShutdown(false);
      // Everyone's spot was queued for saving as they left; finish before the
      // database closes, so a restart puts them back where they were.
      await drainSpotSaves();
      setSpotStore(null);
      setSessionStore(null);
      await repo.close();
    })());

  const shutdown = (signal: string) => {
    log.info({ signal }, "shutting down");
    // Never outlive the orchestrator's grace period (Docker: 10s, then SIGKILL).
    setTimeout(() => {
      log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "shutdown timed out, exiting anyway");
      exitAfterFlush(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    close().then(
      () => {
        log.info("shutdown complete");
        exitAfterFlush(0);
      },
      (err: unknown) => {
        log.error({ err: (err as Error)?.message ?? err }, "shutdown failed");
        exitAfterFlush(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // Colyseus used to log these for us; with its handler off, we do. A crash
  // exits right away (the orchestrator restarts us) rather than limping on.
  process.on("uncaughtException", (err) => {
    log.fatal({ err: err.stack ?? err.message }, "uncaught exception");
    exitAfterFlush(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.fatal({ err: (reason as Error)?.stack ?? String(reason) }, "unhandled promise rejection");
    exitAfterFlush(1);
  });

  return { close, port: env.port };
}

/** Under Docker's default 10s stop grace period. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

/** Exits once buffered log lines are written, so the reason for exiting isn't lost. */
function exitAfterFlush(code: number): void {
  log.flush(() => process.exit(code));
}
