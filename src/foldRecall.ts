/**
 * Fold Recall — ambient page-in for folded context.
 *
 * The rolling fold pages content OUT of context (inter-turn turn skeletons,
 * intra-turn folded tool results); this module pages it back IN when current
 * activity proves it relevant again. Ambient-Atlas-style discipline applied
 * to the fold: tiered relevance triggers, TTL'd residency dedupe, a
 * context-pressure budget ladder, and deterministic rendering.
 *
 * ── Shape ──
 * - The fold INDEX is the page table. It is rebuilt ONLY at fold-freeze epoch
 *   commits (the only moments the folded view changes): inter-turn entries by
 *   replaying the deterministic turn detection over raw history and reading
 *   the folded-view fold blocks' "N turns folded" counts (summed in view order —
 *   FC append-only tail epochs seal one fold block per band); intra-turn
 *   entries by scanning the folded view for the fold's own
 *   "[Folded: tool path — n,nnn chars | self-tap to recover]" markers, keyed
 *   by provider tool ids (tool_use_id / tool_call_id) as recovery handles.
 * - TRIGGERS (tool-boundary only): tier 0 = a tool call re-touches a folded
 *   path; tier 1 = a file claim lands on a folded path. Tier 2 distinctive-term
 *   overlap is default ON after rail-c63e326e A/B; disable with
 *   WARP_FOLD_RECALL_TERMS=0|false|off|no.
 * - INJECTION: the session appends rendered cards/hints to the tool result's
 *   post-dispatch context (the same channel as tool-boundary mesh digest
 *   deltas; payloads are body-only strings). Cards land durably in raw
 *   history, APPEND-ONLY, riding the freeze tail — the frozen prefix stays
 *   byte-identical, the provider prompt cache stays HOT, and recall never
 *   forces an epoch.
 * - PAGE-OUT-AGAIN: cards/hints carry RECALL_CARD_PREFIX / RECALL_HINT_PREFIX,
 *   which rollingFold treats as synthetic (never a turn boundary); at the
 *   next epoch the card's turn refolds and the body leaves the view again.
 *   Fully cyclic: content breathes in and out of context on demand.
 *
 * Pure CPU, zero I/O, zero LLM calls, no clock reads. Deterministic by
 * construction: identical inputs produce byte-identical output, and no
 * Set/Map iteration order is observable in any rendered string (entries are
 * explicitly ordered: tier asc, signal class, optional intent relevance,
 * legacy tier-2 relevance, recency desc, id asc).
 *
 * Kill switch: WARP_FOLD_RECALL=0. Recall only ever runs when fold mode is
 * 'on' and the fold freeze is active — no fold, no index, no recall.
 */

import {
  ALWAYS_ON_FOLD_CONFIG,
  classifyTurn,
  countChars,
  DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS,
  detectTurns,
  extractAssistantText,
  extractPath,
  extractToolPathSet,
  foldMessageSourceIdentities,
  isSyntheticContextText,
  nominateVerbatim,
  normalizeToolPath,
  RECALL_CARD_PREFIX,
  RECALL_HINT_PREFIX,
  stripSyntheticUserContextBlocks,
  type FoldMessage,
  type SyntheticContextOptions,
  type Turn,
  type TurnCategory,
} from './rollingFold.ts';
import type { ContextUtilizationLevel } from './contextWindow.ts';
import { extractDistinctiveTerms, idfFromDocumentFrequency, scoreTermOverlap } from './foldTerms.ts';
import {
  foldMessageTimestampBounds,
  renderChronologicalProvenanceCompact,
} from './chronologicalProvenance.ts';
import {
  extractCognitiveSupersessionPointers,
  type CognitiveSupersessionPointer,
} from './glyphs.ts';

// ══════════════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════════════

export interface FoldRecallConfig {
  /** Master switch (WARP_FOLD_RECALL). Default ON when fold mode is 'on'. */
  enabled: boolean;
  /** Max full-content cards injected per pass (healthy pressure). */
  maxCards: number;
  /** Max total recall chars (cards + hints) injected per pass. */
  maxTotalChars: number;
  /** Max chars per card body (char-safe head+tail excerpt beyond this). */
  maxCardChars: number;
  /** Residency TTL in recall passes — an injected entry is suppressed for this many subsequent passes. */
  ttlPasses: number;
  /** Tier-2 distinctive-term matching. Default ON after A/B; path tiers stay unchanged. */
  termRecallEnabled: boolean;
  /**
   * Exact verbatim-token page-in (WARP_FOLD_RECALL_VERBATIM). When a kept
   * identifier (a hash/UUID conserved by the Coordinate Closet) re-surfaces in the
   * active window, its source turn pages back in. A single EXACT match suffices
   * (vs the ≥2 fuzzy-term gate). Default ON (operator-blessed, Jonah 2026-06-14);
   * set WARP_FOLD_RECALL_VERBATIM=0 for byte-identical legacy behavior. Path/
   * claim tiers still outrank.
   */
  verbatimRecallEnabled: boolean;
  /** Exact normalized error-signature recall. Default ON; explicit off restores legacy. */
  errorRecallEnabled?: boolean;
  /** Emit asynchronous spool RecallIntents for strong triggers. Default ON. */
  autonomicSpoolRecallEnabled?: boolean;
  /**
   * Curated Code Radar — source-highlight guideposts (WARP_FOLD_RECALL_HIGHLIGHTS).
   * Prepends Atlas-curated `⌖ label (a–b)` lines to a recall card so the agent
   * sees the file's key regions the moment it pages back in. Default ON
   * (operator-blessed, Jonah 2026-06-17). Renders only when enrichment is
   * resident in FoldRecallState; absence is byte-identical to legacy recall.
   */
  highlightsEnabled: boolean;
  /**
   * Curated Code Radar — hazard guideposts (WARP_FOLD_RECALL_HAZARDS).
   * Prepends Atlas-curated `⚠️ text (L85)` lines (hazard-first, above highlights)
   * so a hazard the agent is about to trip surfaces on re-touch. Default ON
   * (operator-blessed, Jonah 2026-06-17). Same residency/byte-identity contract.
   */
  hazardsEnabled: boolean;
  /**
   * Episodic voice carriers (WARP_FOLD_RECALL_EPISODES).
   * Prepends self-lineage episode voice lines for recalled paths. Default ON.
   * Same residency/byte-identity contract.
   */
  episodesEnabled: boolean;
  /**
   * Atlas identity metadata carrier (WARP_FOLD_RECALL_ATLAS_META).
   * Prepends purpose/blurb and tags for recalled paths. Default ON; renders
   * only when pathAtlasMeta is resident, so empty/missing remains byte-identical.
   */
  atlasMetaEnabled: boolean;
}

export const DEFAULT_FOLD_RECALL_CONFIG: FoldRecallConfig = {
  enabled: true,
  // Band-coupled: recall card budget grows inversely with the fold band (M).
  // As M shrinks toward low-band, recall must do MORE paging-in work to keep
  // the agent unblinded, so the default floor is 3, not 2. Full band-token
  // coupling (maxCards scales with measured bandTokens) is deferred to the
  // low-band phase; this raises the safe interim floor.
  // Override: WARP_FOLD_RECALL_MAX_CARDS.
  maxCards: 3,
  maxTotalChars: 12_000,
  maxCardChars: 6_000,
  // Residency TTL: 4 passes, not 8. With activeWindowTurns=1, content scrolls
  // out of the visible window after one turn; an 8-pass suppression created a
  // 7-pass dead zone where the marker was present but the card couldn't
  // re-show. 4 is the safer interim (tier-0 bypass also mitigates this now).
  // Override: WARP_FOLD_RECALL_TTL_PASSES.
  ttlPasses: 4,
  termRecallEnabled: true,
  verbatimRecallEnabled: true,
  errorRecallEnabled: true,
  autonomicSpoolRecallEnabled: true,
  highlightsEnabled: true,
  hazardsEnabled: true,
  episodesEnabled: true,
  atlasMetaEnabled: true,
};

/** Hints injected per pass never exceed this, regardless of pressure. */
const MAX_HINTS_PER_PASS = 4;

/** Normative recall-coverage contract shared by ambient and explicit recall. */
export const FOLD_RECALL_COMPLETENESS_CONTRACT_VERSION = 'fold-recall-completeness/v1' as const;

export type FoldRecallCompletenessRoute =
  | 'ambient-signal'
  | 'explicit-range'
  | 'explicit-path'
  | 'explicit-term'
  | 'explicit-waypoint'
  | 'explicit-episode'
  | 'host-hydration-intent';

export interface FoldRecallCompletenessGuarantee {
  id: 'C1' | 'C2' | 'C3' | 'C4';
  retrievableClass: 'folded-turn' | 'folded-tool-result' | 'spooled-artifact' | 'episode-ledger';
  granularity: string;
  freshness: string;
  routes: readonly FoldRecallCompletenessRoute[];
  budget:
    | 'active-config-bounded; shipped-defaults=3-items/12000-total/6000-body/4-hints; explicit-may-only-lower'
    | 'metadata-only-until-host-hydration; active-config-bounded';
}

/**
 * Executable half of the normative matrix in
 * docs/design/fold-atlas-hardening-contract.md. These are the only classes the
 * recall API guarantees. Optional host overlays remain explicitly outside it.
 */
export const FOLD_RECALL_COMPLETENESS_GUARANTEES = [
  {
    id: 'C1',
    retrievableClass: 'folded-turn',
    granularity: 'one indexed inter-turn raw-message range',
    freshness: 'index-membership-at-last-build; body-from-current-raw-reference-at-query',
    routes: ['ambient-signal', 'explicit-range', 'explicit-path', 'explicit-term', 'explicit-waypoint'],
    budget: 'active-config-bounded; shipped-defaults=3-items/12000-total/6000-body/4-hints; explicit-may-only-lower',
  },
  {
    id: 'C2',
    retrievableClass: 'folded-tool-result',
    granularity: 'one indexed provider tool-result identity',
    freshness: 'index-membership-at-last-build; body-from-current-raw-reference-at-query',
    routes: ['ambient-signal', 'explicit-range', 'explicit-path', 'explicit-term'],
    budget: 'active-config-bounded; shipped-defaults=3-items/12000-total/6000-body/4-hints; explicit-may-only-lower',
  },
  {
    id: 'C3',
    retrievableClass: 'spooled-artifact',
    granularity: 'one indexed artifact metadata-and-recovery handle; body only after host hydration',
    freshness: 'metadata-at-index-build; hydrated bytes require host hash verification',
    routes: ['ambient-signal', 'explicit-path', 'explicit-term', 'host-hydration-intent'],
    budget: 'metadata-only-until-host-hydration; active-config-bounded',
  },
  {
    id: 'C4',
    retrievableClass: 'episode-ledger',
    granularity: 'one deduplicated path-and-chapter episode voice row',
    freshness: 'last-host-enrichment-snapshot; endedAt-is-source-time-not-freshness-time',
    routes: ['ambient-signal', 'explicit-episode'],
    budget: 'active-config-bounded; shipped-defaults=3-items/12000-total/6000-body/4-hints; explicit-may-only-lower',
  },
] as const satisfies readonly FoldRecallCompletenessGuarantee[];

/** Claims intentionally excluded from v1; callers must not infer them. */
export const FOLD_RECALL_COMPLETENESS_NON_GUARANTEES = [
  'raw-tail-requery',
  'unindexed-or-unidentified-event-range',
  'semantic-waypoint-understanding',
  'synchronous-spooled-body-read',
  'optional-host-enrichment-availability',
  'invented-source-time',
  'field-level-withholding-inside-a-mixed-superseded-entry',
  'live-working-tree-source-freshness-without-a-source-delta',
] as const;
/**
 * A negative-feedback dismissal spans two recall pass coordinates. With the
 * shipped four-pass card TTL, the same exact entry can become eligible again
 * at pass +2 while its replaced residency would otherwise remain live until
 * pass +4. The window is deliberately fixed and shorter than residency: a
 * caller cannot turn feedback into the old long, unconditional dead zone.
 */
export const FOLD_RECALL_DISMISSAL_WINDOW_PASSES = 2;
/** Bound delayed UI feedback without retaining an unbounded exposure ledger. */
const MAX_FOLD_RECALL_CARD_EXPOSURES = 64;
/** Minimum remaining char budget worth spending on a card; below this, downgrade to hint. */
export const MIN_USEFUL_CARD_CHARS = 400;
/** Bounded lowercased per-turn digest length (reserved for deferred tier-2 term matching). */
const TURN_DIGEST_MAX_CHARS = 400;
const TERM_RECALL_MIN_DISTINCTIVE_COUNT = 2;
/**
 * Reserved gap subtracted from the remaining pass budget before sizing a card
 * body (see the bodyBudget computation in renderRecallPlan), so a rendered
 * card's trailing punctuation/metadata never exactly exhausts the pass
 * budget. Named + exported so validateFoldGeometry() shares the same source
 * of truth as the render path instead of duplicating the literal.
 */
export const RECALL_BODY_RESERVED_GAP_CHARS = 200;

/**
 * Repeat-recall card shrink (rail-c63e326e s6). A path that has already been
 * carded once or more this session and has NOT changed content since (see
 * `RecallSourceDelta.stableSincePrior`, or no live-source info at all — the
 * folded historical entry itself is fixed regardless of live source
 * tracking) does not need the full body budget again: the agent has already
 * seen it. Each repeat multiplies the available body budget by this ratio,
 * floored at REPEAT_CARD_MIN_RATIO so a card never shrinks to uselessness —
 * MIN_USEFUL_CARD_CHARS still governs the eventual card→hint downgrade.
 */
export const REPEAT_CARD_SHRINK_RATIO = 0.6;
/** Floor on the cumulative shrink multiplier — never shrink a repeat card below 35% of its unshrunk budget. */
export const REPEAT_CARD_MIN_RATIO = 0.35;

/**
 * Pure arithmetic: the body-budget multiplier for the (priorShowCount+1)-th
 * card injection of the same path this session. priorShowCount=0 (first-ever
 * card for this path) → 1 (no shrink). Deterministic, no I/O.
 */
export function repeatCardBudgetRatio(priorShowCount: number): number {
  if (priorShowCount <= 0) return 1;
  return Math.max(REPEAT_CARD_MIN_RATIO, REPEAT_CARD_SHRINK_RATIO ** priorShowCount);
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ══════════════════════════════════════════════════════════════════════
// Fold geometry invariant checker (rail-c63e326e s2)
// ══════════════════════════════════════════════════════════════════════

/**
 * Historical bug: ttlPasses=8 vs activeWindowTurns=1 (buffer=7) created a
 * 7-pass recall dead zone where a folded marker was present but the card
 * could not re-show (rail-ed5588b5, fixed 2026-06-24; refined further by
 * rail-dccaa1a1 on 2026-07-02). The fix landed at ttlPasses=4 (buffer=3).
 * Ceiling is set with headroom above the fixed value for legitimate tuning,
 * while still catching a regression back toward the old buggy shape.
 */
export const MAX_TTL_DEADZONE_BUFFER_PASSES = 5;

export interface FoldGeometryInputs {
  /** Recall residency TTL in passes (FoldRecallConfig.ttlPasses). */
  ttlPasses: number;
  /** Inter-turn fold's guaranteed-verbatim window in turns (FoldConfig.activeWindowTurns). */
  activeWindowTurns: number;
  /** Fidelity-value eviction floor in turns (DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS or override). */
  recencyFloorTurns: number;
  /** FoldRecallConfig.maxTotalChars. */
  maxTotalChars: number;
  /** FoldRecallConfig.maxCardChars. */
  maxCardChars: number;
}

export interface FoldGeometryViolation {
  rule: 'ttl-deadzone' | 'recency-floor-below-window' | 'auto-compact-card-too-small';
  message: string;
}

/**
 * Pure cross-knob invariant checker for fold/recall geometry. Each rule
 * encodes a specific interaction class that has previously shipped as a live
 * dogfood regression (see file history for rail-ed5588b5 / rail-dccaa1a1)
 * before being caught and fixed by hand. This does not prove the geometry is
 * "correct" — it only catches a regression back toward a known-bad shape, or
 * flags a genuinely new bad combination in the same families. Violations are
 * data for the caller to log/assert on in dev/test; this function itself
 * never throws or logs, keeping it pure and safe to call from any context.
 */
export function validateFoldGeometry(inputs: FoldGeometryInputs): FoldGeometryViolation[] {
  const violations: FoldGeometryViolation[] = [];

  const ttlDeadZoneBuffer = inputs.ttlPasses - inputs.activeWindowTurns;
  if (ttlDeadZoneBuffer > MAX_TTL_DEADZONE_BUFFER_PASSES) {
    violations.push({
      rule: 'ttl-deadzone',
      message:
        `ttlPasses (${inputs.ttlPasses}) exceeds activeWindowTurns (${inputs.activeWindowTurns}) by ` +
        `${ttlDeadZoneBuffer} passes, beyond the ${MAX_TTL_DEADZONE_BUFFER_PASSES}-pass ceiling. This is the ` +
        `rail-ed5588b5 dead-zone bug class: content scrolls out of the visible window after activeWindowTurns ` +
        `but recall residency keeps suppressing re-injection for the rest of ttlPasses. Tier-0 path-touch bypass ` +
        `(rail-dccaa1a1) only mitigates active-file cases; other tiers stay blinded for the full buffer.`,
    });
  }

  if (inputs.recencyFloorTurns < inputs.activeWindowTurns) {
    violations.push({
      rule: 'recency-floor-below-window',
      message:
        `recencyFloorTurns (${inputs.recencyFloorTurns}) is below activeWindowTurns (${inputs.activeWindowTurns}) ` +
        `— the fidelity-value eviction floor would let turns evict before they even leave the ` +
        `guaranteed-verbatim active window.`,
    });
  }

  const autoCompactCharBudget = Math.min(800, inputs.maxTotalChars);
  const tier0EffectiveBodyChars = Math.min(inputs.maxCardChars, autoCompactCharBudget - RECALL_BODY_RESERVED_GAP_CHARS);
  if (tier0EffectiveBodyChars < MIN_USEFUL_CARD_CHARS) {
    violations.push({
      rule: 'auto-compact-card-too-small',
      message:
        `Under auto_compact pressure, the tier-0 floor's effective per-card body budget ` +
        `(min(maxCardChars=${inputs.maxCardChars}, autoCompactCharBudget=${autoCompactCharBudget} - ` +
        `${RECALL_BODY_RESERVED_GAP_CHARS}) = ${tier0EffectiveBodyChars}) falls below MIN_USEFUL_CARD_CHARS ` +
        `(${MIN_USEFUL_CARD_CHARS}). The one card recall reserves for the actively-edited path under maximum ` +
        `pressure would downgrade to an unhelpfully small stub exactly when the agent needs it most.`,
    });
  }

  return violations;
}

function foldGeometryInputsForRecallConfig(
  config: Pick<FoldRecallConfig, 'ttlPasses' | 'maxTotalChars' | 'maxCardChars'>,
): FoldGeometryInputs {
  return {
    ttlPasses: config.ttlPasses,
    activeWindowTurns: ALWAYS_ON_FOLD_CONFIG.activeWindowTurns,
    recencyFloorTurns: DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS,
    maxTotalChars: config.maxTotalChars,
    maxCardChars: config.maxCardChars,
  };
}

function foldGeometryEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> | undefined {
  return env ?? (typeof process !== 'undefined' ? process.env : undefined);
}

function shouldWarnFoldGeometry(env?: Record<string, string | undefined>): boolean {
  return (foldGeometryEnv(env)?.NODE_ENV ?? '') !== 'production';
}

const warnedFoldGeometryKeys = new Set<string>();

function warnFoldGeometryViolations(
  violations: readonly FoldGeometryViolation[],
  env: Record<string, string | undefined> | undefined,
  source: 'defaults' | 'resolveFoldRecallConfig',
): void {
  if (violations.length === 0 || !shouldWarnFoldGeometry(env)) return;
  for (const violation of violations) {
    const key = `${source}:${violation.rule}:${violation.message}`;
    if (warnedFoldGeometryKeys.has(key)) continue;
    warnedFoldGeometryKeys.add(key);
    // eslint-disable-next-line no-console
    console.warn(`[fold-geometry:${source}] ${violation.rule}: ${violation.message}`);
  }
}

/**
 * Dev/test-only self-check of shipped defaults. Env-resolved config is checked
 * inside resolveFoldRecallConfig(), so operator overrides cannot silently
 * recreate a known-bad geometry. Both paths warn instead of throwing and are
 * skipped in production.
 */
warnFoldGeometryViolations(
  validateFoldGeometry(foldGeometryInputsForRecallConfig(DEFAULT_FOLD_RECALL_CONFIG)),
  foldGeometryEnv(),
  'defaults',
);

/**
 * Resolve config from environment. Default ON (recall is already gated on
 * fold mode 'on' + an active fold-freeze index upstream).
 *   WARP_FOLD_RECALL=0|false|off|no       → disable
 *   WARP_FOLD_RECALL_MAX_CARDS=<n>        → cards per pass (default 3; band-coupled)
 *   WARP_FOLD_RECALL_MAX_TOTAL_CHARS=<n>  → total chars per pass (default 12000)
 *   WARP_FOLD_RECALL_MAX_CARD_CHARS=<n>   → chars per card body (default 6000)
 *   WARP_FOLD_RECALL_TTL_PASSES=<n>       → residency TTL in passes (default 4)
 *   WARP_FOLD_RECALL_TERMS=0|false|off|no → disable tier-2 term matching (default ON)
 *   WARP_FOLD_RECALL_VERBATIM=0|false|off|no → disable exact verbatim-token tier (default ON)
 *   WARP_FOLD_RECALL_ERRORS=0|false|off|no → disable exact error-signature tier (default ON)
 *   WARP_FOLD_RECALL_AUTONOMIC_SPOOL=0|false|off|no → keep hints but disable hydration intents
 *   WARP_FOLD_RECALL_HIGHLIGHTS=0|false|off|no → disable source-highlight radar (default ON)
 *   WARP_FOLD_RECALL_HAZARDS=0|false|off|no → disable hazard radar (default ON)
 *   WARP_FOLD_RECALL_EPISODES=0|false|off|no → disable episodic voice (default ON)
 *   WARP_FOLD_RECALL_ATLAS_META=0|false|off|no → disable Atlas identity meta (default ON)
 * Every WARP_* key also accepts the legacy VOXXO_* spelling. When both are
 * present, WARP_* wins (including an explicitly empty value).
 */
export function resolveFoldRecallConfig(
  env: Record<string, string | undefined> = process.env,
): FoldRecallConfig {
  const readEnv = (suffix: string): string | undefined =>
    env[`WARP_FOLD_RECALL${suffix}`] ?? env[`VOXXO_FOLD_RECALL${suffix}`];
  const normalizedEnv = (suffix: string): string => (readEnv(suffix) ?? '').trim().toLowerCase();
  const raw = normalizedEnv('');
  const enabled = raw === '' || (raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no');
  const termRaw = normalizedEnv('_TERMS');
  const verbatimRaw = normalizedEnv('_VERBATIM');
  const errorRaw = normalizedEnv('_ERRORS');
  const autonomicSpoolRaw = normalizedEnv('_AUTONOMIC_SPOOL');
  const highlightsRaw = normalizedEnv('_HIGHLIGHTS');
  const hazardsRaw = normalizedEnv('_HAZARDS');
  const episodesRaw = normalizedEnv('_EPISODES');
  const atlasMetaRaw = normalizedEnv('_ATLAS_META');
  const config: FoldRecallConfig = {
    enabled,
    maxCards: parsePositiveInt(readEnv('_MAX_CARDS')) ?? DEFAULT_FOLD_RECALL_CONFIG.maxCards,
    maxTotalChars: parsePositiveInt(readEnv('_MAX_TOTAL_CHARS')) ?? DEFAULT_FOLD_RECALL_CONFIG.maxTotalChars,
    maxCardChars: parsePositiveInt(readEnv('_MAX_CARD_CHARS')) ?? DEFAULT_FOLD_RECALL_CONFIG.maxCardChars,
    ttlPasses: parsePositiveInt(readEnv('_TTL_PASSES')) ?? DEFAULT_FOLD_RECALL_CONFIG.ttlPasses,
    // Tier-2 term recall passed rail-c63e326e A/B: default ON; only explicit
    // disable values turn it off. Same default-on idiom as verbatim recall.
    termRecallEnabled:
      termRaw === '' || (termRaw !== '0' && termRaw !== 'false' && termRaw !== 'off' && termRaw !== 'no'),
    // Default ON (operator-blessed); only explicit disable values turn it off.
    verbatimRecallEnabled:
      verbatimRaw === '' || (verbatimRaw !== '0' && verbatimRaw !== 'false' && verbatimRaw !== 'off' && verbatimRaw !== 'no'),
    errorRecallEnabled:
      errorRaw === '' || (errorRaw !== '0' && errorRaw !== 'false' && errorRaw !== 'off' && errorRaw !== 'no'),
    autonomicSpoolRecallEnabled:
      autonomicSpoolRaw === '' || (autonomicSpoolRaw !== '0' && autonomicSpoolRaw !== 'false' && autonomicSpoolRaw !== 'off' && autonomicSpoolRaw !== 'no'),
    // Curated Code Radar (operator-blessed, Jonah 2026-06-17): both default ON;
    // only explicit 0/false/off/no disable. Same idiom as verbatimRecallEnabled.
    highlightsEnabled:
      highlightsRaw === '' || (highlightsRaw !== '0' && highlightsRaw !== 'false' && highlightsRaw !== 'off' && highlightsRaw !== 'no'),
    hazardsEnabled:
      hazardsRaw === '' || (hazardsRaw !== '0' && hazardsRaw !== 'false' && hazardsRaw !== 'off' && hazardsRaw !== 'no'),
    // Episodic voice: default ON; only explicit 0/false/off/no disable.
    episodesEnabled:
      episodesRaw === '' || (episodesRaw !== '0' && episodesRaw !== 'false' && episodesRaw !== 'off' && episodesRaw !== 'no'),
    // Atlas identity meta: default ON; only explicit 0/false/off/no disable.
    atlasMetaEnabled:
      atlasMetaRaw === '' || (atlasMetaRaw !== '0' && atlasMetaRaw !== 'false' && atlasMetaRaw !== 'off' && atlasMetaRaw !== 'no'),
  };
  warnFoldGeometryViolations(
    validateFoldGeometry(foldGeometryInputsForRecallConfig(config)),
    env,
    'resolveFoldRecallConfig',
  );
  return config;
}

// ══════════════════════════════════════════════════════════════════════
// Bash path extraction
// ══════════════════════════════════════════════════════════════════════

const BASH_TOOL_NAME_RE = /^(run_bash|bash)$/i;
const COMPACT_TOOL_TRACE_RE = /⟨tool\s+(?!result\b)[^\s⟩]+(?:\s+([^⟩]+))?⟩/g;
const COMPACT_TRACE_PATH_RE = /"(file_path|path|filePath|file)"\s*:\s*"((?:\\.|[^"\\])+)"/g;

