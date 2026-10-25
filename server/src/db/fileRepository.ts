import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_SPACES,
  type Repository,
  type SpaceRecord,
  type SpotRecord,
  type UpsertUserInput,
  type UserRecord,
} from "./types.js";

interface FileShape {
  users: UserRecord[];
  spaces: SpaceRecord[];
  /** Latest spot per user and space (see Repository.saveSpots). */
  positions: Array<SpotRecord & { space: string; updatedAt: string }>;
}

/**
 * Zero-dependency dev persistence. Chosen so `npm run dev` works on a clean
 * machine with no Postgres and no Docker, which is the MVP requirement that the
 * whole thing runs in a couple of commands. Set DATABASE_URL to switch to
 * PgRepository; nothing else in the app changes.
 *
 * Writes are serialised through a promise chain and land via temp-file + rename
 * so an interrupted write cannot truncate the store.
 */
export class FileRepository implements Repository {
  private data: FileShape = { users: [], spaces: [...DEFAULT_SPACES], positions: [] };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<FileShape>;
      this.data = {
        // Files written before avatars existed have no `avatar` field.
        users: (parsed.users ?? []).map((u) => ({ ...u, avatar: u.avatar ?? "" })),
        spaces: parsed.spaces?.length ? parsed.spaces : [...DEFAULT_SPACES],
        positions: parsed.positions ?? [],
      };
    } catch {
      await this.flush(); // first run: create the file
    }
  }

  private flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      const tmp = this.file + ".tmp";
      await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
      await rename(tmp, this.file);
    });
    return this.queue as Promise<void>;
  }

  async upsertUser(input: UpsertUserInput): Promise<UserRecord> {
    const now = new Date().toISOString();
    const email = input.email.toLowerCase();
    const provider = input.provider ?? "dev";
    // Email is the identity anchor, so the same person arriving via Microsoft
    // and via GitHub on one address is one account, not two.
    let user = this.data.users.find(
      (u) =>
        u.email === email ||
        (!!input.providerId && u.provider === provider && u.providerId === input.providerId),
    );

    if (user) {
      user.name = input.name || user.name;
      user.picture = input.picture ?? user.picture;
      user.provider = provider;
      if (input.providerId) user.providerId = input.providerId;
      user.lastSeenAt = now;
    } else {
      // Dev users get a deterministic id derived from their email so that
      // signing in as "Alice" twice is the same person across restarts.
      const devId = "dev-" + createHash("sha1").update(email).digest("hex").slice(0, 12);
      user = {
        id: input.providerId ? randomUUID() : devId,
        provider,
        providerId: input.providerId ?? null,
        email,
        name: input.name,
        picture: input.picture ?? "",
        avatar: "",
        createdAt: now,
        lastSeenAt: now,
      };
      this.data.users.push(user);
    }

    await this.flush();
    return { ...user };
  }

  async getUser(id: string): Promise<UserRecord | null> {
    return this.data.users.find((u) => u.id === id) ?? null;
  }

  async touchUser(id: string): Promise<void> {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return;
    u.lastSeenAt = new Date().toISOString();
    await this.flush();
  }

  async setAvatar(id: string, look: string): Promise<void> {
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return;
    u.avatar = look;
    await this.flush();
  }

  async getSpot(userId: string, space: string): Promise<{ x: number; y: number } | null> {
    const p = this.data.positions.find((s) => s.userId === userId && s.space === space);
    return p ? { x: p.x, y: p.y } : null;
  }

  async saveSpots(space: string, spots: SpotRecord[]): Promise<void> {
    if (spots.length === 0) return;
    const updatedAt = new Date().toISOString();
    for (const spot of spots) {
      const row = { userId: spot.userId, space, x: spot.x, y: spot.y, updatedAt };
      const i = this.data.positions.findIndex((s) => s.userId === spot.userId && s.space === space);
      if (i >= 0) this.data.positions[i] = row;
      else this.data.positions.push(row);
    }
    await this.flush();
  }

  async listSpaces(): Promise<SpaceRecord[]> {
    return [...this.data.spaces];
  }

  async getSpaceBySlug(slug: string): Promise<SpaceRecord | null> {
    return this.data.spaces.find((s) => s.slug === slug) ?? null;
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
