/**
 * Startup-guard test. Boots the real server in child processes with different
 * environments and checks that unsafe configs are refused (with the right
 * reason) and that safe ones start, with dev sign-in on only in development.
 *
 * Run: npm test (runs after the integration suite).
 */
import { spawn } from "node:child_process";
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
  MICROSOFT_CLIENT_ID: "",
  MICROSOFT_CLIENT_SECRET: "",
  MICROSOFT_TENANT_ID: "",
  GITHUB_CLIENT_ID: "",
  GITHUB_CLIENT_SECRET: "",
  DATABASE_URL: "",
  LOG_LEVEL: "info",
};

const GOOD_SECRET = "x".repeat(48);
const GITHUB = { GITHUB_CLIENT_ID: "test-id", GITHUB_CLIENT_SECRET: "test-secret" };

interface Outcome {
  started: boolean;
  output: string;
  config?: { devAuthEnabled: boolean };
  devRouteStatus?: number;
}

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
        const config = (await fetch(`${base}/api/config`).then((r) => r.json())) as { devAuthEnabled: boolean };
        const dev = await fetch(`${base}/auth/dev`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Probe" }),
        });
        finish({ started: true, output, config, devRouteStatus: dev.status });
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
check("…and without a sign-in provider", o.output.includes("configure at least one sign-in provider"));
check("…and says it is treating unset NODE_ENV as production", o.output.includes("NODE_ENV=unset"));

o = await boot({ JWT_SECRET: GOOD_SECRET, ...GITHUB, DEV_AUTH: "true" });
check("DEV_AUTH=true outside development is refused", !o.started && o.output.includes("DEV_AUTH=true is only allowed"));

o = await boot({ NODE_ENV: "production", JWT_SECRET: "short", ...GITHUB });
check("a short JWT_SECRET is refused", !o.started && o.output.includes("at least 32 characters"));

o = await boot({ NODE_ENV: "production", JWT_SECRET: "dev-only-insecure-secret-change-me", ...GITHUB });
check("the public dev JWT_SECRET is refused", !o.started && o.output.includes("JWT_SECRET must be set"));

o = await boot({ NODE_ENV: "staging", JWT_SECRET: GOOD_SECRET, ...GITHUB, PORT: "abc" });
check("a non-numeric PORT is refused instead of silently defaulting", !o.started && o.output.includes("PORT must be a positive whole number") && o.output.includes("abc"));

o = await boot({
  NODE_ENV: "production",
  JWT_SECRET: GOOD_SECRET,
  MICROSOFT_CLIENT_ID: "id",
  MICROSOFT_CLIENT_SECRET: "secret",
  MICROSOFT_TENANT_ID: "common",
});
check('MICROSOFT_TENANT_ID=common is refused in production', !o.started && o.output.includes("must be your tenant GUID"));

o = await boot({ JWT_SECRET: GOOD_SECRET, ...GITHUB, PORT: "2593" });
check("a safe config starts with NODE_ENV unset", o.started, o.output.slice(-400));
check("…with dev sign-in reported off", o.config?.devAuthEnabled === false);
check("…and the dev sign-in route absent", o.devRouteStatus === 404, `status ${o.devRouteStatus}`);

o = await boot({ NODE_ENV: "development", PORT: "2594" });
check("development starts with no config at all", o.started, o.output.slice(-400));
check("…with dev sign-in on", o.config?.devAuthEnabled === true && o.devRouteStatus === 200);

o = await boot({ NODE_ENV: "development", DEV_AUTH: "false", PORT: "2595" });
check("DEV_AUTH=false turns dev sign-in off in development", o.started && o.config?.devAuthEnabled === false);

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
