#!/usr/bin/env node
/**
 * Dependency audit for CI (audit SEC-13): fails on any high or critical
 * advisory, except the ones listed in ACCEPTED below, each with the reason it
 * can't affect this app. Moderate and low advisories are reported, not fatal.
 *
 * Run: npm run audit
 *
 * To accept an advisory: add its GHSA id with a reason someone can check,
 * and remove it as soon as a fix can be taken.
 */
import { execFileSync } from "node:child_process";

const ACCEPTED = {
  // All three are in nanoid 2 inside @colyseus/core 0.16, which we can't
  // leave: Colyseus is pinned to 0.16 to match the colyseus.js 0.16 browser
  // client (project invariant; 0.18's schema v5 breaks it). Colyseus only calls
  // nanoid's default secure generator with a fixed size of 9
  // (@colyseus/core/build/utils/Utils.js generateId), so none of these apply:
  "GHSA-28wg-ghj8-5hjv": "non-secure generator with a negative size: Colyseus uses the secure one, size 9",
  "GHSA-2v37-7h3g-55p8": "custom generator with size 0: Colyseus uses the default generator, size 9",
  "GHSA-xwg4-73v4-xw9w": "integer overflow of an attacker-chosen size: the size is always 9",
};

let report;
try {
  report = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (err) {
  // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
  report = err.stdout;
}
const { vulnerabilities = {} } = JSON.parse(report);

const advisories = new Map();
for (const [pkg, v] of Object.entries(vulnerabilities)) {
  for (const via of v.via) {
    if (typeof via !== "object") continue;
    const id = via.url?.split("/").pop() ?? via.title;
    advisories.set(id, { pkg, severity: via.severity, title: via.title, range: via.range });
  }
}

let failing = 0;
for (const [id, a] of advisories) {
  const serious = a.severity === "high" || a.severity === "critical";
  const accepted = ACCEPTED[id];
  const tag = accepted ? "accepted" : serious ? "FAIL" : "note";
  if (tag === "FAIL") failing++;
  console.log(`${tag.padEnd(8)} ${a.severity.padEnd(8)} ${a.pkg} ${a.range}  ${id}  ${a.title}`);
  if (accepted) console.log(`         why accepted: ${accepted}`);
}
for (const id of Object.keys(ACCEPTED)) {
  if (!advisories.has(id)) console.log(`stale    ${id} is accepted but no longer reported: remove it from scripts/audit.mjs`);
}
console.log(failing ? `\n${failing} high/critical advisory(ies) to fix.` : "\nNo unaccepted high or critical advisories.");
process.exit(failing ? 1 : 0);
