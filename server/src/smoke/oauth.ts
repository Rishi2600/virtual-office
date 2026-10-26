/**
 * OAuth sign-in test (audit SEC-3): the real auth routes against a fake GitHub
 * running locally, so no network and no real accounts are needed. Checks that
 * `state` and PKCE actually protect the flow:
 *   - a callback without this browser's cookie is refused (login CSRF);
 *   - a wrong `state`, or a tampered cookie, is refused;
 *   - the genuine flow signs in, and the token request carries the PKCE
 *     verifier that matches the challenge sent at the start;
 *   - the state cookie is single-use.
 *
 * Run: npm test.
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "development";
process.env.LOG_LEVEL = "error";
process.env.GITHUB_CLIENT_ID = "test-client";
process.env.GITHUB_CLIENT_SECRET = "test-secret";
process.env.MICROSOFT_CLIENT_ID = "";
process.env.DATABASE_URL = "";
const DATA_FILE = path.join(os.tmpdir(), `lamports-oauth-${process.pid}.json`);
process.env.DATA_FILE = DATA_FILE;

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { createRepository } = await import("../db/index.js");
const { createAuthRouter } = await import("../auth/routes.js");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

// ------------------------------------------------------------- fake GitHub
let tokenCalls = 0;
let lastChallenge = "";
let verifierMatched = false;
const gh = express();
gh.use(express.urlencoded({ extended: false }));
gh.post("/token", (req, res) => {
  tokenCalls++;
  const verifier = String(req.body.code_verifier ?? "");
  verifierMatched = !!verifier && createHash("sha256").update(verifier).digest("base64url") === lastChallenge;
  if (req.body.code !== "good-code" || !verifierMatched) return res.status(400).json({ error: "bad_verification_code" });
  res.json({ access_token: "gho_test", token_type: "bearer", scope: "user:email" });
});
gh.get("/user", (_req, res) => res.json({ id: 4242, login: "octo", name: "Octo Cat", avatar_url: "" }));
gh.get("/user/emails", (_req, res) => res.json([{ email: "octo@example.com", primary: true, verified: true }]));
const ghServer = gh.listen(0);
const GH = `http://localhost:${(ghServer.address() as AddressInfo).port}`;

// ------------------------------------------------------------- our routes
const repo = createRepository();
await repo.init();
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(
  createAuthRouter(repo, {
    githubEndpoints: {
      authorizationURL: `${GH}/authorize`,
      tokenURL: `${GH}/token`,
      userProfileURL: `${GH}/user`,
      userEmailURL: `${GH}/user/emails`,
    },
  }),
);
const appServer = app.listen(0);
const BASE = `http://localhost:${(appServer.address() as AddressInfo).port}`;

const cookieFrom = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`));
const callback = (query: string, cookie?: string) =>
  fetch(`${BASE}/auth/github/callback?${query}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

console.log("\noauth state + PKCE\n");

// Start a sign-in, as the browser does when you click "Continue with GitHub".
const start = await fetch(`${BASE}/auth/github`, { redirect: "manual" });
const to = new URL(start.headers.get("location") ?? "http://x/");
const state = to.searchParams.get("state") ?? "";
lastChallenge = to.searchParams.get("code_challenge") ?? "";
const stateCookie = cookieFrom(start, "vo_oauth") ?? "";
check("the provider gets a random state", state.length >= 32, state);
check("…and a PKCE S256 challenge", to.searchParams.get("code_challenge_method") === "S256" && lastChallenge.length >= 43);
check("…and this browser gets an httpOnly state cookie", !!stateCookie && /HttpOnly/i.test(start.headers.getSetCookie().join(";")));

// Attacks: none of these may reach the token exchange or sign anyone in.
const noCookie = await callback(`code=good-code&state=${state}`);
check("a callback without this browser's cookie is refused (login CSRF)", noCookie.headers.get("location") === "/?error=auth" && !cookieFrom(noCookie, "vo_session"));
const wrongState = await callback(`code=good-code&state=not-the-state`, stateCookie);
check("a wrong state is refused", wrongState.headers.get("location") === "/?error=auth");
const tampered = stateCookie.slice(0, -2) + (stateCookie.endsWith("A") ? "BB" : "AA");
check("a tampered state cookie is refused", (await callback(`code=good-code&state=${state}`, tampered)).headers.get("location") === "/?error=auth");
check("none of them reached the token exchange", tokenCalls === 0, `${tokenCalls} calls`);

// The genuine flow.
const ok = await callback(`code=good-code&state=${state}`, stateCookie);
const session = cookieFrom(ok, "vo_session");
check("the genuine callback signs in", ok.headers.get("location") === "/" && !!session, `${ok.status} ${ok.headers.get("location")}`);
check("the token request carried the matching PKCE verifier", tokenCalls === 1 && verifierMatched);
check("the state cookie is cleared after use", ok.headers.getSetCookie().some((c) => c.startsWith("vo_oauth=;")));
const me = (await fetch(`${BASE}/api/me`, { headers: { cookie: session ?? "" } }).then((r) => r.json())) as { email?: string };
check("…as the GitHub account", me.email === "octo@example.com", JSON.stringify(me));

appServer.close();
ghServer.close();
await repo.close();
rmSync(DATA_FILE, { force: true });
rmSync(DATA_FILE + ".tmp", { force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
