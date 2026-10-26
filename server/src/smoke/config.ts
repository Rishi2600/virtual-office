/**
 * Startup-guard test. Boots the real server in child processes with different
 * environments and checks that unsafe configs are refused (with the right
 * reason) and that safe ones start, with dev sign-in on only in development.
 *
 * Run: npm test (runs after the integration suite).
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Every variable the guards look at, blanked. A var that is set (even to "")
 * is not overwritten by dotenv, so a developer's own .env can't leak in.
 */
const BLANK = {
  NODE_ENV: "",
  DEV_AUTH: "",
  JWT_SECRET: "",
  PORT: "",
  SESSION_TTL_SEC: "",
  REALTIME_TTL_SEC: "",
  GITHUB_CLIENT_ID: "",
  GITHUB_CLIENT_SECRET: "",
  ALLOWED_EMAIL_DOMAIN: "",
  GITHUB_CALLBACK_URL: "",
  PUBLIC_URL: "",
  TRUST_PROXY: "",
  DATABASE_URL: "",
  LOG_LEVEL: "info",
  STUN_URLS: "",
  TURN_URLS: "",
  TURN_SECRET: "",
  TURN_TTL_SEC: "",
  TURN_USERNAME: "",
  TURN_CREDENTIAL: "",
};

const GOOD_SECRET = "x".repeat(48);
const GITHUB = { GITHUB_CLIENT_ID: "test-id", GITHUB_CLIENT_SECRET: "test-secret" };

interface IceResponse {
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  ttlSec: number;
}

interface Outcome {
  started: boolean;
  output: string;
  config?: { devAuthEnabled: boolean } & Record<string, unknown>;
  devRouteStatus?: number;
  /** GET /api/ice without signing in. */
  iceSignedOutStatus?: number;
  /** GET /api/ice as the dev-signed-in probe user (development only). */
  ice?: IceResponse;
  /** Browser-facing security (security.ts), probed from outside. */
  security?: {
    csp: string | null;
    poweredBy: string | null;
    frame: string | null;
    corsEvil: string | null;
    corsOwn: string | null;
    wsEvil: number;
    wsOwn: number;
    joinEvil: string;
  };
}

/** HTTP status of a WebSocket upgrade from `origin` (101 = accepted). */
function upgradeStatus(port: string, origin: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({
      port,
      path: "/probe",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Origin: origin,
      },
    });
    req.on("upgrade", (_res, socket) => (socket.destroy(), resolve(101)));
    req.on("response", (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on("error", () => resolve(0));
    req.end();
  });
}

/** CORS answer of the matchmaker to a preflight from `origin`. */
const corsFor = (base: string, origin: string) =>
  fetch(`${base}/matchmake/joinOrCreate/office`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  }).then((r) => r.headers.get("access-control-allow-origin"));

/** Starts the server; if it comes up, probes it and shuts it down. */
function boot(env: Record<string, string>): Promise<Outcome> {
  return new Promise((resolve) => {
    const port = env.PORT || "2567";
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: serverDir,
      // An empty NODE_ENV would count as "set"; drop it so "unset" is real.
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...BLANK, ...env }).filter(([k, v]) => !(k === "NODE_ENV" && v === "")),
      ),
    });
    let output = "";
    let settled = false;
    const finish = (o: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // SIGKILL: this test is about startup, not shutdown (graceful shutdown is
      // audit OPS-2, fixed separately).
      child.kill("SIGKILL");
      resolve(o);
    };
    const timer = setTimeout(() => finish({ started: false, output: output + "\n(timed out)" }), 20_000);

    let probing = false;
    const onData = async (chunk: Buffer) => {
      output += chunk.toString();
      // Output arrives in chunks; probe once, on the first sign of life.
      if (probing || !output.includes("virtual office server listening")) return;
      probing = true;
      try {
        const base = `http://localhost:${port}`;
        const configRes = await fetch(`${base}/api/config`);
        const config = (await configRes.json()) as Outcome["config"];
        const own = env.PUBLIC_URL || "http://localhost:5173";
        const security = {
          csp: configRes.headers.get("content-security-policy"),
          poweredBy: configRes.headers.get("x-powered-by"),
          frame: configRes.headers.get("x-frame-options"),
          corsEvil: await corsFor(base, "https://evil.example"),
          corsOwn: await corsFor(base, own),
          wsEvil: await upgradeStatus(port, "https://evil.example"),
          wsOwn: await upgradeStatus(port, own),
          // A non-browser client can skip CORS: the room itself checks too.
          joinEvil: await fetch(`${base}/matchmake/joinOrCreate/office`, {
            method: "POST",
            headers: { Origin: "https://evil.example", "content-type": "application/json" },
            body: JSON.stringify({ token: "x" }),
          }).then((r) => r.text()),
        };
        const dev = await fetch(`${base}/auth/dev`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Probe" }),
        });
        const iceSignedOutStatus = (await fetch(`${base}/api/ice`)).status;
        let ice: IceResponse | undefined;
        if (dev.ok) {
          const { token } = (await dev.json()) as { token: string };
          ice = (await fetch(`${base}/api/ice`, { headers: { authorization: `Bearer ${token}` } }).then((r) =>
            r.json(),
          )) as IceResponse;
        }
        finish({ started: true, output, config, devRouteStatus: dev.status, iceSignedOutStatus, ice, security });
      } catch (err) {
        finish({ started: true, output: `${output}\n(probe failed: ${(err as Error).message})` });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => finish({ started: false, output }));
  });
}

