import { extractDistinctiveTerms, scoreTermOverlap } from './foldTerms.ts';

export type FoldRecallUsageEventKind = 'injected' | 'path_edited' | 'verbatim_reused' | 'term_echo' | 'expired';
export type FoldRecallUtilityOutcome = 'exposed' | 'useful' | 'ignored';

export interface FoldRecallUsageCardInput {
  /** Optional transport-owned exposure identity; card/path/episode/boundary are still folded into the correlation id. */
  exposureId?: string;
  targetPath: string;
  renderedCard: string;
  chapterIds: readonly number[];
  memberPaths: readonly string[];
  kind: string;
}

export interface FoldRecallUsageWatch {
  correlationId: string;
  episodeId: number;
  cardKind: string;
  targetPath: string;
  memberPaths: readonly string[];
  verbatimKeys: readonly string[];
  terms: readonly string[];
  injectedAtBoundary: number;
  expiresAtBoundary: number;
  /** Later activity that did not use this card; makes expiry a false-positive proxy, never a causal claim. */
  unmatchedActivityBoundaries: number;
}

export interface FoldRecallUsageEvent {
  correlationId: string;
  episodeId: number;
  kind: FoldRecallUsageEventKind;
  outcome: FoldRecallUtilityOutcome;
  boundarySeq: number;
  tsMs: number;
  cardKind?: string;
  matchedPath?: string;
  weight?: number;
  /** True only for an expiry preceded by unrelated activity after injection. */
  falsePositiveProxy?: boolean;
}

