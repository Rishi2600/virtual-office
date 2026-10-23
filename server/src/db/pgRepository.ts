import pg from "pg";
import {
  DEFAULT_SPACES,
  type Repository,
  type SpaceRecord,
  type UpsertUserInput,
  type UserRecord,
} from "./types.js";

const SCHEMA = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
  `CREATE TABLE IF NOT EXISTS users (
     id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     provider     TEXT NOT NULL DEFAULT 'dev',
     provider_id  TEXT,
     email        TEXT NOT NULL UNIQUE,
     name         TEXT NOT NULL DEFAULT '',
     picture      TEXT NOT NULL DEFAULT '',
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_provider_identity
     ON users (provider, provider_id) WHERE provider_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS spaces (
     id      TEXT PRIMARY KEY,
     slug    TEXT NOT NULL UNIQUE,
     name    TEXT NOT NULL,
     map_key TEXT NOT NULL
   )`,
];

interface Row {
  id: string;
  provider: string;
  provider_id: string | null;
  email: string;
  name: string;
  picture: string;
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
  createdAt: r.created_at.toISOString(),
  lastSeenAt: r.last_seen_at.toISOString(),
});

export class PgRepository implements Repository {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    for (const stmt of SCHEMA) await this.pool.query(stmt);
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
