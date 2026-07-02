import { extractDistinctiveTerms, scoreTermOverlap } from './foldTerms.ts';

export type FoldRecallUsageEventKind = 'injected' | 'path_edited' | 'verbatim_reused' | 'term_echo' | 'expired';

export interface FoldRecallUsageCardInput {
  targetPath: string;
  renderedCard: string;
  chapterIds: readonly number[];
  memberPaths: readonly string[];
  kind: string;
}

export interface FoldRecallUsageWatch {
  episodeId: number;
  cardKind: string;
  targetPath: string;
  memberPaths: readonly string[];
  verbatimKeys: readonly string[];
  terms: readonly string[];
  injectedAtBoundary: number;
  expiresAtBoundary: number;
}

export interface FoldRecallUsageEvent {
  episodeId: number;
  kind: FoldRecallUsageEventKind;
  tsMs: number;
  cardKind?: string;
  matchedPath?: string;
  weight?: number;
}

export interface FoldRecallUsageOptions {
  /** Terminal-outcome window after injection. Default 6 later boundaries. */
  windowBoundaries?: number;
  /** Max resident watches kept after adding fresh cards. Default 128. */
  maxWatches?: number;
  /** Max distinctive terms retained from each card/assistant text. Default 32. */
  termCap?: number;
  /** Minimum distinctive overlap for a term_echo terminal event. Default 2. */
  minEchoTerms?: number;
  /** Optional IDF map for scoreTermOverlap; empty means shared unseen terms count as rare. */
  idf?: ReadonlyMap<string, number>;
  /** Timestamp source for deterministic tests. Default Date.now(). */
  nowMs?: number;
}

export interface AddFoldRecallUsageCardsResult {
  watches: FoldRecallUsageWatch[];
  events: FoldRecallUsageEvent[];
}

export interface AdvanceFoldRecallUsageResult {
  watches: FoldRecallUsageWatch[];
  events: FoldRecallUsageEvent[];
}

export interface FoldRecallUsageSignals {
  touchedPaths?: readonly string[];
  toolArgsText?: string;
  assistantText?: string;
}

export const FOLD_RECALL_USAGE_DEFAULT_WINDOW_BOUNDARIES = 6;
const DEFAULT_MAX_WATCHES = 128;
const DEFAULT_TERM_CAP = 32;
const DEFAULT_MIN_ECHO_TERMS = 2;
const DEFAULT_TEXT_CAP = 64_000;

const VERBATIM_LINE_RE = /^\s*⌖ verbatim:\s*(.+)$/gmu;
const EVENT_RANGE_RE = /\bevents\s+\d+\.\.\d+\b/g;

function nowMs(opts: FoldRecallUsageOptions): number {
  return Number.isFinite(opts.nowMs) ? Math.floor(opts.nowMs as number) : Date.now();
}

function uniqSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter((v) => v.length > 0))).sort();
}

function normalizedWatchKey(watch: Pick<FoldRecallUsageWatch, 'episodeId' | 'cardKind' | 'targetPath'>): string {
  return `${watch.episodeId}\x00${watch.cardKind}\x00${watch.targetPath}`;
}

function extractVerbatimKeys(renderedCard: string): string[] {
  const out: string[] = [];
  for (const match of renderedCard.matchAll(VERBATIM_LINE_RE)) {
    const line = match[1]?.trim();
    if (!line) continue;
    out.push(line);
    for (const range of line.matchAll(EVENT_RANGE_RE)) out.push(range[0]);
  }
  return uniqSorted(out);
}

function watchFromCard(
  card: FoldRecallUsageCardInput,
  episodeId: number,
  boundarySeq: number,
  opts: FoldRecallUsageOptions,
): FoldRecallUsageWatch | null {
  if (!Number.isInteger(episodeId) || episodeId <= 0) return null;
  const termCap = Math.max(1, Math.floor(opts.termCap ?? DEFAULT_TERM_CAP));
  const window = Math.max(1, Math.floor(opts.windowBoundaries ?? FOLD_RECALL_USAGE_DEFAULT_WINDOW_BOUNDARIES));
  const memberPaths = uniqSorted([card.targetPath, ...card.memberPaths]);
  return {
    episodeId,
    cardKind: card.kind,
    targetPath: card.targetPath,
    memberPaths,
    verbatimKeys: extractVerbatimKeys(card.renderedCard),
    terms: extractDistinctiveTerms(card.renderedCard, { cap: termCap }),
    injectedAtBoundary: boundarySeq,
    expiresAtBoundary: boundarySeq + window,
  };
}

