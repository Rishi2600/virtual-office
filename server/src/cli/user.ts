/**
 * Admin command for people's access (audit SEC-5; owner decision: be able to
 * remove someone instantly).
 *
 *   npm run user -- block <email>      remove: can't sign in, every session ends,
 *                                      disconnected from the office within ~15 s
 *   npm run user -- unblock <email>    let them back in
 *   npm run user -- signout <email>    end all their sessions (they can sign in again)
 *
 * Uses the same store as the server (DATABASE_URL, else the JSON file). In
 * production (Docker): docker compose exec app node server/dist/cli/user.js block <email>
 *
 * With the JSON file store, stop the server first: it keeps the file in memory
 * and would overwrite the change. Postgres has no such issue.
 */
import { createRepository } from "../db/index.js";
import { blockUser, setSessionStore, signOutEverywhere, unblockUser } from "../auth/sessions.js";

const [command, email] = process.argv.slice(2);
const usage = "usage: npm run user -- <block|unblock|signout> <email>";

if (!command || !email || !["block", "unblock", "signout"].includes(command)) {
  console.error(usage);
  process.exit(2);
}

const repo = createRepository();
await repo.init();
setSessionStore(repo);
let ok: boolean;
try {
  if (command === "block") {
    const r = await blockUser(email);
    if (r) console.log(`Removed ${r.user.name} <${r.user.email}>: can't sign in, ${r.sessions} session(s) ended.`);
    ok = !!r;
  } else if (command === "unblock") {
    const u = await unblockUser(email);
    if (u) console.log(`${u.name} <${u.email}> can sign in again.`);
    ok = !!u;
  } else {
    const r = await signOutEverywhere(email);
    if (r) console.log(`Signed ${r.user.name} <${r.user.email}> out everywhere: ${r.sessions} session(s) ended.`);
    ok = !!r;
  }
  if (!ok) console.error(`No user with the email ${email}.`);
} finally {
  await repo.close();
}
process.exit(ok ? 0 : 1);
