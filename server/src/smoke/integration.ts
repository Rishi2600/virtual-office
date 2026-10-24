/**
 * End-to-end server test. Boots the real server in-process and drives it with
 * real Colyseus clients over a real WebSocket, exercising:
 *
 *   auth handshake · movement · collision · proximity enter/exit (hysteresis)
 *   signaling authorization · focus-mode suppression · reconnect
 *
 * Run: npm test
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Tests never touch the developer's database (DATABASE_URL): they use
// TEST_DATABASE_URL when set (CI's Postgres job, or local `npm run db:up`),
// otherwise the JSON file. Read .env first so TEST_DATABASE_URL from it counts.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"), quiet: true });
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

process.env.PORT ??= "2588";
process.env.DEV_AUTH = "true";
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL ??= "warn";

import { Client, type Room } from "colyseus.js";
import {
  OfficeState,
  PROXIMITY_ENTER,
  PROXIMITY_EXIT,
  S2C,
  C2S,
  TILE_SIZE,
  type ChatInMessage,
  type ProximityEnterMessage,
  type ProximityExitMessage,
  type SignalInMessage,
} from "@vo/shared";

const { startServer } = await import("../index.js");

const PORT = Number(process.env.PORT);
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;

// ---------------------------------------------------------------- test harness
let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }
  console.log(`        (timed out waiting for ${label})`);
  return false;
}

// ------------------------------------------------------------------ auth flow
async function signIn(name: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`dev sign-in failed for ${name}: ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const tokenRes = await fetch(`${BASE}/api/rt-token`, { headers: { cookie } });
  if (!tokenRes.ok) throw new Error(`rt-token failed for ${name}: ${tokenRes.status}`);
  return ((await tokenRes.json()) as { token: string }).token;
}

interface Peer {
  name: string;
  client: Client;
  room: Room<OfficeState>;
  entered: ProximityEnterMessage[];
  exited: ProximityExitMessage[];
  signals: SignalInMessage[];
  chats: ChatInMessage[];
}

async function joinAs(name: string): Promise<Peer> {
  const token = await signIn(name);
  const client = new Client(WS);
  const room = await client.joinOrCreate<OfficeState>("office", { token }, OfficeState);
  const peer: Peer = { name, client, room, entered: [], exited: [], signals: [], chats: [] };
  wire(peer);
  // joinOrCreate resolves before the first state patch arrives, so wait until we
  // can actually see ourselves — otherwise callers race the sync.
  await waitFor(`${name} appears in state`, () => !!room.state.players.get(room.sessionId));
  return peer;
}

function wire(peer: Peer): void {
  peer.room.onMessage(S2C.ProximityEnter, (m: ProximityEnterMessage) => peer.entered.push(m));
  peer.room.onMessage(S2C.ProximityExit, (m: ProximityExitMessage) => peer.exited.push(m));
  peer.room.onMessage(S2C.Signal, (m: SignalInMessage) => peer.signals.push(m));
  peer.room.onMessage(S2C.Chat, (m: ChatInMessage) => peer.chats.push(m));
}

const self = (p: Peer) => p.room.state.players.get(p.room.sessionId)!;
const gapBetween = (a: Peer, b: Peer) => Math.hypot(self(a).x - self(b).x, self(a).y - self(b).y);
const clearEvents = (...peers: Peer[]) => {
  for (const p of peers) {
    p.entered.length = 0;
    p.exited.length = 0;
    p.signals.length = 0;
    p.chats.length = 0;
  }
};

let seq = 1;

/** One input packet, paced to wall-clock. The server grants simulated time at
 *  wall-clock rate, so bursting inputs would just be throttled. */
function sendInput(peer: Peer, dx: number, dy: number): void {
  peer.room.send(C2S.Input, { seq: seq++, dx, dy, dt: 0.025 });
}

async function holdDirection(peer: Peer, dx: number, dy: number, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) {
    sendInput(peer, dx, dy);
    await sleep(25);
  }
  await sleep(150);
}

/** Walk to a world position, closing whichever axis is still open. Position
 *  aware, so it stops on arrival instead of overshooting the way a fixed-
 *  duration nudge does. */
async function walkTo(peer: Peer, tx: number, ty: number, timeoutMs = 12000): Promise<void> {
  const tol = 10;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const me = self(peer);
    const ddx = tx - me.x;
    const ddy = ty - me.y;
    if (Math.abs(ddx) <= tol && Math.abs(ddy) <= tol) break;
    sendInput(peer, Math.abs(ddx) > tol ? Math.sign(ddx) : 0, Math.abs(ddy) > tol ? Math.sign(ddy) : 0);
    await sleep(25);
  }
  await sleep(150);
}

