/**
 * Generational collapse engine for the rebirth package.
 *
 * The package stops being a container of history and becomes an index of
 * forever: anything that leaves the package collapses exactly one tier and
 * leaves an exact receipt. This module owns that tier arithmetic.
 *
 * Deliberately pure: no filesystem, SQLite, Atlas, Git, or relay-state reads.
 * Same units + same budget ⇒ byte-identical output.
 *
 * Tiers (spec §5):
 *   T0 verbatim  — full text
 *   T1 digest    — one line per unit
 *   T2 era       — one paragraph per contiguous era of units
 *   T3 receipt   — one exact pointer line per unit (mint-verified)
 *   T4 rollup    — one line covering N contiguous receipts
 *
 * Chronology (God Rule 8): ordering is authoritative source time, tie-broken by
 * stable id. A unit with unknown source time never participates in the
 * chronology; it renders in an explicit quarantine block and is demoted before
 * any known-time unit, because it can make no recency claim.
 */

export const COLLAPSE_TIERS = ['t0', 't1', 't2', 't3', 't4'] as const;
export type CollapseTier = (typeof COLLAPSE_TIERS)[number];

export const COLLAPSE_TIER_NAMES: Readonly<Record<CollapseTier, string>> = Object.freeze({
  t0: 'verbatim',
  t1: 'digest',
  t2: 'era',
  t3: 'receipt',
  t4: 'rollup',
});

export type CollapseUnitKind =
  | 'operator'
  | 'episode'
  | 'life'
  | 'era'
  | 'package'
  | 'star'
  | 'cognitive'
  | 'conversation'
  | 'edit';

export interface CollapseUnit {
  /** Stable source-owned identity. Never an ingestion index or file position. */
  readonly id: string;
  /** Authoritative source-event time. Null stays unknown (quarantined). */
  readonly sourceAt: string | null;
  /** Optional authoritative end of this unit's source span (episodes, lives). */
  readonly sourceEndAt?: string | null;
  readonly kind: CollapseUnitKind;
  /** T0 body, already provenance-labelled by the feeder. */
  readonly verbatim: string;
  /** T1 one-line digest, already provenance-labelled by the feeder. */
  readonly digest: string;
  /** Era grouping key (e.g. an ISO date or week). Null groups by kind alone. */
  readonly eraKey?: string | null;
  /** One-line claim carried into the T3 receipt. */
  readonly claim: string;
  /** Exact, copy-pasteable recovery command for this unit. */
  readonly recover: string;
  /**
   * Mint gate (spec §6, invariant 2): a receipt is minted only when the feeder
   * verified the target exists and hashed it. Without a verified hash the unit
   * cannot fall below T2 — content is truth, and a dead pointer is worse than
   * spent chars.
   */
  readonly sha256?: string | null;
  /** Feeder-declared mint verification for this unit's recovery target. */
  readonly verified?: boolean;
  /**
   * Authorship provenance carried from the source store. 'declared' means the
   * row was tagged at the authenticated operator ingress; 'heuristic' means it
   * was attributed by the legacy content denylist (pre-tag era). A hash proves
   * bytes; this proves author — the two are deliberately separate. Absent when
   * the unit kind has no authorship question.
   */
  readonly origin?: 'declared' | 'heuristic';
  /**
   * Instance whose store sourced this unit (lineage feeds span incarnations).
   * Pure carry-through metadata: it never affects rendering or ordering, but a
   * continuity ledger persisting placements needs it so instance erasure can
   * find rows sourced from a purged identity. Null/absent = unknown source.
   */
  readonly sourceInstanceId?: string | null;
  /**
   * Projection declaration. Present only when `verbatim` is a head-clamped or
   * otherwise projected prefix of a longer source body the `recover` handle
   * still addresses. Presence is what lets a receipt name the artifact as a
   * projection instead of claiming full-fidelity proof: `storedChars`/
   * `storedBytes` describe `verbatim`; `sourceChars`/`sourceBytes` describe
   * what `recover` resolves. No source hash is carried here — where the source
   * bytes survive (e.g. the cognitive lane), the feeder must mint `sha256`
   * against them; a projection unit must never mint a hash it cannot verify.
   */
  readonly projection?: {
    readonly mode: 'truncated';
    readonly algorithm: 'head-clamp';
    readonly version: number;
    readonly storedChars: number;
    readonly storedBytes: number;
    readonly sourceChars: number;
    readonly sourceBytes: number;
  } | null;
  /**
   * Deliberate starting tier (audit-2 A25). When present the unit is placed at
   * this tier BEFORE pressure demotion runs — it never renders above it, and
   * adaptive backfill never promotes it past it. Used to keep deliberately
   * decayed lineage (e.g. older-ancestor operator-vault rows rolled to t2 era
   * blocks) out of the verbatim water-fill while leaving younger lineage
   * verbatim. A unit placed at its start tier is not counted as a demotion
   * (the render is complete at the declared starting representation); pressure
   * may still demote it below the start tier, and it stays demotable to its
   * mint-gate floor. Absent = the unit starts at t0 exactly as before.
   */
  readonly startTier?: CollapseTier;
}

