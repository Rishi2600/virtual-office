/**
 * Postgres repository test, against a real database. It DROPS the tables it
 * creates, so it only ever runs against TEST_DATABASE_URL (never
 * DATABASE_URL), and refuses any database whose name doesn't contain "test".
 *
 * Locally: `npm run db:up` (docker-compose.dev.yml creates virtual_office_test),
 * put TEST_DATABASE_URL in .env (see .env.example), then `npm run test:postgres`.
 * CI runs it against a Postgres service container.
 */
import pg from "pg";
import { PgRepository } from "../db/pgRepository.js";
import { MIGRATIONS } from "../db/migrations.js";

// Read after the imports above, which load .env (via env.ts).
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is required: a throwaway database (this test drops its tables). See .env.example.");
  process.exit(1);
}
const dbName = new URL(url).pathname.slice(1);
if (!dbName.includes("test")) {
  console.error(`Refusing to run: database "${dbName}" doesn't look like a test database (its name must contain "test").`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

const admin = new pg.Client({ connectionString: url });
await admin.connect();
const q = async <T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await admin.query<T>(sql, params)).rows;

async function wipe(): Promise<void> {
  await admin.query(`
    DROP TABLE IF EXISTS user_positions, users, spaces, schema_migrations CASCADE;
    DROP EXTENSION IF EXISTS pgcrypto;`);
}
const versions = async () => (await q<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).map((r) => r.version);
const latest = Math.max(...MIGRATIONS.map((m) => m.version));

console.log("\npostgres repository\n");

// -- 1. fresh database --------------------------------------------------------
await wipe();
let repo = new PgRepository(url);
await repo.init();
check("a fresh database is migrated to the latest version", (await versions()).at(-1) === latest, `${await versions()}`);
const tables = (await q<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`)).map((r) => r.t);
check("users, spaces and schema_migrations exist", ["users", "spaces", "schema_migrations"].every((t) => tables.includes(t)), tables.join(","));
check("no pgcrypto extension is needed", (await q(`SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'`)).length === 0);
const user = await repo.upsertUser({ email: "Ada@Example.com", name: "Ada" });
check("users get a generated UUID (gen_random_uuid, built in)", /^[0-9a-f-]{36}$/.test(user.id), user.id);
check("upsert + get round-trip", (await repo.getUser(user.id))?.email === "ada@example.com");
check("a new user has no avatar yet", (await repo.getUser(user.id))?.avatar === "");
await repo.setAvatar(user.id, "1.2.3.4.1.0");
check("setAvatar round-trips (migration 2)", (await repo.getUser(user.id))?.avatar === "1.2.3.4.1.0");
check("no saved spot yet", (await repo.getSpot(user.id, "office")) === null);
const other = await repo.upsertUser({ email: "grace@example.com", name: "Grace" });
await repo.saveSpots("office", [{ userId: user.id, x: 464.5, y: 688.25 }, { userId: other.id, x: 100, y: 200 }]);
const spot = await repo.getSpot(user.id, "office");
check("spots save in a batch and read back exactly (migration 3)", spot?.x === 464.5 && spot?.y === 688.25, JSON.stringify(spot));
await repo.saveSpots("office", [{ userId: user.id, x: 10, y: 20 }]);
check("saving again overwrites: one row per person, no history", (await q(`SELECT 1 FROM user_positions WHERE user_id = '${user.id}'`)).length === 1 && (await repo.getSpot(user.id, "office"))?.x === 10);
check("spots are per space", (await repo.getSpot(user.id, "elsewhere")) === null);

// Identity rules (Repository.upsertUser, audit SEC-4): the GitHub id is the anchor.
const gh1 = await repo.upsertUser({ provider: "github", providerId: "g1", email: "kim@example.com", name: "Kim" });
const gh1Again = await repo.upsertUser({ provider: "github", providerId: "g1", email: "kim.new@example.com", name: "Kim" });
check("a GitHub account keeps its user when its email changes", gh1Again.id === gh1.id && gh1Again.email === "kim.new@example.com");
const conflict = await repo
  .upsertUser({ provider: "github", providerId: "g2", email: "kim.new@example.com", name: "Eve" })
  .then(() => "accepted", (e: Error) => e.name);
check("another GitHub account with that email is refused, not merged", conflict === "IdentityConflictError", conflict);
await q(`INSERT INTO users (provider, provider_id, email, name) VALUES ('microsoft', 'm1', 'lee@example.com', 'Lee')`);
const legacy = (await q<{ id: string }>(`SELECT id FROM users WHERE email = 'lee@example.com'`))[0]!.id;
const adopted = await repo.upsertUser({ provider: "github", providerId: "g3", email: "lee@example.com", name: "Lee" });
check("a legacy account from a removed provider is adopted by its verified email", adopted.id === legacy && adopted.provider === "github");
const stolen = await repo
  .upsertUser({ provider: "github", providerId: "g3", email: "kim.new@example.com", name: "Lee" })
  .then(() => "accepted", (e: Error) => e.name);
check("an email change onto someone else's address is refused", stolen === "IdentityConflictError", stolen);
check("default space is seeded", (await repo.listSpaces()).some((s) => s.slug === "office"));
await repo.ping();
check("ping() answers", true);
await repo.close();

// -- 2. second start is a no-op -----------------------------------------------
repo = new PgRepository(url);
await repo.init();
check("starting again applies nothing twice", JSON.stringify(await versions()) === JSON.stringify(MIGRATIONS.map((m) => m.version)));
check("existing data is untouched", (await repo.getUser(user.id))?.name === "Ada");
await repo.close();

// -- 3. upgrading a database made by the old create-on-boot code --------------
await wipe();
await admin.query(`
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider TEXT NOT NULL DEFAULT 'dev', provider_id TEXT,
    email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX users_provider_identity ON users (provider, provider_id) WHERE provider_id IS NOT NULL;
  CREATE TABLE spaces (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, map_key TEXT NOT NULL);
  INSERT INTO users (email, name) VALUES ('legacy@example.com', 'Legacy');`);
repo = new PgRepository(url);
await repo.init();
check("a pre-migrations database is adopted without errors", (await versions()).at(-1) === latest);
check("…and keeps its existing users", (await q(`SELECT 1 FROM users WHERE email = 'legacy@example.com'`)).length === 1);
await repo.close();

// -- 4. two processes starting at once ----------------------------------------
await wipe();
const a = new PgRepository(url);
const b = new PgRepository(url);
const results = await Promise.allSettled([a.init(), b.init()]);
check("two concurrent startups both succeed (advisory lock)", results.every((r) => r.status === "fulfilled"), JSON.stringify(results.map((r) => r.status)));
check("…and each migration is recorded once", JSON.stringify(await versions()) === JSON.stringify(MIGRATIONS.map((m) => m.version)));
await a.close();
await b.close();

// -- 5. database from a newer build -------------------------------------------
await admin.query(`INSERT INTO schema_migrations (version, name) VALUES (9999, 'from the future')`);
repo = new PgRepository(url);
let refused = "";
try {
  await repo.init();
} catch (err) {
  refused = (err as Error).message;
}
check("a database migrated by a newer build is refused", refused.includes("9999"), refused || "init succeeded");
await repo.close();
await admin.query(`DELETE FROM schema_migrations WHERE version = 9999`);

// -- 6. an idle connection dying must not crash the process -------------------
// Without the pool 'error' listener, the terminated idle connection emits an
// unhandled 'error' event and this very process exits.
const appName = "vo-test-victim";
repo = new PgRepository(`${url}${url.includes("?") ? "&" : "?"}application_name=${appName}`);
await repo.init();
await repo.ping(); // leaves an idle client in the pool
const killed = await q(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()`,
  [appName],
);
await new Promise((r) => setTimeout(r, 500));
check("killed an idle pooled connection", killed.length > 0, `${killed.length} terminated`);
check("the process survived it", true);
let recovered = true;
try {
  await repo.ping();
} catch {
  recovered = false;
}
check("the pool reconnects on next use", recovered);
await repo.close();

await wipe();
await admin.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
