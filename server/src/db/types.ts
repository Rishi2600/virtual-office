export interface UserRecord {
  id: string;
  /** How this account signs in: "github", or "dev" (local only). Older rows
   *  may say "microsoft", which is no longer offered. */
  provider: string;
  /** The provider's own id for this account, if any. */
  providerId: string | null;
  email: string;
  name: string;
  picture: string;
  /** Avatar look the person built ("1.1.1.0.0.2", shared/src/avatar.ts), or
   *  "" if they haven't yet (they then get a default derived from their id). */
  avatar: string;
  createdAt: string;
  lastSeenAt: string;
  /** Removed from the office (npm run user -- block): can't sign in, and any
   *  session they had is gone. */
  blocked: boolean;
}

/** A signed-in browser. `id` is the SHA-256 of the cookie's random key: the
 *  key itself is never stored, so a database leak doesn't hand out sessions. */
export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: number;
}

export interface SpaceRecord {
  id: string;
  slug: string;
  name: string;
  mapKey: string;
}

/** Where someone last stood in a space (only the latest spot is kept, no history). */
export interface SpotRecord {
  userId: string;
  x: number;
  y: number;
}

export interface UpsertUserInput {
  provider?: string;
  providerId?: string | null;
  email: string;
  name: string;
  picture?: string;
}

/** The only persistence surface the app uses. Two implementations back it:
 *  PgRepository (production) and FileRepository (zero-setup local dev). */
/** A sign-in that would take over, or collide with, another account. */
export class IdentityConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdentityConflictError";
  }
}

export interface Repository {
  init(): Promise<void>;
  /**
   * Finds or creates the account for a sign-in, and refreshes its profile.
   *
   * With a provider id (GitHub): the account is the one with that
   * (provider, providerId); its email follows the provider's verified email.
   * If there's none yet, an existing account with the same (verified) email
   * is adopted only if no other identity of this provider owns it, i.e. a
   * legacy row without a provider id or from a provider that's gone.
   * Anything else throws IdentityConflictError: an email must never be a way
   * into someone else's account (audit SEC-4).
   *
   * Without a provider id (dev sign-in): matched by email.
   */
  upsertUser(input: UpsertUserInput): Promise<UserRecord>;
  getUser(id: string): Promise<UserRecord | null>;
  touchUser(id: string): Promise<void>;
  /** Saves a look the caller has already validated with parseLook. */
  setAvatar(id: string, look: string): Promise<void>;
  /** Finds a user by email (for the admin command). */
  findUserByEmail(email: string): Promise<UserRecord | null>;
  setBlocked(userId: string, blocked: boolean): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Moves a session's expiry (each visit renews it). */
  extendSession(id: string, expiresAt: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** Ends every session of a user; returns how many there were. */
  deleteUserSessions(userId: string): Promise<number>;
  /** Of these session ids, the ones that still exist, haven't expired and
   *  belong to a user who isn't blocked. */
  liveSessions(ids: string[]): Promise<Set<string>>;

  /** The last saved spot of a user in a space, or null if none. */
  getSpot(userId: string, space: string): Promise<{ x: number; y: number } | null>;
  /** Saves (overwrites) the latest spot of each given user in a space, in one go. */
  saveSpots(space: string, spots: SpotRecord[]): Promise<void>;
  listSpaces(): Promise<SpaceRecord[]>;
  getSpaceBySlug(slug: string): Promise<SpaceRecord | null>;
  /** Readiness probe: rejects if the store can't be reached. Optional because
   *  the local JSON file has nothing to reach. */
  ping?(): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_SPACES: SpaceRecord[] = [
  { id: "space-office", slug: "office", name: "The Office", mapKey: "office" },
];
