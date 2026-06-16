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
  readonly startedAt: string;
  readonly endedAt: string;
  readonly closedBy: EpisodeClosedBy;
  readonly register: AssistantRegister | null;
  readonly trust: AssistantRegisterClassification['trust'];
  readonly summary: string;
  readonly annotations: readonly EpisodeAnnotation[];
  readonly members: readonly EpisodeMember[];
  readonly trace: readonly string[];
}

export interface DeriveEpisodesOptions {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly foldEpochId?: string;
  readonly rebirthEpochId?: string;
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

interface MutableBurst {
  startedAt: string;
  endedAt: string;
  annotations: EpisodeAnnotation[];
  pathOrder: string[];
  pathRoles: Map<string, EpisodeMember['role']>;
  trace: string[];
}

const DEFAULT_SESSION_ID = 'default';
const PATH_LIKE_RE = /(?:^|[\s"'`(])((?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./:@+-]+\.[A-Za-z0-9]+(?::\d+)?)/gu;
const BARE_FILENAME_RE = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?=$|[\s"'`),.])/gu;
const TOOL_TOUCH_KEYS = new Set(['path', 'paths', 'file', 'files', 'file_path', 'filePath', 'cwd', 'workdir']);

export function deriveEpisodesFromMessages(
  messages: readonly PortableMessage[],
  options: DeriveEpisodesOptions = {},
): readonly PortableEpisode[] {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const now = options.now ?? new Date().toISOString();
  const episodes: PortableEpisode[] = [];
  let burst: MutableBurst | null = null;

  messages.forEach((message, index) => {
    const timestamp = message.timestamp ?? now;
    const text = messageToText(message.content);
    const touches = extractMessageTouchedPaths(message);
    const parsed = message.role === 'assistant' ? parseRegisterGlyph(text) : null;

    if (touches.length > 0 || parsed?.ok) {
      burst ??= createBurst(timestamp);
      burst.endedAt = timestamp;
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
      insertSession.run(
        episode.sessionId,
        episode.startedAt,
        episode.endedAt,
        JSON.stringify({ source: 'episode_record' }),
      );
      const result = insertEpisode.run(
        episode.id,
        episode.sessionId,
        episode.startedAt,
        episode.endedAt,
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

  return insertMany(episodes);
}

export function recallEpisodeCards(
  db: EpisodeDatabase,
  options: EpisodeRecallOptions,
): readonly EpisodeRecallCard[] {
  const normalizedPaths = options.paths.map((item) => normalizeTouchPath(item)).filter((item) => item !== null);
  if (normalizedPaths.length === 0) return [];

  const excludedIds = options.excludeEpisodeIds ?? [];
  const pathPlaceholders = normalizedPaths.map(() => '?').join(', ');
  const excludeClause = excludedIds.length > 0
    ? `AND e.id NOT IN (${excludedIds.map(() => '?').join(', ')})`
    : '';
  const rows = db.prepare(`
    SELECT
      e.id,
      e.summary,
      e.ended_at AS endedAt,
      e.metadata_json AS metadataJson,
      GROUP_CONCAT(DISTINCT em.path) AS matchedPaths
    FROM episodes e
    JOIN episode_members em ON em.episode_id = e.id
    WHERE em.path IN (${pathPlaceholders})
      ${excludeClause}
    GROUP BY e.id
    ORDER BY e.ended_at DESC
    LIMIT ?
  `).all(...normalizedPaths, ...excludedIds, options.limit ?? 5) as Array<{
    id: string;
    summary: string;
    endedAt: string;
    metadataJson: string;
    matchedPaths: string | null;
  }>;

  const cards = rows.map((row) => {
    const matchedPaths = row.matchedPaths?.split(',').filter(Boolean) ?? [];
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
  return applyRecallBudget(cards, options.maxChars);
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

function createBurst(timestamp: string): MutableBurst {
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
  const id = stableEpisodeId(sessionId, burst.startedAt, burst.endedAt, summary, members);

  return {
    id,
    sessionId,
    runId,
    foldEpochId,
    rebirthEpochId,
    startedAt: burst.startedAt,
    endedAt: burst.endedAt,
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
): readonly EpisodeRecallCard[] {
  if (maxChars === undefined) return cards;
  const kept: EpisodeRecallCard[] = [];
  let used = 0;
  for (const card of cards) {
    const nextUsed = used + card.text.length;
    if (nextUsed > maxChars) break;
    kept.push(card);
    used = nextUsed;
  }
  return kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