export interface FoldRecallUtilityRank {
  /** Evidence class: every value below is an observed behavioral proxy, never causal lift. */
  evidence: 'observational_proxy';
  episodeId: number;
  exposures: number;
  usefulOutcomes: number;
  ignoredOutcomes: number;
  falsePositiveProxies: number;
  /** Mean observed proxy weight across terminal outcomes; null means exposure-only. */
  observationalProxy: number | null;
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

function normalizedWatchKey(watch: Pick<FoldRecallUsageWatch, 'correlationId'>): string {
  return watch.correlationId;
}

/** Stable across transports without relying on timestamps, tokens, or process-local counters. */
export function makeFoldRecallUsageCorrelationId(
  card: FoldRecallUsageCardInput,
  episodeId: number,
  boundarySeq: number,
): string {
  const source = [card.exposureId?.trim() ?? '', card.kind, card.targetPath].join('\x00');
  return `fru:${boundarySeq}:${episodeId}:${encodeURIComponent(source)}`;
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
    correlationId: makeFoldRecallUsageCorrelationId(card, episodeId, boundarySeq),
    episodeId,
    cardKind: card.kind,
    targetPath: card.targetPath,
    memberPaths,
    verbatimKeys: extractVerbatimKeys(card.renderedCard),
    terms: extractDistinctiveTerms(card.renderedCard, { cap: termCap }),
    injectedAtBoundary: boundarySeq,
    expiresAtBoundary: boundarySeq + window,
    unmatchedActivityBoundaries: 0,
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
  const known = new Set(existing.map(normalizedWatchKey));
  for (const card of cards) {
    for (const episodeId of new Set(card.chapterIds)) {
      const watch = watchFromCard(card, episodeId, boundarySeq, opts);
      if (!watch) continue;
      if (known.has(watch.correlationId)) continue;
      known.add(watch.correlationId);
      added.push(watch);
      events.push({
        correlationId: watch.correlationId,
        episodeId,
        kind: 'injected',
        outcome: 'exposed',
        boundarySeq,
        tsMs,
        cardKind: card.kind,
      });
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
  const hasActivity = touched.size > 0 || toolText.trim().length > 0 || assistantText.trim().length > 0;
  const next: FoldRecallUsageWatch[] = [];
  const events: FoldRecallUsageEvent[] = [];

  for (const watch of watches) {
    if (boundarySeq <= watch.injectedAtBoundary) {
      next.push(watch);
      continue;
    }

    const matchedPath = firstMatchedPath(watch, touched);
    if (matchedPath) {
      events.push({ correlationId: watch.correlationId, episodeId: watch.episodeId, kind: 'path_edited', outcome: 'useful', boundarySeq, tsMs, cardKind: watch.cardKind, matchedPath });
      continue;
    }
    if (includesVerbatimKey(watch, `${toolText}\n${assistantText}`)) {
      events.push({ correlationId: watch.correlationId, episodeId: watch.episodeId, kind: 'verbatim_reused', outcome: 'useful', boundarySeq, tsMs, cardKind: watch.cardKind });
      continue;
    }
    if (termEchoMatched(watch, assistantTerms, opts)) {
      events.push({ correlationId: watch.correlationId, episodeId: watch.episodeId, kind: 'term_echo', outcome: 'useful', boundarySeq, tsMs, cardKind: watch.cardKind });
      continue;
    }
    const unmatchedActivityBoundaries = watch.unmatchedActivityBoundaries + (hasActivity ? 1 : 0);
    if (boundarySeq > watch.expiresAtBoundary) {
      events.push({
        correlationId: watch.correlationId,
        episodeId: watch.episodeId,
        kind: 'expired',
        outcome: 'ignored',
        boundarySeq,
        tsMs,
        cardKind: watch.cardKind,
        ...(unmatchedActivityBoundaries > 0 ? { falsePositiveProxy: true } : {}),
      });
      continue;
    }
    next.push(unmatchedActivityBoundaries === watch.unmatchedActivityBoundaries
      ? watch
      : { ...watch, unmatchedActivityBoundaries });
  }

  return { watches: next, events };
}

export function foldRecallUsageEventWeight(event: FoldRecallUsageEvent): number | null {
  if (event.kind === 'path_edited' || event.kind === 'verbatim_reused') return 1;
  if (event.kind === 'term_echo') return 0.5;
  if (event.kind === 'expired') return 0;
  return null;
}

/**
 * Deterministic observational-proxy ranking for operator views and shadow experiments.
 * This output is not evidence that recall caused the later behavior.
 * Duplicate transport deliveries are collapsed by correlation id + event kind.
 */
export function rankFoldRecallUtility(events: readonly FoldRecallUsageEvent[]): FoldRecallUtilityRank[] {
  const unique = new Map<string, FoldRecallUsageEvent>();
  for (const event of events) unique.set(`${event.correlationId}\x00${event.kind}`, event);
  const rows = new Map<number, FoldRecallUtilityRank & { weightTotal: number; weightedOutcomes: number }>();
  for (const event of unique.values()) {
    const row = rows.get(event.episodeId) ?? {
      evidence: 'observational_proxy' as const,
      episodeId: event.episodeId,
      exposures: 0,
      usefulOutcomes: 0,
      ignoredOutcomes: 0,
      falsePositiveProxies: 0,
      observationalProxy: null,
      weightTotal: 0,
      weightedOutcomes: 0,
    };
    if (event.outcome === 'exposed') row.exposures += 1;
    if (event.outcome === 'useful') row.usefulOutcomes += 1;
    if (event.outcome === 'ignored') row.ignoredOutcomes += 1;
    if (event.falsePositiveProxy) row.falsePositiveProxies += 1;
    const weight = foldRecallUsageEventWeight(event);
    if (weight !== null) {
      row.weightTotal += weight;
      row.weightedOutcomes += 1;
      row.observationalProxy = row.weightTotal / row.weightedOutcomes;
    }
    rows.set(event.episodeId, row);
  }
  return [...rows.values()]
    .map(({ weightTotal: _weightTotal, weightedOutcomes: _weightedOutcomes, ...row }) => row)
    .sort((a, b) =>
      (b.observationalProxy ?? -1) - (a.observationalProxy ?? -1)
      || b.usefulOutcomes - a.usefulOutcomes
      || b.exposures - a.exposures
      || a.episodeId - b.episodeId,
    );
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
