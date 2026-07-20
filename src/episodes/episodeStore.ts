import { createHash } from 'node:crypto';

import { parseRegisterGlyph } from '../glyphs.ts';
import type {
  AssistantRegister,
  AssistantRegisterClassification,
} from '../glyphs.ts';

/**
 * Minimal structural handle for the episodic store — the subset of a
 * better-sqlite3 `Database` that record/recall actually use. Defined here (not
 * imported from better-sqlite3) so the pure derivation + recall logic carries
 * ZERO hard dependency on the native module; only the reference store factory
 * (`createEpisodeStore` in ./sqliteStore.ts) needs better-sqlite3, which is an
 * optional peer dependency. Any handle exposing these methods works — a real
 * better-sqlite3 Database, a wrapper, or a test double.
 */
export interface EpisodeStatement {
  run(...params: unknown[]): { readonly changes?: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
export interface EpisodeDatabase {
  prepare(sql: string): EpisodeStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

export type EpisodeClosedBy = 'verdict' | 'hazard' | 'blocked' | 'window_end';

export interface PortableToolCall {
  readonly name?: string;
  readonly input?: unknown;
  readonly arguments?: unknown;
}

export interface PortableMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: unknown;
  readonly timestamp?: string;
  readonly toolCalls?: readonly PortableToolCall[];
  readonly tool_calls?: readonly PortableToolCall[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EpisodeAnnotation {
  readonly register: AssistantRegister;
  readonly classification: AssistantRegisterClassification;
  readonly body: string;
  readonly messageIndex: number;
}

export interface EpisodeMember {
  readonly path: string;
  readonly role: 'touched' | 'mentioned';
  readonly ordinal: number;
}

export interface PortableEpisode {
  readonly id: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly foldEpochId?: string;
  readonly rebirthEpochId?: string;
  /** ISO source time of the first contributing message, or UNKNOWN_EPISODE_TIME ('unknown') when none carried a timestamp. */
  readonly startedAt: string;
  /** ISO source time of the last contributing message, or UNKNOWN_EPISODE_TIME ('unknown') when none carried a timestamp. */
  readonly endedAt: string;
  readonly closedBy: EpisodeClosedBy;
  readonly register: AssistantRegister | null;
  readonly trust: AssistantRegisterClassification['trust'];
  readonly summary: string;
  readonly annotations: readonly EpisodeAnnotation[];
  readonly members: readonly EpisodeMember[];
  readonly trace: readonly string[];
  /**
   * Episode ids this episode explicitly retires — harvested from durable
   * (🏁/⚠️) annotation bodies carrying the `↺ episode-<id>` /
   * `supersedes episode-<id>` marker. Recorded into `episode_supersessions`
   * by `recordEpisodes`; superseded episodes stop surfacing in recall.
   */
  readonly supersedes?: readonly string[];
}

export interface DeriveEpisodesOptions {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly foldEpochId?: string;
  readonly rebirthEpochId?: string;
  /**
   * @deprecated Ignored. Missing message timestamps no longer fall back to
   * any clock — unknown source time stays unknown through the sealed episode.
   * Retained for API compatibility.
   */
  readonly now?: string;
  readonly closeOpenBurst?: boolean;
}

export interface TouchExtractionOptions {
  readonly includeBareFilenames?: boolean;
}

export interface RecordEpisodesResult {
  readonly inserted: number;
  readonly skipped: number;
}

export interface EpisodeRecallOptions {
  readonly paths: readonly string[];
  /** Optional rendered-card count. Candidate generation always examines every eligible episode. */
  readonly limit?: number;
  readonly maxChars?: number;
  readonly excludeEpisodeIds?: readonly string[];
}

export interface EpisodeRecallCard {
  readonly episodeId: string;
  readonly matchedPaths: readonly string[];
  readonly text: string;
}

export interface EpisodeRecallState {
  readonly servedEpisodeIds: readonly string[];
}

export interface EpisodeRecallStateResult {
  readonly state: EpisodeRecallState;
  readonly cards: readonly EpisodeRecallCard[];
}

/**
 * Verdict supersession — the grammar's retraction path. A 🏁 that later proves
 * wrong should not stay harvested as durable truth forever: a newer durable
 * message can retire it by carrying `↺ episode-<id>` (or the ASCII form
 * `supersedes episode-<id>`) in its body. Retired episodes are excluded from
 * `recallEpisodeCards`. Storage is an additive sidecar table
 * (`episode_supersessions`) so legacy stores open cleanly — no ALTER needed.
 */
export const SUPERSEDES_MARKER = '↺';

export interface EpisodeSupersession {
  /** Episode being retired. */
  readonly episodeId: string;
  /** Episode (or free-form id) that replaces it, when known. */
  readonly supersededBy?: string;
  readonly reason?: string;
  /**
   * ISO source time of the supersession event; persisted as source_at (NULL
   * when omitted — never the writer's clock). created_at is pure ingestion.
   */
  readonly at?: string;
}

interface MutableBurst {
  startedAt: string | undefined;
  endedAt: string | undefined;
  annotations: EpisodeAnnotation[];
  pathOrder: string[];
  pathRoles: Map<string, EpisodeMember['role']>;
  trace: string[];
}

/**
 * Explicit unknown-time marker for portable episode endpoints — the same
 * sentinel value the canonical fold-episodes engine uses. Sealed when no
 * contributing message carried a timestamp; the derivation clock is NEVER
 * substituted (chronological provenance).
 */
export const UNKNOWN_EPISODE_TIME = 'unknown';

const DEFAULT_SESSION_ID = 'default';
const SQLITE_BIND_BATCH_SIZE = 400;
const SUPERSEDES_REF_RE = /(?:↺|\bsupersedes\b)[:\s]+(episode-[0-9a-f]{8,64})/giu;
const SUPERSESSION_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS episode_supersessions (
    episode_id TEXT PRIMARY KEY,
    superseded_by TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    source_at TEXT
  )
`;
const PATH_LIKE_RE = /(?:^|[\s"'`(])((?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./:@+-]+\.[A-Za-z0-9]+(?::\d+)?)/gu;
const BARE_FILENAME_RE = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?=$|[\s"'`),.])/gu;
const TOOL_TOUCH_KEYS = new Set(['path', 'paths', 'file', 'files', 'file_path', 'filePath', 'cwd', 'workdir']);

export function deriveEpisodesFromMessages(
  messages: readonly PortableMessage[],
  options: DeriveEpisodesOptions = {},
): readonly PortableEpisode[] {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const episodes: PortableEpisode[] = [];
  let burst: MutableBurst | null = null;

  messages.forEach((message, index) => {
    // Missing or malformed provider time stays unknown; valid source text is
    // retained byte-for-byte rather than normalized through a writer clock.
    const timestamp = validSourceTimestamp(message.timestamp);
    const text = messageToText(message.content);
    const touches = extractMessageTouchedPaths(message);
    const parsed = message.role === 'assistant' ? parseRegisterGlyph(text) : null;

    if (touches.length > 0 || parsed?.ok) {
      burst ??= createBurst(timestamp);
      if (timestamp !== undefined) burst.endedAt = timestamp;
    }

    if (burst && touches.length > 0) {
      for (const path of touches) addPathToBurst(burst, path, message.role === 'tool' ? 'touched' : 'mentioned');
      burst.trace.push(`${message.role}:${index}:paths:${touches.join(',')}`);
    }

    if (burst && parsed?.ok) {
      burst.annotations.push({
        register: parsed.register,
        classification: parsed.classification,
        body: parsed.body.trim(),
        messageIndex: index,
      });
      burst.trace.push(`${message.role}:${index}:register:${parsed.register}`);

      if (parsed.classification.final) {
        const closedBy: EpisodeClosedBy =
          parsed.register === 'hazard' ? 'hazard' : parsed.register === 'blocked' ? 'blocked' : 'verdict';
        const episode = sealBurst(burst, sessionId, closedBy, options.runId, options.foldEpochId, options.rebirthEpochId);
        if (episode) episodes.push(episode);
        burst = null;
      }
    }
  });

  if (burst && options.closeOpenBurst) {
    const episode = sealBurst(burst, sessionId, 'window_end', options.runId, options.foldEpochId, options.rebirthEpochId);
    if (episode) episodes.push(episode);
  }

  return episodes;
}

export function extractTouchedPaths(input: unknown, options: TouchExtractionOptions = {}): readonly string[] {
  const found = new Set<string>();
  collectTouchedPaths(input, found, options);
  return [...found];
}

export function normalizeTouchPath(pathLike: string): string | null {
  const trimmed = pathLike.trim().replace(/^['"`]+|['"`.,)]+$/gu, '');
  const withoutLine = trimmed.replace(/:\d+(?::\d+)?$/u, '');
  if (!isEligibleTouchPath(withoutLine)) return null;
  return withoutLine;
}

export function isEligibleTouchPath(pathLike: string, options: TouchExtractionOptions = {}): boolean {
  if (pathLike.length < 3 || pathLike.length > 512) return false;
  if (/^https?:\/\//u.test(pathLike)) return false;
  if (/[\r\n\t]/u.test(pathLike)) return false;
  if (pathLike.includes('node_modules/')) return false;
  if (pathLike.startsWith('data:')) return false;
  if (pathLike.includes('/')) return /\.[A-Za-z0-9]{1,12}$/u.test(pathLike);
  return options.includeBareFilenames === true && /\.[A-Za-z0-9]{1,12}$/u.test(pathLike);
}

export function recordEpisodes(db: EpisodeDatabase, episodes: readonly PortableEpisode[]): RecordEpisodesResult {
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, created_at, updated_at, metadata_json)
    VALUES (?, ?, ?, ?)
  `);
  const insertEpisode = db.prepare(`
    INSERT OR IGNORE INTO episodes (
      id, session_id, started_at, ended_at, register, trust, summary, trace_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO episode_members (episode_id, path, role, ordinal)
    VALUES (?, ?, ?, ?)
  `);
  const insertMany = db.transaction((items: readonly PortableEpisode[]) => {
    let inserted = 0;
    let skipped = 0;
    for (const episode of items) {
      const startedAt = sourceTimestampOrUnknown(episode.startedAt);
      const endedAt = sourceTimestampOrUnknown(episode.endedAt);
      insertSession.run(
        episode.sessionId,
        startedAt,
        endedAt,
        JSON.stringify({ source: 'episode_record' }),
      );
      const result = insertEpisode.run(
        episode.id,
        episode.sessionId,
        startedAt,
        endedAt,
        episode.register,
        episode.trust,
        episode.summary,
        JSON.stringify(episode.trace),
        JSON.stringify({
          sessionId: episode.sessionId,
          runId: episode.runId,
          foldEpochId: episode.foldEpochId,
          rebirthEpochId: episode.rebirthEpochId,
          closedBy: episode.closedBy,
          annotations: episode.annotations,
          ...(episode.supersedes && episode.supersedes.length > 0
            ? { supersedes: episode.supersedes }
            : {}),
        }),
      ) as { changes?: number };

      if ((result.changes ?? 0) > 0) inserted += 1;
      else skipped += 1;

      for (const member of episode.members) {
        insertMember.run(episode.id, member.path, member.role, member.ordinal);
      }
    }
    return { inserted, skipped };
  });

  const result = insertMany(episodes);

  // Apply glyph-harvested supersessions after the insert batch so a verdict
  // recorded in this window can retire an older episode in the same call.
  const supersessions = episodes.flatMap((episode) =>
    (episode.supersedes ?? [])
      .filter((episodeId) => episodeId !== episode.id)
      .map((episodeId) => ({
        episodeId,
        supersededBy: episode.id,
        reason: 'glyph_marker',
      })),
  );
  if (supersessions.length > 0) supersedeEpisodes(db, supersessions);

  return result;
}

/**
 * Extract explicit supersession targets from a durable message body:
 * `↺ episode-<id>`, `↺: episode-<id>`, or `supersedes episode-<id>`.
 * Pure text parse — deduplicated, order-preserving.
 */
export function extractSupersededEpisodeIds(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(SUPERSEDES_REF_RE)) {
    const id = match[1];
    if (id) found.add(id);
  }
  return [...found];
}

/**
 * Record supersessions: retire the named episodes from future recall. Creates
 * the additive `episode_supersessions` sidecar table on demand, so it works
 * against legacy stores opened before the table existed. Semantic fields are
 * first-write-wins; a later replay may only enrich missing source time. Returns
 * rows newly recorded or provenance-enriched.
 */
export function supersedeEpisodes(
  db: EpisodeDatabase,
  entries: readonly EpisodeSupersession[],
): number {
  if (entries.length === 0) return 0;
  db.prepare(SUPERSESSION_TABLE_DDL).run();
  // Pre-provenance sidecar tables gain the nullable source_at column on demand.
  const supersessionColumns = db.prepare("PRAGMA table_info(episode_supersessions)").all() as Array<{ name: string }>;
  if (!supersessionColumns.some((column) => column.name === 'source_at')) {
    try {
      db.prepare('ALTER TABLE episode_supersessions ADD COLUMN source_at TEXT').run();
    } catch {
      /* best-effort: a concurrent writer already added it */
    }
  }
  const insert = db.prepare(`
    INSERT INTO episode_supersessions (episode_id, superseded_by, reason, created_at, source_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(episode_id) DO UPDATE SET source_at = excluded.source_at
    WHERE episode_supersessions.source_at IS NULL AND excluded.source_at IS NOT NULL
  `);
  let recorded = 0;
  const applyAll = db.transaction((items: readonly EpisodeSupersession[]) => {
    for (const entry of items) {
      const result = insert.run(
        entry.episodeId,
        entry.supersededBy ?? null,
        entry.reason ?? null,
        // created_at is pure row ingestion time; the supersession event's
        // source time lives in source_at (NULL when the caller omitted it).
        new Date().toISOString(),
        entry.at ?? null,
      );
      if ((result.changes ?? 0) > 0) recorded += 1;
    }
  });
  applyAll(entries);
  return recorded;
}

/** True when the store has the supersession sidecar table. */
export function hasSupersessionTable(db: EpisodeDatabase): boolean {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episode_supersessions'`)
      .get();
    return row !== undefined && row !== null;
  } catch {
    return false;
  }
}

export function recallEpisodeCards(
  db: EpisodeDatabase,
  options: EpisodeRecallOptions,
): readonly EpisodeRecallCard[] {
  const normalizedPaths = options.paths.map((item) => normalizeTouchPath(item)).filter((item) => item !== null);
  if (normalizedPaths.length === 0) return [];

  const excludedIds = new Set(options.excludeEpisodeIds ?? []);
  const supersededClause = hasSupersessionTable(db)
    ? 'AND e.id NOT IN (SELECT episode_id FROM episode_supersessions)'
    : '';
  const rowsById = new Map<string, {
    id: string;
    summary: string;
    endedAt: string;
    metadataJson: string;
    matchedPaths: Set<string>;
  }>();
  for (let offset = 0; offset < normalizedPaths.length; offset += SQLITE_BIND_BATCH_SIZE) {
    const batch = normalizedPaths.slice(offset, offset + SQLITE_BIND_BATCH_SIZE);
    const rows = db.prepare(`
      SELECT
        e.id,
        e.summary,
        e.ended_at AS endedAt,
        e.metadata_json AS metadataJson,
        GROUP_CONCAT(DISTINCT em.path) AS matchedPaths
      FROM episodes e
      JOIN episode_members em ON em.episode_id = e.id
      WHERE em.path IN (${batch.map(() => '?').join(', ')})
        ${supersededClause}
      GROUP BY e.id
    `).all(...batch) as Array<{
      id: string;
      summary: string;
      endedAt: string;
      metadataJson: string;
      matchedPaths: string | null;
    }>;
    for (const row of rows) {
      if (excludedIds.has(row.id)) continue;
      const existing = rowsById.get(row.id);
      if (existing) {
        for (const matchedPath of row.matchedPaths?.split(',').filter(Boolean) ?? []) {
          existing.matchedPaths.add(matchedPath);
        }
      } else {
        rowsById.set(row.id, {
          ...row,
          matchedPaths: new Set(row.matchedPaths?.split(',').filter(Boolean) ?? []),
        });
      }
    }
  }
  // Known source time first; unknown and legacy malformed values never
  // outrank real time. The id tie-break is identity, not chronology.
  const rows = [...rowsById.values()].sort((left, right) => {
    const leftTime = sourceTimestampMs(left.endedAt);
    const rightTime = sourceTimestampMs(right.endedAt);
    if (leftTime === undefined || rightTime === undefined) {
      if (leftTime !== rightTime) return leftTime === undefined ? 1 : -1;
      return right.id.localeCompare(left.id);
    }
    return rightTime - leftTime || right.id.localeCompare(left.id);
  });

  const cards = rows.map((row) => {
    const matchedPaths = [...row.matchedPaths].sort();
    return {
      episodeId: row.id,
      matchedPaths,
      text: renderEpisodeCard({
        episodeId: row.id,
        summary: row.summary,
        endedAt: row.endedAt,
        matchedPaths,
        metadataJson: row.metadataJson,
      }),
    };
  });
  return applyRecallBudget(cards, options.maxChars, options.limit);
}

export function createEpisodeRecallState(): EpisodeRecallState {
  return { servedEpisodeIds: [] };
}

export function recallEpisodeCardsWithState(
  db: EpisodeDatabase,
  state: EpisodeRecallState,
  options: EpisodeRecallOptions,
): EpisodeRecallStateResult {
  const excludeEpisodeIds = [...state.servedEpisodeIds, ...(options.excludeEpisodeIds ?? [])];
  const cards = recallEpisodeCards(db, { ...options, excludeEpisodeIds });
  const servedEpisodeIds = [...new Set([...state.servedEpisodeIds, ...cards.map((card) => card.episodeId)])];
  return {
    cards,
    state: {
      servedEpisodeIds,
    },
  };
}

export function renderEpisodeCard(input: {
  readonly episodeId: string;
  readonly summary: string;
  readonly endedAt: string;
  readonly matchedPaths: readonly string[];
  readonly metadataJson?: string;
}): string {
  const closedBy = readClosedBy(input.metadataJson);
  return [
    `[Recalled episode ${input.episodeId} — ${closedBy}, ${input.endedAt}]`,
    `Summary: ${input.summary}`,
    `Matched paths: ${input.matchedPaths.join(', ')}`,
  ].join('\n');
}

function extractMessageTouchedPaths(message: PortableMessage): readonly string[] {
  const values: unknown[] = [message.content];
  for (const call of [...(message.toolCalls ?? []), ...(message.tool_calls ?? [])]) {
    values.push(call.name, call.input, call.arguments);
  }
  return extractTouchedPaths(values);
}

function collectTouchedPaths(input: unknown, found: Set<string>, options: TouchExtractionOptions): void {
  if (typeof input === 'string') {
    collectPathsFromText(input, found, options);
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) collectTouchedPaths(item, found, options);
    return;
  }
  if (!isRecord(input)) return;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && TOOL_TOUCH_KEYS.has(key)) {
      const normalized = normalizeTouchPath(value);
      if (normalized) found.add(normalized);
    }
    collectTouchedPaths(value, found, options);
  }
}

function collectPathsFromText(text: string, found: Set<string>, options: TouchExtractionOptions): void {
  for (const match of text.matchAll(PATH_LIKE_RE)) {
    const normalized = normalizeTouchPath(match[1] ?? '');
    if (normalized) found.add(normalized);
  }
  if (!options.includeBareFilenames) return;
  for (const match of text.matchAll(BARE_FILENAME_RE)) {
    const normalized = normalizeTouchPath(match[1] ?? '');
    if (normalized) found.add(normalized);
  }
}

function createBurst(timestamp: string | undefined): MutableBurst {
  return {
    startedAt: timestamp,
    endedAt: timestamp,
    annotations: [],
    pathOrder: [],
    pathRoles: new Map(),
    trace: [],
  };
}

function addPathToBurst(burst: MutableBurst, path: string, role: EpisodeMember['role']): void {
  const normalized = normalizeTouchPath(path);
  if (!normalized) return;
  if (!burst.pathRoles.has(normalized)) burst.pathOrder.push(normalized);
  const currentRole = burst.pathRoles.get(normalized);
  burst.pathRoles.set(normalized, currentRole === 'touched' ? 'touched' : role);
}

function sealBurst(
  burst: MutableBurst,
  sessionId: string,
  closedBy: EpisodeClosedBy,
  runId?: string,
  foldEpochId?: string,
  rebirthEpochId?: string,
): PortableEpisode | null {
  if (burst.pathOrder.length === 0 && burst.annotations.length === 0) return null;
  const finalAnnotation = [...burst.annotations].reverse().find((annotation) => annotation.classification.final);
  const durableAnnotation = [...burst.annotations].reverse().find((annotation) => annotation.classification.durable);
  const representative = finalAnnotation ?? durableAnnotation ?? burst.annotations.at(-1) ?? null;
  const summary = representative?.body || burst.pathOrder.join(', ') || 'Unlabeled work burst';
  const members = burst.pathOrder.map((path, ordinal) => ({
    path,
    role: burst.pathRoles.get(path) ?? 'mentioned',
    ordinal,
  }));
  const register = representative?.register ?? null;
  const trust = representative?.classification.trust ?? 'low_trust';
  // Endpoints stay independently unknown: neither is copied from the other
  // and no clock is synthesized (mirrors the canonical engine's contract).
  const startedAt = burst.startedAt ?? UNKNOWN_EPISODE_TIME;
  const endedAt = burst.endedAt ?? UNKNOWN_EPISODE_TIME;
  const id = stableEpisodeId(sessionId, startedAt, endedAt, summary, members);
  const supersedes = [
    ...new Set(
      burst.annotations
        .filter((annotation) => annotation.classification.durable)
        .flatMap((annotation) => extractSupersededEpisodeIds(annotation.body)),
    ),
  ].filter((episodeId) => episodeId !== id);

  return {
    ...(supersedes.length > 0 ? { supersedes } : {}),
    id,
    sessionId,
    runId,
    foldEpochId,
    rebirthEpochId,
    startedAt,
    endedAt,
    closedBy,
    register,
    trust,
    summary,
    annotations: burst.annotations,
    members,
    trace: burst.trace,
  };
}

function stableEpisodeId(
  sessionId: string,
  startedAt: string,
  endedAt: string,
  summary: string,
  members: readonly EpisodeMember[],
): string {
  const hash = createHash('sha256');
  hash.update(sessionId);
  hash.update('\0');
  hash.update(startedAt);
  hash.update('\0');
  hash.update(endedAt);
  hash.update('\0');
  hash.update(summary);
  hash.update('\0');
  hash.update(JSON.stringify(members));
  return `episode-${hash.digest('hex').slice(0, 16)}`;
}

function messageToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return '';
}

function readClosedBy(metadataJson: string | undefined): string {
  if (!metadataJson) return 'unknown';
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (isRecord(parsed) && typeof parsed.closedBy === 'string') return parsed.closedBy;
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

function applyRecallBudget(
  cards: readonly EpisodeRecallCard[],
  maxChars: number | undefined,
  limit: number | undefined,
): readonly EpisodeRecallCard[] {
  const renderedLimit = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
  const kept: EpisodeRecallCard[] = [];
  let used = 0;
  for (const card of cards) {
    if (renderedLimit !== undefined && kept.length >= renderedLimit) break;
    const nextUsed = used + card.text.length;
    if (maxChars !== undefined && nextUsed > maxChars) break;
    kept.push(card);
    used = nextUsed;
  }
  return kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSourceTimestamp(value: string | undefined): string | undefined {
  return value !== undefined
    && value !== UNKNOWN_EPISODE_TIME
    && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function sourceTimestampOrUnknown(value: string | undefined): string {
  return validSourceTimestamp(value) ?? UNKNOWN_EPISODE_TIME;
}

function sourceTimestampMs(value: string | undefined): number | undefined {
  const valid = validSourceTimestamp(value);
  return valid === undefined ? undefined : Date.parse(valid);
}
