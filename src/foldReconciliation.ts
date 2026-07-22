import {
  foldReconciliationRecordId,
  type FoldActionOutcome,
  type FoldReconciliationCandidate,
} from './foldReceipts.ts';

/** Typed overlay schema for reconciling an interrupted durable mutation. */
export const FOLD_ACTION_RESOLUTION_VERSION = 'fold-action-resolution/v1' as const;

export const FOLD_GROUND_TRUTH_SOURCES = [
  'filesystem',
  'atlas-history',
  'ledger',
] as const;

export type FoldGroundTruthSource = typeof FOLD_GROUND_TRUTH_SOURCES[number];

/** The resolver accepts only records whose outcome genuinely remains open. */
export type FoldUnknownActionRecord = FoldReconciliationCandidate & {
  outcome: 'unknown';
  reconciliationRequired: true;
};

/** One adapter's authoritative observation. Absence is `unknown`, never failure. */
export interface FoldGroundTruthObservation {
  outcome: FoldActionOutcome;
  /** Bounded source-specific proof pointer or fact; required for a final outcome. */
  evidence: string;
  /** Source observation time, or null when the source does not provide one. */
  observedAt: string | null;
}

/** Async-only boundary around live state. Implementations may use a worker or
 * remote client, but this portable core performs no filesystem or ledger I/O. */
export interface FoldGroundTruthAdapter {
  source: FoldGroundTruthSource;
  readOnly: true;
  inspectAsync(record: Readonly<FoldUnknownActionRecord>): Promise<FoldGroundTruthObservation>;
}

export interface FoldGroundTruthConsultation {
  source: FoldGroundTruthSource;
  availability: 'available' | 'unavailable';
  outcome: FoldActionOutcome;
  evidence: string;
  observedAt: string | null;
}

export type FoldActionResolutionReason =
  | 'authoritative-ground-truth'
  | 'conflicting-ground-truth'
  | 'no-authoritative-ground-truth'
  | 'ground-truth-unavailable';

/** A successor-facing overlay. The source receipt and frozen bands stay intact. */
export interface FoldActionResolution {
  version: typeof FOLD_ACTION_RESOLUTION_VERSION;
  recordType: FoldReconciliationCandidate['recordType'];
  recordId: string;
  targetIdentity: string;
  originalOutcome: 'unknown';
  outcome: FoldActionOutcome;
  reconciliationRequired: boolean;
  consultedSources: FoldGroundTruthSource[];
  resolvedBy: FoldGroundTruthSource[];
  reason: FoldActionResolutionReason;
  consultations: FoldGroundTruthConsultation[];
}

const MAX_EVIDENCE_CHARS = 240;

function boundedEvidence(value: unknown, fallback: string): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim() || fallback;
  return text.length <= MAX_EVIDENCE_CHARS
    ? text
    : `${text.slice(0, MAX_EVIDENCE_CHARS - 15)}... [truncated]`;
}

function normalizeObservedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function immutableRecordView(record: FoldUnknownActionRecord): Readonly<FoldUnknownActionRecord> {
  if (record.recordType === 'decision') {
    return Object.freeze({
      ...record,
      supersedesDecisionIds: Object.freeze([...record.supersedesDecisionIds]),
    }) as Readonly<FoldUnknownActionRecord>;
  }
  return Object.freeze({ ...record });
}

function assertAdapters(
  adapters: readonly FoldGroundTruthAdapter[],
): asserts adapters is readonly [FoldGroundTruthAdapter, ...FoldGroundTruthAdapter[]] {
  if (adapters.length === 0) {
    throw new RangeError('At least one ground-truth adapter is required.');
  }
  if (adapters.length > FOLD_GROUND_TRUTH_SOURCES.length) {
    throw new RangeError('At most one adapter per ground-truth source is allowed.');
  }
  const seen = new Set<FoldGroundTruthSource>();
  for (const adapter of adapters) {
    if (!FOLD_GROUND_TRUTH_SOURCES.includes(adapter.source)) {
      throw new TypeError(`Unsupported ground-truth source: ${String(adapter.source)}`);
    }
    if (adapter.readOnly !== true) {
      throw new TypeError(`Ground-truth adapter ${adapter.source} is not read-only.`);
    }
    if (seen.has(adapter.source)) {
      throw new RangeError(`Duplicate ground-truth adapter: ${adapter.source}`);
    }
    seen.add(adapter.source);
  }
}

