import pg from "pg";
import { log } from "../log.js";
import { MIGRATIONS, type Migration } from "./migrations.js";
import {
  DEFAULT_SPACES,
  type Repository,
  type SpaceRecord,
  type UpsertUserInput,
  type UserRecord,
} from "./types.js";

/** Arbitrary but fixed key for pg_advisory_lock: one migrator at a time, even
 *  across processes starting together. */
const MIGRATION_LOCK_KEY = 7_436_201;

/** Fail fast instead of waiting forever for a connection when the database is
 *  down, so /ready reports it within the healthcheck's timeout. */
const CONNECTION_TIMEOUT_MS = 3_000;

interface Row {
  id: string;
  provider: string;
  provider_id: string | null;
  email: string;
  name: string;
  picture: string;
  avatar: string;
  created_at: Date;
  last_seen_at: Date;
}

const toUser = (r: Row): UserRecord => ({
  id: r.id,
  provider: r.provider,
  providerId: r.provider_id,
  email: r.email,
  name: r.name,
  picture: r.picture,
  avatar: r.avatar,
  createdAt: r.created_at.toISOString(),
  lastSeenAt: r.last_seen_at.toISOString(),
});

export class PgRepository implements Repository {
  private pool: pg.Pool;
  /** host:port/database, for error messages. Never includes the password. */
  private readonly target: string;

  constructor(
    connectionString: string,
    private readonly migrations: Migration[] = MIGRATIONS,
  ) {
    this.target = describeTarget(connectionString);
    this.pool = new pg.Pool({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
    // An idle pooled connection can die at any time (database restart, network
    // blip, idle timeout on a proxy). pg reports that as an 'error' event on the
    // pool, and an 'error' event with no listener crashes the whole process.
    // The pool already drops the dead client and opens a new one on next use,
    // so logging is all that's needed.
    this.pool.on("error", (err) => {
      log.error({ err: err.message }, "postgres: idle connection lost (it will be replaced)");
    });
  }

  async init(): Promise<void> {
    await this.migrate();
    for (const s of DEFAULT_SPACES) {
      await this.pool.query(
        `INSERT INTO spaces (id, slug, name, map_key) VALUES ($1,$2,$3,$4)
         ON CONFLICT (slug) DO NOTHING`,
        [s.id, s.slug, s.name, s.mapKey],
      );
    }
  }

  async upsertUser(input: UpsertUserInput): Promise<UserRecord> {
    // Email is the identity anchor: one person signing in via Microsoft and via
    // GitHub on the same address resolves to a single account.
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO users (provider, provider_id, email, name, picture)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE
         SET name         = EXCLUDED.name,
             picture      = EXCLUDED.picture,
             provider     = EXCLUDED.provider,
             provider_id  = COALESCE(EXCLUDED.provider_id, users.provider_id),
             last_seen_at = now()
       RETURNING *`,
      [
        input.provider ?? "dev",
        input.providerId ?? null,
        input.email.toLowerCase(),
        input.name,
        input.picture ?? "",
      ],
    );
    return toUser(rows[0]!);
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async touchUser(id: string): Promise<void> {
    await this.pool.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [id]);
  }

  async setAvatar(id: string, look: string): Promise<void> {
    await this.pool.query(`UPDATE users SET avatar = $2 WHERE id = $1`, [id, look]);
  }

  async listSpaces(): Promise<SpaceRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT id, slug, name, map_key FROM spaces ORDER BY name`,
    );
    return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, mapKey: r.map_key }));
  }

  async getSpaceBySlug(slug: string): Promise<SpaceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT id, slug, name, map_key FROM spaces WHERE slug = $1`,
      [slug],
    );
    const r = rows[0];
    return r ? { id: r.id, slug: r.slug, name: r.name, mapKey: r.map_key } : null;
  }

  /** Applies every migration the database hasn't recorded yet, in order. */
  private async migrate(): Promise<void> {
    const client = await this.pool.connect().catch((err: Error) => {
      throw new Error(
        `can't reach Postgres at ${this.target} (${err.message}). For local development, start it with: npm run db:up`,
        { cause: err },
      );
    });
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ version: number }>("SELECT version FROM schema_migrations");
      const applied = new Set(rows.map((r) => r.version));

      // A database migrated by a newer build would be silently misread by this one.
      const known = new Set(this.migrations.map((m) => m.version));
      const unknown = [...applied].filter((v) => !known.has(v));
      if (unknown.length) {
        throw new Error(
          `database has schema migrations this build doesn't know (${unknown.join(", ")}); deploy the newer build`,
        );
      }

      for (const m of [...this.migrations].sort((a, b) => a.version - b.version)) {
        if (applied.has(m.version)) continue;
        await client.query("BEGIN");
        try {
          await client.query(m.sql);
          await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`, { cause: err });
        }
        log.info({ version: m.version, migration: m.name }, "postgres: migration applied");
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function describeTarget(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "the configured database";
  }
}