/** Quote-aware shell tokenizer. Honors '...' and "..." as single tokens. */
function tokenizeShell(cmd: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    while (i < cmd.length && (cmd[i] === ' ' || cmd[i] === '\t' || cmd[i] === '\n' || cmd[i] === '\r')) i++;
    if (i >= cmd.length) break;
    let token = '';
    while (i < cmd.length && cmd[i] !== ' ' && cmd[i] !== '\t' && cmd[i] !== '\n' && cmd[i] !== '\r') {
      const ch = cmd[i];
      if (ch === "'") {
        i++;
        while (i < cmd.length && cmd[i] !== "'") token += cmd[i++];
        if (i < cmd.length) i++;
      } else if (ch === '"') {
        i++;
        while (i < cmd.length && cmd[i] !== '"') {
          if (cmd[i] === '\\' && i + 1 < cmd.length) i++;
          token += cmd[i++];
        }
        if (i < cmd.length) i++;
      } else {
        token += ch;
        i++;
      }
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

/** Raw path spellings accepted by the bounded bash-token parser. */
export function extractPathSpellingsFromBashCommand(command: string): string[] {
  const tokens = tokenizeShell(command);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tokens) {
    if (result.length >= 4) break;
    const token = raw.replace(/[;:,)"']+$/, '');
    if (!token) continue;
    if (!token.includes('/')) continue;
    if (token.includes('://')) continue;
    if (token.startsWith('-')) continue;
    if (/[<>]/.test(token)) continue;
    if (token.length > 256) continue;
    if (token === '/dev' || token.startsWith('/dev/')) continue;
    if (!seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

/**
 * Extract file paths from a bash command string.
 *
 * Quote-aware tokenize; a token qualifies if: it contains '/', does not
 * contain '://', does not start with '-', contains no shell redirect chars
 * (`<`/`>`), is not a `/dev/...` device path, and length ≤ 256. Trailing
 * punctuation (;:,)"') is stripped before qualifying. First-occurrence order,
 * deduped, capped at 4 paths per command. Each result is normalized with
 * normalizeToolPath — identical to structured-tool path normalization.
 * The raw parser above remains available so repo-qualified absolute identity
 * survives beside this compatibility alias.
 */
export function extractPathsFromBashCommand(command: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const spelling of extractPathSpellingsFromBashCommand(command)) {
    const normalized = normalizeToolPath(spelling);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function sourceAbsolutePathsFromInput(input: Record<string, unknown>): string[] {
  const source = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const path = value.trim();
    if (path.startsWith('/')) source.add(path);
  };
  add(input.file_path ?? input.path ?? input.filePath ?? input.file);
  if (Array.isArray(input.paths)) {
    for (const path of input.paths) add(path);
  }
  if (typeof input.command === 'string') {
    for (const path of extractPathSpellingsFromBashCommand(input.command)) add(path);
  }
  return [...source];
}

/** Collect normalized bash-command paths from tool_use blocks in a turn's messages. */
function extractBashPathsFromMessages(messages: readonly FoldMessage[]): string[] {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_use' && typeof block.name === 'string' && BASH_TOOL_NAME_RE.test(block.name)) {
          const cmd = (block.input as any)?.command;
          if (typeof cmd === 'string') {
            for (const p of extractPathsFromBashCommand(cmd)) paths.add(p);
          }
        }
      }
    }
    if (Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls as any[]) {
        if (tc?.id && tc?.function?.name && BASH_TOOL_NAME_RE.test(tc.function.name)) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments ?? '{}'); } catch { /* skip */ }
          const cmd = args.command;
          if (typeof cmd === 'string') {
            for (const p of extractPathsFromBashCommand(cmd)) paths.add(p);
          }
        }
      }
    }
  }
  return Array.from(paths);
}

function extractSourcePathsFromMessages(messages: readonly FoldMessage[]): string[] {
  const paths = new Set<string>();
  const addInput = (input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    for (const path of sourceAbsolutePathsFromInput(input as Record<string, unknown>)) paths.add(path);
  };
  for (const msg of messages) {
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_use') addInput(block.input);
      }
    }
    if (Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls as any[]) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc?.function?.arguments ?? '{}'); } catch { /* skip */ }
        addInput(args);
      }
    }
    if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts as any[]) addInput(part?.functionCall?.args);
    }
  }
  for (const path of extractCompactToolTraceSourcePaths(messages)) paths.add(path);
  return [...paths].sort();
}

function unescapeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/**
 * Codex fold seed history inlines tool_use rows as compact text traces:
 * `⟨tool Read {"file_path":"src/x.ts"}⟩`. Those are intentionally strings
 * (Responses injection portability), so the FC structured-tool extractor cannot
 * see their path arguments. Parse only the bounded trace wrapper emitted by
 * foldBirthHydration; arbitrary prose remains ignored.
 */
function extractCompactToolTracePaths(messages: readonly FoldMessage[]): string[] {
  const paths = new Set<string>();
  const scan = (text: string): void => {
    COMPACT_TOOL_TRACE_RE.lastIndex = 0;
    let trace: RegExpExecArray | null;
    while ((trace = COMPACT_TOOL_TRACE_RE.exec(text)) !== null) {
      const payload = trace[1];
      if (!payload) continue;
      COMPACT_TRACE_PATH_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = COMPACT_TRACE_PATH_RE.exec(payload)) !== null) {
        const rawPath = unescapeJsonStringFragment(match[2]);
        const normalized = normalizeToolPath(rawPath);
        if (normalized) paths.add(normalized);
      }
    }
  };
  for (const msg of messages) {
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    if (typeof msg.content === 'string') {
      scan(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; text?: unknown } | string>) {
        if (typeof block === 'string') scan(block);
        else if (block?.type === 'text' && typeof block.text === 'string') scan(block.text);
      }
    }
  }
  return Array.from(paths).sort();
}

function extractCompactToolTraceSourcePaths(messages: readonly FoldMessage[]): string[] {
  const paths = new Set<string>();
  const scan = (text: string): void => {
    COMPACT_TOOL_TRACE_RE.lastIndex = 0;
    let trace: RegExpExecArray | null;
    while ((trace = COMPACT_TOOL_TRACE_RE.exec(text)) !== null) {
      const payload = trace[1];
      if (!payload) continue;
      COMPACT_TRACE_PATH_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = COMPACT_TRACE_PATH_RE.exec(payload)) !== null) {
        const rawPath = unescapeJsonStringFragment(match[2]);
        if (rawPath.startsWith('/')) paths.add(rawPath);
      }
    }
  };
  for (const msg of messages) {
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    if (typeof msg.content === 'string') scan(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; text?: unknown } | string>) {
        if (typeof block === 'string') scan(block);
        else if (block?.type === 'text' && typeof block.text === 'string') scan(block.text);
      }
    }
  }
  return [...paths].sort();
}

// ══════════════════════════════════════════════════════════════════════
// Index (page table)
// ══════════════════════════════════════════════════════════════════════

/** A whole turn paged out by the inter-turn fold (skeletonized in the view). */
export interface InterTurnIndexEntry {
  kind: 'turn';
  /** Deterministic id, stable across rebuilds while raw history is append-only. */
  id: string;
  /** Raw history message range [rawStart, rawEnd) — the recall content source. */
  rawStart: number;
  rawEnd: number;
  /** Recency coordinate (raw message index) used for deterministic ordering. */
  recency: number;
  category: TurnCategory;
  /** Normalized tool-arg paths touched in this turn, sorted (trigger matching). */
  paths: string[];
  /** Original repo-qualified absolute spellings retained beside legacy aliases. */
  sourcePaths?: string[];
  /** Bounded lowercased turn text (reserved for deferred tier-2 term matching). */
  digest: string;
  /** Original turn size in chars (telemetry / card header). */
  chars: number;
  /**
   * Sorted verbatim identifiers (UUIDs/hex/paths/KV — nominateVerbatim, cap 40)
   * this turn paged out, the same family the Coordinate Closet conserves. Drives the
   * exact-token page-in tier (WARP_FOLD_RECALL_VERBATIM). Bounded to the turn's
   * own nomination — no dense search/embeddings.
   */
  verbatimTokens?: string[];
}

/** A single tool result paged out by the intra-turn fold (marker in the view). */
export interface IntraTurnIndexEntry {
  kind: 'tool';
  /** Deterministic id: `tool:<toolId>`. */
  id: string;
  /** Provider recovery handle: tool_use_id (Anthropic) / tool_call_id (OpenAI). */
  toolId: string;
  /** Short tool name parsed from the fold marker. */
  tool: string;
  /** Normalized path parsed from the fold marker ('' when the tool had none). */
  path: string;
  /** Original repo-qualified target spelling recovered from the raw tool call. */
  sourcePath?: string;
  /** Recency coordinate (raw message index of the folded result). */
  recency: number;
  /** Folded chars parsed from the marker (telemetry / card header). */
  chars: number;
}

/**
 * Spool entry — an oversized tool result the RELAY evicted before it ever
 * reached the transcript (relay/src/codexSession/toolResultSpool.ts). Unlike a
 * fold entry, the bytes are NOT in raw history: they are on disk, addressed by
 * an opaque artifact id, and recoverable only via an explicit read tool call.
 *
 * That makes spool entries fundamentally HINT-ONLY here. Card rendering pages a
 * body in from raw (findToolResultText); there is no raw copy to page. This
 * module stays pure — it advertises the artifact's existence and its recovery
 * handle, and never touches the filesystem to fetch it.
 */
export interface SpoolIndexEntry {
  kind: 'spool';
  /** Deterministic id: `spool:<artifactId>`. */
  id: string;
  /** Opaque artifact id — the ONLY valid recovery handle for the read tool. */
  artifactId: string;
  /** Source label from the digest header, e.g. "Codex", "Forge", "Relay". */
  source: string;
  /**
   * Authoritative spool category emitted by the writer. Older envelopes omit
   * it; absence stays unknown rather than being inferred from the disk path or
   * mutable source label.
   */
  category?: string;
  /** Short tool name from the originating tool_use, '' when unresolvable. */
  tool: string;
  /**
   * Normalized TARGET path of the originating tool call (what the tool read or
   * edited) — resolved from the tool_use block, never from the envelope's
   * `path:` line. That line is the spool file's own location on disk (/tmp/…);
   * indexing it would never match a touched source path and would pollute path
   * residency with transport coordinates.
   */
  path: string;
  /** Original repo-qualified target spelling recovered from the raw tool call. */
  sourcePath?: string;
  /** Spool file location on disk (telemetry only; NOT a recovery handle). */
  spoolPath: string;
  /** Content hash of the spooled bytes, for optional read-time verification. */
  sha256: string;
  /**
   * Measured timestamp of the original tool-result message. It is deliberately
   * optional: callers must preserve an unavailable source time as unknown.
   */
  sourceTimestamp?: string;
  /** Recency coordinate (raw message index of the spooled result). */
  recency: number;
  /** Original size in chars, parsed from the digest. */
  chars: number;
  /** Bounded pushed capsule text used only for pure term/error/identifier cues. */
  digest?: string;
  /** Exact identifiers nominated from the pushed capsule, sorted and bounded. */
  verbatimTokens?: string[];
  /** Conservative normalized failures nominated from the pushed capsule. */
  errorSignatures?: string[];
}

export type FoldIndexEntry = InterTurnIndexEntry | IntraTurnIndexEntry | SpoolIndexEntry;

export interface FoldRecallIndex {
  /** Raw history length at build time — staleness guard against rewinds. */
  rawCount: number;
  /** Entries in deterministic build order (turns by rawStart asc, then tools by raw position asc). */
  entries: FoldIndexEntry[];
  /**
   * Exact fold-recall card blocks still literally present in the built view.
   * Undefined means a legacy/manually-built index that cannot answer residency
   * by view presence; buildFoldIndex always supplies a bounded array.
   */
  visibleRecallCards?: readonly string[];
  /**
   * Normalized text of the provider-ready view used to build this index. This
   * is the information-residency surface: recall must not page in a body that
   * is already literally present elsewhere in the model's POV just because it
   * is not wrapped in a prior recall card. Bounded and optional for legacy
   * manually-built indexes.
   */
  visiblePovText?: string;
  /**
   * Exact source-row identities for each entry. Present only when the provider
   * supplied authoritative identities; absence stays unknown.
   */
  sourceIdentitiesByEntryId?: Readonly<Record<string, readonly string[]>>;
  /**
   * Append-only cognitive supersession edges visible in the folded view.
   * These alter recall rendering, never the frozen strata that carry them.
   */
  supersessions?: readonly CognitiveSupersessionPointer[];
}

/** Provider-view text retained for literal information-residency checks. */
export const FOLD_RECALL_POV_TEXT_MAX_CHARS = 96_000;

/** Whitespace/quote-stable normalization for exact provider-POV containment. */
export function normalizeFoldRecallPovText(text: string): string {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? ` ${normalized} ` : '';
}

function collectCognitiveSupersessions(
  messages: readonly FoldMessage[],
  syntheticContext: SyntheticContextOptions,
): CognitiveSupersessionPointer[] {
  const bySource = new Map<string, string>();
  for (const message of messages) {
    const trustedSynthetic = message.contextWarpSynthetic === 'folded-context'
      || message.contextWarpSynthetic === 'cognitive-overlay';
    if (message.role !== 'assistant' && message.role !== 'model' && !trustedSynthetic) continue;
    for (const text of collectMessageTextFragments(message)) {
      if (!trustedSynthetic && !isSyntheticContextText(text, syntheticContext)) continue;
      for (const pointer of extractCognitiveSupersessionPointers(text)) {
        bySource.set(pointer.sourceIdentity, pointer.supersededByIdentity);
      }
    }
  }
  return [...bySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceIdentity, supersededByIdentity]) => ({ sourceIdentity, supersededByIdentity }));
}

/** Matches the folded view's fold-block header: "[Conversation Context — N turns folded, …". */
const FOLD_BLOCK_COUNT_RE = /^\[Conversation Context — (\d+) turns folded,/;
/** Whole-content intra-fold marker (generic replacement by foldSummaryText). */
const INTRA_GENERIC_MARKER_RE = /^\[Folded: (\S+)(?: (.+?))? — ([\d,]+) chars \| self-tap to recover\]$/;
/** Suffix intra-fold marker (atlas metadata-preserving variant). */
const INTRA_ATLAS_MARKER_RE = /\n## Source \[Folded: (\S+)(?: (.+?))? — ([\d,]+) chars of source code \| self-tap to recover\]$/;

function parseMarkerChars(raw: string): number {
  const n = Number.parseInt(raw.replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Relay tool-result spool envelopes ──
// Shape emitted by relay/src/codexSession/toolResultSpool.ts formatSpoolDigest:
//   [<Source> tool-result spool]
//   Full raw output scheduled for internal spool: <id>.
//   path: <spool file path>
//   sha256: <hex>
//   chars: 16,439
//   bytes: 16,439
//   <blank>
//   <compacted text>
// Anchored to line starts so compacted BODY text quoting these words cannot
// forge an entry (the body is arbitrary tool output and must never be trusted
// to mint page-table entries).
const SPOOL_HEADER_RE = /^\[([A-Za-z][\w-]*) tool-result spool\]$/m;
const SPOOL_ID_RE = /^Full raw output scheduled for internal spool: (\S+?)\.$/m;
const SPOOL_PATH_RE = /^path: (.+)$/m;
const SPOOL_CATEGORY_RE = /^category: ([a-z0-9][a-z0-9-]{0,79})$/m;
const SPOOL_SHA_RE = /^sha256: ([0-9a-f]{16,64})$/m;
const SPOOL_CHARS_RE = /^chars: ([\d,]+)$/m;
const SPOOL_DIGEST_MAX_CHARS = 2_000;

interface ParsedSpoolEnvelope {
  source: string;
  artifactId: string;
  category?: string;
  spoolPath: string;
  sha256: string;
  chars: number;
  digest: string;
}

/**
 * Conservative, exact-match failure signatures. This intentionally ignores a
 * bare use of the word "error" and accepts only typed exceptions, errno-style
 * codes, or a failure word followed by a concrete message delimiter.
 */
export function extractRecallErrorSignatures(text: string): string[] {
  const signatures = new Set<string>();
  const add = (raw: string): void => {
    const normalized = raw
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLowerCase()
      .slice(0, 180);
    if (normalized.length >= 8) signatures.add(normalized);
  };
  for (const rawLine of text.split(/\r?\n/u).slice(0, 400)) {
    const line = rawLine.trim();
    if (!line || line.length > 1_000) continue;
    const typed = /\b(?:[A-Z][A-Za-z0-9]*(?:Error|Exception)|E[A-Z]{2,})\b(?::\s*[^\n]+)?/u.exec(line);
    if (typed) add(typed[0]);
    const delimited = /\b(?:error|exception|failed|failure|panic|fatal)\s*[:\-]\s*[^\n]{4,}/iu.exec(line);
    if (delimited) add(delimited[0]);
    if (signatures.size >= 12) break;
  }
  return [...signatures].sort();
}

/**
 * Parse a spool digest envelope. Requires the header AND an artifact id: the id
 * is the only usable recovery handle, so an envelope without one is bookkeeping
 * noise rather than an indexable artifact.
 */
function parseSpoolEnvelope(content: string): ParsedSpoolEnvelope | null {
  const header = SPOOL_HEADER_RE.exec(content);
  if (!header) return null;
  const id = SPOOL_ID_RE.exec(content);
  if (!id) return null;
  const separator = content.indexOf('\n\n');
  const digest = separator >= 0 ? content.slice(separator + 2, separator + 2 + SPOOL_DIGEST_MAX_CHARS) : '';
  return {
    source: header[1],
    artifactId: id[1],
    ...(SPOOL_CATEGORY_RE.exec(content)?.[1] ? { category: SPOOL_CATEGORY_RE.exec(content)![1] } : {}),
    spoolPath: SPOOL_PATH_RE.exec(content)?.[1]?.trim() ?? '',
    sha256: SPOOL_SHA_RE.exec(content)?.[1] ?? '',
    chars: parseMarkerChars(SPOOL_CHARS_RE.exec(content)?.[1] ?? ''),
    digest,
  };
}

interface ToolCallMeta {
  tool: string;
  path: string;
  sourcePath?: string;
}

/**
 * Map tool id → originating call's short name and TARGET path, across both
 * provider shapes (Anthropic assistant tool_use blocks, OpenAI assistant
 * tool_calls). Spool entries need this because the digest envelope records the
 * spool file's own disk path, not the path the tool actually operated on.
 */
function buildToolCallMeta(rawHistory: readonly FoldMessage[]): Map<string, ToolCallMeta> {
  const meta = new Map<string, ToolCallMeta>();
  for (const msg of rawHistory) {
    if (msg.role !== 'assistant') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string' || meta.has(block.id)) continue;
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
        const sourcePath = sourceAbsolutePathsFromInput(input)[0];
        meta.set(block.id, {
          tool: shortRecallToolName(String(block.name ?? '')),
          path: extractPath(input),
          ...(sourcePath ? { sourcePath } : {}),
        });
      }
    }
    const toolCalls = (msg as any).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls as any[]) {
        if (typeof call?.id !== 'string' || meta.has(call.id)) continue;
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(String(call.function?.arguments ?? '{}'));
          if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
        } catch {
          // Malformed arguments are a path miss, not an index failure: the entry
          // still indexes on tool name and stays term/recency reachable.
        }
        const sourcePath = sourceAbsolutePathsFromInput(input)[0];
        meta.set(call.id, {
          tool: shortRecallToolName(String(call.function?.name ?? '')),
          path: extractPath(input),
          ...(sourcePath ? { sourcePath } : {}),
        });
      }
    }
  }
  return meta;
}

/** Join an Anthropic tool_result block's content into plain text (mirrors rollingFold). */
function blockContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n');
  }
  return JSON.stringify(content ?? '');
}

interface ParsedIntraMarker {
  tool: string;
  path: string;
  chars: number;
}

/**
 * Parse an intra-fold marker out of a folded tool result's content. Anchored
 * matching (whole-content for the generic marker, suffix for the atlas
 * variant) so markers merely QUOTED inside live tool output never index.
 */
function parseIntraMarker(content: string): ParsedIntraMarker | null {
  const generic = INTRA_GENERIC_MARKER_RE.exec(content);
  if (generic) {
    return { tool: generic[1], path: normalizeToolPath(generic[2] ?? ''), chars: parseMarkerChars(generic[3]) };
  }
  const atlas = INTRA_ATLAS_MARKER_RE.exec(content);
  if (atlas) {
    return { tool: atlas[1], path: normalizeToolPath(atlas[2] ?? ''), chars: parseMarkerChars(atlas[3]) };
  }
  return null;
}

function collectRecallCardsFromText(text: string): string[] {
  if (!text.includes(RECALL_CARD_PREFIX)) return [];
  const cards: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(RECALL_CARD_PREFIX)) continue;
    const block = [lines[i]];
    i++;
    while (i < lines.length && lines[i] !== '[End fold recall]') {
      block.push(lines[i]);
      i++;
    }
    if (i < lines.length && lines[i] === '[End fold recall]') {
      block.push(lines[i]);
      cards.push(block.join('\n'));
    }
  }
  return cards;
}

function collectMessageTextFragments(msg: FoldMessage): string[] {
  const out: string[] = [];
  const content = (msg as any).content;
  if (typeof content === 'string') {
    out.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content as any[]) {
      if (typeof block === 'string') out.push(block);
      else if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text);
      else if (block?.type === 'tool_result') out.push(blockContentText(block.content));
    }
  }
  if (Array.isArray((msg as any).parts)) {
    for (const part of (msg as any).parts as any[]) {
      if (typeof part?.text === 'string') out.push(part.text);
    }
  }
  return out;
}

function collectVisibleRecallCards(messages: readonly FoldMessage[]): string[] {
  const cards: string[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const text of collectMessageTextFragments(msg)) {
      for (const card of collectRecallCardsFromText(text)) {
        if (seen.has(card)) continue;
        seen.add(card);
        cards.push(card);
      }
    }
  }
  return cards;
}

function collectProviderViewText(messages: readonly FoldMessage[]): string {
  const fragments: string[] = [];
  for (const message of messages) fragments.push(...collectMessageTextFragments(message));
  const joined = fragments.join('\n');
  const bounded = joined.length > FOLD_RECALL_POV_TEXT_MAX_CHARS
    ? joined.slice(joined.length - FOLD_RECALL_POV_TEXT_MAX_CHARS)
    : joined;
  return normalizeFoldRecallPovText(bounded);
}

/**
 * Current provider-visible text: the last committed folded view plus the raw
 * messages appended since that view/index was built. Pure and bounded; callers
 * may pass null during pre-fold warmup.
 */
export function foldRecallProviderPovText(
  index: FoldRecallIndex | null | undefined,
  rawHistory: readonly FoldMessage[] | null | undefined,
): string {
  if (!index) return rawHistory ? collectProviderViewText(rawHistory) : '';
  const tail = rawHistory && rawHistory.length > index.rawCount
    ? collectProviderViewText(rawHistory.slice(index.rawCount))
    : '';
  const combined = `${index.visiblePovText ?? ''}${tail}`;
  return combined.length > FOLD_RECALL_POV_TEXT_MAX_CHARS
    ? combined.slice(combined.length - FOLD_RECALL_POV_TEXT_MAX_CHARS)
    : combined;
}

function buildTurnDigest(
  turnMessages: FoldMessage[],
  syntheticContext: SyntheticContextOptions = {},
): string {
  const parts: string[] = [];
  const user = extractFirstUserText(turnMessages, syntheticContext);
  if (user) parts.push(user);
  const assistant = extractAssistantText(turnMessages);
  if (assistant) parts.push(assistant);
  return parts.join(' ').toLowerCase().slice(0, TURN_DIGEST_MAX_CHARS);
}

/** First REAL user text in a slice (synthetic fold/recall blocks excluded). */
function extractFirstUserText(
  messages: readonly FoldMessage[],
  syntheticContext: SyntheticContextOptions = {},
): string {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      const cleaned = stripSyntheticUserContextBlocks(msg.content, syntheticContext).trim();
      if (cleaned.length > 0 && !isSyntheticContextText(cleaned, syntheticContext)) return cleaned;
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (typeof block === 'string') {
          const cleaned = stripSyntheticUserContextBlocks(block, syntheticContext).trim();
          if (cleaned.length > 0 && !isSyntheticContextText(cleaned, syntheticContext)) return cleaned;
          continue;
        }
        if (block?.type === 'text' && typeof block.text === 'string') {
          const cleaned = stripSyntheticUserContextBlocks(block.text, syntheticContext).trim();
          if (cleaned.length > 0 && !isSyntheticContextText(cleaned, syntheticContext)) return cleaned;
        }
      }
    }
  }
  return '';
}

/** Cap on the active-window query text fed to tier-2 term extraction — a few
 *  turns of recent cognition; recency-favored when the unfolded tail exceeds it. */
const ACTIVE_WINDOW_MAX_CHARS = 1600;

/**
 * Active-window text for tier-2 distinctive-term matching: the user- and
 * assistant-authored text of the live, unfolded raw tail (messages added since
 * the fold index was last built — raw.slice(foldedRawCount)). Mirrors
 * buildTurnDigest's surface (first real user text + assistant text; tool results
 * and synthetic recall/fold blocks excluded) so the query terms and the index's
 * per-turn digest terms are drawn from the same vocabulary. Recency-favored cap
 * keeps extraction cheap and focused on current cognition. Pure; returns ''
 * when the unfolded tail is empty or when term recall is explicitly disabled.
 */
export function extractActiveWindowText(
  rawHistory: readonly FoldMessage[],
  foldedRawCount: number,
  syntheticContext: SyntheticContextOptions = {},
): string {
  if (foldedRawCount < 0 || foldedRawCount >= rawHistory.length) return '';
  const tail = rawHistory.slice(foldedRawCount);
  const user = extractFirstUserText(tail, syntheticContext);
  const assistant = extractAssistantText(tail);
  const combined = [user, assistant].filter((s) => s.length > 0).join(' ');
  return combined.length > ACTIVE_WINDOW_MAX_CHARS
    ? combined.slice(combined.length - ACTIVE_WINDOW_MAX_CHARS)
    : combined;
}

/**
 * Concatenate a turn's verbatim-bearing text (user text, assistant text, and
 * tool-result bodies across Anthropic content[], OpenAI tool messages, and
 * Gemini parts) for exact-token indexing. Pure; bounded by the turn's own size.
 * Feeds nominateVerbatim so the indexed tokens are the same family the Verbatim
 * Keep conserves.
 */
