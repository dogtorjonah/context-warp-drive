/// <reference path="../types/better-sqlite3.d.ts" />
/**
 * Reference SQLite episode store for context-warp.
 *
 * A one-call factory that opens a local SQLite database (via the OPTIONAL
 * `better-sqlite3` peer dependency) and creates the episodic spine schema —
 * `sessions`, `episodes`, `episode_members` — that `episodeStore.ts`'s
 * `recordEpisodes` / `recallEpisodeCards` operate on.
 *
 * This is a single-agent reference implementation. The relay's production store
 * (`relay/src/workerPool/handlers/foldEpisodes.ts`) additionally layers
 * multi-agent lineage scoping, silo quarantine, workspace-root scoping, jaccard
 * chapter coalescing, and chainScore ranking — documented as the production
 * extension. For a single agent, recency-ordered path-keyed recall is enough.
 *
 * `better-sqlite3` is the only piece of the episodic layer that needs a native
 * module; the derivation + recall logic in `episodeStore.ts` is dependency-free,
 * so you can also implement `EpisodeDatabase` against any other SQLite binding.
 */
import type { EpisodeDatabase } from './episodeStore.ts';

/**
 * Episodic spine DDL — the migration-1 tables the portable store reads/writes.
 * Generic (no engine-specific columns): a session groups episodes; an episode
 * carries its register/trust/summary/trace; episode_members link an episode to
 * the file paths it touched/mentioned (the recall trigger keys).
 */
export const EPISODE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cwd TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    register TEXT,
    trust TEXT NOT NULL,
    summary TEXT NOT NULL,
    trace_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS episode_members (
    episode_id TEXT NOT NULL,
    path TEXT NOT NULL,
    role TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (episode_id, path, role),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_episode_members_path ON episode_members(path);
  CREATE INDEX IF NOT EXISTS idx_episodes_ended_at ON episodes(ended_at);
`;

export interface CreateEpisodeStoreOptions {
  /** SQLite file path. Defaults to an in-memory database (':memory:'). */
  readonly path?: string;
  /** Enable WAL journal mode for file-backed databases (default true). */
  readonly wal?: boolean;
}

/**
 * Open (or create) a SQLite-backed episode store and ensure the schema exists.
 * Returns a handle compatible with `recordEpisodes` / `recallEpisodeCards`.
 *
 * `better-sqlite3` is imported LAZILY here so that merely importing context-warp
 * (even the root barrel) never requires the native module — only calling this
 * factory does. Async for the same reason.
 */
export async function createEpisodeStore(
  options: CreateEpisodeStoreOptions = {},
): Promise<EpisodeDatabase> {
  const { default: Database } = await import('better-sqlite3');
  const path = options.path ?? ':memory:';
  const db = new Database(path);
  if (path !== ':memory:' && options.wal !== false) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.exec(EPISODE_SCHEMA);
  return db as unknown as EpisodeDatabase;
}

/** Close an episode store opened by {@link createEpisodeStore}. */
export function closeEpisodeStore(db: EpisodeDatabase): void {
  (db as unknown as { close(): void }).close();
}