async function consult(
  adapter: FoldGroundTruthAdapter,
  record: Readonly<FoldUnknownActionRecord>,
): Promise<FoldGroundTruthConsultation> {
  try {
    const observation = await adapter.inspectAsync(record);
    const evidence = boundedEvidence(observation?.evidence, 'no authoritative evidence returned');
    const requestedOutcome = observation?.outcome;
    const outcome: FoldActionOutcome = requestedOutcome === 'applied' || requestedOutcome === 'failed'
      ? (evidence === 'no authoritative evidence returned' ? 'unknown' : requestedOutcome)
      : 'unknown';
    return {
      source: adapter.source,
      availability: 'available',
      outcome,
      evidence,
      observedAt: normalizeObservedAt(observation?.observedAt),
    };
  } catch (error) {
    return {
      source: adapter.source,
      availability: 'unavailable',
      outcome: 'unknown',
      evidence: boundedEvidence(error instanceof Error ? error.message : error, 'adapter unavailable'),
      observedAt: null,
    };
  }
}

/**
 * Resolve an interrupted mutation against named live sources. All adapters are
 * started together and only affirmative, evidenced observations may finalize
 * the overlay. Conflicting or absent evidence remains `unknown` and flagged.
 */
export async function reconcileUnknownFoldAction(
  record: FoldUnknownActionRecord,
  adapters: readonly [FoldGroundTruthAdapter, ...FoldGroundTruthAdapter[]],
): Promise<FoldActionResolution> {
  if (record.outcome !== 'unknown' || record.reconciliationRequired !== true) {
    throw new TypeError('Only unknown reconciliation-required action records may be reconciled.');
  }
  assertAdapters(adapters);
  const recordView = immutableRecordView(record);
  const consultations = await Promise.all(adapters.map((adapter) => consult(adapter, recordView)));
  const authoritative = consultations.filter((item) => (
    item.outcome === 'applied' || item.outcome === 'failed'
  ));
  const outcomes = new Set(authoritative.map((item) => item.outcome));

  let outcome: FoldActionOutcome = 'unknown';
  let reason: FoldActionResolutionReason;
  if (outcomes.size === 1) {
    outcome = authoritative[0]!.outcome;
    reason = 'authoritative-ground-truth';
  } else if (outcomes.size > 1) {
    reason = 'conflicting-ground-truth';
  } else if (consultations.every((item) => item.availability === 'unavailable')) {
    reason = 'ground-truth-unavailable';
  } else {
    reason = 'no-authoritative-ground-truth';
  }

  return {
    version: FOLD_ACTION_RESOLUTION_VERSION,
    recordType: record.recordType,
    recordId: foldReconciliationRecordId(record),
    targetIdentity: record.targetIdentity,
    originalOutcome: 'unknown',
    outcome,
    reconciliationRequired: outcome === 'unknown',
    consultedSources: consultations.map((item) => item.source),
    resolvedBy: outcome === 'unknown'
      ? []
      : authoritative.map((item) => item.source),
    reason,
    consultations,
  };
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Deterministic, source-citing rendering for a new reconciliation overlay. */
export function renderFoldActionResolution(resolution: FoldActionResolution): string {
  const header = [
    `RECONCILIATION version=${resolution.version}`,
    `record-type=${resolution.recordType}`,
    `record-id=${quoted(resolution.recordId)}`,
    `target=${quoted(resolution.targetIdentity || 'unknown')}`,
    `outcome=${resolution.outcome}`,
    `reconciliation-required=${String(resolution.reconciliationRequired)}`,
    `reason=${resolution.reason}`,
    `consulted=${quoted(resolution.consultedSources.join(',') || 'none')}`,
    `resolved-by=${quoted(resolution.resolvedBy.join(',') || 'none')}`,
  ].join(' ');
  return [
    header,
    ...resolution.consultations.map((item) => [
      '↞ ground-truth',
      `source=${item.source}`,
      `availability=${item.availability}`,
      `outcome=${item.outcome}`,
      `observed-at=${item.observedAt ?? 'unknown'}`,
      `evidence=${quoted(item.evidence)}`,
    ].join(' ')),
  ].join('\n');
}