function extractTurnVerbatimText(
  turnMessages: readonly FoldMessage[],
  syntheticContext: SyntheticContextOptions = {},
): string {
  const parts: string[] = [];
  const pushText = (text: string, role: string | undefined): void => {
    if (!text) return;
    if (role === 'user') {
      const cleaned = stripSyntheticUserContextBlocks(text, syntheticContext).trim();
      if (cleaned && !isSyntheticContextText(cleaned, syntheticContext)) parts.push(cleaned);
      return;
    }
    parts.push(text);
  };
  const pushBlockContent = (content: unknown): void => {
    if (typeof content === 'string') {
      if (content) parts.push(content);
    } else if (Array.isArray(content)) {
      for (const b of content as any[]) {
        if (typeof b === 'string') parts.push(b);
        else if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
  };
  for (const msg of turnMessages) {
    const content = (msg as any).content;
    if (typeof content === 'string') {
      pushText(content, msg.role);
    } else if (Array.isArray(content)) {
      for (const block of content as any[]) {
        if (typeof block === 'string') pushText(block, msg.role);
        else if (block?.type === 'text' && typeof block.text === 'string') pushText(block.text, msg.role);
        else if (block?.type === 'tool_result') pushBlockContent(block.content);
      }
    }
    // OpenAI role:'tool' string content is already captured by the string branch above.
    if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts as any[]) {
        if (typeof part?.text === 'string' && part.text) pushText(part.text, msg.role);
        const resp = part?.functionResponse?.response;
        if (resp !== undefined) {
          try {
            parts.push(typeof resp === 'string' ? resp : JSON.stringify(resp));
          } catch {
            /* non-serializable response — skip */
          }
        }
      }
    }
  }
  return parts.join('\n');
}

/**
 * Build the episodic voice block for a recall card: pre-rendered voice lines
 * from the caller's own-lineage episode chain for this path. Reads
 * state.pathEpisodes safely; returns '' when empty, disabled, or missing.
 * Does NOT parse annotation kinds — the worker already rendered/attribution.
 */
function buildEpisodeVoiceBlock(
  item: RecallPlanItem,
  state: FoldRecallState,
  config: FoldRecallConfig,
  charBudget: number,
  suppressPaths: ReadonlySet<string>,
): string {
  if (charBudget <= 0 || !config.episodesEnabled) return '';
  const path = item.matchedPath;
  const alias = normalizeToolPath(path);
  if (suppressPaths.has(path) || suppressPaths.has(alias)) return '';
  const voices = state.pathEpisodes?.get(path) ?? state.pathEpisodes?.get(alias);
  if (!voices || voices.length === 0) return '';

  const parts: string[] = ['🗣 Your lineage:'];
  let used = parts[0].length + 1;

  for (const ev of voices) {
    if (used >= charBudget) break;
    // Intent (the operator ask) — strongest voice signal.
    if (ev.intent && used + ev.intent.length + 10 < charBudget) {
      const line = `  ask: "${ev.intent}"`;
      parts.push(line);
      used += line.length + 1;
    }
    // Pre-rendered voice lines from the episode chain.
    for (const vl of ev.voiceLines) {
      if (used >= charBudget) break;
      const line = `  ${vl}`;
      parts.push(line);
      used += line.length + 1;
    }
  }

  // If only the header fits, return nothing.
  if (parts.length <= 1) return '';
  return parts.join('\n');
}

/** Map of toolId → raw message index for every tool result present in raw history. */
function buildToolResultPositions(rawHistory: readonly FoldMessage[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (let i = 0; i < rawHistory.length; i++) {
    const msg = rawHistory[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && !positions.has(block.tool_use_id)) {
          positions.set(block.tool_use_id, i);
        }
      }
    }
    if (msg.role === 'tool' && typeof (msg as any).tool_call_id === 'string') {
      const id = (msg as any).tool_call_id as string;
      if (!positions.has(id)) positions.set(id, i);
    }
  }
  return positions;
}

/**
 * Build the fold index (page table) from the raw history and the freshly
 * recomputed folded view. Call ONLY at fold-freeze epoch commits — the fold
 * is deterministic, so replaying detectTurns over raw plus summing the view's
 * fold-block counts (one block per sealed band on FC append-only tail epochs;
 * a single cumulative block on whole-view rebuilds) reproduces exactly which turns
 * folded, with zero extra fold passes and zero I/O.
 *
 * Caveat: turn replay assumes upstream pipeline stages preserve user-text
 * message structure (they replace/truncate content; they don't add or remove
 * turn-boundary messages). The clamp below bounds any pathological drift, and
 * the index is advisory — recall degrades to "no entry", never to wrong slices
 * (entries carry raw ranges that are bounds-checked at render time).
 *
 * precomputedTurns: when the fold was produced with an explicit turn tiling
 * (foldContext's precomputedTurns seam — e.g. the Codex synthetic step-fold,
 * where detectTurns would collapse the flattened one-user-turn seed to a single
 * turn and yield zero inter-turn entries), pass that SAME tiling here so each
 * folded step becomes recall-addressable. Omit it on the normal multi-turn path
 * where detectTurns(rawHistory) reproduces the fold segmentation byte-for-byte.
 *
 * seedFoldsEntireRaw (BuildFoldIndexOptions): hard-epoch portable-reset case.
 * The foldedView is a flattened rebirth-package seed that carries NO
 * "[Conversation Context — N turns folded]" block marker, yet the ENTIRE
 * pre-reset raw history (minus the trailing live turn) folded into it. Without
 * a marker the inter-turn gate stays 0 and the page table comes back empty, so
 * recall would go dormant across portable resets. When this flag is set and no
 * marker is found, the folded-turn count is taken from the detected raw turns
 * (clamped to all-but-the-live-turn) so every pre-reset turn becomes
 * recall-addressable against the retained (push-based) raw backing store.
 */
export interface BuildFoldIndexOptions {
  /**
   * Hard-epoch markerless seed: treat the whole pre-reset raw as folded when the
   * foldedView carries no fold-block count marker. Default false ⇒ legacy
   * marker-gated behavior (byte-identical for all existing callers).
   */
  seedFoldsEntireRaw?: boolean;
}

export function buildFoldIndex(
  rawHistory: readonly FoldMessage[],
  foldedView: readonly FoldMessage[],
  precomputedTurns?: readonly Turn[],
  syntheticContext: SyntheticContextOptions = {},
  options: BuildFoldIndexOptions = {},
): FoldRecallIndex {
  const entries: FoldIndexEntry[] = [];
  const visibleRecallCards = collectVisibleRecallCards(foldedView);
  const supersessions = collectCognitiveSupersessions(foldedView, syntheticContext);

  // ── Inter-turn entries: replay turn detection over raw, count from the view's fold blocks ──
  // FC append-only tail epochs seal one fold block PER BAND, so a folded view
  // may carry several "[Conversation Context — N turns folded, …]" markers in
  // chronological band order; the folded raw prefix is their SUM. First-match-
  // wins pinned the page table to the oldest band forever (measured: permanent
  // cards:0 recall on multi-band FC sessions while newer folded spans stayed
  // unindexed). Single-block whole-view-rebuild views are unchanged by summing.
  let interFoldedCount = 0;
  for (const msg of foldedView) {
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const match = FOLD_BLOCK_COUNT_RE.exec(msg.content);
    if (match) {
      interFoldedCount += Number.parseInt(match[1], 10) || 0;
    }
  }
  // Markerless hard-epoch seed (seedFoldsEntireRaw): the seed folded the whole
  // pre-reset raw but carries no fold-block count, so derive the folded-turn
  // count from the detected raw turns. The clamp below keeps the trailing live
  // turn unfolded, exactly as the marker path does.
  const seedFullFold = interFoldedCount === 0 && options.seedFoldsEntireRaw === true;
  if (interFoldedCount > 0 || seedFullFold) {
    const turns = precomputedTurns ?? detectTurns(rawHistory as FoldMessage[], syntheticContext);
    // Marker-bearing folded views are authoritative: continuous folding can
    // legitimately fold every detected turn, so indexing must not invent an
    // unfolded live-tail clamp. Markerless hard-epoch seeds still keep the
    // trailing live turn outside the page table.
    const maxFoldedTurns = seedFullFold ? Math.max(0, turns.length - 1) : turns.length;
    const count = Math.min(seedFullFold ? turns.length : interFoldedCount, maxFoldedTurns);
    for (let j = 0; j < count; j++) {
      const turn = turns[j];
      const structuredPaths = Array.from(extractToolPathSet(turn.messages));
      const bashPaths = extractBashPathsFromMessages(turn.messages);
      const compactTracePaths = extractCompactToolTracePaths(turn.messages);
      const paths = Array.from(new Set([...structuredPaths, ...bashPaths, ...compactTracePaths])).sort();
      const sourcePaths = extractSourcePathsFromMessages(turn.messages);
      const verbatimTokens = nominateVerbatim(extractTurnVerbatimText(turn.messages, syntheticContext)).sort();
      entries.push({
        kind: 'turn',
        id: `turn:${turn.startIndex}`,
        rawStart: turn.startIndex,
        rawEnd: turn.endIndex,
        recency: turn.startIndex,
        category: classifyTurn(turn.messages),
        paths,
        ...(sourcePaths.length > 0 ? { sourcePaths } : {}),
        digest: buildTurnDigest(turn.messages, syntheticContext),
        chars: countChars(turn.messages),
        ...(verbatimTokens.length > 0 ? { verbatimTokens } : {}),
      });
    }
  }

  // ── Intra-turn entries: scan the view for fold markers, anchor to raw by tool id ──
  const rawPositions = buildToolResultPositions(rawHistory);
  const toolCallMeta = buildToolCallMeta(rawHistory);
  for (const msg of foldedView) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        if (typeof block.content !== 'string') continue; // folded blocks always carry string content
        const marker = parseIntraMarker(block.content);
        if (!marker) continue;
        const rawIndex = rawPositions.get(block.tool_use_id);
        if (rawIndex === undefined) continue; // cannot recall what raw no longer holds
        const id = `tool:${block.tool_use_id}`;
        if (entries.some(e => e.id === id)) continue;
        const meta = toolCallMeta.get(block.tool_use_id);
        entries.push({
          kind: 'tool',
          id,
          toolId: block.tool_use_id,
          tool: marker.tool,
          path: marker.path,
          ...(meta?.sourcePath ? { sourcePath: meta.sourcePath } : {}),
          recency: rawIndex,
          chars: marker.chars,
        });
      }
    }
    if (msg.role === 'tool' && typeof (msg as any).tool_call_id === 'string' && typeof msg.content === 'string') {
      const toolId = (msg as any).tool_call_id as string;
      const marker = parseIntraMarker(msg.content);
      if (!marker) continue;
      const rawIndex = rawPositions.get(toolId);
      if (rawIndex === undefined) continue;
      const id = `tool:${toolId}`;
      if (entries.some(e => e.id === id)) continue;
      const meta = toolCallMeta.get(toolId);
      entries.push({
        kind: 'tool',
        id,
        toolId,
        tool: marker.tool,
        path: marker.path,
        ...(meta?.sourcePath ? { sourcePath: meta.sourcePath } : {}),
        recency: rawIndex,
        chars: marker.chars,
      });
    }
  }

  // ── Spool entries: scan RAW for relay spool digests, anchor by tool id ──
  // Raw rather than the view on purpose. A spool digest still visible in the
  // view is only half-invisible (the model can read the artifact id off it);
  // one that has since been FOLDED out of view is invisible twice over — the
  // bytes were never in the transcript AND the recovery handle is now gone from
  // the model's POV. Indexing raw covers both, and raw position doubles as the
  // recency coordinate.
  const addSpoolEntry = (toolId: string, text: string, rawIndex: number, sourceTimestamp?: string): void => {
    const parsed = parseSpoolEnvelope(text);
    if (!parsed) return;
    const id = `spool:${parsed.artifactId}`;
    if (entries.some(e => e.id === id)) return;
    const meta = toolCallMeta.get(toolId);
    entries.push({
      kind: 'spool',
      id,
      artifactId: parsed.artifactId,
      source: parsed.source,
      ...(parsed.category ? { category: parsed.category } : {}),
      tool: meta?.tool ?? '',
      path: meta?.path ?? '',
      ...(meta?.sourcePath ? { sourcePath: meta.sourcePath } : {}),
      spoolPath: parsed.spoolPath,
      sha256: parsed.sha256,
      ...(sourceTimestamp ? { sourceTimestamp } : {}),
      recency: rawIndex,
      chars: parsed.chars,
      ...(parsed.digest ? {
        digest: parsed.digest,
        verbatimTokens: nominateVerbatim(parsed.digest).sort(),
        errorSignatures: extractRecallErrorSignatures(parsed.digest),
      } : {}),
    });
  };
  for (let i = 0; i < rawHistory.length; i++) {
    const msg = rawHistory[i];
    const sourceTimestamp = foldMessageTimestampBounds([msg]).firstTimestamp;
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        addSpoolEntry(block.tool_use_id, blockContentText(block.content), i, sourceTimestamp);
      }
    }
    if (msg.role === 'tool' && typeof (msg as any).tool_call_id === 'string' && typeof msg.content === 'string') {
      addSpoolEntry((msg as any).tool_call_id as string, msg.content, i, sourceTimestamp);
    }
  }

  const sourceIdentitiesByEntryId: Record<string, readonly string[]> = {};
  for (const entry of entries) {
    const bounds = entry.kind === 'turn'
      ? { start: entry.rawStart, endExclusive: entry.rawEnd }
      : { start: entry.recency, endExclusive: entry.recency + 1 };
    const identities = new Set<string>();
    for (const message of rawHistory.slice(bounds.start, bounds.endExclusive)) {
      for (const identity of foldMessageSourceIdentities(message)) identities.add(identity);
    }
    if (identities.size > 0) sourceIdentitiesByEntryId[entry.id] = [...identities].sort();
  }

  return {
    rawCount: rawHistory.length,
    entries,
    visibleRecallCards,
    visiblePovText: collectProviderViewText(foldedView),
    ...(Object.keys(sourceIdentitiesByEntryId).length > 0 ? { sourceIdentitiesByEntryId } : {}),
    ...(supersessions.length > 0 ? { supersessions } : {}),
  };
}

// ══════════════════════════════════════════════════════════════════════
// Curated Code Radar — Atlas enrichment carried on recall state (Atlas-free)
// ══════════════════════════════════════════════════════════════════════
//
// Atlas source_highlights + ranged hazards, fetched OFF-THREAD by the relay
// (worker-pool atlas:recallEnrichment) and merged into FoldRecallState keyed by
// normalized path. This package stays pure: it only HOLDS and RENDERS these — it
// never reads Atlas. Absent/empty ⇒ recall renders exactly as before (byte-
// identical), so the radar is a strict superset enhancement.

/** A curated source-highlight guidepost for a file (mirrors Atlas source_highlights). */
export interface RecallSourceHighlight {
  label: string;
  startLine: number;
  endLine: number;
}

/** A curated hazard for a file. Null start/endLine = file-level (whole-file) hazard. */
export interface RecallHazard {
  text: string;
  startLine: number | null;
  endLine: number | null;
}

/** Worker-provided live file snapshot for historical-vs-current recall deltas. */
export interface RecallSourceDelta {
  /** Normalized workspace-relative path. */
  path: string;
  /** Stable hash of the live source snapshot, supplied by the relay worker. */
  liveHash: string;
  /** Current file text, bounded by the worker before crossing back to the main thread. */
  liveSource: string;
  /** True when liveSource is a prefix because the file exceeded the worker cap. */
  truncated?: boolean;
  /**
   * Set by the relay when this path's full-file liveHash is unchanged since the
   * prior epoch's snapshot. Lets the renderer suppress a *repeat* beyond-window
   * fresh-read nudge for a settled (unchanged) file, while the first epoch a
   * change appears (liveHash differs) still warns.
   */
  stableSincePrior?: boolean;
}

/**
 * Pre-rendered episodic voice for a recalled path. Each entry carries the
 * agent's own words from past work bursts on this path — already rendered
 * and attributed by the fold-episodes worker using the canonical episode
 * voice renderer helpers (changelog, tap_star, chatroom). foldRecall must NOT
 * parse annotation kinds or invent a second attribution scheme; it renders
 * voiceLines verbatim into the recall card.
 */
export interface EpisodeVoice {
  /** Normalized workspace-relative path that triggered the episode recall. */
  path: string;
  /** Pre-rendered, already-attributed voice lines from the episode chain. */
  voiceLines: string[];
  /** The operator ask that motivated the work burst, or null. */
  intent: string | null;
  /** Chapter IDs in the episode chain for this path. */
  chapterIds: number[];
  /** ISO-8601 timestamp of when the episode ended. */
  endedAt: string;
}

/**
 * Atlas file identity metadata for a recalled path. Carries the timeless
 * identity fields (purpose, blurb, tags) from the Atlas record — the same
 * fields that appear in Ambient Atlas blocks. Does NOT duplicate
 * highlights/hazards (those already ride pathHighlights/pathHazards).
 */
export interface AtlasFileMeta {
  /** Normalized workspace-relative path. */
  path: string;
  /** Timeless file purpose from Atlas (null when not curated). */
  purpose: string | null;
  /** Short one-line file identity from Atlas (null when not curated). */
  blurb: string | null;
  /** Canonical tag list from Atlas (empty when not curated). */
  tags: string[];
  /**
   * Exact Atlas history route for this path. `null` means the worker checked
   * Atlas and found no changelog coverage; `undefined` is a legacy/unhydrated
   * carrier and is rendered with the same honest unavailable state.
   */
  drilldown?: AtlasSnapshotDrilldown | null;
}

/** Exact retained Atlas snapshot coordinate; no summary text is synthesized. */
export interface AtlasSnapshotDrilldown {
  changelogId: number;
  snapshotId: number | null;
  startLine: number | null;
  endLine: number | null;
}

// ══════════════════════════════════════════════════════════════════════
// State (per-session; lives beside foldFreezeState)
// ══════════════════════════════════════════════════════════════════════

export interface ResidencyRecord {
  level: 'card' | 'hint';
  /** Pass number at which TTL fallback expires (suppression while passSeq < expiresAtPass). */
  expiresAtPass: number;
  /**
   * Exact rendered card text that created CARD path residency. When present and
   * the index has moved since injection, suppression follows literal view
   * presence instead of this pass-count fallback.
   */
  renderedCard?: string;
  /** Fold-index signature in force when `renderedCard` was injected. */
  indexSignature?: string;
}

/** Typed handle returned with each rendered full card for negative feedback. */
export interface FoldRecallCardExposure {
  exposureId: string;
  entryId: string;
  matchedPath: string;
  passSeq: number;
}

/** Session-local evidence needed to apply one exposure's dismissal safely. */
export interface FoldRecallCardExposureRecord extends FoldRecallCardExposure {
  entryKey: string;
  residencyId: string;
  indexSignature: string;
  residencyExpiresAtPass: number;
  renderedCard: string;
  dismissedAtPass?: number;
}

/** Append-only overlay over one structural entry; it never mutates the index. */
export interface FoldRecallDismissalRecord {
  entryKey: string;
  entryId: string;
  matchedPath: string;
  exposureId: string;
  dismissedAtPass: number;
  expiresAtPass: number;
}

export type FoldRecallDismissalOutcome =
  | { status: 'recorded'; record: FoldRecallDismissalRecord }
  | { status: 'already-dismissed'; record: FoldRecallDismissalRecord | null }
  | { status: 'unknown-exposure'; exposureId: string }
  | { status: 'stale-exposure'; exposureId: string; entryId: string };

export interface FoldRecallState {
  index: FoldRecallIndex | null;
  /** entryId → residency. Map iteration order is never observable in output. */
  resident: Map<string, ResidencyRecord>;
  /**
   * Normalized path → lifetime count of CARD-level injections this session
   * (rail-c63e326e s6). Unlike `residentPaths`, this NEVER expires or gets
   * cleared on index rebuild — it is a pure session-lifetime counter used
   * only to shrink same-content repeat cards, never to suppress them.
   */
  pathCardShowCounts: Map<string, number>;
  /**
   * Normalized path → CARD residency. Content-level suppression that survives
   * index rebuilds only while the exact rendered card is still literally present
   * in the rebuilt view. TTL remains a bounded cleanup fallback for legacy/manual
   * indexes and same-index immediate repeats.
   */
  residentPaths: Map<string, ResidencyRecord>;
  /** Bounded rendered-card handles awaiting optional caller feedback. */
  cardExposures?: Map<string, FoldRecallCardExposureRecord>;
  /** Structural entry key → fixed-window, non-sliding dismissal overlay. */
  dismissedEntries?: Map<string, FoldRecallDismissalRecord>;
  /** Lifetime count of newly recorded dismissals (idempotent repeats excluded). */
  dismissalsRecorded?: number;
  /**
   * Curated Code Radar carriers, keyed by normalized workspace-relative path
   * (== Atlas file_path == index entry path). Populated OFF-THREAD by the relay
   * after each epoch's buildFoldIndex; read at render time with zero I/O. Empty
   * until enrichment resolves (and whenever both flags are off) — recall degrades
   * silently to its pre-radar (byte-identical) output.
   */
  pathHighlights: Map<string, RecallSourceHighlight[]>;
  pathHazards: Map<string, RecallHazard[]>;
  /** Live source snapshots, keyed by normalized path, supplied off-thread by the relay worker. */
  pathSourceDeltas: Map<string, RecallSourceDelta>;
  /**
   * Tier-1 behavioral co-activation affinity carrier. Keyed by a composite
   * "anchor\x00zonePath" string (see affinityKey), value = normalized 0-1
   * relevance score (1.0 = strongest co-activation). Populated OFF-THREAD by the
   * relay worker from real touch/edit history (NOT recall output — closing the
   * loop on recall output creates a self-reinforcing echo chamber). Empty in
   * standalone/no-host mode → orderZoneByRelevance falls back to tier-0 proximity.
   */
  pathAffinity: Map<string, number>;
  /**
   * Episodic voice carriers: normalized path → EpisodeVoice entries from the
   * caller's own lineage episode chain. Populated OFF-THREAD by the relay
   * after epoch boundaries via foldEpisodes:recallEnrichment. Empty in
   * standalone/no-host mode → recall degrades to byte-identical output.
   */
  pathEpisodes: Map<string, EpisodeVoice[]>;
  /**
   * Optional Atlas file identity metadata carriers: normalized path →
   * AtlasFileMeta (purpose, blurb, tags). Populated OFF-THREAD by the relay
   * alongside the atlas:recallEnrichment batch. Optional for package API
   * compatibility; missing = empty (byte-identical). Does NOT duplicate
   * pathHighlights/pathHazards.
   */
  pathAtlasMeta?: Map<string, AtlasFileMeta>;
  /** Recall pass counter — one pass per tool boundary that carried signals. */
  passSeq: number;
  /**
   * Signature of the index seen on the previous pass (rawCount|firstId|lastId).
   * When the index is rebuilt by a freeze epoch (refold), the entry ids change
   * identity even though path residency stays content-keyed — so entry-id
   * residency must be cleared on index change to avoid suppressing a genuinely
   * fresh refolded entry that legitimately re-cards. Path residency survives
   * (content-keyed, intentionally post-refold-stable). null/undefined =
   * first pass (undefined preserves compatibility with older state objects).
   */
  lastIndexSignature?: string | null;
  /** Last bounded suppressed-manifest composition shown to the provider. */
  lastSuppressedManifestKey?: string | null;
  /** Matching suppression passes since that manifest was last shown. */
  suppressedManifestQuietPasses?: number;
  // ── Lifetime telemetry counters ──
  cardsInjected: number;
  hintsInjected: number;
  recallChars: number;
  suppressed: number;
}