export function addInjectedFoldRecallUsageCards(
  existing: readonly FoldRecallUsageWatch[],
  cards: readonly FoldRecallUsageCardInput[],
  boundarySeq: number,
  opts: FoldRecallUsageOptions = {},
): AddFoldRecallUsageCardsResult {
  const tsMs = nowMs(opts);
  const added: FoldRecallUsageWatch[] = [];
  const events: FoldRecallUsageEvent[] = [];
  for (const card of cards) {
    for (const episodeId of card.chapterIds) {
      const watch = watchFromCard(card, episodeId, boundarySeq, opts);
      if (!watch) continue;
      added.push(watch);
      events.push({ episodeId, kind: 'injected', tsMs, cardKind: card.kind });
    }
  }

  const byKey = new Map<string, FoldRecallUsageWatch>();
  for (const watch of [...existing, ...added]) byKey.set(normalizedWatchKey(watch), watch);
  const maxWatches = Math.max(1, Math.floor(opts.maxWatches ?? DEFAULT_MAX_WATCHES));
  const watches = [...byKey.values()]
    .sort((a, b) =>
      b.injectedAtBoundary - a.injectedAtBoundary
      || a.expiresAtBoundary - b.expiresAtBoundary
      || a.episodeId - b.episodeId
      || a.targetPath.localeCompare(b.targetPath),
    )
    .slice(0, maxWatches)
    .sort((a, b) =>
      a.expiresAtBoundary - b.expiresAtBoundary
      || a.injectedAtBoundary - b.injectedAtBoundary
      || a.episodeId - b.episodeId,
    );
  return { watches, events };
}

function firstMatchedPath(watch: FoldRecallUsageWatch, touched: ReadonlySet<string>): string | null {
  for (const path of watch.memberPaths) {
    if (touched.has(path)) return path;
  }
  return null;
}

function includesVerbatimKey(watch: FoldRecallUsageWatch, text: string): boolean {
  if (text.length === 0 || watch.verbatimKeys.length === 0) return false;
  return watch.verbatimKeys.some((key) => key.length > 0 && text.includes(key));
}

function termEchoMatched(watch: FoldRecallUsageWatch, assistantTerms: readonly string[], opts: FoldRecallUsageOptions): boolean {
  if (watch.terms.length === 0 || assistantTerms.length === 0) return false;
  const overlap = scoreTermOverlap(watch.terms, assistantTerms, opts.idf ?? new Map(), {
    idfFloor: 0.3,
    unseenIdf: 1,
  });
  return overlap.distinctiveCount >= Math.max(1, Math.floor(opts.minEchoTerms ?? DEFAULT_MIN_ECHO_TERMS));
}

export function advanceFoldRecallUsageWatches(
  watches: readonly FoldRecallUsageWatch[],
  boundarySeq: number,
  signals: FoldRecallUsageSignals,
  opts: FoldRecallUsageOptions = {},
): AdvanceFoldRecallUsageResult {
  const tsMs = nowMs(opts);
  const touched = new Set(signals.touchedPaths ?? []);
  const toolText = signals.toolArgsText ?? '';
  const assistantText = signals.assistantText ?? '';
  const assistantTerms = assistantText.length > 0
    ? extractDistinctiveTerms(assistantText, { cap: Math.max(1, Math.floor(opts.termCap ?? DEFAULT_TERM_CAP)) })
    : [];
  const next: FoldRecallUsageWatch[] = [];
  const events: FoldRecallUsageEvent[] = [];

  for (const watch of watches) {
    if (boundarySeq <= watch.injectedAtBoundary) {
      next.push(watch);
      continue;
    }

    const matchedPath = firstMatchedPath(watch, touched);
    if (matchedPath) {
      events.push({ episodeId: watch.episodeId, kind: 'path_edited', tsMs, cardKind: watch.cardKind, matchedPath });
      continue;
    }
    if (includesVerbatimKey(watch, `${toolText}\n${assistantText}`)) {
      events.push({ episodeId: watch.episodeId, kind: 'verbatim_reused', tsMs, cardKind: watch.cardKind });
      continue;
    }
    if (termEchoMatched(watch, assistantTerms, opts)) {
      events.push({ episodeId: watch.episodeId, kind: 'term_echo', tsMs, cardKind: watch.cardKind });
      continue;
    }
    if (boundarySeq > watch.expiresAtBoundary) {
      events.push({ episodeId: watch.episodeId, kind: 'expired', tsMs, cardKind: watch.cardKind });
      continue;
    }
    next.push(watch);
  }

  return { watches: next, events };
}

export function serializeRecallUsageText(value: unknown, cap: number = DEFAULT_TEXT_CAP): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = String(value);
    }
  }
  return text.length > cap ? text.slice(0, cap) : text;
}
