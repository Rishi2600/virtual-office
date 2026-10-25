export interface UserRecord {
  id: string;
  /** Which provider this account most recently signed in with: "microsoft",
   *  "github", or "dev". Email remains the identity anchor — see upsertUser. */
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
export interface Repository {
  init(): Promise<void>;
  upsertUser(input: UpsertUserInput): Promise<UserRecord>;
  getUser(id: string): Promise<UserRecord | null>;
  touchUser(id: string): Promise<void>;
  /** Saves a look the caller has already validated with parseLook. */
  setAvatar(id: string, look: string): Promise<void>;
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