export function createFoldRecallState(): FoldRecallState {
  return {
    index: null,
    resident: new Map(),
    pathCardShowCounts: new Map(),
    residentPaths: new Map(),
    cardExposures: new Map(),
    dismissedEntries: new Map(),
    dismissalsRecorded: 0,
    pathHighlights: new Map(),
    pathHazards: new Map(),
    pathSourceDeltas: new Map(),
    pathAffinity: new Map(),
    pathEpisodes: new Map(),
    pathAtlasMeta: new Map(),
    passSeq: 0,
    lastIndexSignature: null,
    lastSuppressedManifestKey: null,
    suppressedManifestQuietPasses: 0,
    cardsInjected: 0,
    hintsInjected: 0,
    recallChars: 0,
    suppressed: 0,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Signals (v1: tool-boundary path triggers only)
// ══════════════════════════════════════════════════════════════════════

export interface RecallSignals {
  /** Normalized paths touched by the just-executed tool call, sorted. */
  touchedPaths: string[];
  /** Original absolute touch spellings, sorted; hosts use these for repo identity. */
  sourceTouchedPaths?: string[];
  /** Normalized currently-claimed paths, sorted. */
  claimedPaths: string[];
  /** Original absolute claim spellings, sorted; matching prefers these over aliases. */
  sourceClaimedPaths?: string[];
  /** Active-window distinctive terms for tier-2 matching. Empty/omitted unless supplied by caller. */
  terms?: string[];
  /** Exact verbatim identifiers seen in the active window, sorted. Drives the verbatim-token tier; omitted unless supplied. */
  verbatimTokens?: string[];
  /** Exact conservative failure signatures seen in the active window, sorted. */
  errorSignatures?: string[];
  /**
   * Paths whose Curated Code Radar is suppressed because the current boundary's
   * tool is an Atlas read (lookup/brief/snippet) of them — the agent is seeing
   * that file's full source_highlights+hazards live, so the compressed radar
   * would just parrot the tool output. Omitted unless the relay supplies it; the
   * folded card BODY still pages in, and tier matching is unaffected.
  */
  atlasReadPaths?: string[];
  /**
   * Optional caller-owned intent context used ONLY to order already-eligible
   * candidates within their existing recall tier. It never creates a match,
   * bypasses residency, changes pressure budgets, or crosses tier boundaries.
   */
  ranking?: RecallRankingContext;
}

export interface RecallRankingContext {
  /** Current task/rail objective text, bounded and source-authoritative. */
  objective: string;
  /** Current active-step title/instruction/scope text. */
  activeStep: string;
  /** Caller-scoped claimed files plus files edited at this boundary. */
  activeFiles: string[];
}

export interface RecallIntentRelevance {
  /** Fraction of bounded objective terms recovered by the candidate digest. */
  objectiveCoverage: number;
  /** Fraction of bounded active-step terms recovered by the candidate digest. */
  activeStepCoverage: number;
  /** Fraction of bounded active files carried by the candidate. */
  activeFileCoverage: number;
  /** Mean of the non-empty component coverages, always within [0, 1]. */
  score: number;
}

const RECALL_RANKING_TEXT_MAX_CHARS = 12_000;
const RECALL_RANKING_TERM_CAP = 96;
const RECALL_RANKING_ACTIVE_FILE_CAP = 64;

/**
 * Normalize host-owned ranking inputs once at the relay seam. Empty context is
 * represented by undefined so standalone callers retain byte-identical legacy
 * ordering without manufacturing an objective from prompt prose.
 */
export function buildRecallRankingContext(input: {
  objective?: string | null;
  activeStep?: string | null;
  activeFiles?: readonly string[];
}): RecallRankingContext | undefined {
  const boundedText = (value: string | null | undefined): string => (
    typeof value === 'string'
      ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, RECALL_RANKING_TEXT_MAX_CHARS)
      : ''
  );
  const objective = boundedText(input.objective);
  const activeStep = boundedText(input.activeStep);
  const activeFiles = [...new Set((input.activeFiles ?? [])
    .map((path) => {
      const normalized = path.normalize('NFKC').trim();
      // Preserve repo-qualified identity when the host has it. Relative paths
      // remain the compatibility key; absolute paths are compared exactly
      // before any legacy alias fallback during scoring.
      return normalized.startsWith('/') ? normalized : normalizeToolPath(normalized);
    })
    .filter(Boolean))]
    .sort()
    .slice(0, RECALL_RANKING_ACTIVE_FILE_CAP);
  if (!objective && !activeStep && activeFiles.length === 0) return undefined;
  return { objective, activeStep, activeFiles };
}

/**
 * Repo-aware touch spellings for hosts that canonicalize episodic storage.
 * Absolute originals replace only their own stripped compatibility alias;
 * unrelated relative inputs remain present.
 */
function sourceAwareRecallPaths(source: readonly string[], aliases: readonly string[]): string[] {
  if (source.length === 0) return [...new Set(aliases)].sort();
  const shadowedAliases = new Set(source.map((path) => normalizeToolPath(path)));
  return [...new Set([
    ...source,
    ...aliases.filter((path) => !shadowedAliases.has(path)),
  ])].sort();
}

export function recallSignalTouchPaths(signals: RecallSignals): string[] {
  return sourceAwareRecallPaths(signals.sourceTouchedPaths ?? [], signals.touchedPaths);
}

function indexContainsAnySourcePath(
  index: FoldRecallIndex,
  sourcePaths: readonly string[],
): boolean {
  if (sourcePaths.length === 0) return false;
  const wanted = new Set(sourcePaths);
  return index.entries.some((entry) => foldIndexEntryPaths(entry).some((path) => wanted.has(path)));
}

/**
 * Leaf-normalize a dispatched tool name for Atlas-read matching. Mirrors the
 * relay's normalizeAmbientAtlasToolName (kept local so this carve-out package
 * stays relay-dependency-free): strips MCP server namespaces
 * (mcp__server__atlas_query), provider prefixes (functions.atlas_query), and
 * mcp_/mcp_to_ leaders, then lowercases the leaf.
 */
function normalizeAtlasReadToolLeaf(toolName: string | null | undefined): string {
  const raw = (toolName ?? '').trim();
  if (!raw) return '';
  const doubleUnderscoreLeaf = raw.split('__').at(-1) ?? raw;
  const dottedLeaf = doubleUnderscoreLeaf.split('.').at(-1) ?? doubleUnderscoreLeaf;
  return dottedLeaf.replace(/^mcp_to_/, '').replace(/^mcp_/, '').trim().toLowerCase();
}

/**
 * True when the just-dispatched tool is itself a highlight/hazard-rendering
 * Atlas read of the touched path — atlas_lookup/atlas_brief/atlas_snippet, or
 * atlas_query with action in {lookup,brief,snippet}. The agent is then already
 * seeing that file's full source_highlights+hazards live, so the (compressed)
 * Curated Code Radar would just parrot the tool output and is suppressed for
 * those paths (the folded card BODY still pages in). The tool name is
 * leaf-normalized so namespaced MCP forms (mcp__voxxo-swarm-bridge__atlas_query)
 * and provider-prefixed forms match — not only bare names. search/history/graph/
 * diff do NOT match: they do not render the curated per-file record.
 */
export function radarDuplicatesActiveAtlasRead(
  toolName: string | null | undefined,
  action: unknown,
): boolean {
  const leaf = normalizeAtlasReadToolLeaf(toolName);
  if (leaf === 'atlas_lookup' || leaf === 'atlas_brief' || leaf === 'atlas_snippet') return true;
  if (leaf === 'atlas_query') return action === 'lookup' || action === 'brief' || action === 'snippet';
  return false;
}

/**
 * True when the dispatched tool is an Atlas DISCOVERY read whose text output
 * leads each result line with a workspace path: search (`atlas_search` or
 * `atlas_query action=search`), catalog, and cluster. lookup/brief/snippet/
 * history/graph/diff are excluded — they render per-file bodies or analytics,
 * not a path-led result list. Gating here is what keeps arbitrary tool stdout
 * (and non-discovery Atlas reads) from ever becoming a recall trigger source.
 */
export function isAtlasDiscoveryResultTool(toolName: string | null | undefined, action: unknown): boolean {
  const leaf = normalizeAtlasReadToolLeaf(toolName);
  if (leaf === 'atlas_search') return true;
  return leaf === 'atlas_query' && (action === 'search' || action === 'catalog' || action === 'cluster');
}

// Leading list/tree markers Atlas discovery outputs prepend before a result
// path: catalog uses "- ", cluster uses "📄 "/"📁 "/"📂 "; search has none.
// Stripped (after trim) so search/catalog/cluster lines all normalize to a
// path-led head before the path regex runs. Requires a space after a bullet so
// a path that legitimately begins with "-" is never truncated.
const ATLAS_RESULT_LINE_MARKER_RE = /^(?:[-*•]\s+)?(?:📄|📁|📂)?\s*/u;

// A result path leads the (marker-stripped) line and is delimited by an Atlas
// separator: search uses " — "/"match:"/"score:", catalog uses " [cluster]" or
// " (NN LOC)", cluster uses " (NN LOC)". The (?:…/)+ requires at least one "/"
// so bare root files and prose words never qualify, and the "^" anchor means
// only a LEADING path is read (paths embedded in a blurb are ignored).
const ATLAS_RESULT_PATH_RE = /^`?((?:\/?[A-Za-z0-9_.@+\-=]+\/)+[^\s`]+?)`?(?:\s+(?:[—–-]|match:|score:|\[|\()|\s*$)/;

/**
 * Extract bounded path anchors from Atlas discovery result text (search,
 * catalog, cluster). Intentionally narrower than generic output parsing: only
 * Atlas discovery tools qualify (isAtlasDiscoveryResultTool) and only leading
 * result paths are accepted, so arbitrary tool stdout cannot become a recall
 * trigger source. Bounded by construction: at most the first 200 lines are
 * scanned and at most maxPaths anchors are returned.
 */
export function extractAtlasSearchResultPaths(
  toolName: string | null | undefined,
  action: unknown,
  output: string | null | undefined,
  maxPaths = 12,
): string[] {
  if (!output || !isAtlasDiscoveryResultTool(toolName, action)) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of output.split('\n').slice(0, 200)) {
    if (paths.length >= maxPaths) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 512 || trimmed.includes('://')) continue;
    const body = trimmed.replace(ATLAS_RESULT_LINE_MARKER_RE, '');
    const match = ATLAS_RESULT_PATH_RE.exec(body);
    if (!match) continue;
    const candidate = match[1].replace(/[.,;:)\]}]+$/, '');
    if (!candidate.includes('/') || candidate.length > 256) continue;
    const normalized = normalizeToolPath(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths.sort();
}

/**
 * Derive recall signals at a tool boundary from the just-executed tool call,
 * the current global claims set, and optional active-window text for tier-2
 * distinctive-term matching. The term tier is config-gated default OFF.
 */
export function extractRecallSignals(
  toolInput: Record<string, unknown> | null,
  claimedPaths: ReadonlySet<string>,
  activeText: string | readonly string[] = '',
): RecallSignals {
  const touched = new Set<string>();
  const sourceTouched = new Set<string>();
  if (toolInput) {
    for (const path of sourceAbsolutePathsFromInput(toolInput)) sourceTouched.add(path);
    const primary = extractPath(toolInput);
    if (primary) touched.add(primary);
    const multi = (toolInput as { paths?: unknown }).paths;
    if (Array.isArray(multi)) {
      for (const p of multi) {
        if (typeof p === 'string' && p.trim()) touched.add(normalizeToolPath(p.trim()));
      }
    }
    const cmd = (toolInput as { command?: unknown }).command;
    if (typeof cmd === 'string') {
      for (const p of extractPathsFromBashCommand(cmd)) touched.add(p);
    }
  }
  const claimed = new Set<string>();
  const sourceClaimed = new Set<string>();
  for (const p of claimedPaths) {
    claimed.add(normalizeToolPath(p));
    if (p.startsWith('/')) sourceClaimed.add(p);
  }
  const termText = typeof activeText === 'string' ? activeText : activeText.join('\n');
  const terms = extractDistinctiveTerms(termText);
  const errorSignatures = extractRecallErrorSignatures(termText);
  return {
    touchedPaths: Array.from(touched).sort(),
    ...(sourceTouched.size > 0 ? { sourceTouchedPaths: Array.from(sourceTouched).sort() } : {}),
    claimedPaths: Array.from(claimed).sort(),
    ...(sourceClaimed.size > 0 ? { sourceClaimedPaths: Array.from(sourceClaimed).sort() } : {}),
    ...(terms.length > 0 ? { terms } : {}),
    ...(errorSignatures.length > 0 ? { errorSignatures } : {}),
  };
}

/**
 * Compose the tool-boundary recall query exactly as the live GET path consumes
 * it: derive active-window terms ('' when term recall is explicitly off), build
 * signals, and decide whether recall should proceed. `proceed` mirrors
 * buildFoldRecallContext's internal admit guard — path-touch OR claim OR
 * distinctive term signals — so pathless cognition is no longer short-circuited
 * before terms are weighed.
 * Pure; the single seam shared by the live caller and its wiring tests.
 */
export function deriveBoundaryRecallSignals(
  toolInput: Record<string, unknown> | null,
  claimedPaths: ReadonlySet<string>,
  rawHistory: readonly FoldMessage[],
  foldedRawCount: number,
  config: FoldRecallConfig,
  syntheticContext: SyntheticContextOptions = {},
): { signals: RecallSignals; proceed: boolean } {
  const needActive = config.termRecallEnabled || config.verbatimRecallEnabled || config.errorRecallEnabled !== false;
  const activeText = needActive ? extractActiveWindowText(rawHistory, foldedRawCount, syntheticContext) : '';
  const signals = extractRecallSignals(toolInput, claimedPaths, activeText);
  // extractRecallSignals always derives terms from activeText; but the verbatim
  // tier also needs activeText, so when term recall is OFF keep terms OUT of the
  // signal (planRecall ignores them anyway) — byte-identical term behavior.
  if (!config.termRecallEnabled) delete signals.terms;
  if (config.errorRecallEnabled === false) delete signals.errorSignatures;
  // Exact verbatim-token signal: hashes/ids re-surfacing in the active window.
  // Flag-gated; nominateVerbatim is bounded (cap 40), sorted for firstIntersection.
  if (config.verbatimRecallEnabled && activeText) {
    const tokens = nominateVerbatim(activeText).sort();
    if (tokens.length > 0) signals.verbatimTokens = tokens;
  }
  const hasTermSignals = config.termRecallEnabled && (signals.terms?.length ?? 0) > 0;
  const hasVerbatimSignals = config.verbatimRecallEnabled && (signals.verbatimTokens?.length ?? 0) > 0;
  const hasErrorSignals = config.errorRecallEnabled !== false && (signals.errorSignatures?.length ?? 0) > 0;
  const proceed =
    signals.touchedPaths.length > 0
    || signals.claimedPaths.length > 0
    || hasTermSignals
    || hasVerbatimSignals
    || hasErrorSignals;
  return { signals, proceed };
}

// ══════════════════════════════════════════════════════════════════════
// Planning (pure)
// ══════════════════════════════════════════════════════════════════════

export type RecallTier = 0 | 1 | 2;

/** Resolution requested from cold spool storage by the pure recall planner. */
export type RecallResolution = 'hint' | 'excerpt' | 'full';

/** Explainable trigger family that earned an autonomic spool walk-back. */
export type RecallIntentReason =
  | 'path-touch'
  | 'claim'
  | 'error-signature'
  | 'verbatim-token'
  | 'term-overlap';

/**
 * A bounded exact slice requested from an immutable spool artifact. Ranges are
 * character coordinates in the decoded artifact; match queries ask the worker
 * for trigger-centered neighborhoods without exposing storage paths.
 */
export type RecallSliceRequest =
  | { kind: 'head'; maxChars: number }
  | { kind: 'tail'; maxChars: number }
  | { kind: 'range'; offset: number; maxChars: number }
  | { kind: 'match'; query: string; maxChars: number; maxMatches: number };

/**
 * Pure, deterministic request for asynchronous host hydration. This carries no
 * storage path and performs no I/O; a relay/standalone host may resolve it off
 * thread and later inject the verified result. `sourceTimestamp` is copied only
 * from authoritative source material and remains absent when unknown.
 */
export interface RecallIntent {
  kind: 'spool-artifact';
  version: 1;
  /** Stable deterministic identity for residency and in-flight deduplication. */
  intentId: string;
  artifactId: string;
  category?: string;
  expectedSha256?: string;
  sourceTimestamp?: string;
  path: string;
  tool: string;
  reason: RecallIntentReason;
  trigger: string;
  resolution: RecallResolution;
  requestedSlices: readonly RecallSliceRequest[];
  characterBudget: number;
}

export interface RecallPlanItem {
  entry: FoldIndexEntry;
  tier: RecallTier;
  /** Matched path for tiers 0/1; a deterministic term-residency key for tier 2. */
  matchedPath: string;
  trigger: string;
  /** Tier-2 relevance only; path tiers continue to sort by recency. */
  relevanceScore?: number;
  /** Within-tier objective/step/active-file score; absent preserves legacy order. */
  intentRelevance?: RecallIntentRelevance;
  /** Planned render level before measured char budgeting. */
  render: 'card' | 'hint';
  /** True when a resident HINT is being escalated by a fresh hard trigger. */
  escalatedFromHint: boolean;
  /**
   * Structural replacement pointers for a stale historical entry. Such items
   * render a pointer-only hint; their historical body is deliberately withheld.
   */
  supersessions?: readonly FoldRecallSupersessionResolution[];
  /** Separate residency identity for a supersession correction notice. */
  residencyId?: string;
}

export interface RecallPlan {
  items: RecallPlanItem[];
  /** Strong spool triggers eligible for asynchronous exact-body hydration. */
  intents: RecallIntent[];
  /** Entries suppressed by card residency (or non-escalatable hint residency). */
  suppressed: number;
  /** Live residency records that caused suppression and should slide forward. */
  suppressedResidencies: RecallSuppressedResidency[];
}

export interface RecallSuppressedResidency {
  entryId: string;
  residencyId?: string;
  matchedPath: string;
  refreshEntry: boolean;
  refreshPath: boolean;
}

export interface FoldRecallSupersessionResolution {
  sourceIdentity: string;
  supersededByIdentity: string;
  terminalIdentity: string;
  chain: readonly string[];
}

function resolveSupersessionTerminal(
  sourceIdentity: string,
  edgeBySource: ReadonlyMap<string, string>,
): FoldRecallSupersessionResolution | null {
  const chain = [sourceIdentity];
  const seen = new Set(chain);
  let current = sourceIdentity;
  let firstTarget: string | null = null;
  while (true) {
    const next = edgeBySource.get(current);
    if (!next) break;
    firstTarget ??= next;
    if (next === current || seen.has(next)) return null;
    chain.push(next);
    seen.add(next);
    current = next;
  }
  if (!firstTarget) return null;
  return {
    sourceIdentity,
    supersededByIdentity: firstTarget,
    terminalIdentity: current,
    chain,
  };
}

/**
 * Resolve exact source-identity supersession for one recall entry. Cycles,
 * self-links, unknown identities, and entries that already include their own
 * terminal replacement do not suppress historical content.
 */
export function resolveFoldRecallEntrySupersessions(
  index: FoldRecallIndex,
  entry: FoldIndexEntry,
): FoldRecallSupersessionResolution[] {
  const sourceIdentities = index.sourceIdentitiesByEntryId?.[entry.id] ?? [];
  const pointers = index.supersessions ?? [];
  if (sourceIdentities.length === 0 || pointers.length === 0) return [];
  const edgeBySource = new Map(
    pointers.map((pointer) => [pointer.sourceIdentity, pointer.supersededByIdentity] as const),
  );
  const entryIdentities = new Set(sourceIdentities);
  const resolutions: FoldRecallSupersessionResolution[] = [];
  for (const sourceIdentity of [...sourceIdentities].sort()) {
    const resolution = resolveSupersessionTerminal(sourceIdentity, edgeBySource);
    if (!resolution || entryIdentities.has(resolution.terminalIdentity)) continue;
    resolutions.push(resolution);
  }
  return resolutions;
}

function supersessionResidencyId(
  entry: FoldIndexEntry,
  resolutions: readonly FoldRecallSupersessionResolution[],
): string {
  const signature = resolutions
    .map((resolution) => resolution.chain.join('>'))
    .sort()
    .join('|');
  return 'supersession:' + entry.id + ':' + hashVisibleCard(signature);
}

interface PressureBudget {
  cardBudget: number;
  charBudget: number;
}

function pressureBudget(level: ContextUtilizationLevel, config: FoldRecallConfig): PressureBudget {
  switch (level) {
    case 'healthy':
      return { cardBudget: config.maxCards, charBudget: config.maxTotalChars };
    case 'warning':
      return { cardBudget: config.maxCards, charBudget: Math.floor(config.maxTotalChars / 2) };
    case 'critical':
      return { cardBudget: 1, charBudget: Math.floor(config.maxTotalChars / 4) };
    case 'auto_compact':
      return { cardBudget: 0, charBudget: Math.min(800, config.maxTotalChars) };
  }
}

const STRONG_SPOOL_TERM_COUNT = 3;

function recallIntentReason(item: RecallPlanItem): RecallIntentReason | null {
  if (item.trigger.startsWith('path-touch ')) return 'path-touch';
  if (item.trigger.startsWith('claim ')) return 'claim';
  if (item.trigger.startsWith('error-signature ')) return 'error-signature';
  if (item.trigger.startsWith('verbatim-token ')) return 'verbatim-token';
  if (item.trigger.startsWith('term-overlap ')) return 'term-overlap';
  return null;
}

/**
 * Translate a matched spool hint into a deterministic, bounded hydration plan.
 * The pushed capsule already carries head/tail/salient evidence, so path and
 * claim triggers preferentially request the dormant middle. Exact error/token
 * cues request trigger-centered neighborhoods. Auto-compact pressure never
 * schedules cold I/O; a visible hint remains the pressure-safe fallback.
 */
function buildSpoolRecallIntent(
  item: RecallPlanItem,
  budget: PressureBudget,
  utilization: ContextUtilizationLevel,
  config: FoldRecallConfig,
): RecallIntent | null {
  if (item.entry.kind !== 'spool' || config.autonomicSpoolRecallEnabled === false) return null;
  if (item.escalatedFromHint) return null;
  if (utilization === 'auto_compact') return null;
  const reason = recallIntentReason(item);
  if (!reason) return null;
  if (reason === 'term-overlap') {
    const termCount = item.matchedPath.slice('term:'.length).split('+').filter(Boolean).length;
    if (termCount < STRONG_SPOOL_TERM_COUNT) return null;
  }
  const characterBudget = Math.min(config.maxCardChars, budget.charBudget);
  if (characterBudget < MIN_USEFUL_CARD_CHARS) return null;

  const entry = item.entry;
  const requestedSlices: RecallSliceRequest[] = [];
  const exactQuery = reason === 'error-signature'
    ? item.matchedPath.slice('error:'.length)
    : reason === 'verbatim-token'
      ? item.matchedPath.slice('verbatim:'.length)
      : reason === 'term-overlap'
        ? item.matchedPath.slice('term:'.length).split('+').join(' ')
        : '';
  if (exactQuery) {
    const matchBudget = Math.max(1, Math.floor(characterBudget * 0.7));
    requestedSlices.push({ kind: 'match', query: exactQuery, maxChars: matchBudget, maxMatches: 3 });
    const middleBudget = characterBudget - matchBudget;
    if (middleBudget > 0) {
      requestedSlices.push({
        kind: 'range',
        offset: Math.max(0, Math.floor((entry.chars - middleBudget) / 2)),
        maxChars: middleBudget,
      });
    }
  } else {
    const middleBudget = Math.max(1, Math.floor(characterBudget * 0.8));
    const edgeBudget = characterBudget - middleBudget;
    requestedSlices.push({
      kind: 'range',
      offset: Math.max(0, Math.floor((entry.chars - middleBudget) / 2)),
      maxChars: middleBudget,
    });
    if (edgeBudget > 0) {
      const headBudget = Math.floor(edgeBudget / 2);
      if (headBudget > 0) requestedSlices.push({ kind: 'head', maxChars: headBudget });
      if (edgeBudget - headBudget > 0) requestedSlices.push({ kind: 'tail', maxChars: edgeBudget - headBudget });
    }
  }

  return {
    kind: 'spool-artifact',
    version: 1,
    intentId: `spool:${entry.artifactId}:${reason}:${item.matchedPath}`,
    artifactId: entry.artifactId,
    ...(entry.category ? { category: entry.category } : {}),
    ...(/^[a-f0-9]{64}$/u.test(entry.sha256) ? { expectedSha256: entry.sha256 } : {}),
    ...(entry.sourceTimestamp ? { sourceTimestamp: entry.sourceTimestamp } : {}),
    path: entry.path,
    tool: entry.tool,
    reason,
    trigger: item.trigger,
    resolution: 'excerpt',
    requestedSlices,
    characterBudget,
  };
}

export function foldIndexEntryPaths(entry: FoldIndexEntry): readonly string[] {
  const aliases = entry.kind === 'turn' ? entry.paths : entry.path ? [entry.path] : [];
  const source = entry.kind === 'turn'
    ? (entry.sourcePaths ?? [])
    : entry.sourcePath ? [entry.sourcePath] : [];
  if (source.length === 0) return aliases;
  // Keep compatibility aliases first for stable card rendering. Matching still
  // uses the absolute source signal (its stripped alias is shadowed upstream),
  // so this ordering cannot reintroduce cross-repo collisions.
  return [...new Set([...aliases, ...source])];
}

const entryPaths = foldIndexEntryPaths;

function isSyntheticRecallKey(matchedPath: string): boolean {
  return matchedPath.startsWith('verbatim:')
    || matchedPath.startsWith('error:')
    || matchedPath.startsWith('term:');
}

/** Maximum number of zone paths that participate in enrichment (radar + source deltas). */
const ZONE_ENRICHMENT_MAX_PATHS = 3;

function dirSegments(p: string): string[] {
  const i = p.lastIndexOf('/');
  return (i < 0 ? '' : p.slice(0, i)).split('/').filter(Boolean);
}

function sharedPrefix(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Order zone paths by directory proximity to the anchor: anchor first, then
 * closest sibling dirs, cross-cluster paths last. Stable within ties.
 * Pure string work — zero I/O. Used for enrichment ranking, not body collection.
 */
function orderZoneByProximity(anchor: string, paths: readonly string[]): string[] {
  const aSegs = dirSegments(anchor);
  return paths
    .map((p, i) => ({ p, i, score: p === anchor ? Infinity : sharedPrefix(dirSegments(p), aSegs) }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .map(z => z.p);
}

/**
 * Composite key for the pairwise pathAffinity carrier. Null-byte separator
 * avoids path collision (paths never contain \x00).
 */
function affinityKey(anchor: string, zonePath: string): string {
  return `${anchor}\x00${zonePath}`;
}

/**
 * Order zone paths by behavioral co-activation affinity from the host-supplied
 * pathAffinity carrier (tier-1): anchor first, then by descending affinity score.
 * Directory proximity (tier-0) is the deterministic tie-breaker AND the per-anchor
 * fallback: paths with equal or absent affinity keep proximity order, so a
 * behaviorally-cold zone (this anchor has no affinity entries → every score -1)
 * collapses to pure tier-0 proximity instead of arbitrary entry/insertion order —
 * even when the carrier is non-empty for some OTHER anchor. An empty carrier
 * short-circuits straight to proximity (byte-identical standalone behavior).
 */
function orderZoneByRelevance(
  anchor: string,
  paths: readonly string[],
  affinity: ReadonlyMap<string, number>,
): string[] {
  if (affinity.size === 0) return orderZoneByProximity(anchor, paths);
  // Proximity rank is the fallback ordering: it tie-breaks equal affinity scores
  // and fully orders a zone whose anchor has no affinity keys (all score -1),
  // preserving tier-0 proximity rather than collapsing to insertion order.
  const proximityRank = new Map(
    orderZoneByProximity(anchor, paths).map((p, rank) => [p, rank] as const),
  );
  return paths
    .map((p) => ({
      p,
      rank: proximityRank.get(p) ?? Number.MAX_SAFE_INTEGER,
      score: p === anchor ? Infinity : (affinity.get(affinityKey(anchor, p)) ?? -1),
    }))
    .sort((x, y) => y.score - x.score || x.rank - y.rank)
    .map((z) => z.p);
}

// ── Tier-1b booster math (BENCHED) ──────────────────────────────────────────
// Pure import-graph-distance ranking helpers. BENCHED: nothing in the live
// pipeline calls these. The host-side affinity worker computes behavioral-only
// affinity — the import booster was demoted by its own thesis to a minority-case
// tie-breaker, could not resolve the workspace root inside a worker thread
// (process.chdir throws there), and had no relevance telemetry to justify it.
// They live HERE, in the fold-engine package, because they are pure recall-ranking
// math (the natural sibling of orderZoneByRelevance) so standalone and any host
// share one source of truth. Revive only after measuring tier-1 lift AND threading
// the impact-graph root explicitly (never via process.chdir). Kept unit-tested.
const BEHAVIORAL_WEIGHT = 0.7;
const IMPORT_BOOSTER_WEIGHT = 0.3;

/**
 * BENCHED (tier-1b). Convert import-graph distance to a 0-1 booster signal:
 * distance 0 (same file / direct dependency) → 1.0; distance ∞ (cross-cluster) →
 * 0 (no boost, NO penalty). Formula: max(0, 1 - distance / 6) — the 6-hop bound
 * matches the host impact graph's max traversal depth.
 */
export function distanceToBooster(distance: number): number {
  if (!Number.isFinite(distance)) return 0; // cross-cluster → zero boost, no penalty
  return Math.max(0, 1 - distance / 6);
}

/**
 * BENCHED (tier-1b). Blend behavioral affinity with the import-graph booster.
 * Booster-only invariant: the result is never below the behavioral baseline (import
 * distance only RAISES a score, never penalizes). Cold-start (behavioral 0) falls
 * back to the booster.
 * finalScore = max(behavioral, behavioral*BEHAVIORAL_WEIGHT + importBooster*IMPORT_BOOSTER_WEIGHT)
 */
export function blendScores(behavioral: number, importBooster: number): number {
  const blended = behavioral * BEHAVIORAL_WEIGHT + importBooster * IMPORT_BOOSTER_WEIGHT;
  // Booster-only invariant: never below behavioral baseline; clamp to [0,1].
  return Math.max(behavioral, Math.max(0, Math.min(1, blended)));
}

/**
 * Paths that share the same recall body/enrichment zone. A folded inter-turn
 * entry is one temporal read burst, so touching any member path should recover
 * the whole co-folded source context. Intra-tool entries stay exact-path.
 *
 * For real anchors (tier-0/1 path touches) the zone is relevance-ordered:
 * tier-1 behavioral affinity when the carrier is populated, tier-0 directory
 * proximity as fallback. Synthetic keys (verbatim:/term:) have no real anchor,
 * so they keep entry order.
 */
function recallZonePaths(item: RecallPlanItem, state?: FoldRecallState): readonly string[] {
  if (item.entry.kind === 'turn' || isSyntheticRecallKey(item.matchedPath)) {
    if (isSyntheticRecallKey(item.matchedPath)) return entryPaths(item.entry);
    const affinity = state?.pathAffinity;
    return affinity
      ? orderZoneByRelevance(item.matchedPath, entryPaths(item.entry), affinity)
      : orderZoneByProximity(item.matchedPath, entryPaths(item.entry));
  }
  return [item.matchedPath];
}

/** Smallest path present in both sorted lists, or null. Both inputs sorted. */
function firstIntersection(sortedA: readonly string[], sortedB: readonly string[]): string | null {
  let i = 0;
  let j = 0;
  while (i < sortedA.length && j < sortedB.length) {
    if (sortedA[i] === sortedB[j]) return sortedA[i];
    if (sortedA[i] < sortedB[j]) i++;
    else j++;
  }
  return null;
}

function entryDigestTerms(entry: FoldIndexEntry): string[] {
  if (entry.kind === 'turn') return extractDistinctiveTerms(entry.digest);
  if (entry.kind === 'spool' && entry.digest) return extractDistinctiveTerms(entry.digest);
  return [];
}

function idfForEntryDigests(
  entries: readonly FoldIndexEntry[],
  getTerms: (entry: FoldIndexEntry) => string[] = entryDigestTerms,
): Map<string, number> {
  const df = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    if (entry.kind !== 'turn' && entry.kind !== 'spool') continue;
    const terms = getTerms(entry);
    if (terms.length === 0) continue;
    total++;
    for (const term of new Set(terms)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return idfFromDocumentFrequency(df, total);
}

/**
 * Positive smoothed IDF for ranking coverage. Tier-2 eligibility intentionally
 * permits zero/negative weights to reject corpus-common terms; ranking cannot
 * reuse that gate because `ln(2 / (1 + 1)) === 0` would erase a term carried by
 * exactly one of two candidates. Adding one preserves rarity ordering while
 * keeping every observed overlap measurable.
 */
function rankingIdfForEntryDigests(
  entries: readonly FoldIndexEntry[],
  getTerms: (entry: FoldIndexEntry) => string[] = entryDigestTerms,
): Map<string, number> {
  const idf = idfForEntryDigests(entries, getTerms);
  for (const [term, weight] of idf) {
    idf.set(term, Math.max(Number.EPSILON, weight + 1));
  }
  return idf;
}

function normalizedIntentTermCoverage(
  queryTerms: readonly string[],
  candidateTerms: readonly string[],
  idf: ReadonlyMap<string, number>,
): number {
  if (queryTerms.length === 0 || candidateTerms.length === 0) return 0;
  const overlap = scoreTermOverlap(queryTerms, candidateTerms, idf, {
    idfFloor: 0,
    unseenIdf: 1,
  });
  const totalQueryWeight = [...new Set(queryTerms)].reduce(
    (sum, term) => sum + (idf.get(term) ?? 1),
    0,
  );
  return totalQueryWeight > 0 ? Math.min(1, overlap.score / totalQueryWeight) : 0;
}

function entryCarriesActiveFile(entry: FoldIndexEntry, activeFile: string): boolean {
  const aliases = entry.kind === 'turn' ? entry.paths : entry.path ? [entry.path] : [];
  const sources = entry.kind === 'turn'
    ? (entry.sourcePaths ?? [])
    : entry.sourcePath ? [entry.sourcePath] : [];
  const normalized = normalizeToolPath(activeFile);
  if (activeFile.startsWith('/')) {
    // Exact source identity wins whenever this entry carries it. Fall back to
    // the alias only for legacy entries that predate sourcePaths/sourcePath.
    return sources.length > 0
      ? sources.includes(activeFile)
      : aliases.some((path) => normalizeToolPath(path) === normalized);
  }
  return aliases.some((path) => normalizeToolPath(path) === normalized)
    || sources.some((path) => normalizeToolPath(path) === normalized);
}

/**
 * Score intent relevance without changing eligibility. Components are
 * normalized independently and averaged only when their input is present, so
 * no arbitrary source-specific multiplier can dominate the ordering.
 */
function scorePreparedRecallIntentRelevance(
  entry: FoldIndexEntry,
  context: RecallRankingContext,
  idf: ReadonlyMap<string, number>,
  candidateTerms: readonly string[],
  objectiveTerms: readonly string[],
  activeStepTerms: readonly string[],
): RecallIntentRelevance {
  const activeFiles = context.activeFiles;
  const activeFileMatches = activeFiles.reduce(
    (count, path) => count + (entryCarriesActiveFile(entry, path) ? 1 : 0),
    0,
  );
  const objectiveCoverage = normalizedIntentTermCoverage(objectiveTerms, candidateTerms, idf);
  const activeStepCoverage = normalizedIntentTermCoverage(activeStepTerms, candidateTerms, idf);
  const activeFileCoverage = activeFiles.length > 0 ? activeFileMatches / activeFiles.length : 0;
  const components = [
    ...(objectiveTerms.length > 0 ? [objectiveCoverage] : []),
    ...(activeStepTerms.length > 0 ? [activeStepCoverage] : []),
    ...(activeFiles.length > 0 ? [activeFileCoverage] : []),
  ];
  const score = components.length > 0
    ? components.reduce((sum, component) => sum + component, 0) / components.length
    : 0;
  return {
    objectiveCoverage: Number(objectiveCoverage.toFixed(4)),
    activeStepCoverage: Number(activeStepCoverage.toFixed(4)),
    activeFileCoverage: Number(activeFileCoverage.toFixed(4)),
    score: Number(score.toFixed(4)),
  };
}

export function scoreRecallIntentRelevance(
  entry: FoldIndexEntry,
  context: RecallRankingContext | undefined,
  idf: ReadonlyMap<string, number>,
  cachedEntryTerms?: readonly string[],
): RecallIntentRelevance | undefined {
  if (!context) return undefined;
  return scorePreparedRecallIntentRelevance(
    entry,
    context,
    idf,
    cachedEntryTerms ?? entryDigestTerms(entry),
    extractDistinctiveTerms(context.objective, { cap: RECALL_RANKING_TERM_CAP }),
    extractDistinctiveTerms(context.activeStep, { cap: RECALL_RANKING_TERM_CAP }),
  );
}

/**
 * Plan which folded entries to page back in this pass. Pure — reads residency,
 * never mutates. Ordering is fully deterministic: tier asc; exact tier-2
 * signal class; optional within-tier intent relevance; legacy tier-2 relevance;
 * recency desc; id asc. With no ranking context the order is byte-identical to
 * the legacy tier/relevance/recency pipeline. Residency: resident cards suppress
 * (by entry id AND by
 * content path — path residency survives index rebuilds); resident hints
 * escalate to card-eligible on a fresh hard trigger (tiers 0-1 are both hard
 * in v1) and suppress otherwise.
 */
export function planRecall(
  index: FoldRecallIndex,
  resident: ReadonlyMap<string, ResidencyRecord>,
  residentPaths: ReadonlyMap<string, ResidencyRecord>,
  passSeq: number,
  signals: RecallSignals,
  utilization: ContextUtilizationLevel,
  config: FoldRecallConfig,
  dismissedEntries: ReadonlyMap<string, FoldRecallDismissalRecord> = new Map(),
): RecallPlan {
  const budget = pressureBudget(utilization, config);
  const matched: RecallPlanItem[] = [];
  const suppressedResidencies: RecallSuppressedResidency[] = [];
  const queryTerms = config.termRecallEnabled ? (signals.terms ?? []) : [];
  const queryTokens = config.verbatimRecallEnabled ? (signals.verbatimTokens ?? []) : [];
  const queryErrors = config.errorRecallEnabled !== false ? (signals.errorSignatures ?? []) : [];
  const sourceTouches = signals.sourceTouchedPaths ?? [];
  const sourceClaims = signals.sourceClaimedPaths ?? [];
  const touchSignals = sourceTouches.length > 0 && !indexContainsAnySourcePath(index, sourceTouches)
    ? [...new Set([...sourceTouches, ...signals.touchedPaths])].sort()
    : recallSignalTouchPaths(signals);
  const claimSignals = sourceClaims.length > 0 && !indexContainsAnySourcePath(index, sourceClaims)
    ? [...new Set([...sourceClaims, ...signals.claimedPaths])].sort()
    : sourceAwareRecallPaths(sourceClaims, signals.claimedPaths);
  // Memoize per-turn distinctive-term extraction for this pass: idfForTurnDigests
  // and the tier-2 match loop below would otherwise tokenize each turn digest
  // twice. Pure cache keyed by entry.id — identical content per entry, so plan
  // output stays byte-identical.
  const entryTermsCache = new Map<string, string[]>();
  const getEntryTerms = (entry: FoldIndexEntry): string[] => {
    let terms = entryTermsCache.get(entry.id);
    if (terms === undefined) {
      terms = entryDigestTerms(entry);
      entryTermsCache.set(entry.id, terms);
    }
    return terms;
  };
  const termIdf = queryTerms.length >= TERM_RECALL_MIN_DISTINCTIVE_COUNT
    ? idfForEntryDigests(index.entries, getEntryTerms)
    : null;
  const intentIdf = signals.ranking
    ? rankingIdfForEntryDigests(index.entries, getEntryTerms)
    : null;
  const intentObjectiveTerms = signals.ranking
    ? extractDistinctiveTerms(signals.ranking.objective, { cap: RECALL_RANKING_TERM_CAP })
    : [];
  const intentActiveStepTerms = signals.ranking
    ? extractDistinctiveTerms(signals.ranking.activeStep, { cap: RECALL_RANKING_TERM_CAP })
    : [];
  let suppressed = 0;

  for (const entry of index.entries) {
    const paths = foldIndexEntryPaths(entry);
    const matchPaths = [...paths].sort();
    // Exact verbatim-token re-surface: a single kept hash/id matching the active
    // window pages this turn in. Stronger than fuzzy term overlap (evaluated
    // first within tier 2), but path-touch/claim still outrank.
    const tokenEligible = queryTokens.length > 0
      && (entry.kind === 'turn' || entry.kind === 'spool')
      && (entry.verbatimTokens?.length ?? 0) > 0;
    const tokenHit = tokenEligible
      ? firstIntersection(entry.verbatimTokens ?? [], queryTokens)
      : null;
    const errorEligible = queryErrors.length > 0
      && entry.kind === 'spool'
      && (entry.errorSignatures?.length ?? 0) > 0;
    const errorHit = errorEligible
      ? firstIntersection(entry.errorSignatures ?? [], queryErrors)
      : null;
    const digestEligible = entry.kind === 'turn' || entry.kind === 'spool';
    if (paths.length === 0 && (termIdf === null || !digestEligible) && tokenHit === null && errorHit === null) continue;
    let tier: RecallTier | null = null;
    let matchedPath: string | null = null;
    let trigger: string | null = null;
    let relevanceScore = 0;
    const touch = firstIntersection(matchPaths, touchSignals);
    if (touch !== null) {
      tier = 0;
      matchedPath = touch;
      trigger = `path-touch ${normalizeToolPath(matchedPath)}`;
    } else {
      const claim = firstIntersection(matchPaths, claimSignals);
      if (claim !== null) {
        tier = 1;
        matchedPath = claim;
        trigger = `claim ${normalizeToolPath(matchedPath)}`;
      } else if (errorHit !== null) {
        tier = 2;
        matchedPath = `error:${errorHit}`;
        trigger = `error-signature ${errorHit}`;
        relevanceScore = Number.POSITIVE_INFINITY;
      } else if (tokenHit !== null) {
        tier = 2;
        matchedPath = `verbatim:${tokenHit}`;
        trigger = `verbatim-token ${tokenHit}`;
        relevanceScore = Number.POSITIVE_INFINITY;
      } else if (termIdf !== null && digestEligible) {
        const overlap = scoreTermOverlap(queryTerms, getEntryTerms(entry), termIdf);
        if (overlap.distinctiveCount >= TERM_RECALL_MIN_DISTINCTIVE_COUNT) {
          tier = 2;
          const matchedTerms = overlap.matched.map((m) => m.term);
          matchedPath = `term:${matchedTerms.join('+')}`;
          trigger = `term-overlap ${matchedTerms.join(', ')}`;
          relevanceScore = overlap.score;
        }
      }
    }
    if (tier === null || matchedPath === null || trigger === null) continue;

    const supersessions = resolveFoldRecallEntrySupersessions(index, entry);
    if (supersessions.length > 0) {
      const residencyId = supersessionResidencyId(entry, supersessions);
      const correctionRecord = resident.get(residencyId);
      const correctionLive = correctionRecord !== undefined
        && passSeq < correctionRecord.expiresAtPass;
      if (correctionLive) {
        suppressed++;
        suppressedResidencies.push({
          entryId: entry.id,
          residencyId,
          matchedPath,
          refreshEntry: true,
          refreshPath: false,
        });
        continue;
      }
      matched.push({
        entry,
        tier,
        matchedPath,
        trigger,
        relevanceScore,
        render: 'hint',
        escalatedFromHint: false,
        supersessions,
        residencyId,
      });
      continue;
    }

    // A dismissal is exact-entry and non-sliding. It is checked after the
    // supersession branch so a later structural safety correction can never be
    // hidden by negative feedback on the stale card it replaces. New entries
    // on the same path carry a different structural key and remain eligible.
    const dismissal = dismissedEntries.get(foldRecallEntryKey(index, entry));
    if (dismissal !== undefined && passSeq < dismissal.expiresAtPass) {
      suppressed++;
      suppressedResidencies.push({
        entryId: entry.id,
        matchedPath,
        refreshEntry: false,
        refreshPath: false,
      });
      continue;
    }

    // Content-level suppression operates on TWO independent residency maps:
    //
    // 1. PATH residency (residentPaths): coarse — "this path's content was
    //    carded recently, possibly under a DIFFERENT entry id after a refold."
    //    Tier-0 (active path-touch) BYPASSES this: post-refold the same logical
    //    content reappears under a new entry id, and suppressing it would create
    //    a dead zone where the marker is present but recall can't re-show it
    //    (rail recall-derisk, 2026-06-24). This bypass MUST stay.
    //
    // 2. ENTRY-ID residency (resident): fine-grained — "this EXACT folded entry
    //    was carded recently." Entry id is turn:<startIndex>, stable within an
    //    index. A tier-0 path-touch that matches the SAME entry id is re-carding
    //    byte-identical content shown one tool-boundary ago — pure repetition
    //    tax. Tier-0 now RESPECTS entry-id card residency (rail-dccaa1a1): the
    //    identical entry is suppressed for ttlPasses, while a genuinely different
    //    entry for the same path (new content or post-refold new id) still cards.
    const pathRecord = residentPaths.get(matchedPath);
    const pathLive = pathRecord !== undefined && passSeq < pathRecord.expiresAtPass;
    const record = resident.get(entry.id);
    const entryLive = record !== undefined && passSeq < record.expiresAtPass;
    if (pathLive && tier !== 0) {
      suppressed++;
      suppressedResidencies.push({
        entryId: entry.id,
        matchedPath,
        refreshEntry: entryLive,
        refreshPath: true,
      });
      continue;
    }

    let escalatedFromHint = false;
    if (entryLive) {
      if (record!.level === 'card') {
        // Exact-entry dedup: this identical entry was carded within ttlPasses.
        // Applies to ALL tiers including tier-0 — an active path-touch does not
        // justify re-injecting byte-identical content the agent saw one tool
        // boundary ago. Path residency (above) still bypasses for tier-0 so a
        // different/new entry for the same path can card.
        suppressed++;
        suppressedResidencies.push({
          entryId: entry.id,
          matchedPath,
          refreshEntry: true,
          refreshPath: false,
        });
        continue;
      }
      // Resident hint + fresh hard trigger → card-eligible escalation.
      escalatedFromHint = true;
    }

    matched.push({
      entry,
      tier,
      matchedPath,
      trigger,
      relevanceScore,
      ...(intentIdf && signals.ranking
        ? {
            intentRelevance: scorePreparedRecallIntentRelevance(
              entry,
              signals.ranking,
              intentIdf,
              getEntryTerms(entry),
              intentObjectiveTerms,
              intentActiveStepTerms,
            ),
          }
        : {}),
      render: 'card',
      escalatedFromHint,
    });
  }

  matched.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const aCorrection = a.supersessions && a.supersessions.length > 0 ? 1 : 0;
    const bCorrection = b.supersessions && b.supersessions.length > 0 ? 1 : 0;
    if (aCorrection !== bCorrection) return bCorrection - aCorrection;
    if (a.tier === 2 && b.tier === 2) {
      const aExact = a.relevanceScore === Number.POSITIVE_INFINITY ? 1 : 0;
      const bExact = b.relevanceScore === Number.POSITIVE_INFINITY ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
    }
    const intentDelta = (b.intentRelevance?.score ?? 0) - (a.intentRelevance?.score ?? 0);
    if (intentDelta !== 0) return intentDelta;
    if (a.tier === 2 && b.tier === 2 && a.relevanceScore !== b.relevanceScore) {
      return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    }
    if (a.entry.recency !== b.entry.recency) return b.entry.recency - a.entry.recency;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });

  // Assign planned render levels against the pressure card budget.
  const items: RecallPlanItem[] = [];
  const intents: RecallIntent[] = [];
  let cards = 0;
  let hints = 0;
  // Tier-0 pressure floor: under auto_compact (cardBudget: 0) the budget loop
  // would downgrade everything to hints, blinding an agent on the path it is
  // actively editing. Reserve one card for the highest-priority tier-0 item so
  // a marker never becomes a dead end. matched[] is sorted tier-ascending, so
  // matched[0] is the top item. Normal/critical/warning paths are unaffected
  // (cardBudget >= 1 already covers tier-0 naturally).
  const tier0Floor = budget.cardBudget === 0 && matched.length > 0 && matched[0].tier === 0 ? 1 : 0;
  const effectiveCardBudget = budget.cardBudget + tier0Floor;
  for (const item of matched) {
    if (item.supersessions && item.supersessions.length > 0) {
      // Safety corrections outrank the ordinary hint-count gate. The measured
      // character budget still caps emitted bytes; any correction that cannot
      // fit remains non-resident and therefore eligible on the following pass.
      items.push({ ...item, render: 'hint' });
      hints++;
      continue;
    }
    // Spool entries can only ever render as hints: card rendering pages a body
    // in from raw history, and a spool artifact has no raw copy to page. They
    // must not consume a card slot either, or an unpageable artifact would
    // starve a genuinely recoverable fold entry out of the card budget.
    if (item.entry.kind === 'spool') {
      if (hints < MAX_HINTS_PER_PASS) {
        items.push({ ...item, render: 'hint' });
        const intent = buildSpoolRecallIntent(item, budget, utilization, config);
        if (intent) intents.push(intent);
        hints++;
      }
      continue;
    }
    if (cards < effectiveCardBudget) {
      items.push(item);
      cards++;
    } else if (hints < MAX_HINTS_PER_PASS) {
      items.push({ ...item, render: 'hint' });
      hints++;
    }
    // Overflow beyond cards+hints is silently omitted (re-eligible next pass).
  }

  return { items, intents, suppressed, suppressedResidencies };
}

// ══════════════════════════════════════════════════════════════════════
// Rendering (deterministic, char-safe)
// ══════════════════════════════════════════════════════════════════════

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Slice that never splits a surrogate pair at either boundary. */
function charSafeSlice(s: string, start: number, end: number): string {
  let a = start;
  let b = end;
  if (a > 0 && a < s.length && isLowSurrogate(s.charCodeAt(a))) a++;
  if (b > 0 && b < s.length && isLowSurrogate(s.charCodeAt(b))) b--;
  return s.slice(a, Math.max(a, b));
}

function formatChars(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Head+tail excerpt with an omission note, char-safe on multibyte content.
 * Returns the input unchanged when it fits.
 */
export function excerptForRecall(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = Math.max(0, maxChars - headLen);
  const omitted = text.length - headLen - tailLen;
  const head = charSafeSlice(text, 0, headLen);
  const tail = tailLen > 0 ? charSafeSlice(text, text.length - tailLen, text.length) : '';
  return `${head}\n…[${formatChars(omitted)} chars omitted — self-tap for full content]…\n${tail}`;
}

/**
 * Strip previously-injected recall blocks from text before re-recalling it.
 * Feedback-loop guard: injected cards land inside tool results in raw
 * history; when that turn later folds and is itself recalled, re-quoting the
 * embedded card would nest stale copies and double-spend budget.
 */
export function stripRecallBlocks(text: string): string {
  if (!text.includes(RECALL_CARD_PREFIX) && !text.includes(RECALL_HINT_PREFIX)) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let inCard = false;
  for (const line of lines) {
    if (inCard) {
      if (line === '[End fold recall]') inCard = false;
      continue;
    }
    if (line.startsWith(RECALL_CARD_PREFIX)) {
      inCard = true;
      continue;
    }
    if (line.startsWith(RECALL_HINT_PREFIX)) continue; // hints are single lines
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.join('\n');
}

/** Find the original (pre-fold) tool result text in raw history by tool id. */
export function findToolResultText(rawHistory: readonly FoldMessage[], toolId: string): string | null {
  for (const msg of rawHistory) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_result' && block.tool_use_id === toolId) {
          return blockContentText(block.content);
        }
      }
    }
    if (msg.role === 'tool' && (msg as any).tool_call_id === toolId) {
      return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }
  }
  return null;
}

/**
 * Collect tool result texts within a turn slice whose tool-arg path matches any
 * recall-zone path, each paired with the matched path. Tool-id encounter order
 * and global dedup are identical to legacy single-text collection, so callers
 * that ignore the path produce byte-identical output; the path lets a caller
 * substitute current box source for an individually-changed path.
 */
function collectToolResultEntriesForPaths(
  slice: readonly FoldMessage[],
  paths: readonly string[],
): Array<{ path: string; text: string }> {
  if (paths.length === 0) return [];
  const wanted = new Set(paths);
  const ids: string[] = [];
  const idPath = new Map<string, string>();
  const seenIds = new Set<string>();
  const pushId = (id: string, matched: string): void => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    ids.push(id);
    idPath.set(id, matched);
  };
  const firstWanted = (cmdPaths: readonly string[]): string | null => {
    for (const p of cmdPaths) if (wanted.has(p)) return p;
    return null;
  };
  for (const msg of slice) {
    if (msg.role !== 'assistant') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const path = extractPath(block.input ?? {});
          if (path && wanted.has(path)) {
            pushId(block.id, path);
          } else if (typeof block.name === 'string' && BASH_TOOL_NAME_RE.test(block.name)) {
            const cmd = (block.input as any)?.command;
            const matched = typeof cmd === 'string' ? firstWanted(extractPathsFromBashCommand(cmd)) : null;
            if (matched) pushId(block.id, matched);
          }
        }
      }
    }
    if (Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        if (tc?.id && tc?.function?.name) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments ?? '{}'); } catch { /* skip */ }
          const path = extractPath(args);
          if (path && wanted.has(path)) {
            pushId(tc.id, path);
          } else if (BASH_TOOL_NAME_RE.test(tc.function.name)) {
            const cmd = args.command;
            const matched = typeof cmd === 'string' ? firstWanted(extractPathsFromBashCommand(cmd)) : null;
            if (matched) pushId(tc.id, matched);
          }
        }
      }
    }
  }
  const out: Array<{ path: string; text: string }> = [];
  for (const id of ids) {
    const text = findToolResultText(slice, id);
    if (text) out.push({ path: idPath.get(id) as string, text });
  }
  return out;
}

function describeEntry(entry: FoldIndexEntry): string {
  if (entry.kind === 'tool') {
    return entry.path ? `${entry.tool} ${entry.path}` : entry.tool;
  }
  if (entry.kind === 'spool') {
    const what = entry.tool ? (entry.path ? `${entry.tool} ${entry.path}` : entry.tool) : entry.spoolPath || entry.artifactId;
    return `${entry.source} spool ${what}`;
  }
  const preview = entry.paths.slice(0, 3).join(', ');
  const more = entry.paths.length > 3 ? `, +${entry.paths.length - 3} more` : '';
  return preview ? `${entry.category} turn (${preview}${more})` : `${entry.category} turn`;
}

function shortRecallToolName(name: string): string {
  const parts = name.split('__').filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/** Ordered, counted tool-call labels for a recalled raw episode. */
function recallEpisodeToolLabels(messages: readonly FoldMessage[]): string[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const add = (raw: unknown): void => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const name = shortRecallToolName(raw.trim());
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content as any[]) {
        if (block?.type === 'tool_use') add(block.name);
      }
    }
    if (Array.isArray((message as any).tool_calls)) {
      for (const call of (message as any).tool_calls as any[]) add(call?.function?.name);
    }
    if (Array.isArray((message as any).parts)) {
      for (const part of (message as any).parts as any[]) add(part?.functionCall?.name);
    }
  }
  return order.slice(0, 4).map((name) => {
    const count = counts.get(name) ?? 1;
    return count > 1 ? `${name} ×${count}` : name;
  });
}

function renderHint(item: RecallPlanItem): string {
  if (item.supersessions && item.supersessions.length > 0) {
    const pointers = item.supersessions
      .slice(0, 3)
      .map((resolution) => {
        const terminal = resolution.terminalIdentity === resolution.supersededByIdentity
          ? ''
          : ' terminal=' + resolution.terminalIdentity;
        return 'source-id=' + resolution.sourceIdentity
          + ' superseded-by=' + resolution.supersededByIdentity
          + terminal;
      })
      .join(' ; ');
    const omitted = item.supersessions.length > 3
      ? ' ; +' + (item.supersessions.length - 3) + ' more'
      : '';
    return RECALL_HINT_PREFIX + ' ' + describeEntry(item.entry)
      + ' superseded; historical body withheld | trigger: ' + item.trigger
      + ' | ' + pointers + omitted + ']';
  }
  // Spool artifacts are NOT self-tap recoverable: the bytes never entered raw
  // history, so there is nothing for the fold to page back in. The only handle
  // that works is the opaque artifact id via read_spooled_artifact — and the
  // envelope's `path:` is deliberately NOT offered here, because it looks more
  // actionable than the id while being the wrong argument to reach for.
  if (item.entry.kind === 'spool') {
    return `${RECALL_HINT_PREFIX} ${describeEntry(item.entry)} spooled out of context (${formatChars(item.entry.chars)} chars, never in transcript) | trigger: ${item.trigger} | read_spooled_artifact artifact_id: ${item.entry.artifactId}]`;
  }
  return `${RECALL_HINT_PREFIX} ${describeEntry(item.entry)} folded earlier (${formatChars(item.entry.chars)} chars) | trigger: ${item.trigger} | self-tap to recover]`;
}

/** Per-path live-source substitution applied to a recall body; drives the notifier. */
interface AppliedSourceDelta {
  path: string;
  liveHash: string;
  /** Bounded "what changed" hunk for a visible change; '' for a beyond-window flag. */
  diff: string;
  truncated: boolean;
  /** Truncated snapshot whose changed region (if any) lies beyond the window. */
  beyond?: boolean;
  /**
   * True when the card body was swapped to CURRENT box source (claim-tier
   * recall); false when the historical folded copy was kept and only the
   * notifier flags the drift (read/term-tier recall, or beyond-window).
   */
  swapped: boolean;
}

/** Rendered recall body plus the current-source swaps applied to it. */
interface RenderedEntryBody {
  body: string;
  applied: AppliedSourceDelta[];
}

/**
 * Body text for a recall card, sliced from in-memory raw history only. When a
 * recalled path's CURRENT box source (worker-fetched liveSource) genuinely
 * differs from the historical folded copy, the response is trigger-tier-aware:
 * a claim-tier recall (`swapBodyToCurrent` — the agent is about to edit) swaps
 * that path's body section to the current source; read/term-tier recalls keep
 * the HISTORICAL folded copy and only record the delta so the notifier can flag
 * the drift with a fresh-read pointer. A truncated snapshot whose change is
 * beyond the window keeps the historical body but records a beyond-window flag.
 * No carrier / no genuine change ⇒ byte-identical legacy body.
 */
function renderEntryBody(
  entry: FoldIndexEntry,
  recallPaths: readonly string[],
  rawHistory: readonly FoldMessage[],
  syntheticContext: SyntheticContextOptions,
  sourceDeltas: ReadonlyMap<string, RecallSourceDelta>,
  swapBodyToCurrent: boolean,
): RenderedEntryBody | null {
  const applied: AppliedSourceDelta[] = [];
  if (entry.kind === 'tool') {
    const text = findToolResultText(rawHistory, entry.toolId);
    if (text === null) return null;
    const historical = stripRecallBlocks(text);
    const swap = entry.path ? swapPathToCurrentSource(entry.path, historical, sourceDeltas, swapBodyToCurrent) : null;
    if (swap) {
      applied.push(swap.applied);
      return { body: swap.body ?? historical, applied };
    }
    return { body: historical, applied };
  }
  // Spool artifacts have no body to render: the bytes live on disk, not in raw
  // history, and this module is pure (zero I/O). planRecall forces them to hint
  // render, so reaching here means a caller bypassed the plan — refuse rather
  // than fabricate a body. null is the established "cannot render" signal.
  if (entry.kind === 'spool') return null;
  if (entry.rawStart < 0 || entry.rawEnd > rawHistory.length || entry.rawStart >= entry.rawEnd) return null;
  const slice = rawHistory.slice(entry.rawStart, entry.rawEnd);
  const parts: string[] = [];
  const user = extractFirstUserText(slice, syntheticContext);
  if (user) parts.push(`User asked: ${user.length > 300 ? charSafeSlice(user, 0, 299) + '…' : user}`);
  const assistant = extractAssistantText(slice as FoldMessage[]);
  if (assistant) parts.push(assistant);
  if (recallPaths.length > 0) {
    for (const { path, text } of collectToolResultEntriesForPaths(slice, recallPaths)) {
      const historical = stripRecallBlocks(text);
      const swap = swapPathToCurrentSource(path, historical, sourceDeltas, swapBodyToCurrent);
      if (swap) {
        parts.push(swap.body ?? historical);
        applied.push(swap.applied);
      } else {
        parts.push(historical);
      }
    }
  }
  const body = parts.join('\n\n');
  return body.trim() ? { body, applied } : null;
}

// ── Curated Code Radar formatters (deterministic, bounded, char-safe) ──

const RECALL_RADAR_MAX_LINES = 3;

/** Deterministic line-range token: "L85" for a point, "L85–95" for a span. */
function formatRadarLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`;
}