// Map landmarks. Row 19 is clear wall-to-wall and columns 5 and 22 have no desk
// pods, so these routes never walk into furniture.
const LANE_Y = 19 * TILE_SIZE + TILE_SIZE / 2; // 624
const COL = (tile: number) => tile * TILE_SIZE + TILE_SIZE / 2;

// ------------------------------------------------------------------- the test
const server = await startServer();
console.log(`\nvirtual-office integration test (port ${PORT})\n`);

const alice = await joinAs("Alice");
const bob = await joinAs("Bob");
await waitFor("both players in state", () => alice.room.state.players.size === 2);

// -- 1. auth ----------------------------------------------------------------
console.log("auth");
check("two authenticated clients joined", alice.room.state.players.size === 2);
check("player identity came from the token", self(alice).name === "Alice" && self(bob).name === "Bob");

let rejected = false;
try {
  await new Client(WS).joinOrCreate<OfficeState>("office", { token: "not-a-real-token" }, OfficeState);
} catch { rejected = true; }
check("join with an invalid token is rejected at the handshake", rejected);

let noToken = false;
try {
  await new Client(WS).joinOrCreate<OfficeState>("office", {}, OfficeState);
} catch { noToken = true; }
check("join with no token is rejected", noToken);

// -- 2. movement ------------------------------------------------------------
console.log("\nmovement");
const startX = self(alice).x;
await holdDirection(alice, 1, 0, 300);
const movedX = self(alice).x;
check("server applied movement", movedX > startX + 10, `x ${startX.toFixed(1)} -> ${movedX.toFixed(1)}`);

const bobsViewOfAlice = bob.room.state.players.get(alice.room.sessionId);
check(
  "movement replicated to the other client",
  !!bobsViewOfAlice && Math.abs(bobsViewOfAlice.x - movedX) < 1,
  `bob sees ${bobsViewOfAlice?.x.toFixed(1)}, actual ${movedX.toFixed(1)}`,
);
check("server acked the input sequence", self(alice).lastSeq > 0);

// -- 3. collision -----------------------------------------------------------
console.log("\ncollision");
await holdDirection(alice, 0, 1, 2500); // walk hard into the bottom wall
const wallY = self(alice).y;
const wallTop = (30 - 1) * TILE_SIZE; // row 29 is solid => y=928
check(
  "avatar stops at the wall instead of passing through",
  wallY < wallTop && wallY > wallTop - TILE_SIZE,
  `y=${wallY.toFixed(1)}, wall at ${wallTop}`,
);

const beforeSlide = self(alice).x;
await holdDirection(alice, 1, 1, 400); // press into the wall diagonally
check(
  "diagonal into a wall slides along it instead of sticking",
  self(alice).x > beforeSlide + 5 && self(alice).y < wallTop,
  `x ${beforeSlide.toFixed(1)} -> ${self(alice).x.toFixed(1)}`,
);

// -- 4. proximity -----------------------------------------------------------
console.log("\nproximity");
// Stage both peers in the clear corridor, routing via desk-free columns.
await walkTo(alice, COL(5), self(alice).y);
await walkTo(alice, COL(5), LANE_Y);
await walkTo(bob, COL(22), self(bob).y);
await walkTo(bob, COL(22), LANE_Y);
await walkTo(bob, COL(12), LANE_Y);
clearEvents(alice, bob);

const startGap = gapBetween(alice, bob);
check("peers staged outside the enter radius", startGap > PROXIMITY_EXIT, `gap=${startGap.toFixed(1)}`);
check("no call is open while apart", alice.entered.length === 0 && bob.entered.length === 0);

// Signaling must be refused while they are not adjacent.
alice.room.send(C2S.Signal, { to: bob.room.sessionId, payload: { kind: "candidate", candidate: null } });
await sleep(300);
check("signaling between non-adjacent peers is dropped", bob.signals.length === 0);

// Walk Alice to within the enter radius of Bob.
await walkTo(alice, self(bob).x - 80, LANE_Y);
const closeGap = gapBetween(alice, bob);
const opened = await waitFor("proximity enter", () => alice.entered.length > 0 && bob.entered.length > 0);
check("walking together opened a call", opened, `gap=${closeGap.toFixed(1)}`);
check(
  "both peers were told about each other",
  alice.entered[0]?.peerId === bob.room.sessionId && bob.entered[0]?.peerId === alice.room.sessionId,
);
check(
  "exactly one peer is the offerer (no glare)",
  alice.entered[0]?.polite !== bob.entered[0]?.polite,
  `alice.polite=${alice.entered[0]?.polite} bob.polite=${bob.entered[0]?.polite}`,
);