console.log("\nstartup guards\n");

let o = await boot({});
check("NODE_ENV unset is treated as production and refused without a secret", !o.started && o.output.includes("JWT_SECRET must be set"));
check("…and without GitHub sign-in", o.output.includes("configure GitHub sign-in"));
check("…and says it is treating unset NODE_ENV as production", o.output.includes("NODE_ENV=unset"));

o = await boot({ JWT_SECRET: GOOD_SECRET, ...GITHUB, DEV_AUTH: "true" });
check("DEV_AUTH=true outside development is refused", !o.started && o.output.includes("DEV_AUTH=true is only allowed"));

o = await boot({ NODE_ENV: "production", JWT_SECRET: "short", ...GITHUB });
check("a short JWT_SECRET is refused", !o.started && o.output.includes("at least 32 characters"));

o = await boot({ NODE_ENV: "production", JWT_SECRET: "dev-only-insecure-secret-change-me", ...GITHUB });
check("the public dev JWT_SECRET is refused", !o.started && o.output.includes("JWT_SECRET must be set"));

o = await boot({ NODE_ENV: "staging", JWT_SECRET: GOOD_SECRET, ...GITHUB, PORT: "abc" });
check("a non-numeric PORT is refused instead of silently defaulting", !o.started && o.output.includes("PORT must be a positive whole number") && o.output.includes("abc"));

o = await boot({ JWT_SECRET: GOOD_SECRET, ...GITHUB, PORT: "2593" });
check("a safe config starts with NODE_ENV unset", o.started, o.output.slice(-400));
check("…with dev sign-in reported off", o.config?.devAuthEnabled === false);
check("…and the dev sign-in route absent", o.devRouteStatus === 404, `status ${o.devRouteStatus}`);
check("…and it warns that sign-in is open to any GitHub account", o.output.includes("open to ANYONE with a GitHub account"));
const sec = o.security;
check("…sends a strict Content-Security-Policy", !!sec?.csp?.includes("script-src 'self'") && !!sec.csp.includes("frame-ancestors 'none'"), sec?.csp ?? "none");
check("…without X-Powered-By, and refuses to be framed", sec?.poweredBy === null && sec?.frame === "DENY");
check("…the matchmaker gives other sites no CORS permission", sec?.corsEvil === null, `${sec?.corsEvil}`);
check("…but answers for the office's own address", sec?.corsOwn === "http://localhost:5173", `${sec?.corsOwn}`);
check("…and the room refuses a join sent from another site", !!sec?.joinEvil.includes("forbidden_origin"), sec?.joinEvil);
check("…the WebSocket refuses other sites and accepts its own", sec?.wsEvil === 401 && sec?.wsOwn === 101, `evil=${sec?.wsEvil} own=${sec?.wsOwn}`);

