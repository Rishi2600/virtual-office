/**
 * Privacy of the server log (owner decision; audit PRIV-1): people appear only
 * as opaque ids, never by name, email or IP address.
 *
 *   1. A real server run (child process, info level): someone signs in, joins,
 *      walks, leaves and signs out; nothing in the whole log names them.
 *   2. The safety net: if a personal field is ever passed to the logger, the
 *      production (JSON) logger writes "[redacted]" instead.
 *
 * Run: npm test.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "colyseus.js";
import { C2S, OfficeState } from "@vo/shared";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 2591;
const BASE = `http://localhost:${PORT}`;
const DATA_FILE = path.join(os.tmpdir(), `lamports-logs-${process.pid}.json`);
const NAME = `Zelda Privacyperson ${process.pid}`;
const EMAIL = `zelda.privacyperson.${process.pid}@dev.local`;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\nprivacy of the server log\n");

// 1. A real run at info level (development's readable format: the same fields).
const child = spawn(process.execPath, ["--import", "tsx", "src/dev.ts"], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: "", DATA_FILE, LOG_LEVEL: "info", DEV_AUTH: "true" },
});
let output = "";
child.stdout.on("data", (c: Buffer) => (output += c.toString()));
child.stderr.on("data", (c: Buffer) => (output += c.toString()));
for (let i = 0; i < 150 && !output.includes("server listening"); i++) await sleep(100);

const signIn = await fetch(`${BASE}/auth/dev`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: NAME }),
});
const cookie = signIn.headers.getSetCookie()[0]!.split(";")[0]!;
const { token } = (await fetch(`${BASE}/api/rt-token`, { headers: { cookie } }).then((r) => r.json())) as { token: string };
const room = await new Client(`ws://localhost:${PORT}`).joinOrCreate("office", { token }, OfficeState);
room.onMessage("*", () => {});
for (let i = 0; i < 20; i++) {
  room.send(C2S.Input, { seq: i, dx: 1, dy: 0, dt: 0.03 });
  await sleep(25);
}
room.send(C2S.Chat, { scope: "room", text: "hello from the privacy test" });
room.send(C2S.RtcFailure, { peerId: "p", state: "failed", detail: "via 203.0.113.7" });
await sleep(300);
await room.leave(true);
await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { cookie } });
await sleep(300);
child.kill("SIGTERM");
await new Promise((r) => child.on("exit", r));

const first = NAME.split(" ")[0]!;
check("the run produced a real log (sign-in, connect, disconnect)", /dev sign-in/.test(output) && /client connected/.test(output) && /client disconnected/.test(output));
check("the log never contains the person's name", !output.includes(first), output.split("\n").find((l) => l.includes(first)));
check("…or their email address", !output.toLowerCase().includes(EMAIL.split("@")[0]!), output.split("\n").find((l) => l.includes("privacyperson")));
check("…or what they said in chat", !output.includes("hello from the privacy test"));
check("…or an IP address from a client report", !output.includes("203.0.113.7"));
check("people appear as their internal id instead", /userId/.test(output));
check("no Colyseus banner", !/colyseus\.io|Colyseus \d/.test(output));

// 2. The safety net, in the production (JSON) format.
const net = spawn(
  process.execPath,
  ["--import", "tsx", "-e", `import("./src/log.ts").then(({ authLog }) => authLog.info({ email: "a@b.c", name: "Al", ip: "198.51.100.1", user: { email: "x@y.z" } }, "probe"))`],
  { cwd: serverDir, env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "info", JWT_SECRET: "x".repeat(48) } },
);
let netOut = "";
net.stdout.on("data", (c: Buffer) => (netOut += c.toString()));
await new Promise((r) => net.on("exit", r));
const line = netOut.split("\n").find((l) => l.includes('"probe"')) ?? "";
check("personal fields passed to the logger are written as [redacted]", line.includes("[redacted]") && !/a@b\.c|"Al"|198\.51|x@y\.z/.test(line), line);

rmSync(DATA_FILE, { force: true });
rmSync(DATA_FILE + ".tmp", { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