alice.signals.length = 0; bob.signals.length = 0;
// A real SDP offer is several KB once codecs and ICE parameters are listed.
// Colyseus caps WebSocket payloads at 4KB by default, which severed the socket
// with code 1009 the instant anyone started a call — and presented as a
// reconnect loop rather than a signaling error. Use a realistically sized offer
// so that regression can never come back silently.
const bigSdp = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n" +
  "a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000\r\n".repeat(220);
alice.room.send(C2S.Signal, {
  to: bob.room.sessionId,
  payload: { kind: "description", description: { type: "offer", sdp: bigSdp } },
});
const relayed = await waitFor("signal relay", () => bob.signals.length > 0);
check("signaling between adjacent peers is relayed", relayed);
check("relayed signal is attributed to the sender", bob.signals[0]?.from === alice.room.sessionId);

const received = bob.signals[0]?.payload;
check(
  `a realistically sized SDP offer (${(bigSdp.length / 1024).toFixed(1)}KB) survives the relay`,
  received?.kind === "description" && received.description.sdp?.length === bigSdp.length,
  `sent ${bigSdp.length}B, got ${received?.kind === "description" ? received.description.sdp?.length : "nothing"}B`,
);
check("the connection survived sending it", alice.room.connection.isOpen);

// -- 5. hysteresis ----------------------------------------------------------
console.log("\nhysteresis");
alice.exited.length = 0; bob.exited.length = 0;
// Step back past ENTER but stay inside EXIT — the call must survive.
await walkTo(alice, self(bob).x - (PROXIMITY_ENTER + PROXIMITY_EXIT) / 2, LANE_Y);
const bandGap = gapBetween(alice, bob);
await sleep(400);
check(
  "call survives inside the hysteresis band",
  bandGap > PROXIMITY_ENTER && bandGap < PROXIMITY_EXIT && alice.exited.length === 0,
  `gap=${bandGap.toFixed(1)} (band ${PROXIMITY_ENTER}-${PROXIMITY_EXIT}), exits=${alice.exited.length}`,
);

// -- 6. exit ----------------------------------------------------------------
console.log("\nteardown on walking away");
await walkTo(alice, self(bob).x - (PROXIMITY_EXIT + 60), LANE_Y);
const left = await waitFor("proximity exit", () => alice.exited.length > 0 && bob.exited.length > 0);
check("walking apart closed the call", left, `gap=${gapBetween(alice, bob).toFixed(1)}`);
check(
  "both peers were told to tear down",
  alice.exited[0]?.peerId === bob.room.sessionId && bob.exited[0]?.peerId === alice.room.sessionId,
);

// -- 7. focus mode ----------------------------------------------------------
console.log("\nfocus mode");
clearEvents(alice, bob);
alice.room.send(C2S.SetStatus, { status: "focus" });
await waitFor("status replicated", () => self(alice).status === "focus");
check("status is replicated to everyone", bob.room.state.players.get(alice.room.sessionId)?.status === "focus");

// Walk right back into Bob while in focus — no call may be offered.
await walkTo(alice, self(bob).x - 70, LANE_Y);
const focusGap = gapBetween(alice, bob);
await sleep(500);
check("focus mode was tested at close range", focusGap < PROXIMITY_ENTER, `gap=${focusGap.toFixed(1)}`);
check(
  "no call is offered while in focus mode",
  alice.entered.length === 0 && bob.entered.length === 0,
  `gap=${focusGap.toFixed(1)}`,
);

alice.room.send(C2S.SetStatus, { status: "available" });
const reopened = await waitFor("call opens after leaving focus", () => alice.entered.length > 0);
check("leaving focus mode opens the call", reopened);

// -- 8. chat ----------------------------------------------------------------
// Alice and Bob are adjacent here; Carol joins and stays across the room.
console.log("\nchat");
const carol = await joinAs("Carol");
await walkTo(carol, COL(30), self(carol).y);
await walkTo(carol, COL(30), LANE_Y);
clearEvents(alice, bob, carol);

const farGap = Math.hypot(self(carol).x - self(bob).x, self(carol).y - self(bob).y);
check("Carol is staged well away from the others", farGap > PROXIMITY_EXIT, `gap=${farGap.toFixed(1)}`);

alice.room.send(C2S.Chat, { scope: "nearby", text: "just between us" });
await waitFor("nearby chat delivered", () => bob.chats.length > 0);
await sleep(300);
check("nearby chat reaches the person you're standing with", bob.chats[0]?.text === "just between us");
check("nearby chat is attributed to the sender", bob.chats[0]?.name === "Alice");
check("the sender sees their own nearby message", alice.chats.length === 1);
check("nearby chat does NOT reach someone across the room", carol.chats.length === 0);

