import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";
import { log } from "../log.js";
import { FileRepository } from "./fileRepository.js";
import { PgRepository } from "./pgRepository.js";
import type { Repository } from "./types.js";

export * from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Postgres when DATABASE_URL is set, otherwise a local JSON file so a fresh
 * clone runs with no infrastructure at all. Identical interface either way, so
 * nothing downstream knows or cares which one is active.
 */
export function createRepository(): Repository {
  if (env.databaseUrl) {
    log.info({ backend: "postgres" }, "persistence backend selected");
    return new PgRepository(env.databaseUrl);
  }
  const file = env.dataFile || path.join(repoRoot, ".data", "dev.json");
  log.warn({ backend: "file", file }, "no DATABASE_URL set - using local JSON store (dev only)");
  return new FileRepository(file);
}