export interface CollapseOptions {
  readonly units: readonly CollapseUnit[];
  readonly maxChars: number;
  /** Display known-time units newest-first without changing oldest-first demotion. */
  readonly renderOrder?: 'oldest_first' | 'newest_first';
  /** Range recovery command used by T4 rollups; falls back to the unit's own. */
  readonly rangeRecover?: string | null;
  /** Emitted when even the floor representation cannot fit. */
  readonly floorRecover?: string | null;
  /**
   * Optional recency floor (B7): the newest `recencyFloorK` units of kind
   * `recencyFloorKind` (e.g. the K newest lives) never demote below t1, so
   * pressure is absorbed by older units first. Applies only to units whose
   * sourceAt is known (unknown-time units are always demotable).
   */
  readonly recencyFloorK?: number;
  readonly recencyFloorKind?: CollapseUnitKind;
}

export interface CollapseUnitPlacement {
  readonly id: string;
  readonly tier: CollapseTier;
}

export interface CollapseResult {
  readonly text: string;
  /** True only when every unit rendered at T0. */
  readonly complete: boolean;
  readonly chars: number;
  readonly placements: readonly CollapseUnitPlacement[];
  readonly demotions: number;
  /** Units that could not fit even at their floor tier; explicit, never silent. */
  readonly droppedToFloorRollup: number;
  readonly tierCounts: Readonly<Record<CollapseTier, number>>;
}

const MIN_BACKFILL_CHARS = 2_000;
const BLOCK_SEPARATOR = '\n';
const QUARANTINE_BANNER = 'Unknown source time (quarantined; not part of the chronology):';

function isoOrUnknown(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : 'unknown';
}

function unitSpan(unit: CollapseUnit): string {
  const start = isoOrUnknown(unit.sourceAt);
  const end = isoOrUnknown(unit.sourceEndAt ?? unit.sourceAt);
  return `${start}..${end}`;
}

function oneLine(value: string, maxChars = 180): string {
  const flattened = value.replace(/\s+/gu, ' ').trim();
  if (flattened.length <= maxChars) return flattened;
  return `${flattened.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Exact T3 receipt line (spec §6). Minted only for verified, hashed targets. */
export function formatCollapseReceipt(unit: CollapseUnit): string {
  const sha = (unit.sha256 ?? '').slice(0, 12) || 'unknown';
  // A projection unit's `sha256` (when present) attests the STORED prefix only;
  // the source dimensions here prevent the receipt from reading as full-proof.
  const projection = unit.projection
    ? ` projection=${unit.projection.mode}/v${unit.projection.version}`
      + ` stored-chars=${unit.projection.storedChars} source-chars=${unit.projection.sourceChars}`
      + ` stored-bytes=${unit.projection.storedBytes} source-bytes=${unit.projection.sourceBytes}`
    : '';
  return `[RECEIPT kind=${unit.kind} id=${unit.id} span=${unitSpan(unit)}`
    + ` sha256=${sha} verbatim-chars-total=${unit.verbatim.length}${projection}`
    + ` claim="${oneLine(unit.claim, 160).replace(/"/gu, "'")}" recover=${unit.recover}]`;
}

