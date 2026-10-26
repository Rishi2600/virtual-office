/**
 * Postgres schema migrations, applied in order on startup by PgRepository.
 *
 * Rules:
 *  - Never edit a migration that has shipped; add a new one with the next
 *    version number. The database records which versions it has applied
 *    (table `schema_migrations`), so an edited migration would never re-run.
 *  - Each migration runs in its own transaction: it applies completely or not
 *    at all.
 *  - Written as TypeScript strings (not .sql files) so `tsc` carries them into
 *    dist/ and the Docker image with no extra copy step.
 *
 * Requires Postgres 13+ (gen_random_uuid() is built in from 13).
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    // IF NOT EXISTS throughout: databases created before migrations existed
    // (the old create-on-boot code) already have these tables, and this
    // migration must adopt them rather than fail.
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider     TEXT NOT NULL DEFAULT 'dev',
        provider_id  TEXT,
        email        TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL DEFAULT '',
        picture      TEXT NOT NULL DEFAULT '',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_provider_identity
        ON users (provider, provider_id) WHERE provider_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS spaces (
        id      TEXT PRIMARY KEY,
        slug    TEXT NOT NULL UNIQUE,
        name    TEXT NOT NULL,
        map_key TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "users.avatar",
    // A constant default makes this a metadata-only change (no table rewrite).
    // "" means "not built yet": the app then derives a default from the id.
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 3,
    name: "user_positions",
    // Each person's latest spot per space, so a server restart puts everyone
    // back where they were. One row per person and space, overwritten: no
    // history (owner decision, docs/persistent-spot-plan.md). A table of its
    // own so the frequent saves don't rewrite users rows.
    sql: `
      CREATE TABLE IF NOT EXISTS user_positions (
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        space      TEXT NOT NULL,
        x          DOUBLE PRECISION NOT NULL,
        y          DOUBLE PRECISION NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, space)
      );
    `,
  },
  {
    version: 4,
    name: "sessions and blocked users",
    // Server-side sessions (audit SEC-5): the cookie holds a random key, and
    // this table holds its SHA-256, so signing out or removing someone takes
    // effect at once. blocked_at: removed people can't sign in again.
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
    `,
  },
];
