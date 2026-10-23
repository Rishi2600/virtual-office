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
  // Fails fast if production is misconfigured (dev auth left on, default secret).
  assertSafeConfig();

  const repo = createRepository();
  await repo.init();

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.use(createAuthRouter(repo));

  app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

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
  });

  gameServer.define("office", OfficeRoom);

  await gameServer.listen(env.port);
  log.info(
    {
      port: env.port,
      env: env.nodeEnv,
      microsoftAuth: microsoftConfigured(),
      githubAuth: githubConfigured(),
      devAuth: env.devAuth && !env.isProd,
      iceServers: env.iceServers.flatMap((s) => s.urls),
    },
    "virtual office server listening",
  );

  const close = async () => {
    await gameServer.gracefullyShutdown(false);
    await repo.close();
  };

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try { await close(); } finally { process.exit(0); }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return { close, port: env.port };
}