/** Exact T4 rollup line (spec §6) covering N contiguous receipts. */
export function formatCollapseRollup(
  units: readonly CollapseUnit[],
  rangeRecover: string | null | undefined,
): string {
  const kinds = [...new Set(units.map((unit) => unit.kind))].sort();
  const times = units
    .map((unit) => unit.sourceAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const span = times.length > 0
    ? `${isoOrUnknown(times[0])}..${isoOrUnknown(times.at(-1))}`
    : 'unknown..unknown';
  const recover = rangeRecover || units[0]?.recover || 'unavailable';
  return `[ROLLUP kind=${kinds.join('+')} n=${units.length} span=${span} recover=${recover}]`;
}

/** T2 era block: one paragraph per contiguous era of demoted units. */
export function formatCollapseEraBlock(units: readonly CollapseUnit[]): string {
  const first = units[0];
  const times = units
    .map((unit) => unit.sourceAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const span = times.length > 0
    ? `${isoOrUnknown(times[0])}..${isoOrUnknown(times.at(-1))}`
    : 'unknown..unknown';
  const samples = units.slice(0, 3).map((unit) => `· ${oneLine(unit.claim, 140)}`);
  const chars = units.reduce((total, unit) => total + unit.verbatim.length, 0);
  return [
    `[ERA kind=${first.kind} key=${first.eraKey ?? first.kind} span=${span}`
    + ` n=${units.length} verbatim-chars-total=${chars} recover=${first.recover}]`,
    ...samples,
    units.length > samples.length ? `· … ${units.length - samples.length} more in this era` : '',
  ].filter(Boolean).join('\n');
}

function compareUnits(left: CollapseUnit, right: CollapseUnit): number {
  const leftMs = left.sourceAt ? Date.parse(left.sourceAt) : Number.NaN;
  const rightMs = right.sourceAt ? Date.parse(right.sourceAt) : Number.NaN;
  const leftKnown = Number.isFinite(leftMs);
  const rightKnown = Number.isFinite(rightMs);
  if (leftKnown && rightKnown && leftMs !== rightMs) return leftMs - rightMs;
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  return left.id.localeCompare(right.id);
}

/** A unit's demotion floor, mint-gate aware (B7). */
function floorTier(unit: CollapseUnit): CollapseTier {
  // Verified, hashed units may demote all the way to a T4 rollup. Unverified
  // units may ALSO roll up to T4 (a rollup names only span+count+recover and
  // mints no per-unit hash, so the "never mint a dead pointer" rationale is
  // preserved) but must SKIP the T3 receipt tier (a receipt mints a per-unit
  // hash, which an unverified unit cannot attest). Both floor at T4.
  return 't4';
}

function nextTier(tier: CollapseTier, skipReceipt = false): CollapseTier | null {
  const index = COLLAPSE_TIERS.indexOf(tier);
  if (index < 0 || index >= COLLAPSE_TIERS.length - 1) return null;
  // B7 mint-gate split: an unverified unit skips the T3 receipt tier (a receipt
  // mints a per-unit hash an unverified unit cannot attest) and rolls straight
  // to T4 (a rollup names only span+count+recover, so it is safe).
  if (skipReceipt && tier === 't2') return 't4';
  return COLLAPSE_TIERS[index + 1];
}

function previousTier(tier: CollapseTier): CollapseTier | null {
  const index = COLLAPSE_TIERS.indexOf(tier);
  return index > 0 ? COLLAPSE_TIERS[index - 1] : null;
}

interface RenderState {
  /** Provider-visible order for known-time units. */
  readonly known: readonly CollapseUnit[];
  /** Oldest-first order used exclusively for tier demotion. */
  readonly demotionKnown: readonly CollapseUnit[];
  readonly unknown: readonly CollapseUnit[];
  readonly tiers: Map<string, CollapseTier>;
  /**
   * Unit ids protected by the B7 recency floor (never demote below t1). Mutable:
   * the audit-2 A14 floor-overflow path clears it when the section cannot fit
   * under cap with protected digests, then lets protected units demote.
   */
  recencyProtectedIds: Set<string>;
}

function renderRun(
  units: readonly CollapseUnit[],
  tier: CollapseTier,
  rangeRecover: string | null | undefined,
): string {
  switch (tier) {
    case 't0':
      return units.map((unit) => unit.verbatim).join(BLOCK_SEPARATOR);
    case 't1':
      return units.map((unit) => unit.digest).join(BLOCK_SEPARATOR);
    case 't2':
      return formatCollapseEraBlock(units);
    case 't3':
      return units.map(formatCollapseReceipt).join(BLOCK_SEPARATOR);
    case 't4':
    default:
      return formatCollapseRollup(units, rangeRecover);
  }
}

/**
 * Fuse the chronological unit sequence into runs. Adjacent units sharing a tier
 * fuse when that tier is aggregate (t2 era blocks fuse per era key; t4 rollups
 * fuse per kind). Non-aggregate tiers render per unit.
 */
function renderSequence(
  units: readonly CollapseUnit[],
  tiers: ReadonlyMap<string, CollapseTier>,
  rangeRecover: string | null | undefined,
): string {
  const blocks: string[] = [];
  let run: CollapseUnit[] = [];
  let runTier: CollapseTier | null = null;
  let runKey: string | null = null;

  const flush = (): void => {
    if (run.length === 0 || !runTier) return;
    blocks.push(renderRun(run, runTier, rangeRecover));
    run = [];
    runTier = null;
    runKey = null;
  };

  for (const unit of units) {
    const tier = tiers.get(unit.id) ?? 't0';
    const aggregate = tier === 't2' || tier === 't4';
    const key = tier === 't2' ? `${unit.kind}\0${unit.eraKey ?? unit.kind}` : unit.kind;
    if (aggregate && runTier === tier && runKey === key) {
      run.push(unit);
      continue;
    }
    flush();
    run = [unit];
    runTier = tier;
    runKey = aggregate ? key : `${unit.id}`;
    if (!aggregate) flush();
  }
  flush();
  return blocks.filter((block) => block.length > 0).join(BLOCK_SEPARATOR);
}

function renderState(state: RenderState, rangeRecover: string | null | undefined): string {
  const chronological = renderSequence(state.known, state.tiers, rangeRecover);
  if (state.unknown.length === 0) return chronological;
  const quarantined = renderSequence(state.unknown, state.tiers, rangeRecover);
  return [chronological, '', QUARANTINE_BANNER, quarantined]
    .filter((block, index) => index === 1 || block.length > 0)
    .join(BLOCK_SEPARATOR);
}

/**
 * Demotion order: unknown-time units first (they can claim no recency), then
 * the oldest known-time unit. Units never skip a tier in one step (except the
 * B7 mint-gate split where an unverified unit skips the T3 receipt), and a
 * unit stops at its effective floor: the B7 recency floor (newest-K lives never
 * below t1) or the mint-gate floor (t4 rollup) otherwise.
 */
function effectiveFloor(unit: CollapseUnit, state: RenderState): CollapseTier {
  if (state.recencyProtectedIds.has(unit.id)) {
    const current = state.tiers.get(unit.id) ?? 't0';
    // The newest-K lives never demote below t1: if already at/below t1 (t0 or
    // t1) their floor is t1; otherwise keep their current (higher) tier where
    // it is, since only demotion can move them and the floor check compares
    // against the current tier.
    const currentIndex = COLLAPSE_TIERS.indexOf(current);
    const t1Index = COLLAPSE_TIERS.indexOf('t1');
    return currentIndex <= t1Index ? 't1' : current;
  }
  return floorTier(unit);
}

function nextDemotionCandidate(state: RenderState): CollapseUnit | null {
  for (const unit of state.unknown) {
    const tier = state.tiers.get(unit.id) ?? 't0';
    if (tier !== effectiveFloor(unit, state)) return unit;
  }
  for (const unit of state.demotionKnown) {
    const tier = state.tiers.get(unit.id) ?? 't0';
    if (tier !== effectiveFloor(unit, state)) return unit;
  }
  return null;
}

export function collapseUnits(options: CollapseOptions): CollapseResult {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const sorted = [...options.units].sort(compareUnits);
  const demotionKnown = sorted.filter((unit) => unit.sourceAt);
  const known = options.renderOrder === 'newest_first'
    ? [...demotionKnown].reverse()
    : demotionKnown;
  const unknown = sorted.filter((unit) => !unit.sourceAt);
  // Deliberate start tiers (audit-2 A25): a unit that declares `startTier`
  // begins at that tier instead of t0 — deliberate decay that pressure may
  // deepen but adaptive backfill never reverses past the declared tier.
  const tiers = new Map<string, CollapseTier>(sorted.map((unit) => (
    [unit.id, unit.startTier && COLLAPSE_TIERS.includes(unit.startTier) ? unit.startTier : 't0' as CollapseTier]
  )));
  // B7 recency floor: the newest K units of the named kind are protected from
  // demoting below t1, so the OLDEST units absorb floor pressure first.
  const recencyFloorK = Math.max(0, Math.floor(options.recencyFloorK ?? 0));
  const recencyKind = options.recencyFloorKind;
  const demotionKnownByTime = [...demotionKnown];
  let recencyProtectedIds = new Set<string>();
  if (recencyFloorK > 0 && recencyKind) {
    const eligible = demotionKnownByTime
      .filter((unit) => unit.kind === recencyKind)
      .sort(compareUnits)
      .slice(-recencyFloorK);
    recencyProtectedIds = new Set(eligible.map((unit) => unit.id));
  }
  const state: RenderState = {
    known,
    demotionKnown,
    unknown,
    tiers,
    recencyProtectedIds,
  };

  if (sorted.length === 0) {
    return {
      text: '',
      complete: true,
      chars: 0,
      placements: [],
      demotions: 0,
      droppedToFloorRollup: 0,
      tierCounts: { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0 },
    };
  }

  let text = renderState(state, options.rangeRecover);
  let demotions = 0;
  // Each unit can be demoted at most COLLAPSE_TIERS.length - 1 times, so this
  // loop is bounded by construction and always terminates.
  const demotionCeiling = sorted.length * (COLLAPSE_TIERS.length - 1);
  // Audit-2 A14 repair: demote in SMALL exact-re-render batches, never on the
  // per-unit estimate alone. The old estimator accumulated
  // `max(1, per-unit size delta)` until it covered the overflow; for units
  // whose per-unit receipt/rollup representation is no smaller than their
  // verbatim (short episodes, small operator rows), every step "saved" only 1
  // estimated char while the REAL savings only materialize when the exact
  // re-render fuses whole runs into era blocks and rollups. The estimator
  // therefore demoted every unit to its floor before the exact re-render
  // showed a single ~680-char rollup fit under a 5k partition — zero chapters
  // retained per-row. Exact re-render after every bounded batch makes the
  // measured text the authority again: the batch can never demote more than
  // `MAX_DEMOTIONS_PER_BATCH` units past the point where the section fits, and
  // each re-render is cheap because batches are small.
  const MAX_DEMOTIONS_PER_BATCH = 8;
  while (text.length > maxChars && demotions < demotionCeiling) {
    let applied = 0;
    while (applied < MAX_DEMOTIONS_PER_BATCH && demotions < demotionCeiling) {
      const candidate = nextDemotionCandidate(state);
      if (!candidate) break;
      const current = tiers.get(candidate.id) ?? 't0';
      // B7 mint-gate split: unverified units skip the T3 receipt tier and roll
      // straight to T4. Verified units walk every tier normally.
      const demoted = nextTier(current, candidate.verified !== true);
      if (!demoted) break;
      tiers.set(candidate.id, demoted);
      demotions += 1;
      applied += 1;
    }
    if (applied === 0) break;
    text = renderState(state, options.rangeRecover);
  }
  // Recency-floor overflow (audit-2 A14 gate fix): when demotion has exhausted
  // every DEMOTABLE unit but the text still exceeds maxChars because newest-K
  // recency-protected units are pinned at their digest floor (t1), the floor is
  // a PRESSURE PREFERENCE, not a hard promise. Continuing to ship > maxChars
  // would let this section overrun its declared cap and character-truncate a
  // trailing ledger/recover handle mid-token (the executed-handle invariant:
  // every advertised handle stays whole). So when the loop above terminates
  // over budget, we release the recency floor and let the protected units
  // demote too — so the existing floor-pressure rollup below can fit under
  // maxChars exactly as it does for non-recency sections. A recency floor
  // reverts to a single rollup rather than a cap-over-shipped truncation.
  if (text.length > maxChars && state.recencyProtectedIds.size > 0) {
    const protectedUnits = sorted.filter((unit) => state.recencyProtectedIds.has(unit.id));
    state.recencyProtectedIds = new Set();
    for (const unit of protectedUnits) {
      const current = tiers.get(unit.id) ?? 't0';
      const demoted = nextTier(current, unit.verified !== true);
      if (demoted) {
        tiers.set(unit.id, demoted);
        demotions += 1;
      }
    }
    text = renderState(state, options.rangeRecover);
    // Finish walking every unit to its true floor until the section fits.
    while (text.length > maxChars && demotions < demotionCeiling) {
      let applied = 0;
      while (applied < MAX_DEMOTIONS_PER_BATCH && demotions < demotionCeiling) {
        const candidate = nextDemotionCandidate(state);
        if (!candidate) break;
        const current = tiers.get(candidate.id) ?? 't0';
        const demoted = nextTier(current, candidate.verified !== true);
        if (!demoted) break;
        tiers.set(candidate.id, demoted);
        demotions += 1;
        applied += 1;
      }
      if (applied === 0) break;
      text = renderState(state, options.rangeRecover);
    }
  }

  let droppedToFloorRollup = 0;
  if (text.length > maxChars) {
    // Floor pressure: every unit is already at its floor and still overflows.
    // Degrade to a single honest rollup line (spec §8). NEVER character-slice a
    // rollup here: its `recover=` may carry a full executable ledger command,
    // and cutting it mid-token advertises a corrupt pointer (the executed-handle
    // invariant — "ledger fetch handle without owner"). If the recover-bearing
    // rollup cannot fit a positive cap, emit a whole census rollup WITHOUT a
    // recover=` command token — never `recover=none` (which the schema layer
    // rejects as a tool) and never a partial handle. The ledger recovery route
    // lives in the `[COLLAPSE ...]` receipt the caller appends / the recovery
    // index, so a recover-less census line stays truthful and handle-safe.
    droppedToFloorRollup = sorted.length;
    const rollup = formatCollapseRollup(sorted, options.floorRecover ?? options.rangeRecover);
    if (rollup.length <= maxChars || maxChars === 0) {
      text = rollup;
    } else {
      const kinds = [...new Set(sorted.map((unit) => unit.kind))].sort().join('+');
      let compact = `[ROLLUP kind=${kinds} n=${sorted.length}]`;
      if (compact.length > maxChars || maxChars === 0) compact = `[ROLLUP n=${sorted.length}]`;
      // `recover=` is deliberately absent: the command could not fit whole and
      // a partial `recover=` would be harvested as a corrupt executable handle.
      // The recovery route stays in the caller's appended receipt / index.
      text = compact;
    }
  }
  const tierCounts: Record<CollapseTier, number> = { t0: 0, t1: 0, t2: 0, t3: 0, t4: 0 };
  for (const unit of sorted) tierCounts[tiers.get(unit.id) ?? 't0'] += 1;

  return {
    text,
    complete: demotions === 0 && droppedToFloorRollup === 0,
    chars: text.length,
    placements: sorted.map((unit) => ({ id: unit.id, tier: tiers.get(unit.id) ?? 't0' })),
    demotions,
    droppedToFloorRollup,
    tierCounts,
  };
}

export interface AdaptiveBackfillSection<TId extends string = string> {
  readonly id: TId;
  readonly units: readonly CollapseUnit[];
  readonly baseCap: number;
  readonly rangeRecover?: string | null;
  readonly floorRecover?: string | null;
}

export interface AdaptiveBackfillGrant<TId extends string = string> {
  readonly id: TId;
  readonly cap: number;
  readonly granted: number;
  readonly result: CollapseResult;
}

export interface AdaptiveBackfillOutcome<TId extends string = string> {
  readonly grants: readonly AdaptiveBackfillGrant<TId>[];
  readonly spareRemaining: number;
  readonly rounds: number;
}

/**
 * Adaptive Backfill (spec §7): unspent global budget is redistributed in
 * priority order, promoting the newest demoted unit one tier per pass and
 * round-robining across sections after each full pass. Stops when the remaining
 * pool falls below the fragmentation guard.
 *
 * Implemented as a cap grant rather than a mutation of tier state: granting a
 * section the exact chars its next promotion needs makes collapseUnits produce
 * that promotion deterministically, so the result is identical to promoting in
 * place and stays byte-reproducible from (units, caps).
 */
export function adaptiveBackfill<TId extends string = string>(
  sections: readonly AdaptiveBackfillSection<TId>[],
  spareChars: number,
  options: { readonly minChunk?: number; readonly maxRounds?: number } = {},
): AdaptiveBackfillOutcome<TId> {
  const minChunk = Math.max(1, options.minChunk ?? MIN_BACKFILL_CHARS);
  const maxRounds = Math.max(0, options.maxRounds ?? 64);
  const granted = new Map<TId, number>(sections.map((section) => [section.id, 0]));
  const evaluate = (section: AdaptiveBackfillSection<TId>): CollapseResult => collapseUnits({
    units: section.units,
    maxChars: section.baseCap + (granted.get(section.id) ?? 0),
    rangeRecover: section.rangeRecover ?? null,
    floorRecover: section.floorRecover ?? null,
  });

  let spare = Math.max(0, Math.floor(spareChars));
  let rounds = 0;
  let results = new Map<TId, CollapseResult>(
    sections.map((section) => [section.id, evaluate(section)]),
  );

  while (spare >= minChunk && rounds < maxRounds) {
    let promotedThisRound = false;
    for (const section of sections) {
      if (spare < minChunk) break;
      const current = results.get(section.id)!;
      if (current.complete) continue;
      const cost = promotionCost(section, current, granted.get(section.id) ?? 0);
      if (cost === null || cost > spare) continue;
      granted.set(section.id, (granted.get(section.id) ?? 0) + cost);
      spare -= cost;
      results.set(section.id, evaluate(section));
      promotedThisRound = true;
    }
    rounds += 1;
    if (!promotedThisRound) break;
  }

  results = new Map(sections.map((section) => [section.id, evaluate(section)]));
  return {
    grants: sections.map((section) => ({
      id: section.id,
      cap: section.baseCap + (granted.get(section.id) ?? 0),
      granted: granted.get(section.id) ?? 0,
      result: results.get(section.id)!,
    })),
    spareRemaining: spare,
    rounds,
  };
}

/**
 * Chars required to promote a section's newest demoted unit exactly one tier.
 * Newest-first promotion (spec §7.2). Returns null when nothing can be promoted.
 */
function promotionCost<TId extends string>(
  section: AdaptiveBackfillSection<TId>,
  current: CollapseResult,
  alreadyGranted: number,
): number | null {
  const byId = new Map(section.units.map((unit) => [unit.id, unit]));
  const demoted = current.placements.filter((placement) => placement.tier !== 't0');
  if (demoted.length === 0) return null;
  // placements are chronological; scan newest-first for the newest demoted unit
  // that CAN be promoted — a deliberate-start unit (audit-2 A25) is never
  // promoted above its declared startTier, so units parked at their start tier
  // are skipped in favor of genuinely pressure-demoted younger units.
  for (const target of [...demoted].reverse()) {
    const unit = byId.get(target.id);
    if (!unit) continue;
    const startTier = unit.startTier && COLLAPSE_TIERS.includes(unit.startTier) ? unit.startTier : null;
    const promoted = previousTier(target.tier);
    if (!promoted) continue;
    if (startTier && COLLAPSE_TIERS.indexOf(promoted) < COLLAPSE_TIERS.indexOf(startTier)) continue;
    const probeUnits = section.units;
    const cap = section.baseCap + alreadyGranted;
    // Grow the cap until the target unit actually reaches the promoted tier.
    // The step is the measured size delta of that unit's own representation,
    // so the search converges in a couple of probes instead of scanning char
    // by char.
    const sizeAt = (tier: CollapseTier): number => renderRun([unit], tier, section.rangeRecover ?? null).length;
    let step = Math.max(1, sizeAt(promoted) - sizeAt(target.tier));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const probeCap = cap + step;
      const probe = collapseUnits({
        units: probeUnits,
        maxChars: probeCap,
        rangeRecover: section.rangeRecover ?? null,
        floorRecover: section.floorRecover ?? null,
      });
      const placed = probe.placements.find((placement) => placement.id === unit.id);
      if (placed && COLLAPSE_TIERS.indexOf(placed.tier) <= COLLAPSE_TIERS.indexOf(promoted)) {
        return step;
      }
      step *= 2;
    }
  }
  return null;
}

export const GENERATIONAL_COLLAPSE_MIN_BACKFILL_CHARS = MIN_BACKFILL_CHARS;
export const GENERATIONAL_COLLAPSE_QUARANTINE_BANNER = QUARANTINE_BANNER;