/**
 * Compact source-highlight radar — Atlas-curated guideposts to a touched file's
 * key regions, rendered as `⌖ label (a–b)` lines. Deterministic (startLine asc),
 * bounded by RECALL_RADAR_MAX_LINES and charBudget. Returns '' when nothing fits.
 */
export function formatHighlightsRadar(highlights: readonly RecallSourceHighlight[], charBudget: number): string {
  if (highlights.length === 0 || charBudget <= 0) return '';
  const sorted = [...highlights].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const lines: string[] = [];
  let used = 0;
  for (const h of sorted) {
    if (lines.length >= RECALL_RADAR_MAX_LINES) break;
    const line = `⌖ ${h.label} (${formatRadarLineRange(h.startLine, h.endLine)})`;
    if (used + line.length + 1 > charBudget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Compact hazard radar — `⚠️ text (L85)` / `⚠️ text (L85–95)` for ranged hazards,
 * `⚠️ text` for file-level (null range). Ranged hazards sort by startLine asc;
 * file-level hazards sort last. Deterministic, bounded. '' when nothing fits.
 */
export function formatHazardRadar(hazards: readonly RecallHazard[], charBudget: number): string {
  if (hazards.length === 0 || charBudget <= 0) return '';
  const sorted = [...hazards].sort((a, b) => {
    const aFile = a.startLine === null;
    const bFile = b.startLine === null;
    if (aFile !== bFile) return aFile ? 1 : -1; // file-level hazards sort last
    if (aFile && bFile) return 0;
    return (a.startLine as number) - (b.startLine as number);
  });
  const lines: string[] = [];
  let used = 0;
  for (const hz of sorted) {
    if (lines.length >= RECALL_RADAR_MAX_LINES) break;
    const range = hz.startLine === null ? '' : ` (${formatRadarLineRange(hz.startLine, hz.endLine ?? hz.startLine)})`;
    const line = `⚠️ ${hz.text}${range}`;
    if (used + line.length + 1 > charBudget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Resolve the curated enrichment for a plan item from FoldRecallState. Tier 0/1
 * matched a real file path; tier 2 (verbatim/term) keys are synthetic, so fall
 * back to the entry's own paths. Deduped across paths.
 */
function resolveItemEnrichment(
  item: RecallPlanItem,
  state: FoldRecallState,
  suppressPaths: ReadonlySet<string>,
): { highlights: RecallSourceHighlight[]; hazards: RecallHazard[] } {
  const keys = recallZonePaths(item, state).slice(0, ZONE_ENRICHMENT_MAX_PATHS);
  const highlights: RecallSourceHighlight[] = [];
  const hazards: RecallHazard[] = [];
  const seenH = new Set<string>();
  const seenZ = new Set<string>();
  for (const key of keys) {
    // Dedup vs an active Atlas read: the agent is seeing this file's full record
    // live this turn, so its radar would duplicate the tool output — skip it.
    if (suppressPaths.has(key)) continue;
    for (const h of state.pathHighlights.get(key) ?? []) {
      const sig = `${h.startLine}:${h.endLine}:${h.label}`;
      if (seenH.has(sig)) continue;
      seenH.add(sig);
      highlights.push(h);
    }
    for (const hz of state.pathHazards.get(key) ?? []) {
      const sig = `${hz.startLine}:${hz.endLine}:${hz.text}`;
      if (seenZ.has(sig)) continue;
      seenZ.add(sig);
      hazards.push(hz);
    }
  }
  return { highlights, hazards };
}

/**
 * Build the Curated Code Radar block for a card: hazard radar first (higher
 * urgency), then highlight radar — each flag-gated, the two sharing charBudget.
 * Returns '' when both flags are off, nothing is resident, or nothing fits.
 */
function buildRadar(
  item: RecallPlanItem,
  state: FoldRecallState,
  config: FoldRecallConfig,
  charBudget: number,
  suppressPaths: ReadonlySet<string>,
): string {
  if (charBudget <= 0 || (!config.highlightsEnabled && !config.hazardsEnabled)) return '';
  const { highlights, hazards } = resolveItemEnrichment(item, state, suppressPaths);
  const parts: string[] = [];
  let used = 0;
  if (config.hazardsEnabled && hazards.length > 0) {
    const block = formatHazardRadar(hazards, charBudget - used);
    if (block) { parts.push(block); used += block.length + 1; }
  }
  if (config.highlightsEnabled && highlights.length > 0) {
    const block = formatHighlightsRadar(highlights, charBudget - used);
    if (block) { parts.push(block); used += block.length + 1; }
  }
  return parts.join('\n');
}

/**
 * Build the Atlas identity metadata block for a recall card: purpose + tags
 * from the Atlas record for this path. Compact, budget-bounded, and '' when
 * empty or missing. Does NOT duplicate highlights/hazards.
 *
 * When both purpose and blurb exist, purpose takes precedence for brevity
 * (purpose is the longer timeless description; blurb is the tweet-length
 * fallback used when purpose is absent). Tags are always rendered separately.
 */
function buildAtlasMetaBlock(
  item: RecallPlanItem,
  state: FoldRecallState,
  config: FoldRecallConfig,
  charBudget: number,
  _suppressPaths: ReadonlySet<string>,
): string | null {
  if (!config.atlasMetaEnabled) return '';
  if (charBudget <= 0) return '';
  const candidateMeta = state.pathAtlasMeta?.get(item.matchedPath)
    ?? state.pathAtlasMeta?.get(normalizeToolPath(item.matchedPath));
  const matchedPath = normalizeToolPath(item.matchedPath);
  // A route is authoritative only for the exact path whose Atlas row minted
  // it. Treat mismatched legacy/host carriers as uncovered instead of pairing
  // one file's changelog id with another file's history query.
  const meta = candidateMeta && normalizeToolPath(candidateMeta.path) === matchedPath
    ? candidateMeta
    : undefined;
  const pathTriggered = item.tier <= 1 && !isSyntheticRecallKey(item.matchedPath);
  if (!meta && !pathTriggered) return '';

  const parts: string[] = [];
  let used = 0;
  const optionalMetaBudget = Math.floor(charBudget / 3);

  // Path recall is an index, not a summary generator. Put the exact Atlas
  // route first so pressure drops optional identity prose before it can detach
  // the changelog/snapshot coordinate. Missing coverage stays visibly missing.
  if (pathTriggered) {
    const rawDrilldown = meta?.drilldown;
    const drilldown = rawDrilldown
      && Number.isSafeInteger(rawDrilldown.changelogId)
      && rawDrilldown.changelogId > 0
      ? rawDrilldown
      : null;
    const hasSnapshotRange = drilldown
      && Number.isSafeInteger(drilldown.startLine)
      && Number.isSafeInteger(drilldown.endLine)
      && (drilldown.startLine ?? 0) > 0
      && (drilldown.endLine ?? 0) >= (drilldown.startLine ?? 0);
    const line = drilldown
      && hasSnapshotRange
      ? `  ↳ atlas_snapshot changelog_id=${drilldown.changelogId} start_line=${drilldown.startLine} end_line=${drilldown.endLine}`
      : drilldown
        ? `  ↳ Atlas changelog #${drilldown.changelogId}; snapshot coordinates unavailable`
        : '  ↳ Atlas drill-down unavailable';
    if (line.length + 1 > charBudget) return null;
    parts.push(line);
    used += line.length + 1;
  }

  // A claim-tier card, or a path-touch card that the host marks as an active
  // file, sits on the behavior-changing boundary. Carry the actual Atlas
  // history query there rather than relying on separate operator discipline.
  // The route is minted only from a real changelog row; uncovered paths retain
  // the explicit unavailable line above and never receive a fabricated link.
  const historyGateRequired = pathTriggered && (
    item.tier === 1 || (item.intentRelevance?.activeFileCoverage ?? 0) > 0
  );
  const validHistoryDrilldown = meta?.drilldown
    && Number.isSafeInteger(meta.drilldown.changelogId)
    && meta.drilldown.changelogId > 0
    ? meta.drilldown
    : null;
  if (historyGateRequired && validHistoryDrilldown) {
    const historyPath = matchedPath;
    const line = `  ↳ history gate: atlas_query action=history file_path=${JSON.stringify(historyPath)} limit=5 (latest changelog_id=${validHistoryDrilldown.changelogId})`;
    if (used + line.length + 1 > charBudget) return null;
    parts.push(line);
    used += line.length + 1;
  }

  const identity = meta?.purpose ?? meta?.blurb;
  if (identity && used + identity.length + 5 < Math.max(used, optionalMetaBudget)) {
    const line = `  📌 ${identity}`;
    parts.push(line);
    used += line.length + 1;
  }
  if ((meta?.tags.length ?? 0) > 0) {
    const tagLine = `  🏷 ${meta?.tags.slice(0, 5).join(', ')}`;
    if (used + tagLine.length + 1 < Math.max(used, optionalMetaBudget)) {
      parts.push(tagLine);
      used += tagLine.length + 1;
    }
  }

  if (parts.length === 0) return '';
  return parts.join('\n');
}

const DELTA_MAX_LINES = 14;
const DELTA_LINE_MAX_CHARS = 200;
const DELTA_NOTIFIER_BUDGET = 900;
const SOURCE_GUTTER_RE = /^\s*\d+\t/;

/**
 * Strip the cat -n line-number gutter ("   123\tcode") that Read tool results
 * carry, so a historical folded body is comparable to raw on-disk liveSource
 * (which has no gutter) and removed-side diff lines read as code. No-op when no
 * tab gutter is present.
 */
function stripSourceGutter(text: string): string {
  if (!text.includes('\t')) return text;
  return text.split('\n').map(line => line.replace(SOURCE_GUTTER_RE, '')).join('\n');
}

function splitNormalizedLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/[ \t]+$/, ''));
}

type SourceDeltaResult =
  | { kind: 'changed'; diff: string }
  | { kind: 'beyond' }
  | null;

/**
 * Bounded, deterministic line delta between a historical folded body and the
 * current box source. 'changed' carries the minimal "what changed" hunk; 'beyond'
 * means a truncated snapshot showed no in-window divergence but the file extends
 * past the char cap (real state unknown — flag, don't fabricate a deletion diff);
 * null means identical (gutter-normalized) ⇒ no genuine change. For a truncated
 * snapshot the partial final line and the historical tail beyond the window are
 * dropped so comparison stays within the region both sides cover; common
 * prefix/suffix are then trimmed to a minimal hunk.
 *
 * LIMITATION: the hunk is a single contiguous prefix/suffix block, not an LCS
 * diff — scattered edits collapse into one coarse removed+added block. This only
 * coarsens the NOTIFIER; on a claim-tier 'changed' result the card BODY still
 * pages back the full current box source, so no current content is lost.
 *
 * CONTEXT FLOOR: a 'changed' verdict additionally requires the shared
 * prefix+suffix (pre+post) to cover at least ~15% of the comparable region.
 * A genuine edit of one document leaves unchanged context around the changed
 * span; near-zero shared context means the two texts are different document
 * *shapes* — an Atlas-lookup/metadata-shaped folded body, or a windowed
 * mid-file read, compared against raw full-file source — not an edit.
 * Rendering those as 'changed' produced misleading whole-file "edit" hunks,
 * so they return null (historical body kept, no notifier). Cost, accepted: a
 * zero-shared-context TOTAL rewrite is line-indistinguishable from a shape
 * mismatch and is also suppressed; a fresh read still shows the real file.
 */
function computeSourceDelta(historicalBody: string, liveSource: string, truncated: boolean, budget: number): SourceDeltaResult {
  if (budget < 80) return null;
  const histFull = splitNormalizedLines(stripSourceGutter(historicalBody));
  let liveLines = splitNormalizedLines(liveSource);
  let histLines = histFull;
  if (truncated) {
    // The live snapshot is a char-capped prefix: its final line is a truncation
    // artifact (a partial line, or a trailing empty from a boundary newline).
    // Drop it and cap the historical side to the same window so the tail beyond
    // the snapshot is never mistaken for a deletion.
    liveLines = liveLines.slice(0, Math.max(0, liveLines.length - 1));
    histLines = histFull.slice(0, liveLines.length);
  }
  let pre = 0;
  const maxPre = Math.min(histLines.length, liveLines.length);
  while (pre < maxPre && histLines[pre] === liveLines[pre]) pre++;
  let post = 0;
  const maxPost = Math.min(histLines.length - pre, liveLines.length - pre);
  while (post < maxPost && histLines[histLines.length - 1 - post] === liveLines[liveLines.length - 1 - post]) post++;
  const removed = histLines.slice(pre, histLines.length - post);
  const added = liveLines.slice(pre, liveLines.length - post);
  if (removed.length === 0 && added.length === 0) {
    // Identical within the comparable region. For a truncated snapshot the real
    // current state past the window is unknown ⇒ flag; else genuinely unchanged.
    return truncated ? { kind: 'beyond' } : null;
  }
  // Context floor (see docblock): veto 'changed' when the shared prefix+suffix
  // is too thin relative to the comparable region — different document shapes,
  // not an edit. The floor is relative (not a fixed line count) so genuine
  // small-file edits with proportionally substantial context still qualify.
  const contextFloor = Math.max(1, Math.ceil(0.15 * Math.min(histLines.length, liveLines.length)));
  if (pre + post < contextFloor) return null;
  const out: string[] = [`@@ ~line ${pre + 1} @@`];
  let used = out[0].length + 1;
  let shown = 0;
  let omitted = 0;
  const push = (marker: string, text: string): void => {
    if (shown >= DELTA_MAX_LINES) { omitted++; return; }
    const clipped = text.length > DELTA_LINE_MAX_CHARS ? `${charSafeSlice(text, 0, DELTA_LINE_MAX_CHARS - 1)}…` : text;
    const line = `${marker} ${clipped}`;
    if (used + line.length + 1 > budget) { omitted++; return; }
    out.push(line);
    used += line.length + 1;
    shown++;
  };
  for (const r of removed) push('−', r);
  for (const a of added) push('+', a);
  if (omitted > 0) out.push(`…(±${omitted} more line${omitted === 1 ? '' : 's'} in this region — self-tap/fresh-read for full)`);
  return { kind: 'changed', diff: out.join('\n') };
}

function currentSourceLabel(path: string, truncated: boolean): string {
  return truncated
    ? `↻ CURRENT box source — ${path} (snapshot truncated; fresh-read for full file):`
    : `↻ CURRENT box source — ${path}:`;
}

/**
 * Decide how to render `path`'s worker-fetched live snapshot:
 * - genuine visible change + `swapToCurrent` (claim-tier recall — the agent is
 *   about to edit) ⇒ body becomes current box source + a recorded diff;
 * - genuine visible change without `swapToCurrent` (read/term-tier recall — a
 *   passive glance back) ⇒ body stays historical (null) + a recorded diff so
 *   the notifier flags the drift with a fresh-read pointer;
 * - truncated change beyond the window ⇒ body stays historical (null) + a
 *   beyond-window flag so the notifier warns to fresh-read;
 * - no carrier / no change ⇒ null (caller keeps historical, byte-identical legacy).
 */
function swapPathToCurrentSource(
  path: string,
  historical: string,
  sourceDeltas: ReadonlyMap<string, RecallSourceDelta>,
  swapToCurrent: boolean,
): { body: string | null; applied: AppliedSourceDelta } | null {
  const delta = sourceDeltas.get(path);
  if (!delta || !delta.liveSource.trim()) return null;
  const res = computeSourceDelta(historical, delta.liveSource, !!delta.truncated, DELTA_NOTIFIER_BUDGET);
  if (res === null) return null;
  if (res.kind === 'beyond') {
    // A truncated snapshot whose in-window region matched the historical body and
    // whose full-file hash is unchanged since the prior epoch is not a fresh
    // divergence — suppress the repeat fresh-read nudge and keep the historical
    // body byte-identical. The first epoch a change appears (liveHash differs)
    // still flags beyond-window.
    if (delta.stableSincePrior) return null;
    return { body: null, applied: { path, liveHash: delta.liveHash, diff: '', truncated: true, beyond: true, swapped: false } };
  }
  if (!swapToCurrent) {
    // Read/term-tier recall: the agent is remembering, not editing. Swapping
    // the body under a passive glance replaced remembered context with
    // unexpected current text — keep the historical folded copy and let the
    // notifier carry the drift warning + hunk instead.
    return { body: null, applied: { path, liveHash: delta.liveHash, diff: res.diff, truncated: !!delta.truncated, swapped: false } };
  }
  return {
    body: `${currentSourceLabel(path, !!delta.truncated)}\n${delta.liveSource}`,
    applied: { path, liveHash: delta.liveHash, diff: res.diff, truncated: !!delta.truncated, swapped: true },
  };
}

/**
 * True unless the relay has explicitly signaled a live-source change for this
 * path (`stableSincePrior === false`). Absence of any source-delta signal is
 * treated as "unchanged" because the folded historical entry itself is fixed
 * content from rawHistory — it never changes on its own between recalls;
 * only a live file diverging from that historical snapshot is a genuine
 * change worth paying full card budget for again.
 */
function isPathContentUnchanged(matchedPath: string, state: FoldRecallState): boolean {
  const delta = state.pathSourceDeltas.get(matchedPath);
  return !delta || delta.stableSincePrior !== false;
}

function resolveItemSourceDeltaMap(item: RecallPlanItem, state: FoldRecallState): Map<string, RecallSourceDelta> {
  const map = new Map<string, RecallSourceDelta>();
  for (const key of recallZonePaths(item, state).slice(0, ZONE_ENRICHMENT_MAX_PATHS)) {
    const delta = state.pathSourceDeltas.get(key);
    if (!delta) continue;
    if (!map.has(delta.path)) map.set(delta.path, delta);
    // renderEntryBody addresses historical tool results by their compatibility
    // alias. Alias the already-selected source-qualified delta within this one
    // item only; anchor ordering ensures a same-named foreign path cannot win.
    const alias = normalizeToolPath(delta.path);
    if (!map.has(alias)) map.set(alias, delta);
  }
  return map;
}

/**
 * Notifier block, rendered before the body excerpt so it always survives body
 * truncation. Heading is honest about what the body IS:
 * - every changed path swapped (claim-tier) ⇒ announces the body is CURRENT
 *   box source and lists each path's "what changed" hunk;
 * - every changed path unswapped (read/term-tier) ⇒ announces the body is the
 *   HISTORICAL folded copy, warns to fresh-read before relying on it, and
 *   still lists the hunks;
 * - mixed, or any beyond-window flag (truncated snapshot whose change lies
 *   past the cap) ⇒ neutral heading with per-path body annotations.
 * The heading never claims the body is CURRENT when it is not. '' when
 * nothing was applied ⇒ byte-identical legacy.
 */
function formatDeltaNotifier(applied: readonly AppliedSourceDelta[], budget: number): string {
  if (applied.length === 0 || budget < 80) return '';
  const allChanged = applied.every(a => !a.beyond);
  const allSwapped = allChanged && applied.every(a => a.swapped);
  const noneSwapped = applied.every(a => !a.swapped);
  const heading = allSwapped
    ? (applied.length === 1
        ? 'Δ Source changed since fold — body below is CURRENT box source; what changed:'
        : `Δ ${applied.length} sources changed since fold — bodies below are CURRENT box source; what changed:`)
    : allChanged && noneSwapped
      ? (applied.length === 1
          ? 'Δ Source changed since fold — body below is the HISTORICAL folded copy; fresh-read before relying on it; what changed:'
          : `Δ ${applied.length} sources changed since fold — bodies below are the HISTORICAL folded copies; fresh-read before relying on them; what changed:`)
      : 'Δ Fold-recall live-source check:';
  // Per-path body annotation, only where the heading does not already say it.
  const uniformHeading = allSwapped || (allChanged && noneSwapped);
  const out: string[] = [heading];
  let used = heading.length + 1;
  for (const a of applied) {
    if (a.beyond) {
      const head = `${a.path} (liveHash=${a.liveHash}) [snapshot truncated] — body may be stale beyond the shown prefix; fresh-read to verify current code`;
      if (used + head.length + 1 > budget) break;
      out.push(head);
      used += head.length + 1;
    } else {
      const suffix = uniformHeading
        ? ''
        : a.swapped
          ? ' [body: CURRENT box source]'
          : ' [body: HISTORICAL folded copy — fresh-read before relying on it]';
      const head = `${a.path} (liveHash=${a.liveHash})${suffix}`;
      if (used + head.length + 1 > budget) break;
      out.push(head);
      used += head.length + 1;
      for (const line of a.diff.split('\n')) {
        if (used + line.length + 1 > budget) break;
        out.push(line);
        used += line.length + 1;
      }
    }
  }
  return out.length > 1 ? out.join('\n') : '';
}

/** Rendered card text plus the composition breakdown of where its chars went. */
interface RenderedCard {
  text: string;
  stats: RecallCompositionStats;
}

function renderRecallProvenance(
  item: RecallPlanItem,
  rawHistory: readonly FoldMessage[],
  rawTailStart: number,
): string {
  const sourceStart = item.entry.kind === 'turn' ? item.entry.rawStart : item.entry.recency;
  const sourceEnd = item.entry.kind === 'turn' ? item.entry.rawEnd : item.entry.recency + 1;
  const sourceTime = foldMessageTimestampBounds(rawHistory.slice(sourceStart, sourceEnd));
  const rawTailCount = Math.max(0, rawHistory.length - rawTailStart);
  const rendered = renderChronologicalProvenanceCompact({
    artifact: `fold-recall#${item.entry.id}`,
    contentClass: 'retrieved-history',
    source: {
      start: { unit: 'message', index: sourceStart, timestamp: sourceTime.firstTimestamp },
      endExclusive: { unit: 'message', index: sourceEnd },
      count: sourceEnd - sourceStart,
      lastTimestamp: sourceTime.lastTimestamp,
    },
    transformedAt: { unit: 'message', index: rawHistory.length },
    ...(rawTailCount > 0 ? { rawResumesAt: { unit: 'message', index: rawTailStart } as const } : {}),
    authority: 'historical-background',
    supersession: rawTailCount > 0 ? 'later-raw-wins' : 'none-known',
    topology: {
      host: 'dedicated-synthetic-message',
      previous: 'raw-history',
      next: rawTailCount > 0 ? 'raw-tail' : 'none',
      representation: 'canonical',
      rawTailCount,
    },
  });
  if (!rendered) return '';
  const paths = (item.entry.kind === 'turn'
    ? item.entry.paths
    : item.entry.path ? [item.entry.path] : []).slice(0, 3);
  const tools = recallEpisodeToolLabels(rawHistory.slice(sourceStart, sourceEnd));
  const sourceBits = [
    tools.length > 0 ? tools.join(' → ') : '',
    paths.length > 0 ? paths.join(', ') : '',
  ].filter(Boolean);
  if (sourceBits.length === 0) return rendered;
  const episode = `↞ source episode: ${sourceBits.join(' · ')}`;
  return `${rendered}\n${episode.length > 260 ? `${charSafeSlice(episode, 0, 259)}…` : episode}`;
}

function renderCard(item: RecallPlanItem, body: string, bodyBudget: number, cardEnvelopeChars: number, radar: string, applied: readonly AppliedSourceDelta[], rawHistory: readonly FoldMessage[], rawTailStart: number, episodeVoice = '', atlasMeta = ''): RenderedCard {
  // Radar (hazard + highlight guideposts), episodic voice, and the source-delta
  // notifier all prepend the body excerpt and share the card budget. For a
  // claim-tier recall the body is already swapped to CURRENT box source for
  // changed paths (renderEntryBody); read/term-tier recalls keep the historical
  // body and the notifier carries the drift warning. Empty carriers ⇒ byte-identical.
  const radarBlock = radar ? `${radar}\n` : '';
  const voiceBlock = episodeVoice ? `${episodeVoice}\n` : '';
  const metaBlock = atlasMeta ? `${atlasMeta}\n` : '';
  const provenance = renderRecallProvenance(item, rawHistory, rawTailStart);
  const provenanceBlock = provenance ? `${provenance}\n` : '';
  const header = `${RECALL_CARD_PREFIX} ${describeEntry(item.entry)} | trigger: ${item.trigger} | ${formatChars(item.entry.chars)} chars folded]`;
  const footer = '[End fold recall]';
  // The first Atlas line is a mechanical coordinate required on every path
  // card. Fund it from RECALL_BODY_RESERVED_GAP_CHARS (the framing reserve)
  // only after charging the actual header/footer framing. Any remainder stays
  // body-budgeted so the route cannot overflow the total card envelope.
  const atlasLines = atlasMeta.split('\n');
  const framingChars = header.length + 1 + 1 + footer.length;
  const availableRouteReserve = Math.max(0, RECALL_BODY_RESERVED_GAP_CHARS - framingChars);
  const routeReserve = atlasLines[0]?.trimStart().startsWith('↳')
    ? Math.min((atlasLines[0]?.length ?? 0) + 1, availableRouteReserve)
    : 0;
  const chargedMetaChars = Math.max(0, metaBlock.length - routeReserve);
  const notifierBudget = Math.floor(Math.max(0, bodyBudget - radarBlock.length - voiceBlock.length - chargedMetaChars - provenanceBlock.length) / 2);
  const notifier = formatDeltaNotifier(applied, notifierBudget);
  const notifierBlock = notifier ? `${notifier}\n` : '';
  const prefixBlock = `${provenanceBlock}${metaBlock}${voiceBlock}${radarBlock}${notifierBlock}`;
  const preferredExcerptChars = Math.max(0, bodyBudget - prefixBlock.length + routeReserve);
  const excerptRenderedLimit = Math.max(
    0,
    cardEnvelopeChars - framingChars - prefixBlock.length,
  );
  let boundedExcerptChars = Math.min(preferredExcerptChars, excerptRenderedLimit);
  let excerpt = excerptForRecall(body, boundedExcerptChars);
  // excerptForRecall adds an omission marker outside its payload budget. Pay
  // that marker from the remaining framing reserve too; otherwise a route can
  // make a valid card overflow and silently downgrade to a hint.
  for (let pass = 0; excerpt.length > excerptRenderedLimit && pass < 4; pass++) {
    boundedExcerptChars = Math.max(0, boundedExcerptChars - (excerpt.length - excerptRenderedLimit));
    excerpt = excerptForRecall(body, boundedExcerptChars);
  }
  if (excerpt.length > excerptRenderedLimit) excerpt = '';
  return {
    text: `${header}\n${prefixBlock}${excerpt}\n${footer}`,
    stats: {
      bodyChars: excerpt.length,
      notifierChars: notifier.length,
      radarChars: radar.length,
      episodeVoiceChars: episodeVoice.length,
      atlasMetaChars: atlasMeta.length,
      swappedPaths: applied.reduce((n, a) => n + (a.swapped ? 1 : 0), 0),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// Session-facing orchestration
// ══════════════════════════════════════════════════════════════════════

/** Where a pass's injected card chars went + how many bodies were swapped. */
export interface RecallCompositionStats {
  /** Chars of body excerpts across injected cards. */
  bodyChars: number;
  /** Chars of source-delta notifier blocks. */
  notifierChars: number;
  /** Chars of Curated Code Radar blocks. */
  radarChars: number;
  /** Chars of episodic voice blocks. */
  episodeVoiceChars: number;
  /** Chars of Atlas identity metadata blocks. */
  atlasMetaChars: number;
  /** Paths whose card body was swapped to CURRENT box source (claim-tier). */
  swappedPaths: number;
}

export interface FoldRecallOutcome {
  /** Normative coverage/freshness contract governing this outcome. */
  contractVersion: typeof FOLD_RECALL_COMPLETENESS_CONTRACT_VERSION;
  /** Rendered body-only recall block, or null when nothing injects. */
  text: string | null;
  cards: number;
  hints: number;
  chars: number;
  suppressed: number;
  /** Bounded paths/source-coordinates-only account of bodies withheld this pass. */
  suppressedManifest?: string;
  triggers: string[];
  /** Pure hydration requests for strong spool triggers; host resolution is async. */
  recallIntents?: RecallIntent[];
  /**
   * Additive per-pass card composition breakdown — answers "where did the
   * injected chars go, and were any bodies swapped to current source?".
   * Present only when at least one card rendered this pass; optional so
   * standalone hosts consuming FoldRecallOutcome are unaffected.
   */
  composition?: RecallCompositionStats;
  /** Typed handles for full cards rendered by this pass; omitted for hints/empty passes. */
  exposures?: FoldRecallCardExposure[];
}

const EMPTY_OUTCOME: FoldRecallOutcome = {
  contractVersion: FOLD_RECALL_COMPLETENESS_CONTRACT_VERSION,
  text: null,
  cards: 0,
  hints: 0,
  chars: 0,
  suppressed: 0,
  triggers: [],
};

function hashVisibleCard(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function foldIndexSignature(index: FoldRecallIndex): string {
  const entries = index.entries;
  const cards = index.visibleRecallCards;
  const cardSig = cards === undefined
    ? 'legacy'
    : `${cards.length}:${cards.map(hashVisibleCard).join(',')}`;
  const supersessionSig = (index.supersessions ?? [])
    .map((pointer) => pointer.sourceIdentity + '>' + pointer.supersededByIdentity)
    .join(',');
  return [
    index.rawCount,
    entries[0]?.id ?? '',
    entries[entries.length - 1]?.id ?? '',
    cardSig,
    hashVisibleCard(supersessionSig),
  ].join('|');
}

/**
 * Stable identity for dismissal. Unlike `entry.id`, this cannot alias a new
 * body that happens to reuse the same raw start after a rebuild/rewind.
 */
function foldRecallEntryKey(index: FoldRecallIndex, entry: FoldIndexEntry): string {
  const sourceIdentities = index.sourceIdentitiesByEntryId?.[entry.id] ?? [];
  if (entry.kind === 'turn') {
    return JSON.stringify([
      'turn/v1', entry.rawStart, entry.rawEnd, entry.chars, entry.digest,
      entry.paths, entry.sourcePaths ?? [], sourceIdentities,
    ]);
  }
  if (entry.kind === 'tool') {
    return JSON.stringify([
      'tool/v1', entry.toolId, entry.tool, entry.path, entry.sourcePath ?? '',
      entry.recency, entry.chars, sourceIdentities,
    ]);
  }
  return JSON.stringify([
    'spool/v1', entry.artifactId, entry.sha256, entry.path,
    entry.sourcePath ?? '', entry.recency, entry.chars, sourceIdentities,
  ]);
}

function cardExposureMap(state: FoldRecallState): Map<string, FoldRecallCardExposureRecord> {
  return state.cardExposures ??= new Map();
}

function dismissalMap(state: FoldRecallState): Map<string, FoldRecallDismissalRecord> {
  return state.dismissedEntries ??= new Map();
}

function recordCardExposure(
  state: FoldRecallState,
  exposure: FoldRecallCardExposureRecord,
): void {
  const exposures = cardExposureMap(state);
  exposures.set(exposure.exposureId, exposure);
  while (exposures.size > MAX_FOLD_RECALL_CARD_EXPOSURES) {
    const oldest = exposures.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    exposures.delete(oldest);
  }
}

/**
 * Record negative feedback for one rendered full-card exposure. The overlay is
 * idempotent and non-sliding: repeating feedback for the same exposure cannot
 * extend the window. The card's ordinary residency is removed, so after the
 * shorter dismissal expires a relevant signal can re-show it before the
 * original TTL would have elapsed. New structural entries are never hidden.
 */
export function dismissFoldRecallCard(
  state: FoldRecallState,
  exposureId: string,
): FoldRecallDismissalOutcome {
  const normalizedExposureId = exposureId.trim();
  const exposure = state.cardExposures?.get(normalizedExposureId);
  if (!exposure) return { status: 'unknown-exposure', exposureId: normalizedExposureId };

  const existing = state.dismissedEntries?.get(exposure.entryKey) ?? null;
  if (exposure.dismissedAtPass !== undefined) {
    return { status: 'already-dismissed', record: existing };
  }

  // Feedback for an older rendering must not erase residency established by a
  // later rendering of the same structural entry. Exposure retention is
  // bounded, so this latest-render check is bounded as well.
  const supersededExposure = [...(state.cardExposures?.values() ?? [])].some(
    (candidate) => candidate.entryKey === exposure.entryKey && candidate.passSeq > exposure.passSeq,
  );
  if (supersededExposure) {
    return { status: 'stale-exposure', exposureId: normalizedExposureId, entryId: exposure.entryId };
  }

  const currentEntry = state.index?.entries.find(
    (entry) => foldRecallEntryKey(state.index!, entry) === exposure.entryKey,
  );
  if (!currentEntry) {
    return { status: 'stale-exposure', exposureId: normalizedExposureId, entryId: exposure.entryId };
  }

  const record: FoldRecallDismissalRecord = {
    entryKey: exposure.entryKey,
    entryId: currentEntry.id,
    matchedPath: exposure.matchedPath,
    exposureId: normalizedExposureId,
    dismissedAtPass: state.passSeq,
    expiresAtPass: Math.min(
      state.passSeq + FOLD_RECALL_DISMISSAL_WINDOW_PASSES,
      exposure.residencyExpiresAtPass,
    ),
  };
  dismissalMap(state).set(record.entryKey, record);
  exposure.dismissedAtPass = state.passSeq;

  // Replace the ordinary residency with the shorter feedback overlay. Remove
  // path residency only when it still belongs to this exact rendered card, so
  // delayed feedback cannot erase a newer card on the same path.
  state.resident.delete(exposure.residencyId);
  const pathRecord = state.residentPaths.get(exposure.matchedPath);
  if (pathRecord?.renderedCard === exposure.renderedCard) {
    state.residentPaths.delete(exposure.matchedPath);
  }
  state.dismissalsRecorded = (state.dismissalsRecorded ?? 0) + 1;
  return { status: 'recorded', record };
}

function refreshResidency(
  map: Map<string, ResidencyRecord>,
  key: string,
  expiresAtPass: number,
): void {
  const existing = map.get(key);
  if (existing) map.set(key, { ...existing, expiresAtPass });
}

function sweepPathResidencyByView(
  residentPaths: Map<string, ResidencyRecord>,
  index: FoldRecallIndex,
  rawHistory: readonly FoldMessage[],
  currentIndexSignature: string,
  passSeq: number,
  refreshedExpiresAtPass: number,
): void {
  const visibleCards = index.visibleRecallCards === undefined ? null : new Set(index.visibleRecallCards);
  if (visibleCards !== null) {
    const tailStart = Math.max(0, Math.min(index.rawCount, rawHistory.length));
    for (const card of collectVisibleRecallCards(rawHistory.slice(tailStart))) {
      visibleCards.add(card);
    }
  }
  for (const [path, record] of residentPaths) {
    const renderedCardVisible = record.renderedCard !== undefined && visibleCards?.has(record.renderedCard) === true;
    const canCheckView =
      visibleCards !== null &&
      record.level === 'card' &&
      record.renderedCard !== undefined &&
      record.indexSignature !== undefined &&
      (record.indexSignature !== currentIndexSignature || renderedCardVisible);

    if (canCheckView) {
      if (renderedCardVisible) {
        if (passSeq >= record.expiresAtPass) {
          residentPaths.set(path, { ...record, expiresAtPass: refreshedExpiresAtPass });
        }
      } else {
        residentPaths.delete(path);
      }
      continue;
    }

    if (passSeq >= record.expiresAtPass) residentPaths.delete(path);
  }
}

function makeResidencyRecord(
  level: 'card' | 'hint',
  expiresAtPass: number,
  renderedCard?: string,
  indexSignature?: string,
): ResidencyRecord {
  return {
    level,
    expiresAtPass,
    ...(renderedCard !== undefined ? { renderedCard } : {}),
    ...(indexSignature !== undefined ? { indexSignature } : {}),
  };
}

interface SuppressedRecallCoordinate {
  readonly paths: readonly string[];
  readonly source: string;
}

const SUPPRESSED_MANIFEST_MAX_ENTRIES = 6;
const SUPPRESSED_MANIFEST_MAX_CHARS = 480;
const SUPPRESSED_MANIFEST_REMINDER_PASSES = 6;

function suppressedRecallCoordinate(
  entry: FoldIndexEntry,
  matchedPath: string,
): SuppressedRecallCoordinate {
  const paths = entryPaths(entry);
  const fallbackPath = matchedPath.startsWith('term:') || matchedPath.startsWith('verbatim:')
    ? []
    : [matchedPath];
  const source = entry.kind === 'turn'
    ? `raw messages ${entry.rawStart + 1}–${entry.rawEnd}`
    : `raw message ${entry.recency + 1}`;
  return { paths: paths.length > 0 ? paths : fallbackPath, source };
}

function renderSuppressedRecallManifest(
  suppressed: number,
  coordinates: readonly SuppressedRecallCoordinate[],
): string {
  if (suppressed <= 0) return '';
  const header = `[Fold recall suppressed manifest — ${suppressed} matching bod${suppressed === 1 ? 'y' : 'ies'} withheld as already resident]`;
  const rows = coordinates.slice(0, SUPPRESSED_MANIFEST_MAX_ENTRIES).map((coordinate) => {
    const pathLabel = coordinate.paths.length > 0 ? coordinate.paths.slice(0, 3).join(', ') : 'path unavailable';
    return `- ${pathLabel} @ ${coordinate.source}`;
  });
  if (rows.length === 0) rows.push('- path/source coordinates unavailable');
  if (coordinates.length > rows.length) rows.push(`- …${coordinates.length - rows.length} more coordinate${coordinates.length - rows.length === 1 ? '' : 's'} elided`);
  const fitted: string[] = [];
  let used = header.length;
  for (const row of rows) {
    const boundedRow = row.length > 220 ? `${charSafeSlice(row, 0, 219)}…` : row;
    if (used + boundedRow.length + 1 > SUPPRESSED_MANIFEST_MAX_CHARS) break;
    fitted.push(boundedRow);
    used += boundedRow.length + 1;
  }
  return [header, ...fitted].join('\n');
}

/**
 * Show a suppressed-body manifest on first sight, whenever its bounded
 * composition changes, and occasionally while an identical suppression set
 * persists. This keeps the visibility win without repeating the same block at
 * every busy tool boundary.
 */
function takeSuppressedRecallManifest(
  state: FoldRecallState,
  suppressed: number,
  coordinates: readonly SuppressedRecallCoordinate[],
): string {
  const manifest = renderSuppressedRecallManifest(suppressed, coordinates);
  if (!manifest) {
    state.lastSuppressedManifestKey = null;
    state.suppressedManifestQuietPasses = 0;
    return '';
  }
  if (state.lastSuppressedManifestKey !== manifest) {
    state.lastSuppressedManifestKey = manifest;
    state.suppressedManifestQuietPasses = 0;
    return manifest;
  }
  const quietPasses = (state.suppressedManifestQuietPasses ?? 0) + 1;
  if (quietPasses >= SUPPRESSED_MANIFEST_REMINDER_PASSES) {
    state.suppressedManifestQuietPasses = 0;
    return manifest;
  }
  state.suppressedManifestQuietPasses = quietPasses;
  return '';
}

function fitSuppressedRecallManifest(manifest: string, maxChars: number): string {
  if (!manifest || maxChars < 80) return '';
  if (manifest.length <= maxChars) return manifest;
  return `${charSafeSlice(manifest, 0, maxChars - 1)}…`;
}

function rawTailProviderPovText(
  index: FoldRecallIndex,
  rawHistory: readonly FoldMessage[],
): string {
  const start = Math.max(0, Math.min(index.rawCount, rawHistory.length));
  return collectProviderViewText(rawHistory.slice(start));
}

/**
 * Remove exact, meaningful body paragraphs that are already visible in the
 * unfolded raw tail. Novel paragraphs remain, so a partly redundant card can
 * still recover unique tool output instead of being suppressed wholesale.
 */
function pruneRawTailResidentParagraphs(body: string, rawTailPovText: string): string {
  if (!rawTailPovText || !body.trim()) return body;
  const paragraphs = body.split(/\n{2,}/);
  const kept = paragraphs.filter((paragraph) => {
    const normalized = normalizeFoldRecallPovText(paragraph);
    return normalized.length < 82 || !rawTailPovText.includes(normalized);
  });
  return kept.join('\n\n').trim();
}

/**
 * One recall pass at a tool boundary: plan against the index + residency,
 * render measured cards/hints from in-memory raw history, update residency
 * and telemetry. Mutates only `state`. Deterministic for identical inputs.
 *
 * Budget semantics: the pressure char budget caps the TOTAL rendered block;
 * a card whose remaining budget is below MIN_USEFUL_CARD_CHARS downgrades to
 * a hint (an escalated resident hint suppresses instead of re-hinting).
 */
export function buildFoldRecallContext(
  state: FoldRecallState,
  rawHistory: readonly FoldMessage[],
  signals: RecallSignals,
  utilization: ContextUtilizationLevel,
  config: FoldRecallConfig,
  syntheticContext: SyntheticContextOptions = {},
): FoldRecallOutcome {
  if (!config.enabled || !state.index || state.index.entries.length === 0) return EMPTY_OUTCOME;
  // Staleness guard: a rewound history invalidates raw ranges; the next
  // freeze epoch (history-rewound) rebuilds the index from current truth.
  if (rawHistory.length < state.index.rawCount) return EMPTY_OUTCOME;

  // Index-change detection: a freeze epoch rebuilds the index, and entry ids
  // (turn:<startIndex>) can collide across rebuilds even though the refolded
  // entry is fresh. Clear entry-id residency on rebuild so the new entry can
  // legitimately re-card. Path residency is content-keyed and intentionally
  // survives refolds, so it is NOT cleared here.
  const currentIndexSignature = foldIndexSignature(state.index);
  if (state.lastIndexSignature != null && state.lastIndexSignature !== currentIndexSignature) {
    state.resident.clear();
  }
  state.lastIndexSignature = currentIndexSignature;

  const hasTermSignals = config.termRecallEnabled && (signals.terms?.length ?? 0) > 0;
  const hasVerbatimSignals = config.verbatimRecallEnabled && (signals.verbatimTokens?.length ?? 0) > 0;
  const hasErrorSignals = config.errorRecallEnabled !== false && (signals.errorSignatures?.length ?? 0) > 0;
  if (
    signals.touchedPaths.length === 0 &&
    signals.claimedPaths.length === 0 &&
    !hasTermSignals &&
    !hasVerbatimSignals &&
    !hasErrorSignals
  ) {
    return EMPTY_OUTCOME;
  }

  state.passSeq += 1;
  const passSeq = state.passSeq;
  const refreshedExpiresAtPass = passSeq + config.ttlPasses;

  // Deterministic sweep of expired residency and fixed-window feedback.
  for (const [id, record] of state.resident) {
    if (passSeq >= record.expiresAtPass) state.resident.delete(id);
  }
  for (const [entryKey, record] of state.dismissedEntries ?? []) {
    if (passSeq >= record.expiresAtPass) state.dismissedEntries!.delete(entryKey);
  }
  sweepPathResidencyByView(state.residentPaths, state.index, rawHistory, currentIndexSignature, passSeq, refreshedExpiresAtPass);

  const plan = planRecall(
    state.index,
    state.resident,
    state.residentPaths,
    passSeq,
    signals,
    utilization,
    config,
    state.dismissedEntries,
  );
  let suppressed = plan.suppressed;
  const suppressedCoordinates = new Map<string, SuppressedRecallCoordinate>();
  const recordSuppressed = (entry: FoldIndexEntry, matchedPath: string): void => {
    const coordinate = suppressedRecallCoordinate(entry, matchedPath);
    const key = `${coordinate.paths.join('\u0000')}\u0001${coordinate.source}`;
    if (!suppressedCoordinates.has(key)) suppressedCoordinates.set(key, coordinate);
  };
  const entriesById = new Map(state.index.entries.map((entry) => [entry.id, entry]));
  for (const residency of plan.suppressedResidencies) {
    const entry = entriesById.get(residency.entryId);
    if (entry) recordSuppressed(entry, residency.matchedPath);
    if (residency.refreshEntry) {
      refreshResidency(
        state.resident,
        residency.residencyId ?? residency.entryId,
        refreshedExpiresAtPass,
      );
    }
    if (residency.refreshPath) refreshResidency(state.residentPaths, residency.matchedPath, refreshedExpiresAtPass);
  }
  const budget = pressureBudget(utilization, config);
  if (plan.items.length === 0) {
    const rawSuppressedManifest = takeSuppressedRecallManifest(state, suppressed, [...suppressedCoordinates.values()]);
    const suppressedManifest = fitSuppressedRecallManifest(rawSuppressedManifest, budget.charBudget);
    state.suppressed += suppressed;
    state.recallChars += suppressedManifest.length;
    return {
      ...EMPTY_OUTCOME,
      text: suppressedManifest || null,
      chars: suppressedManifest.length,
      suppressed,
      ...(suppressedManifest ? { suppressedManifest } : {}),
    };
  }

  const providerPovText = foldRecallProviderPovText(state.index, rawHistory);
  const rawTailPovText = rawTailProviderPovText(state.index, rawHistory);
  const blocks: string[] = [];
  const triggers: string[] = [];
  const injected: Array<{ id: string; level: 'card' | 'hint' }> = [];
  let charsUsed = 0;
  let cards = 0;
  let hints = 0;
  let composition: RecallCompositionStats | null = null;
  const exposures: FoldRecallCardExposure[] = [];
  const emittedCardContentKeys = new Set<string>();
  // Radar dedup: paths the current Atlas-read tool already rendered live, whose
  // radar would duplicate the tool output (empty set ⇒ byte-identical).
  const radarSuppressPaths = new Set(signals.atlasReadPaths ?? []);

  for (const item of plan.items) {
    const separatorChars = blocks.length > 0 ? 2 : 0;
    const remaining = budget.charBudget - charsUsed - separatorChars;
    if (remaining <= 0) break;

    let level: 'card' | 'hint' = item.render;
    let rendered: string | null = null;
    let cardStats: RecallCompositionStats | null = null;
    let cardContentKey: string | null = null;

    if (item.supersessions && item.supersessions.length > 0) {
      level = 'hint';
      rendered = renderHint(item);
    }

    if (level === 'card') {
      const uncappedBodyBudget = Math.min(config.maxCardChars, remaining - RECALL_BODY_RESERVED_GAP_CHARS);
      // Repeat-recall shrink (rail-c63e326e s6): a path already carded earlier
      // this session, with no signaled live-source change, needs less budget
      // on each repeat — the agent has already seen it once.
      const priorShowCount = state.pathCardShowCounts.get(item.matchedPath) ?? 0;
      const shrinkRatio = isPathContentUnchanged(item.matchedPath, state)
        ? repeatCardBudgetRatio(priorShowCount)
        : 1;
      const bodyBudget = shrinkRatio < 1 ? Math.floor(uncappedBodyBudget * shrinkRatio) : uncappedBodyBudget;
      if (bodyBudget < MIN_USEFUL_CARD_CHARS) {
        level = 'hint'; // measured budget overflow → card degrades to hint
      } else {
        const recallPaths = recallZonePaths(item, state);
        const sourceDeltas = resolveItemSourceDeltaMap(item, state);
        // Body-swap is claim-tier only: a claim says "about to edit this file",
        // where stale code is actively dangerous. Read/term-tier recalls are
        // passive glances — they keep the historical body and rely on the
        // notifier's drift warning instead.
        const rb = renderEntryBody(item.entry, recallPaths, rawHistory, syntheticContext, sourceDeltas, item.tier === 1);
        if (rb === null) continue; // raw no longer recoverable — skip silently
        // Curated Code Radar may take up to a third of the card body budget; the
        // notifier + excerpt share the rest. '' (empty carriers / flags off) ⇒ byte-identical.
        const radar = buildRadar(item, state, config, Math.floor(bodyBudget / 3), radarSuppressPaths);
        const episodeVoice = buildEpisodeVoiceBlock(item, state, config, Math.floor(bodyBudget / 4), radarSuppressPaths);
        // Atlas routes are mandatory coordinates, so let them consume the full
        // body budget. buildAtlasMetaBlock keeps optional identity prose on the
        // former one-third sub-ceiling; renderCard charges every non-reserved
        // byte against the same measured envelope.
        const atlasMeta = buildAtlasMetaBlock(item, state, config, bodyBudget, radarSuppressPaths);
        if (atlasMeta === null) {
          // A mandatory mechanical route could not fit. Preserve the invariant
          // that every full edit-relevant card carries it by degrading this
          // candidate to the ordinary bounded hint path.
          level = 'hint';
        } else {
          // Information residency is broader than recall-card residency. Suppress
          // only when the recovered body AND every rendered enrichment are already
          // present. A source-delta notifier is always novel continuity evidence,
          // so changed/beyond-source cards must still render even when their body
          // is resident elsewhere in POV.
          const residentPrunedBody = rb.applied.length === 0
            ? pruneRawTailResidentParagraphs(rb.body, rawTailPovText)
            : rb.body;
          if (!residentPrunedBody) {
            suppressed++;
            recordSuppressed(item.entry, item.matchedPath);
            continue;
          }
          const povComponents = [residentPrunedBody, radar, episodeVoice, atlasMeta].filter((part) => part.length > 0);
          cardContentKey = povComponents.map(normalizeFoldRecallPovText).join('\u0000');
          const allComponentsResident = rb.applied.length === 0
            && povComponents.length > 0
            && povComponents.every((part) => {
              const normalized = normalizeFoldRecallPovText(part);
              const minimumResidentChars = part === atlasMeta ? 20 : 82;
              return normalized.length >= minimumResidentChars && providerPovText.includes(normalized);
            });
          if (allComponentsResident) {
            suppressed++;
            recordSuppressed(item.entry, item.matchedPath);
            continue;
          }
          if (rb.applied.length === 0 && cardContentKey && emittedCardContentKeys.has(cardContentKey)) {
            suppressed++;
            recordSuppressed(item.entry, item.matchedPath);
            continue;
          }
          const rc = renderCard(
            item,
            residentPrunedBody,
            bodyBudget,
            remaining,
            radar,
            rb.applied,
            rawHistory,
            state.index?.rawCount ?? rawHistory.length,
            episodeVoice,
            atlasMeta,
          );
          rendered = rc.text;
          if (rendered.length > remaining) {
            level = 'hint';
            rendered = null;
          } else {
            cardStats = rc.stats;
          }
        }
      }
    }

    if (level === 'hint') {
      if (item.escalatedFromHint) {
        // Already hinted recently and we cannot afford the card — stay quiet.
        suppressed++;
        recordSuppressed(item.entry, item.matchedPath);
        refreshResidency(state.resident, item.entry.id, refreshedExpiresAtPass);
        continue;
      }
      const safetyCorrection = (item.supersessions?.length ?? 0) > 0;
      if (hints >= MAX_HINTS_PER_PASS && !safetyCorrection) continue;
      rendered ??= renderHint(item);
      if (rendered.length > remaining) continue;
    }

    if (rendered === null) continue;
    // Hints are single-line and have no path-level visible-card ledger. After
    // an index rebuild their entry residency can reset while the exact hint is
    // still in POV. The same literal check also closes any full-card seam not
    // covered by body/enrichment component residency above.
    const normalizedRendered = normalizeFoldRecallPovText(rendered);
    if (normalizedRendered.length >= 42 && providerPovText.includes(normalizedRendered)) {
      suppressed++;
      recordSuppressed(item.entry, item.matchedPath);
      continue;
    }
    blocks.push(rendered);
    triggers.push(item.trigger);
    injected.push({ id: item.residencyId ?? item.entry.id, level });
    if (level === 'card') {
      if (cardContentKey) emittedCardContentKeys.add(cardContentKey);
      // Content-level residency: keep this path quiet across index rebuilds.
      state.residentPaths.set(
        item.matchedPath,
        makeResidencyRecord('card', passSeq + config.ttlPasses, rendered, currentIndexSignature),
      );
      // Lifetime repeat counter (rail-c63e326e s6) — never expires/clears, unlike residency.
      state.pathCardShowCounts.set(item.matchedPath, (state.pathCardShowCounts.get(item.matchedPath) ?? 0) + 1);
      const entryKey = foldRecallEntryKey(state.index, item.entry);
      const exposureId = `fold-recall-exposure/v1:${passSeq}:${item.entry.id}:${hashVisibleCard(`${currentIndexSignature}\u0000${entryKey}\u0000${item.matchedPath}`)}`;
      const exposure: FoldRecallCardExposureRecord = {
        exposureId,
        entryId: item.entry.id,
        entryKey,
        matchedPath: item.matchedPath,
        residencyId: item.residencyId ?? item.entry.id,
        indexSignature: currentIndexSignature,
        residencyExpiresAtPass: passSeq + config.ttlPasses,
        renderedCard: rendered,
        passSeq,
      };
      recordCardExposure(state, exposure);
      exposures.push({ exposureId, entryId: item.entry.id, matchedPath: item.matchedPath, passSeq });
    }
    charsUsed += separatorChars + rendered.length;
    if (level === 'card') cards++;
    else hints++;
    if (level === 'card' && cardStats !== null) {
      composition = composition === null
        ? { ...cardStats }
        : {
            bodyChars: composition.bodyChars + cardStats.bodyChars,
            notifierChars: composition.notifierChars + cardStats.notifierChars,
            radarChars: composition.radarChars + cardStats.radarChars,
            episodeVoiceChars: composition.episodeVoiceChars + cardStats.episodeVoiceChars,
            atlasMetaChars: composition.atlasMetaChars + cardStats.atlasMetaChars,
            swappedPaths: composition.swappedPaths + cardStats.swappedPaths,
          };
    }
  }

  for (const { id, level } of injected) {
    state.resident.set(id, makeResidencyRecord(level, passSeq + config.ttlPasses));
  }
  state.cardsInjected += cards;
  state.hintsInjected += hints;
  const rawSuppressedManifest = takeSuppressedRecallManifest(state, suppressed, [...suppressedCoordinates.values()]);
  const manifestSeparatorChars = blocks.length > 0 ? 2 : 0;
  const suppressedManifest = fitSuppressedRecallManifest(
    rawSuppressedManifest,
    budget.charBudget - charsUsed - manifestSeparatorChars,
  );
  if (suppressedManifest) {
    blocks.push(suppressedManifest);
    charsUsed += manifestSeparatorChars + suppressedManifest.length;
  }
  state.recallChars += charsUsed;
  state.suppressed += suppressed;

  if (blocks.length === 0) {
    return {
      ...EMPTY_OUTCOME,
      suppressed,
      ...(plan.intents.length > 0 ? { recallIntents: plan.intents } : {}),
    };
  }
  const text = blocks.join('\n\n');
  return {
    contractVersion: FOLD_RECALL_COMPLETENESS_CONTRACT_VERSION,
    text,
    cards,
    hints,
    chars: text.length,
    suppressed,
    ...(suppressedManifest ? { suppressedManifest } : {}),
    triggers,
    ...(plan.intents.length > 0 ? { recallIntents: plan.intents } : {}),
    ...(composition !== null ? { composition } : {}),
    ...(exposures.length > 0 ? { exposures } : {}),
  };
}

// ══════════════════════════════════════════════════════════════════════
// Explicit recall (pure, append-only host surface)
// ══════════════════════════════════════════════════════════════════════

/** First-class drill-downs over material already represented by the fold index. */
export type ExplicitFoldRecallQuery =
  | { kind: 'range'; startEvent: number; endEventExclusive: number }
  | { kind: 'path'; path: string }
  | { kind: 'term'; term: string }
  | { kind: 'waypoint'; waypoint: string }
  | { kind: 'episode'; chapterId: number };

export interface ExplicitFoldRecallOptions {
  /**
   * Caller-requested total ceiling. The ambient config remains authoritative:
   * this value can lower, never raise, FoldRecallConfig.maxTotalChars.
   */
  maxTotalChars?: number;
  /**
   * Caller-requested per-result body ceiling. This can lower, never raise,
   * FoldRecallConfig.maxCardChars.
   */
  maxResultChars?: number;
  /**
   * Caller-requested result count. This can lower, never raise,
   * FoldRecallConfig.maxCards.
   */
  maxResults?: number;
}

export type ExplicitFoldRecallStratum =
  | 'folded-turn'
  | 'folded-tool-result'
  | 'spooled-artifact'
  | 'episode-ledger';

export interface ExplicitFoldRecallSource {
  /** Raw message coordinates backing the result; absent for episode-ledger rows. */
  startMessage: number | null;
  endMessageExclusive: number | null;
  /** Exact source-row identities carried by the raw messages. Never synthesized. */
  sourceIdentities: string[];
  /** Measured source-time bounds. Unknown remains null. */
  firstSourceTime: string | null;
  lastSourceTime: string | null;
}

export interface ExplicitFoldRecallMatch {
  id: string;
  stratum: ExplicitFoldRecallStratum;
  source: ExplicitFoldRecallSource;
  provenance: string;
  body: string;
  /** Exact replacement pointers when the historical body was withheld. */
  supersessions?: readonly FoldRecallSupersessionResolution[];
}

export interface ExplicitFoldRecallOutcome {
  /** Normative coverage/freshness contract governing this outcome. */
  contractVersion: typeof FOLD_RECALL_COMPLETENESS_CONTRACT_VERSION;
  status: 'matched' | 'empty' | 'unavailable';
  query: ExplicitFoldRecallQuery;
  text: string;
  chars: number;
  totalMatches: number;
  returnedMatches: number;
  omittedMatches: number;
  truncated: boolean;
  /**
   * Host contract: the returned text is suitable only for a newly appended
   * tool-result/context message. The query path never requests an epoch.
   */
  injection: 'append-only';
  frozenPrefixMutated: false;
  epochTriggered: false;
  matches: ExplicitFoldRecallMatch[];
}

/** Match bare and namespaced bridge names without coupling to a host canonicalizer. */
export function isExplicitFoldRecallToolName(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  return toolName === 'fold_recall' || toolName.endsWith('__fold_recall');
}

interface ExplicitFoldRecallCandidate extends ExplicitFoldRecallMatch {
  recency: number;
}

function explicitQueryLabel(query: ExplicitFoldRecallQuery): string {
  switch (query.kind) {
    case 'range':
      return `range:event#${query.startEvent}..event#${query.endEventExclusive}`;
    case 'path':
      return `path:${normalizeToolPath(query.path.trim())}`;
    case 'term':
      return `term:${query.term.trim()}`;
    case 'waypoint':
      return `waypoint:${query.waypoint.trim()}`;
    case 'episode':
      return `episode:chapter#${query.chapterId}`;
  }
}

function validateExplicitFoldRecallQuery(query: ExplicitFoldRecallQuery): void {
  switch (query.kind) {
    case 'range':
      if (
        !Number.isSafeInteger(query.startEvent)
        || !Number.isSafeInteger(query.endEventExclusive)
        || query.startEvent < 0
        || query.endEventExclusive <= query.startEvent
      ) {
        throw new RangeError('Explicit recall range requires 0 <= startEvent < endEventExclusive.');
      }
      return;
    case 'path':
      if (!normalizeToolPath(query.path.trim())) throw new Error('Explicit recall path must be non-empty.');
      return;
    case 'term':
      if (!query.term.trim()) throw new Error('Explicit recall term must be non-empty.');
      return;
    case 'waypoint':
      if (!query.waypoint.trim()) throw new Error('Explicit recall waypoint must be non-empty.');
      return;
    case 'episode':
      if (!Number.isSafeInteger(query.chapterId) || query.chapterId < 0) {
        throw new RangeError('Explicit recall chapterId must be a non-negative integer.');
      }
  }
}

function explicitEntryBounds(entry: FoldIndexEntry): { start: number; endExclusive: number } {
  return entry.kind === 'turn'
    ? { start: entry.rawStart, endExclusive: entry.rawEnd }
    : { start: entry.recency, endExclusive: entry.recency + 1 };
}

function explicitEntrySlice(
  entry: FoldIndexEntry,
  rawHistory: readonly FoldMessage[],
): readonly FoldMessage[] {
  const bounds = explicitEntryBounds(entry);
  if (
    bounds.start < 0
    || bounds.start >= bounds.endExclusive
    || bounds.endExclusive > rawHistory.length
  ) return [];
  return rawHistory.slice(bounds.start, bounds.endExclusive);
}

function explicitSourceIdentities(messages: readonly FoldMessage[]): string[] {
  const identities = new Set<string>();
  for (const message of messages) {
    for (const identity of foldMessageSourceIdentities(message)) identities.add(identity);
  }
  return [...identities];
}

function explicitEventCoordinate(sourceIdentity: string | undefined): number | null {
  if (!sourceIdentity) return null;
  const match = /(?:^|[:/])event(?:#|:)(\d+)(?:\b|$)/u.exec(sourceIdentity);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(value) ? value : null;
}

function explicitSupersessionPoint(sourceIdentity: string) {
  const match = /^(.*):event#(\d+)$/u.exec(sourceIdentity);
  const index = match ? Number.parseInt(match[2], 10) : Number.NaN;
  return match?.[1] && Number.isSafeInteger(index)
    ? { traceId: match[1], unit: 'event' as const, index }
    : { unit: 'event' as const, id: sourceIdentity };
}

function explicitEntrySearchText(
  entry: FoldIndexEntry,
  rawHistory: readonly FoldMessage[],
): string {
  const parts = [entry.id];
  if (entry.kind === 'turn') parts.push(entry.digest, ...entry.paths, ...(entry.sourcePaths ?? []));
  else {
    parts.push(entry.tool, entry.path, entry.sourcePath ?? '');
    if (entry.kind === 'spool') {
      parts.push(entry.artifactId, entry.digest ?? '', ...(entry.verbatimTokens ?? []));
    }
  }
  for (const message of explicitEntrySlice(entry, rawHistory)) {
    parts.push(...foldMessageSourceIdentities(message), ...collectMessageTextFragments(message));
  }
  return parts.join('\n');
}

function explicitEntryStratum(entry: FoldIndexEntry): ExplicitFoldRecallStratum {
  if (entry.kind === 'turn') return 'folded-turn';
  if (entry.kind === 'tool') return 'folded-tool-result';
  return 'spooled-artifact';
}

function explicitEntryProvenance(
  entry: FoldIndexEntry,
  rawHistory: readonly FoldMessage[],
  rawTailStart: number,
  supersessions: readonly FoldRecallSupersessionResolution[] = [],
): { source: ExplicitFoldRecallSource; rendered: string } {
  const bounds = explicitEntryBounds(entry);
  const messages = explicitEntrySlice(entry, rawHistory);
  const times = foldMessageTimestampBounds(messages);
  const sourceIdentities = explicitSourceIdentities(messages);
  const rawTailCount = Math.max(0, rawHistory.length - rawTailStart);
  const rendered = renderChronologicalProvenanceCompact({
    artifact: `explicit-fold-recall#${entry.id}`,
    contentClass: 'retrieved-history',
    source: {
      start: { unit: 'message', index: bounds.start, timestamp: times.firstTimestamp },
      endExclusive: { unit: 'message', index: bounds.endExclusive },
      count: bounds.endExclusive - bounds.start,
      lastTimestamp: times.lastTimestamp,
    },
    transformedAt: { unit: 'message', index: rawHistory.length },
    ...(rawTailCount > 0
      ? { rawResumesAt: { unit: 'message', index: rawTailStart } as const }
      : {}),
    authority: 'historical-background',
    supersession: supersessions.length > 0
      ? 'explicit'
      : rawTailCount > 0 ? 'later-raw-wins' : 'none-known',
    ...(supersessions[0]
      ? { supersededAt: explicitSupersessionPoint(supersessions[0].terminalIdentity) }
      : {}),
    topology: {
      host: 'dedicated-synthetic-message',
      previous: 'raw-history',
      next: rawTailCount > 0 ? 'raw-tail' : 'none',
      representation: 'canonical',
      rawTailCount,
    },
  });
  const identityLine = sourceIdentities.length > 0
    ? `source-identities=${sourceIdentities.join(',')}`
    : 'source-identities=unknown';
  const supersessionLines = supersessions.map((resolution) => (
    'supersession=explicit:' + resolution.terminalIdentity
      + ' source-id=' + resolution.sourceIdentity
      + ' superseded-by=' + resolution.supersededByIdentity
  ));
  return {
    source: {
      startMessage: bounds.start,
      endMessageExclusive: bounds.endExclusive,
      sourceIdentities,
      firstSourceTime: times.firstTimestamp ?? null,
      lastSourceTime: times.lastTimestamp ?? null,
    },
    rendered: [rendered, identityLine, ...supersessionLines].filter(Boolean).join('\n'),
  };
}

function explicitEntryBody(
  entry: FoldIndexEntry,
  rawHistory: readonly FoldMessage[],
): string | null {
  if (entry.kind === 'spool') {
    return [
      `Spool artifact ${entry.artifactId} is not resident in raw history.`,
      `tool=${entry.tool || 'unknown'} path=${entry.path || 'unknown'} chars=${entry.chars}`,
      `recovery=read_spooled_artifact artifact_id=${entry.artifactId} sha256=${entry.sha256}`,
    ].join('\n');
  }
  const paths = entry.kind === 'turn'
    ? entry.paths
    : entry.path ? [entry.path] : [];
  return renderEntryBody(entry, paths, rawHistory, {}, new Map(), false)?.body ?? null;
}

function explicitEntryMatches(
  entry: FoldIndexEntry,
  rawHistory: readonly FoldMessage[],
  query: ExplicitFoldRecallQuery,
  exactSourcePathOnly = false,
): boolean {
  if (query.kind === 'episode') return false;
  if (query.kind === 'range') {
    return explicitEntrySlice(entry, rawHistory).some((message) => {
      return foldMessageSourceIdentities(message).some((sourceIdentity) => {
        const coordinate = explicitEventCoordinate(sourceIdentity);
        return coordinate !== null
          && coordinate >= query.startEvent
          && coordinate < query.endEventExclusive;
      });
    });
  }
  if (query.kind === 'path') {
    const spelling = query.path.trim();
    const sourcePaths = entry.kind === 'turn'
      ? entry.sourcePaths ?? []
      : entry.sourcePath ? [entry.sourcePath] : [];
    if (exactSourcePathOnly) return sourcePaths.includes(spelling);
    const target = normalizeToolPath(spelling);
    const aliases = foldIndexEntryPaths(entry);
    return aliases.includes(target)
      || sourcePaths.includes(spelling);
  }
  const needle = (query.kind === 'term' ? query.term : query.waypoint).trim().toLowerCase();
  return explicitEntrySearchText(entry, rawHistory).toLowerCase().includes(needle);
}

function collectExplicitEntryCandidates(
  state: FoldRecallState,
  rawHistory: readonly FoldMessage[],
  query: ExplicitFoldRecallQuery,
): ExplicitFoldRecallCandidate[] {
  const index = state.index;
  if (!index || query.kind === 'episode') return [];
  const exactPathSpelling = query.kind === 'path' ? query.path.trim() : null;
  const exactSourcePathOnly = exactPathSpelling !== null && index.entries.some((entry) => {
    const bounds = explicitEntryBounds(entry);
    if (explicitEntrySlice(entry, rawHistory).length !== bounds.endExclusive - bounds.start) return false;
    return entry.kind === 'turn'
      ? (entry.sourcePaths ?? []).includes(exactPathSpelling)
      : entry.sourcePath === exactPathSpelling;
  });
  const candidates: ExplicitFoldRecallCandidate[] = [];
  for (const entry of index.entries) {
    const bounds = explicitEntryBounds(entry);
    if (explicitEntrySlice(entry, rawHistory).length !== bounds.endExclusive - bounds.start) continue;
    if (!explicitEntryMatches(entry, rawHistory, query, exactSourcePathOnly)) continue;
    const supersessions = resolveFoldRecallEntrySupersessions(index, entry);
    const body = supersessions.length > 0
      ? [
          'Historical body withheld because its exact source identity is superseded.',
          ...supersessions.map((resolution) => (
            'source-id=' + resolution.sourceIdentity
              + ' superseded-by=' + resolution.supersededByIdentity
              + ' terminal=' + resolution.terminalIdentity
          )),
        ].join('\n')
      : explicitEntryBody(entry, rawHistory);
    if (!body) continue;
    const provenance = explicitEntryProvenance(entry, rawHistory, index.rawCount, supersessions);
    candidates.push({
      id: entry.id,
      stratum: explicitEntryStratum(entry),
      source: provenance.source,
      provenance: provenance.rendered,
      body,
      ...(supersessions.length > 0 ? { supersessions } : {}),
      recency: entry.recency,
    });
  }
  return candidates.sort((a, b) => {
    if (query.kind === 'range') {
      const aStart = a.source.startMessage ?? Number.MAX_SAFE_INTEGER;
      const bStart = b.source.startMessage ?? Number.MAX_SAFE_INTEGER;
      if (aStart !== bStart) return aStart - bStart;
    }
    return b.recency - a.recency || a.id.localeCompare(b.id);
  });
}

function collectExplicitEpisodeCandidates(
  state: FoldRecallState,
  query: ExplicitFoldRecallQuery,
): ExplicitFoldRecallCandidate[] {
  if (query.kind !== 'episode') return [];
  const candidates: ExplicitFoldRecallCandidate[] = [];
  const dedupe = new Set<string>();
  const entries = [...state.pathEpisodes.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [path, voices] of entries) {
    for (const voice of voices) {
      if (!voice.chapterIds.includes(query.chapterId)) continue;
      const signature = `${path}\u0000${voice.endedAt}\u0000${voice.chapterIds.join(',')}\u0000${voice.voiceLines.join('\n')}`;
      if (dedupe.has(signature)) continue;
      dedupe.add(signature);
      const id = `episode:${query.chapterId}:${path}`;
      candidates.push({
        id,
        stratum: 'episode-ledger',
        source: {
          startMessage: null,
          endMessageExclusive: null,
          sourceIdentities: [`fold-episode:chapter#${query.chapterId}`],
          firstSourceTime: voice.endedAt || null,
          lastSourceTime: voice.endedAt || null,
        },
        provenance: [
          '[Chronological Provenance v1]',
          `artifact=explicit-fold-recall#${id} class=retrieved-history`,
          `source=fold-episode:chapter#${query.chapterId} source-time=${voice.endedAt || 'time unknown'}`,
          'authority=historical-background supersession=later-raw-wins stratum=episode-ledger',
        ].join('\n'),
        body: [
          `path=${path}`,
          `chapters=${voice.chapterIds.join(',')}`,
          voice.intent ? `intent=${voice.intent}` : null,
          ...voice.voiceLines,
        ].filter((line): line is string => line !== null).join('\n'),
        recency: Date.parse(voice.endedAt) || 0,
      });
    }
  }
  return candidates.sort((a, b) => b.recency - a.recency || a.id.localeCompare(b.id));
}

function clampExplicitLimit(requested: number | undefined, ceiling: number): number {
  const boundedCeiling = Number.isFinite(ceiling) ? Math.max(0, Math.floor(ceiling)) : 0;
  if (requested === undefined || !Number.isFinite(requested)) return boundedCeiling;
  return Math.max(0, Math.min(boundedCeiling, Math.floor(requested)));
}

function truncateExplicitBody(body: string, maxChars: number): { text: string; truncated: boolean } {
  if (body.length <= maxChars) return { text: body, truncated: false };
  const longReceipt = '\n…[explicit recall body elided by budget]…\n';
  const shortReceipt = '…[body-elided]…';
  const receipt = maxChars >= longReceipt.length ? longReceipt : shortReceipt;
  if (maxChars <= receipt.length) {
    return { text: charSafeSlice(receipt, 0, maxChars), truncated: true };
  }
  const available = maxChars - receipt.length;
  const headChars = Math.floor(available * 0.7);
  const tailChars = available - headChars;
  return {
    text: `${charSafeSlice(body, 0, headChars)}${receipt}${charSafeSlice(body, body.length - tailChars, body.length)}`,
    truncated: true,
  };
}

function explicitEmptyOutcome(
  query: ExplicitFoldRecallQuery,
  status: 'empty' | 'unavailable',
  reason: string,
  maxTotalChars: number,
): ExplicitFoldRecallOutcome {
  const fullText = [
    '[Explicit Fold Recall v1]',
    `status=${status} query=${explicitQueryLabel(query)}`,
    `reason=${reason}`,
    'injection=append-only frozen-prefix-mutated=false epoch-triggered=false',
    '[End explicit fold recall]',
  ].join('\n');
  const text = charSafeSlice(fullText, 0, maxTotalChars);
  return {
    contractVersion: FOLD_RECALL_COMPLETENESS_CONTRACT_VERSION,
    status,
    query,
    text,
    chars: text.length,
    totalMatches: 0,
    returnedMatches: 0,
    omittedMatches: 0,
    truncated: text.length < fullText.length,
    injection: 'append-only',
    frozenPrefixMutated: false,
    epochTriggered: false,
    matches: [],
  };
}

/** Build the same typed fail-closed response for hosts without a live fold index. */
export function buildExplicitFoldRecallUnavailableOutcome(
  query: ExplicitFoldRecallQuery,
  reason = 'host-does-not-expose-fold-index',
  maxTotalChars = DEFAULT_FOLD_RECALL_CONFIG.maxTotalChars,
): ExplicitFoldRecallOutcome {
  validateExplicitFoldRecallQuery(query);
  return explicitEmptyOutcome(
    query,
    'unavailable',
    reason,
    clampExplicitLimit(maxTotalChars, DEFAULT_FOLD_RECALL_CONFIG.maxTotalChars),
  );
}

/**
 * Query folded material directly without waiting for an ambient tool-boundary
 * trigger. Pure: it reads the current index/raw reference and returns a body
 * for the host to append as the current tool result. It never mutates recall
 * residency, the frozen prefix, raw history, or epoch state.
 */
export function buildExplicitFoldRecallContext(
  state: FoldRecallState,
  rawHistory: readonly FoldMessage[] | null | undefined,
  query: ExplicitFoldRecallQuery,
  config: FoldRecallConfig,
  options: ExplicitFoldRecallOptions = {},
): ExplicitFoldRecallOutcome {
  validateExplicitFoldRecallQuery(query);
  const maxTotalChars = clampExplicitLimit(options.maxTotalChars, config.maxTotalChars);
  const maxResultChars = clampExplicitLimit(options.maxResultChars, config.maxCardChars);
  const maxResults = clampExplicitLimit(options.maxResults, config.maxCards);
  if (!config.enabled) {
    return explicitEmptyOutcome(query, 'unavailable', 'fold-recall-disabled', maxTotalChars);
  }
  if (!state.index || !rawHistory || rawHistory.length < state.index.rawCount) {
    return explicitEmptyOutcome(query, 'unavailable', 'no-current-fold-index', maxTotalChars);
  }

  const candidates = query.kind === 'episode'
    ? collectExplicitEpisodeCandidates(state, query)
    : collectExplicitEntryCandidates(state, rawHistory, query);
  if (candidates.length === 0) {
    return explicitEmptyOutcome(query, 'empty', 'no-folded-match', maxTotalChars);
  }

  const selected = candidates.slice(0, maxResults);
  const fullHeader = [
    '[Explicit Fold Recall v1]',
    `status=matched query=${explicitQueryLabel(query)} total-matches=${candidates.length}`,
    'injection=append-only frozen-prefix-mutated=false epoch-triggered=false',
  ].join('\n');
  const header = charSafeSlice(fullHeader, 0, maxTotalChars);
  if (header.length < fullHeader.length) {
    return {
      contractVersion: FOLD_RECALL_COMPLETENESS_CONTRACT_VERSION,
      status: 'matched',
      query,
      text: header,
      chars: header.length,
      totalMatches: candidates.length,
      returnedMatches: 0,
      omittedMatches: candidates.length,
      truncated: true,
      injection: 'append-only',
      frozenPrefixMutated: false,
      epochTriggered: false,
      matches: [],
    };
  }
  const blocks: string[] = [header];
  const matches: ExplicitFoldRecallMatch[] = [];
  let used = header.length;
  let truncated = candidates.length > selected.length;

  for (const candidate of selected) {
    const bounded = truncateExplicitBody(candidate.body, maxResultChars);
    const prefix = [
      `[Explicit recall result ${matches.length + 1}]`,
      `id=${candidate.id} stratum=${candidate.stratum}`,
      candidate.provenance,
      '',
    ].join('\n');
    const suffix = '\n[End explicit recall result]';
    const separatorChars = 2;
    const remaining = maxTotalChars - used - separatorChars;
    if (remaining <= prefix.length + suffix.length) {
      truncated = true;
      break;
    }
    const allowedBodyChars = Math.min(
      bounded.text.length,
      remaining - prefix.length - suffix.length,
    );
    const fitted = allowedBodyChars < bounded.text.length
      ? truncateExplicitBody(candidate.body, allowedBodyChars)
      : bounded;
    const block = `${prefix}${fitted.text}${suffix}`;
    blocks.push(block);
    used += separatorChars + block.length;
    truncated ||= fitted.truncated;
    matches.push({
      id: candidate.id,
      stratum: candidate.stratum,
      source: candidate.source,
      provenance: candidate.provenance,
      body: fitted.text,
      ...(candidate.supersessions ? { supersessions: candidate.supersessions } : {}),
    });
  }

  const omittedMatches = candidates.length - matches.length;
  const receipt = omittedMatches > 0
    ? `[Explicit recall elision] omitted-matches=${omittedMatches} recovery=repeat-query-with-narrower-selector`
    : '[End explicit fold recall]';
  if (used + 2 + receipt.length <= maxTotalChars) blocks.push(receipt);
  else truncated = true;
  const text = blocks.join('\n\n');
  return {
    contractVersion: FOLD_RECALL_COMPLETENESS_CONTRACT_VERSION,
    status: 'matched',
    query,
    text,
    chars: text.length,
    totalMatches: candidates.length,
    returnedMatches: matches.length,
    omittedMatches,
    truncated,
    injection: 'append-only',
    frozenPrefixMutated: false,
    epochTriggered: false,
    matches,
  };
}
