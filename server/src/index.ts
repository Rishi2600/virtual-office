import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { assertSafeConfig, env, githubConfigured, microsoftConfigured } from "./env.js";
import { log } from "./log.js";
import { createRepository } from "./db/index.js";
import { createAuthRouter } from "./auth/routes.js";
import { OfficeRoom } from "./rooms/OfficeRoom.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface RunningServer { close: () => Promise<void>; port: number; }

export async function startServer(): Promise<RunningServer> {
  // Fails fast on a bad or unsafe config (see env.ts: anything but
  // NODE_ENV=development is production, with every guard on).
  assertSafeConfig();

  const repo = createRepository();
  await repo.init();

  const app = express();
  app.use(express.json({ limit: "64kb" }));
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
    transport: new WebSocketTransport({
      server: httpServer,
      // Colyseus defaults maxPayload to 4KB, which is fine for movement input
      // but far too small for WebRTC signaling: a single SDP offer is routinely
      // 5-15KB once codecs and ICE parameters are listed. Exceeding it makes
      // `ws` close the socket with 1009 the instant anyone tries to start a
      // call, which looks like a reconnect loop rather than a signaling bug.
      maxPayload: 256 * 1024,
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

  gameServer.define("office", OfficeRoom);

  await gameServer.listen(env.port);
  log.info(
    {
      port: env.port,
      env: env.nodeEnv,
      microsoftAuth: microsoftConfigured(),
      githubAuth: githubConfigured(),
      devAuth: env.devAuth,
      stun: env.stunUrls,
      turn: env.turnUrls.length ? env.turnUrls : "off",
    },
    "virtual office server listening",
  );

  // Idempotent: a second signal (or a test calling close()) joins the same shutdown.
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      shuttingDown = true;
      // Disconnects every client (consented, so no 30s reconnect hold) and
      // disposes the rooms, then stops the HTTP/WS listener.
      await gameServer.gracefullyShutdown(false);
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