clearEvents(alice, bob, carol);
alice.room.send(C2S.Chat, { scope: "room", text: "morning everyone" });
await waitFor("room chat delivered", () => carol.chats.length > 0);
await sleep(200);
check("room chat reaches everyone", bob.chats.length === 1 && carol.chats.length === 1);
check("room chat keeps its scope", carol.chats[0]?.scope === "room");

alice.room.send(C2S.Chat, { scope: "nearby", text: "   " });
await sleep(250);
check("empty chat is dropped", bob.chats.length === 1);

// -- 9. locked conversations ------------------------------------------------
console.log("\nlocked conversation");
clearEvents(alice, bob, carol);
alice.room.send(C2S.SetLock, { locked: true });
await waitFor("lock replicated", () => self(alice).lockGroup !== "");
check("locking marks the whole huddle, not just the locker", self(bob).lockGroup === self(alice).lockGroup);
check("lock group is non-empty", self(alice).lockGroup.length > 0);

// Carol walks right into them — she must not be connected.
await walkTo(carol, self(bob).x + 60, LANE_Y);
const intruderGap = Math.hypot(self(carol).x - self(bob).x, self(carol).y - self(bob).y);
await sleep(500);
check("Carol got close enough to test the lock", intruderGap < PROXIMITY_ENTER, `gap=${intruderGap.toFixed(1)}`);
check("a locked conversation refuses new people", carol.entered.length === 0);
check("the locked pair was not disturbed", alice.exited.length === 0 && bob.exited.length === 0);

// Unlocking lets her in.
alice.room.send(C2S.SetLock, { locked: false });
await waitFor("unlock replicated", () => self(alice).lockGroup === "");
const joined = await waitFor("Carol connects after unlock", () => carol.entered.length > 0);
check("unlocking lets people join again", joined);
check("lock cleared for everyone in the huddle", self(bob).lockGroup === "");

// A lock nobody else holds must not strand the last person.
clearEvents(alice, bob, carol);
alice.room.send(C2S.SetLock, { locked: true });
await waitFor("re-locked", () => self(alice).lockGroup !== "");
await walkTo(alice, COL(22), LANE_Y);
await walkTo(alice, COL(22), self(alice).y - 200);
const released = await waitFor("stale lock released", () => self(alice).lockGroup === "", 6000);
check("walking away alone releases the lock automatically", released);

await carol.room.leave(true);
await waitFor("Carol removed", () => alice.room.state.players.size === 2);

// -- 10. reconnect ----------------------------------------------------------
console.log("\nreconnect");
// Bring Alice back next to Bob so there is a live call to tear down.
await walkTo(alice, COL(22), LANE_Y);
await walkTo(alice, self(bob).x - 70, LANE_Y);
await waitFor("call re-established", () => alice.entered.length > 0 || bob.entered.length > 0, 3000);
bob.exited.length = 0;
const beforeDrop = { x: self(alice).x, y: self(alice).y };
const reconnectionToken = alice.room.reconnectionToken;
const oldSessionId = alice.room.sessionId;

await alice.room.leave(false); // unconsented: server holds the slot open
await waitFor(
  "peer marked disconnected",
  () => bob.room.state.players.get(oldSessionId)?.connected === false,
);
check(
  "dropped peer is marked disconnected for everyone else",
  bob.room.state.players.get(oldSessionId)?.connected === false,
);
const toreDown = await waitFor("call torn down on drop", () =>
  bob.exited.some((e) => e.peerId === oldSessionId),
);
check("peer's call is torn down immediately on drop", toreDown);

alice.room = await alice.client.reconnect<OfficeState>(reconnectionToken, OfficeState);
wire(alice);
await waitFor("state after reconnect", () => !!alice.room.state.players.get(alice.room.sessionId));
check("reconnect kept the same session", alice.room.sessionId === oldSessionId);
check(
  "reconnect restored the same position (no respawn)",
  Math.abs(self(alice).x - beforeDrop.x) < 1 && Math.abs(self(alice).y - beforeDrop.y) < 1,
  `${beforeDrop.x.toFixed(1)},${beforeDrop.y.toFixed(1)} -> ${self(alice).x.toFixed(1)},${self(alice).y.toFixed(1)}`,
);
check("player is connected again", self(alice).connected === true);

// -- 9. leaving -------------------------------------------------------------
console.log("\nleaving");
await bob.room.leave(true);
await waitFor("player removed", () => alice.room.state.players.size === 1);
check("a consented leave removes the player immediately", alice.room.state.players.size === 1);

// ---------------------------------------------------------------------- done
await alice.room.leave(true);
await server.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("All integration checks passed.\n");
process.exit(0);
