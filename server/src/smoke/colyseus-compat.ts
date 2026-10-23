/**
 * PHASE 0 SMOKE TEST — Colyseus client/server wire compatibility.
 *
 * Why this exists: the published `colyseus` meta-package (0.18.x) expects
 * @colyseus/schema ^5, while the newest browser client (colyseus.js 0.16.x)
 * still expects schema ^3. Mixing them yields a v5 encoder talking to a v3
 * decoder — state silently fails to sync. This test proves the pinned pairing
 * (@colyseus/core 0.16.x + colyseus.js 0.16.x, both on schema ^3) actually
 * encodes and decodes across the wire before any game logic depends on it.
 *
 * Run: npm run smoke
 */
import { Server, Room, type Client as ServerClient } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Schema, type, MapSchema } from "@colyseus/schema";
import { Client as BrowserClient } from "colyseus.js";

const PORT = 2599;

class SmokePlayer extends Schema {
  @type("number") x = 0;
  @type("string") name = "";
}

class SmokeState extends Schema {
  @type({ map: SmokePlayer }) players = new MapSchema<SmokePlayer>();
}

class SmokeRoom extends Room<SmokeState> {
  onCreate() {
    this.state = new SmokeState();
    this.onMessage("move", (client, msg: { x: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.x = msg.x;
    });
  }
  onJoin(client: ServerClient) {
    const p = new SmokePlayer();
    p.name = "smoke";
    p.x = 1;
    this.state.players.set(client.sessionId, p);
  }
}

function waitFor(label: string, predicate: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for: ${label}`));
      }
    }, 25);
  });
}

async function main() {
  const gameServer = new Server({
    transport: new WebSocketTransport({ /* standalone http server */ }),
  });
  gameServer.define("smoke", SmokeRoom);
  await gameServer.listen(PORT);
  console.log(`[smoke] server listening on ${PORT}`);

  const client = new BrowserClient(`ws://localhost:${PORT}`);
  const room = await client.joinOrCreate<SmokeState>("smoke", {}, SmokeState);
  console.log(`[smoke] joined room, sessionId=${room.sessionId}`);

  // 1. Initial state must decode.
  await waitFor("initial state decode", () => {
    const p = room.state.players?.get(room.sessionId);
    return !!p && p.name === "smoke" && p.x === 1;
  });
  console.log("[smoke] PASS: initial state decoded (name=smoke, x=1)");

  // 2. Incremental patches must decode.
  room.send("move", { x: 42 });
  await waitFor("patch decode", () => room.state.players.get(room.sessionId)?.x === 42);
  console.log("[smoke] PASS: incremental patch decoded (x=42)");

  await room.leave();
  await gameServer.gracefullyShutdown(false);
  console.log("\n[smoke] ✅ Colyseus client/server pairing is COMPATIBLE");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[smoke] ❌ FAILED:", err?.message ?? err);
  process.exit(1);
});
