/**
 * Restart test (docs/persistent-spot-plan.md). Runs the real server as a child
 * process, twice over the same store, and checks that people come back where
 * they stood:
 *
 *   1. a clean restart (SIGTERM): spots saved at shutdown, and two people who
 *      were talking are paired again;
 *   2. a crash (SIGKILL, no shutdown at all): the 30 s periodic save is what
 *      brings you back.
 *
 * Store: TEST_DATABASE_URL when set (CI's postgres job), else a throwaway JSON
 * file. Names are unique per run, so earlier runs' spots never interfere.
 *
 * Run: npm test (after the other server suites).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client, type Room } from "colyseus.js";
import { C2S, OfficeState, PROXIMITY_ENTER, S2C } from "@vo/shared";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(serverDir, "../.env"), quiet: true });
const PORT = 2590;
const BASE = `http://localhost:${PORT}`;
const DATA_FILE = path.join(os.tmpdir(), `lamports-restart-${process.pid}.json`);
const RUN = process.pid.toString(36);

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ server
let child: ChildProcess | null = null;
let exited: Promise<number | null> = Promise.resolve(null);

async function start(): Promise<void> {
  child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEV_AUTH: "true",
      PORT: String(PORT),
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      DATA_FILE,
      LOG_LEVEL: "info",
    },
  });
  let output = "";
  child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
  exited = new Promise((resolve) => child!.on("exit", (code) => resolve(code)));
  for (let i = 0; i < 150 && !output.includes("server listening"); i++) await sleep(100);
  if (!output.includes("server listening")) throw new Error(`server didn't start:\n${output}`);
}

async function stop(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  child?.kill(signal);
  await Promise.race([exited, sleep(10_000)]);
}

// ------------------------------------------------------------------ people
interface Person {
  room: Room<OfficeState>;
  paired: string[];
}

async function join(name: string): Promise<Person> {
  const res = await fetch(`${BASE}/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  const { token } = (await fetch(`${BASE}/api/rt-token`, { headers: { cookie } }).then((r) => r.json())) as { token: string };
  const room = await new Client(`ws://localhost:${PORT}`).joinOrCreate("office", { token }, OfficeState);
  const person: Person = { room, paired: [] };
  room.onMessage(S2C.ProximityEnter, (m: { peerId: string }) => person.paired.push(m.peerId));
  room.onMessage("*", () => {});
  room.onError(() => {}); // the old server going away mid-test is expected
  for (let i = 0; i < 50 && !me(person); i++) await sleep(50);
  return person;
}

const me = (p: Person) => p.room.state.players.get(p.room.sessionId);
const at = (p: Person) => ({ x: me(p)!.x, y: me(p)!.y });
const gap = (a: Person, b: Person) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
const same = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1;

let seq = 1;
/** Walks `p` straight towards `target` (open lobby floor) until within `stopAt`. */
async function walkTowards(p: Person, target: () => { x: number; y: number }, stopAt: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const t = target();
    const here = at(p);
    if (Math.hypot(t.x - here.x, t.y - here.y) <= stopAt) return;
    const dx = Math.abs(t.x - here.x) > 3 ? Math.sign(t.x - here.x) : 0;
    const dy = Math.abs(t.y - here.y) > 3 ? Math.sign(t.y - here.y) : 0;
    p.room.send(C2S.Input, { seq: seq++, dx, dy, dt: 0.025 });
    await sleep(25);
  }
}

// -------------------------------------------------------------------- test
console.log("\nrestart keeps everyone's spot\n");
try {
  await start();
  let ann = await join(`Ann-${RUN}`);
  let ben = await join(`Ben-${RUN}`);
  await walkTowards(ann, () => at(ben), PROXIMITY_ENTER - 40);
  await sleep(500);
  check("Ann and Ben are talking before the restart", ann.paired.length > 0, `gap=${gap(ann, ben).toFixed(1)}`);
  const annSpot = at(ann);
  const benSpot = at(ben);

  // 1. Clean restart.
  await stop("SIGTERM");
  await start();
  ann = await join(`Ann-${RUN}`);
  ben = await join(`Ben-${RUN}`);
  check("after a restart Ann is back on her spot", same(at(ann), annSpot), `${JSON.stringify(annSpot)} -> ${JSON.stringify(at(ann))}`);
  check("after a restart Ben is back on his spot", same(at(ben), benSpot), `${JSON.stringify(benSpot)} -> ${JSON.stringify(at(ben))}`);
  for (let i = 0; i < 40 && !ann.paired.length; i++) await sleep(50);
  check("their conversation re-forms by itself", ann.paired.length > 0 && ben.paired.length > 0);

  // 2. Crash: no shutdown, so only the 30 s periodic save can help.
  const target = { x: annSpot.x, y: annSpot.y + 96 };
  await walkTowards(ann, () => target, 4);
  const moved = at(ann);
  console.log("        (waiting 32 s for the periodic save)");
  await sleep(32_000);
  await stop("SIGKILL");
  await start();
  ann = await join(`Ann-${RUN}`);
  check("after a crash Ann is back where the last periodic save had her", same(at(ann), moved), `${JSON.stringify(moved)} -> ${JSON.stringify(at(ann))}`);
  await ann.room.leave(true);
} catch (err) {
  check("the restart test ran to the end", false, (err as Error).message);
} finally {
  await stop("SIGTERM");
  rmSync(DATA_FILE, { force: true });
  rmSync(DATA_FILE + ".tmp", { force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
