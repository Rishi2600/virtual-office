/**
 * Graceful-shutdown test. Starts the real server as a child process, connects
 * a real client, sends SIGTERM, and checks the shutdown is orderly: the client
 * is told, the room is disposed, the process exits 0 in time, and only one
 * shutdown path ran (Colyseus's own signal handler used to race ours).
 *
 * Run: npm test (runs after the other server suites).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "colyseus.js";
import { OfficeState } from "@vo/shared";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 2589;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\ngraceful shutdown\n");

// node itself is the child (no shell in between), so the signal reaches it.
const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
  cwd: serverDir,
  env: { ...process.env, NODE_ENV: "development", DEV_AUTH: "true", PORT: String(PORT), DATABASE_URL: "" },
});
let output = "";
child.stdout.on("data", (c: Buffer) => (output += c.toString()));
child.stderr.on("data", (c: Buffer) => (output += c.toString()));
const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

for (let i = 0; i < 100 && !output.includes("virtual office server listening"); i++) await sleep(100);

const ready = await fetch(`${BASE}/ready`).then((r) => r.status);
check("/ready answers 200 while serving", ready === 200, `status ${ready}`);

const signIn = await fetch(`${BASE}/auth/dev`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Shutdown" }),
});
const cookie = signIn.headers.getSetCookie()[0]!.split(";")[0]!;
const { token } = (await fetch(`${BASE}/api/rt-token`, { headers: { cookie } }).then((r) => r.json())) as { token: string };
const room = await new Client(`ws://localhost:${PORT}`).joinOrCreate("office", { token }, OfficeState);
let leaveCode: number | null = null;
room.onLeave((code) => (leaveCode = code));
await sleep(500);

const started = Date.now();
child.kill("SIGTERM");
const code = await Promise.race([exited, sleep(10_000).then(() => "timeout" as const)]);
const tookMs = Date.now() - started;
if (code === "timeout") child.kill("SIGKILL");
await sleep(200);

check("the process exits after SIGTERM", code !== "timeout");
check("…with exit code 0", code === 0, `code ${code}`);
check("…within the 8s shutdown limit", tookMs < 8_000, `${tookMs}ms`);
check("the connected client was told (consented close, code 4000)", leaveCode === 4000, `code ${leaveCode}`);
check("the room was disposed", output.includes("room disposed"));
check('"shutdown complete" was logged', output.includes("shutdown complete"));
check("only one shutdown path ran (no already_shutting_down)", !output.includes("already_shutting_down"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