o = await boot({ JWT_SECRET: GOOD_SECRET, ...GITHUB, PUBLIC_URL: "office.example.com", TRUST_PROXY: "-1" });
check("a PUBLIC_URL that isn't a full URL is refused", !o.started && o.output.includes("PUBLIC_URL must be a full http(s) URL"));
check("…and so is a negative TRUST_PROXY", o.output.includes("TRUST_PROXY must be a whole number"));

o = await boot({ JWT_SECRET: GOOD_SECRET, ...GITHUB, PUBLIC_URL: "https://office.example.com", PORT: "2596" });
check("PUBLIC_URL sets the one origin allowed in", o.security?.corsOwn === "https://office.example.com" && o.security?.wsOwn === 101 && o.security?.wsEvil === 401, JSON.stringify(o.security));

o = await boot({ NODE_ENV: "development", PORT: "2594" });
check("development starts with no config at all", o.started, o.output.slice(-400));
check("…with dev sign-in on", o.config?.devAuthEnabled === true && o.devRouteStatus === 200);

o = await boot({ NODE_ENV: "development", DEV_AUTH: "false", PORT: "2595" });
check("DEV_AUTH=false turns dev sign-in off in development", o.started && o.config?.devAuthEnabled === false);

// -- TURN ----------------------------------------------------------------------
const TURN = { TURN_URLS: "turn:turn.example.com:3478?transport=udp", TURN_SECRET: "a".repeat(64) };

o = await boot({ NODE_ENV: "development", TURN_URLS: TURN.TURN_URLS });
check("TURN_URLS without TURN_SECRET is refused", !o.started && o.output.includes("TURN_SECRET isn't"));

o = await boot({ NODE_ENV: "development", TURN_SECRET: TURN.TURN_SECRET });
check("TURN_SECRET without TURN_URLS is refused", !o.started && o.output.includes("TURN_URLS isn't"));

o = await boot({ NODE_ENV: "development", TURN_USERNAME: "u", TURN_CREDENTIAL: "p" });
check("the old static TURN_USERNAME/TURN_CREDENTIAL are refused", !o.started && o.output.includes("no longer used"));

o = await boot({ NODE_ENV: "production", JWT_SECRET: GOOD_SECRET, ...GITHUB, TURN_URLS: TURN.TURN_URLS, TURN_SECRET: "short" });
check("a short TURN_SECRET is refused in production", !o.started && o.output.includes("TURN_SECRET must be at least 32"));

o = await boot({ NODE_ENV: "development", TURN_URLS: TURN.TURN_URLS, TURN_SECRET: "abc$(id)def" });
check("a shell-unsafe TURN_SECRET is refused", !o.started && o.output.includes("may only contain"));

const before = Math.floor(Date.now() / 1000);
o = await boot({ NODE_ENV: "development", PORT: "2596", ...TURN, TURN_TTL_SEC: "3600" });
check("starts with TURN configured", o.started, o.output.slice(-400));
check("/api/config no longer hands out ICE servers", !!o.config && !("iceServers" in o.config));
check("/api/ice refuses signed-out callers", o.iceSignedOutStatus === 401, `status ${o.iceSignedOutStatus}`);
const turn = o.ice?.iceServers.find((s) => s.urls.some((u) => u.startsWith("turn:")));
check("/api/ice gives a signed-in user STUN and TURN", !!turn && !!o.ice?.iceServers.some((s) => s.urls.some((u) => u.startsWith("stun:"))));
const [expiry, userId] = (turn?.username ?? "").split(":");
check(
  "the TURN username is <expiry>:<user id>, expiring after TURN_TTL_SEC",
  !!userId && Math.abs(Number(expiry) - (before + 3600)) <= 5,
  turn?.username,
);
check(
  "the TURN credential is coturn's HMAC of the username with TURN_SECRET",
  turn?.credential === createHmac("sha1", TURN.TURN_SECRET).update(turn?.username ?? "").digest("base64"),
);
check("the TTL is reported so the client can refresh", o.ice?.ttlSec === 3600);

o = await boot({ NODE_ENV: "development", PORT: "2597" });
check("without TURN, /api/ice gives STUN only", o.started && o.ice?.iceServers.length === 1 && !!o.ice.iceServers[0]!.urls[0]!.startsWith("stun:"));

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
