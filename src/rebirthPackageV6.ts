/**
 * Canonical Rebirth Package v6 model and renderer.
 *
 * This module is deliberately pure: callers freeze every external fact before
 * construction, then every delivery surface renders the same immutable model.
 * It performs no filesystem, Git, Atlas, transcript, or relay-state reads.
 */

import { createHash } from 'node:crypto';

import type { ContinuityLiveFieldSource, ContinuityReceipt } from './continuityReceipt.ts';
import type { FoldMessage } from './rollingFold.ts';
import {
  collapseUnits,
  type CollapseResult,
  type CollapseUnit,
  type CollapseUnitPlacement,
} from './generationalCollapse.ts';
import { redactContinuityModel } from './redactionLane.ts';

export const REBIRTH_PACKAGE_V6_VERSION = 'rebirth-package-v6/v1' as const;
/**
 * Generational contract (spec docs/rebirth-package-generational-spec.md). The
 * model shape is a superset of v6: the three lineage sections are optional, so
 * a persisted v6 package remains a valid model and renders unchanged apart from
 * the rebalanced caps.
 */
export const REBIRTH_PACKAGE_V7_VERSION = 'rebirth-package-v7/v1' as const;

export type RebirthPackageVersion =
  | typeof REBIRTH_PACKAGE_V6_VERSION
  | typeof REBIRTH_PACKAGE_V7_VERSION;

export const REBIRTH_PACKAGE_V6_SECTION_IDS = [
  'boundaryAndActiveTask',
  'executionState',
  'activeEditDelta',
  'cognitiveArtifacts',
  'recentConversation',
  'operatorVault',
  'episodeChapterIndex',
  'lifeLedger',
  'recoveryIndex',
] as const;

/** Lineage sections introduced by the generational contract. */
export const REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS = [
  'operatorVault',
  'episodeChapterIndex',
  'lifeLedger',
] as const;

export type RebirthPackageV7LineageSectionId =
  (typeof REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS)[number];

export type RebirthPackageV6SectionId = (typeof REBIRTH_PACKAGE_V6_SECTION_IDS)[number];

export type RebirthPackageV6Lifecycle =
  | 'same_instance_hard_epoch'
  | 'continuation'
  | 'fresh_fork'
  | 'resurrection'
  | 'brain_merge';

export const REBIRTH_PACKAGE_V6_LIFECYCLE_PROFILES: Readonly<
  Record<RebirthPackageV6Lifecycle, { readonly identityMeaning: string }>
> = Object.freeze({
  same_instance_hard_epoch: {
    identityMeaning: 'same instance identity; provider context reset',
  },
  continuation: {
    identityMeaning: 'same instance identity; new session continuation',
  },
  fresh_fork: {
    identityMeaning: 'new instance identity; predecessor evidence is inherited',
  },
  resurrection: {
    identityMeaning: 'restored instance identity; persisted evidence resumed',
  },
  brain_merge: {
    identityMeaning: 'receiver identity retained; donor cognition is inherited',
  },
});

export type RebirthPackageV6SourceStatus = 'exact' | 'partial' | 'unknown';

export interface RebirthPackageV6SourceRef {
  /** Stable source-owned identity. Never an ingestion index or file position. */
  readonly provenanceId: string;
  /** Authoritative source-event time. Null remains unknown. */
  readonly sourceAt: string | null;
  readonly status: RebirthPackageV6SourceStatus;
}

export interface RebirthPackageV6ExactMessage {
  readonly text: string;
  readonly chars: number;
  readonly source: RebirthPackageV6SourceRef;
}

export type RebirthPackageV6ActiveRequestClaimStatus =
  | 'current'
  | 'expired_by_newer_operator'
  | 'fallback_operator_frontier_unknown';

export interface RebirthPackageV6ActiveRequestClaims {
  /** Newest known-time agent interpretation. Never operator authority. */
  readonly latest: RebirthPackageV6ExactMessage;
  readonly latestStatus: RebirthPackageV6ActiveRequestClaimStatus;
  /** Immediately preceding known-time interpretation, always expired. */
  readonly previous: RebirthPackageV6ExactMessage | null;
}

export interface RebirthPackageV6BoundaryAndActiveTask {
  readonly lifecycle: RebirthPackageV6Lifecycle;
  readonly lifecycleMeaning: string;
  readonly captureId: string;
  readonly capturedAt: string | null;
  readonly sourceFrontier: string | null;
  readonly instanceId: string;
  readonly instanceName: string;
  readonly predecessorInstanceId: string | null;
  readonly predecessorName: string | null;
  readonly workspace: string;
  readonly cwd: string | null;
  readonly runtimeChange: string | null;
  readonly activeRequest: RebirthPackageV6ExactMessage | null;
  readonly activeRequestClaims?: RebirthPackageV6ActiveRequestClaims;
  readonly lastMaterialAssistant: RebirthPackageV6ExactMessage | null;
  /**
   * Optional durable fork identity carried into the v6 Boundary. Distinct from
   * the relay's v4 prose banner: this is the structured fact set (is this the
   * immediate post-fork rebirth, which fork group, position within the group,
   * and the fork-point message) an agent needs to reason about its lineage
   * without re-expecting phantom post-fork coordination. Optional so retained
   * v1 models (and existing constructors that predate this field) remain valid:
   * absent means "no fork metadata provided at assembly time". Render it only
   * when present.
   */
  readonly forkContext?: {
    readonly isFreshFork: boolean;
    readonly groupId: string | null;
    readonly index: number | null;
    readonly count: number | null;
    readonly pointMessageId: string | null;
  } | null;
}

export interface RebirthPackageV6ExecutionFact {
  readonly provenanceId: string;
  readonly sourceAt: string | null;
  readonly status: RebirthPackageV6SourceStatus;
  readonly kind:
    | 'rail'
    | 'pending_assistant_action'
    | 'next_action'
    | 'blocker'
    | 'claim'
    | 'validation'
    | 'review'
    | 'runtime'
    | 'coordination';
  readonly text: string;
  /**
   * Measured chronology flag: present only when this fact's source time and
   * the active request's source time are BOTH known and this row is strictly
   * older. The capsule authority order (a later genuine operator message
   * outranks live rail direction) is why renderExecution surfaces it; the
   * model records the measurement, never the judgment. Absent covers every
   * unknown-time case — absence of evidence is not "current" (God Rule 8).
   */
  readonly predatesActiveRequest?: true;
}

export interface RebirthPackageV6ExecutionState {
  readonly facts: readonly RebirthPackageV6ExecutionFact[];
  readonly unknownReasons: readonly string[];
}

export type RebirthPackageV6EditState = 'none' | 'exact' | 'partial' | 'unknown';
export type RebirthPackageV6EditFileState = 'open' | 'partial' | 'unknown' | 'withheld_sensitive';

export interface RebirthPackageV6EditContributor {
  readonly provenanceId: string;
  readonly instanceId: string;
  readonly relation: 'owner' | 'inherited' | 'later_contributor' | 'unknown';
  readonly sourceAt: string | null;
}

export interface RebirthPackageV6EditPreview {
  readonly text: string;
  readonly complete: boolean;
  readonly omittedHunks: number;
  readonly omittedLines: number;
}

export interface RebirthPackageV6EditFile {
  readonly provenanceId: string;
  readonly sourceAt: string | null;
  readonly filePath: string;
  readonly changeKind: 'added' | 'modified' | 'deleted' | 'unchanged' | 'unknown';
  readonly baselineQuality: 'exact' | 'absent' | 'reconstructed_verified' | 'baseline_unknown' | 'withheld_sensitive';
  readonly ownership: 'mine' | 'inherited' | 'shared' | 'unattributed' | 'baseline_unknown';
  readonly state: RebirthPackageV6EditFileState;
  readonly insertions: number | null;
  readonly deletions: number | null;
  readonly validationState: 'passed' | 'failed' | 'pending' | 'unknown';
  readonly closureState: 'open' | 'returned_to_baseline' | 'git_landed' | 'atlas_landed' | 'explicit_archive' | 'unknown';
  readonly contributors: readonly RebirthPackageV6EditContributor[];
  readonly preview: RebirthPackageV6EditPreview | null;
  /** Null for sensitive-withheld files and unavailable exact recovery. */
  readonly diffHandle: string | null;
  /** Null for sensitive-withheld files and unavailable exact recovery. */
  readonly snapshotHandle: string | null;
  readonly reason: string | null;
}

export interface RebirthPackageV6ActiveEditDelta {
  readonly captureId: string | null;
  readonly state: RebirthPackageV6EditState;
  readonly capturedSourceAt: string | null;
  readonly completedObservedAt: string | null;
  readonly inheritedCaptureIds: readonly string[];
  readonly files: readonly RebirthPackageV6EditFile[];
  readonly omittedFiles: number;
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

export interface RebirthPackageV6CognitiveArtifact {
  readonly provenanceId: string;
  readonly sourceAt: string | null;
  readonly kind: 'decision' | 'discovery' | 'hazard' | 'question' | 'result' | 'flow';
  readonly text: string;
  readonly authority: string;
  readonly supersededBy: string | null;
}

export interface RebirthPackageV6CognitiveArtifactCapture {
  /** Completeness of the indexed projection, not of the underlying stores. */
  readonly status: 'complete' | 'partial' | 'unavailable';
  /** Capture/ingestion time; never used as artifact chronology. */
  readonly capturedAt: string | null;
  readonly totalMatched: number | null;
  readonly overlayCount: number | null;
  readonly missingFamilies: readonly string[];
  readonly warnings: readonly string[];
}

export interface RebirthPackageV6ConversationRow {
  readonly provenanceId: string;
  readonly sourceAt: string | null;
  readonly role: 'user' | 'assistant' | 'runtime';
  readonly text: string;
}

export interface RebirthPackageV6RecoveryHandle {
  readonly id: string;
  readonly label: string;
  /** Exact tool command or durable URI. */
  readonly handle: string;
  readonly status: 'available' | 'partial' | 'unavailable';
  readonly count: number | null;
  readonly frontier: string | null;
  /**
   * Optional bounded inline snapshot of the evidence this handle points at
   * (for example a captured Atlas handoff card body). Distinct from `label`,
   * which stays a short title. Rendered beneath the handle when present and
   * elided-with-exact-handle when it exceeds the section budget. Optional so
   * retained v1 models (entries without inline evidence) remain valid.
   */
  readonly inlineEvidence?: string;
}

/**
 * A lineage section's content is a list of collapse units: the generational
 * engine decides each unit's tier from the section's budget, so the model
 * carries the whole lineage and the renderer carries the arithmetic.
 */
export type RebirthPackageV7LineageUnit = CollapseUnit;

export interface RebirthPackageV7LineageSection {
  readonly units: readonly RebirthPackageV7LineageUnit[];
  /** Exact range-recovery command used by T4 rollups. */
  readonly rangeRecover: string | null;
  /** Explicit reason when the feeder could not read the whole store. */
  readonly partialReason?: string | null;
}

export const EMPTY_REBIRTH_PACKAGE_V7_LINEAGE_SECTION: RebirthPackageV7LineageSection =
  Object.freeze({ units: [], rangeRecover: null, partialReason: null });

export interface RebirthPackageV6Model {
  readonly version: RebirthPackageVersion;
  readonly boundaryAndActiveTask: RebirthPackageV6BoundaryAndActiveTask;
  readonly executionState: RebirthPackageV6ExecutionState;
  readonly activeEditDelta: RebirthPackageV6ActiveEditDelta;
  readonly cognitiveArtifacts: readonly RebirthPackageV6CognitiveArtifact[];
  /** Optional for persisted packages produced before indexed cognition delivery. */
  readonly cognitiveArtifactCapture?: RebirthPackageV6CognitiveArtifactCapture;
  readonly recentConversation: readonly RebirthPackageV6ConversationRow[];
  // Lineage sections are optional on the model because `isRebirthPackageV6Model`
  // accepts persisted v6 packages that predate them. `buildRebirthPackageV6Model`
  // always populates all three; readers must still treat absence as empty so the
  // type never promises more than the validator enforces.
  /** Every operator message ever, tiered by the generational engine. */
  readonly operatorVault?: RebirthPackageV7LineageSection;
  /** Episode/chapter history newest-verbatim, older eras collapsed. */
  readonly episodeChapterIndex?: RebirthPackageV7LineageSection;
  /** One line per life/boundary; older lives fuse into era lines. */
  readonly lifeLedger?: RebirthPackageV7LineageSection;
  readonly recoveryIndex: readonly RebirthPackageV6RecoveryHandle[];
}

export interface BuildRebirthPackageV6ModelInput {
  readonly boundaryAndActiveTask: RebirthPackageV6BoundaryAndActiveTask;
  readonly executionState?: RebirthPackageV6ExecutionState;
  readonly activeEditDelta?: RebirthPackageV6ActiveEditDelta;
  readonly cognitiveArtifacts?: readonly RebirthPackageV6CognitiveArtifact[];
  readonly cognitiveArtifactCapture?: RebirthPackageV6CognitiveArtifactCapture;
  readonly recentConversation?: readonly RebirthPackageV6ConversationRow[];
  readonly operatorVault?: RebirthPackageV7LineageSection;
  readonly episodeChapterIndex?: RebirthPackageV7LineageSection;
  readonly lifeLedger?: RebirthPackageV7LineageSection;
  readonly recoveryIndex?: readonly RebirthPackageV6RecoveryHandle[];
}

export interface RebirthPackageV6LegacyShape {
  readonly predecessorName?: string;
  readonly lifecycleBoundary?: RebirthPackageV6Lifecycle;
  readonly triggeringUserMessage?: string;
  readonly lastUserAiMessages?: string;
  readonly currentThread?: string;
  readonly activeEditDelta?: string;
  readonly cognitiveArtifacts?: string;
  readonly starredMoments?: string;
  readonly taskRailContext?: string;
  readonly resumePoint?: string;
  readonly coordinationState?: string;
  readonly workspaceContext?: string | {
    readonly currentCwd?: string;
    readonly currentWorkspace?: string;
  };
  readonly runtimeModel?: {
    readonly changed?: boolean;
    readonly predecessor?: { readonly engine?: string; readonly model?: string };
    readonly successor?: { readonly engine?: string; readonly model?: string };
  };
  /** Canonical receipt type; persisted v1 receipts may omit newer optional fields. */
  readonly continuityReceipt?: ContinuityReceipt;
}

export interface AdaptLegacyRebirthPackageV6Options {
  readonly predecessorName?: string;
  readonly instanceId?: string;
  readonly instanceName?: string;
  readonly workspace?: string;
  readonly cwd?: string;
  readonly activeEditDelta?: RebirthPackageV6ActiveEditDelta;
  readonly cognitiveArtifacts?: readonly RebirthPackageV6CognitiveArtifact[];
  readonly recentConversation?: readonly RebirthPackageV6ConversationRow[];
  readonly operatorVault?: RebirthPackageV7LineageSection;
  readonly episodeChapterIndex?: RebirthPackageV7LineageSection;
  readonly lifeLedger?: RebirthPackageV7LineageSection;
  readonly recoveryIndex?: readonly RebirthPackageV6RecoveryHandle[];
}

export interface RenderRebirthPackageV6Options {
  /**
   * Soft total-package target (protected relay envelope included). When the
   * first render is larger, collapse-citizen sections are re-rendered at
   * reduced caps before the hard package ceiling is allowed to elide a whole
   * section. Defaults to `packageBudget`, preserving the 100k production
   * ceiling while giving callers a lower push target when desired.
   */
  readonly pushTargetChars?: number;
  readonly packageBudget?: number;
  readonly sectionMaxChars?: Partial<Record<RebirthPackageV6SectionId, number>>;
  /**
   * Chars consumed by the protected lifecycle envelope emitted by the caller
   * (relay) ABOVE the six framed sections. The section allocator reserves this
   * from packageBudget so the total (envelope + sections) never silently exceeds
   * the declared budget. When the envelope alone exceeds packageBudget, the
   * allocator records a protected-overrun and emits exactly the protected six
   * sections (no optional admission) — never an apparently-budget-bounded
   * package that is actually over its declared budget.
   */
  readonly envelopeChars?: number;
  /**
   * Adaptive Backfill (spec §7) is on by default: unspent global budget is
   * redistributed to lineage memory in priority order. Set false for golden
   * fixtures that must render at exactly the declared section caps.
   */
  readonly adaptiveBackfill?: boolean;
}

export interface RenderedRebirthPackageV6Section {
  readonly id: RebirthPackageV6SectionId;
  readonly title: string;
  readonly text: string;
  readonly complete: boolean;
  /**
   * Final generational-collapse result for lineage sections: the exact
   * placements behind `text`. Absent for non-lineage sections; null for an
   * admitted lineage section that rendered with zero units.
   */
  readonly collapse?: CollapseResult | null;
}

const SECTION_TITLES: Readonly<Record<RebirthPackageV6SectionId, string>> = Object.freeze({
  boundaryAndActiveTask: 'Boundary and Active Task',
  executionState: 'Execution State',
  activeEditDelta: 'Active Edit Delta',
  cognitiveArtifacts: 'Cognitive Artifacts',
  recentConversation: 'Recent Conversation',
  operatorVault: 'Operator Vault',
  episodeChapterIndex: 'Episode Chapter Index',
  lifeLedger: 'Life Ledger',
  recoveryIndex: 'Recovery Index',
});

/**
 * Generational caps (spec §4). These are caps, not guarantees: unspent capacity
 * flows to Adaptive Backfill (§7). This 145k content profile leaves 5k for framing
 * inside the 150k package ceiling. Under pressure, older lineage units collapse
 * through the Continuity Ledger while active-task and recovery sections remain
 * must-push.
 */
export const DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS: Readonly<
  Record<RebirthPackageV6SectionId, number>
> = Object.freeze({
  boundaryAndActiveTask: 15_000,
  executionState: 4_000,
  // Edit evidence gets the dedicated rebirth-side budget: this section may now
  // consume the package's +50k increase (100k→150k) so agent edits are carried
  // at full fidelity instead of clipping to a 10k summary.
  activeEditDelta: 60_000,
  cognitiveArtifacts: 6_000,
  recentConversation: 20_000,
  operatorVault: 20_000,
  episodeChapterIndex: 10_000,
  lifeLedger: 5_000,
  recoveryIndex: 5_000,
});

export const DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS = 150_000;

/**
 * Smallest cap the push-shrink gear assigns to a collapse citizen. Matches the
 * collapse engine's fragmentation guard: below 2k, preserve the section's
 * eviction envelope instead of pretending a sliver is useful continuity.
 */
export const REBIRTH_PACKAGE_V7_COLLAPSE_FLOOR_CHARS = 2_000;

/**
 * Section envelopes, provenance headers, and the chronology block. Never
 * allocated to content, so a fully-backfilled package still has room for its
 * own framing (spec §4 row 10).
 */
export const REBIRTH_PACKAGE_V7_FRAMING_RESERVE_CHARS = 5_000;

/**
 * Adaptive Backfill priority (spec §7.1). Unspent budget flows left to right;
 * hard-pressure degradation (§8) returns it right to left.
 */
export const REBIRTH_PACKAGE_V7_BACKFILL_PRIORITY = [
  'operatorVault',
  'cognitiveArtifacts',
  'recentConversation',
  'episodeChapterIndex',
  'lifeLedger',
] as const satisfies readonly RebirthPackageV6SectionId[];

const V6_SECTION_OPEN_PREFIX = '[REBIRTH-V6-SECTION';
const V6_SECTION_CLOSE = '[/REBIRTH-V6-SECTION]';

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function knownSourceTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function stableTextIdentity(prefix: string, value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}:${hash.toString(16).padStart(8, '0')}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function compareSourceRows(
  left: { readonly sourceAt: string | null; readonly provenanceId: string },
  right: { readonly sourceAt: string | null; readonly provenanceId: string },
): number {
  const leftMs = left.sourceAt ? Date.parse(left.sourceAt) : Number.NaN;
  const rightMs = right.sourceAt ? Date.parse(right.sourceAt) : Number.NaN;
  const leftKnown = Number.isFinite(leftMs);
  const rightKnown = Number.isFinite(rightMs);
  if (leftKnown && rightKnown && leftMs !== rightMs) return leftMs - rightMs;
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  return left.provenanceId.localeCompare(right.provenanceId);
}

function normalizeCognitiveRows(
  rows: readonly RebirthPackageV6CognitiveArtifact[],
): RebirthPackageV6CognitiveArtifact[] {
  const seen = new Set<string>();
  const retained = [...rows]
    .filter((row) => row.text.trim() && !row.supersededBy)
    .sort(compareSourceRows)
    .filter((row) => {
      if (seen.has(row.provenanceId)) return false;
      seen.add(row.provenanceId);
      return true;
    });
  // God Rule 8: never infer chronological order from IDs or position. Selecting
  // "newest" is legitimate ONLY among rows with a known source time; for an
  // unknown-time flow row, compareSourceRows falls back to provenance-ID
  // lexical order, which is not chronology. So:
  //  - exactly one live flow is retained: the newest KNOWN-source-time row;
  //  - unknown-time flow rows are NOT dropped: they are retained as-is so
  //    renderCognition quarantines them under the "not part of the chronology"
  //    banner, where they make no recency claim. They are never selected as
  //    the live flow.
  let newestKnownFlowIndex = -1;
  for (let index = 0; index < retained.length; index += 1) {
    const row = retained[index];
    if (row.kind !== 'flow' || !row.sourceAt) continue;
    newestKnownFlowIndex = index;
  }
  if (newestKnownFlowIndex < 0) return retained;
  // Keep exactly one live flow (the newest known-time one) plus every
  // unknown-time flow row (so renderCognition quarantines each under the
  // "not part of the chronology" banner); an older known-time flow drops.
  return retained.filter((row, index) => (
    row.kind !== 'flow' || index === newestKnownFlowIndex || !row.sourceAt
  ));
}

function normalizeConversationRows(
  rows: readonly RebirthPackageV6ConversationRow[],
  activeRequest: string | null,
  lastAssistant: string | null,
): RebirthPackageV6ConversationRow[] {
  const excluded = new Set([activeRequest, lastAssistant].filter((value): value is string => Boolean(value)));
  const seen = new Set<string>();
  return [...rows]
    .filter((row) => {
      const text = row.text.trim();
      if (!text) return false;
      if (excluded.has(text)) return false;

      // Legacy conversation rows retain their display envelope, while the
      // promoted active-request / last-assistant fields contain the semantic
      // message bytes. Compare only exact payload candidates derived from
      // known wrappers; a substring match could erase unrelated prose.
      const candidates = new Set<string>([text]);
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) {
        const header = text.slice(0, firstNewline).trim();
        const withoutHeader = text.slice(firstNewline + 1).trim();
        if (/^role:(?:user|assistant|runtime)\b/u.test(withoutHeader)) {
          candidates.add(withoutHeader);
        }
        // Raw-seed current-thread rows carry a dialogue header envelope
        // (`[message 12] 👤 USER:`) around the exact message bytes that the
        // Boundary section already promotes verbatim. Without this candidate
        // the same operator request reaches the provider twice. Match the
        // header shape exactly — never a substring/prefix heuristic — so an
        // ordinary prose line that happens to precede a blank line is untouched.
        if (/^\[message \d+\]\s+\S+(?:\s+\S+)?:$/u.test(header)) {
          candidates.add(withoutHeader);
        }
      }
      const contentMarker = '\ncontent:\n';
      const contentStart = text.indexOf(contentMarker);
      if (contentStart >= 0) {
        const payload = text.slice(contentStart + contentMarker.length).trim();
        candidates.add(payload);
        candidates.add(payload.replace(/^\[\d{4}-\d{2}-\d{2}(?:[ T][^\]]+)?\]\s*/u, ''));
      }
      return ![...candidates].some((candidate) => excluded.has(candidate));
    })
    .sort(compareSourceRows)
    .filter((row) => {
      const identity = `${row.provenanceId}\0${row.text}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

/**
 * Lineage units are deduped on stable source identity and never reordered here:
 * chronological placement is the collapse engine's job and is authoritative
 * source time, tie-broken by stable id (God Rule 8).
 */
function normalizeLineageSection(
  section: RebirthPackageV7LineageSection | undefined,
): RebirthPackageV7LineageSection {
  if (!section || section.units.length === 0) {
    return {
      units: [],
      rangeRecover: section?.rangeRecover ?? null,
      partialReason: section?.partialReason ?? null,
    };
  }
  const seen = new Set<string>();
  const units = section.units.filter((unit) => {
    if (!unit.id || seen.has(unit.id)) return false;
    if (!unit.verbatim.trim() && !unit.digest.trim()) return false;
    seen.add(unit.id);
    return true;
  });
  return {
    units,
    rangeRecover: section.rangeRecover ?? null,
    partialReason: section.partialReason ?? null,
  };
}

export function buildRebirthPackageV6Model(
  input: BuildRebirthPackageV6ModelInput,
): RebirthPackageV6Model {
  const activeRequest = nonEmpty(input.boundaryAndActiveTask.activeRequest?.text);
  const lastAssistant = nonEmpty(input.boundaryAndActiveTask.lastMaterialAssistant?.text);
  const model: RebirthPackageV6Model = {
    version: REBIRTH_PACKAGE_V7_VERSION,
    boundaryAndActiveTask: input.boundaryAndActiveTask,
    executionState: input.executionState ?? { facts: [], unknownReasons: ['execution capture unavailable'] },
    activeEditDelta: input.activeEditDelta ?? {
      captureId: null,
      state: 'unknown',
      capturedSourceAt: null,
      completedObservedAt: null,
      inheritedCaptureIds: [],
      files: [],
      omittedFiles: 0,
      truncated: false,
      reasons: ['no immutable Atlas edit capture was supplied'],
    },
    cognitiveArtifacts: normalizeCognitiveRows(input.cognitiveArtifacts ?? []),
    ...(input.cognitiveArtifactCapture ? {
      cognitiveArtifactCapture: {
        ...input.cognitiveArtifactCapture,
        missingFamilies: [...input.cognitiveArtifactCapture.missingFamilies],
        warnings: [...input.cognitiveArtifactCapture.warnings],
      },
    } : {}),
    recentConversation: normalizeConversationRows(
      input.recentConversation ?? [],
      activeRequest,
      lastAssistant,
    ),
    operatorVault: normalizeLineageSection(input.operatorVault),
    episodeChapterIndex: normalizeLineageSection(input.episodeChapterIndex),
    lifeLedger: normalizeLineageSection(input.lifeLedger),
    recoveryIndex: [...(input.recoveryIndex ?? [])],
  };
  return deepFreeze(model) as RebirthPackageV6Model;
}

export function isRebirthPackageV6Model(value: unknown): value is RebirthPackageV6Model {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<RebirthPackageV6Model>;
  // Persisted v6 packages remain valid: the lineage sections are additive, and
  // the renderer treats an absent section as empty rather than unknown.
  return (candidate.version === REBIRTH_PACKAGE_V6_VERSION
      || candidate.version === REBIRTH_PACKAGE_V7_VERSION)
    && Boolean(candidate.boundaryAndActiveTask)
    && Boolean(candidate.executionState)
    && Boolean(candidate.activeEditDelta)
    && Array.isArray(candidate.cognitiveArtifacts)
    && (candidate.cognitiveArtifactCapture === undefined
      || (typeof candidate.cognitiveArtifactCapture === 'object'
        && candidate.cognitiveArtifactCapture !== null
        && ['complete', 'partial', 'unavailable'].includes(candidate.cognitiveArtifactCapture.status)
        && (candidate.cognitiveArtifactCapture.capturedAt === null
          || typeof candidate.cognitiveArtifactCapture.capturedAt === 'string')
        && (candidate.cognitiveArtifactCapture.totalMatched === null
          || (Number.isSafeInteger(candidate.cognitiveArtifactCapture.totalMatched)
            && candidate.cognitiveArtifactCapture.totalMatched >= 0))
        && (candidate.cognitiveArtifactCapture.overlayCount === null
          || (Number.isSafeInteger(candidate.cognitiveArtifactCapture.overlayCount)
            && candidate.cognitiveArtifactCapture.overlayCount >= 0))
        && Array.isArray(candidate.cognitiveArtifactCapture.missingFamilies)
        && candidate.cognitiveArtifactCapture.missingFamilies.every((family) => typeof family === 'string')
        && Array.isArray(candidate.cognitiveArtifactCapture.warnings)
        && candidate.cognitiveArtifactCapture.warnings.every((warning) => typeof warning === 'string')))
    && Array.isArray(candidate.recentConversation)
    && Array.isArray(candidate.recoveryIndex);
}

function extractLegacyAssistant(text: string | undefined): string | null {
  if (!text?.trim()) return null;
  const lines = text.split('\n');
  let marker = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*🤖\s/u.test(lines[index])) marker = index;
  }
  if (marker < 0) return null;
  const body: string[] = [];
  for (let index = marker + 1; index < lines.length; index += 1) {
    if (/^\s*(?:👤|🤖|⚠️)\s/u.test(lines[index])) break;
    body.push(lines[index]);
  }
  return nonEmpty(body.join('\n'));
}

function legacyConversationRows(text: string | undefined): RebirthPackageV6ConversationRow[] {
  if (!text?.trim()) return [];
  return text.split(/\n{2,}/u).map((block, index) => {
    const trimmed = block.trim();
    const role: RebirthPackageV6ConversationRow['role'] = /^\s*👤/u.test(trimmed)
      ? 'user'
      : /^\s*🤖/u.test(trimmed)
        ? 'assistant'
        : 'runtime';
    return {
      provenanceId: stableTextIdentity('legacy-conversation', `${index}\0${trimmed}`),
      sourceAt: null,
      role,
      text: trimmed,
    };
  });
}

function legacyCognitiveRows(text: string | undefined): RebirthPackageV6CognitiveArtifact[] {
  if (!text?.trim()) return [];
  return text.split('\n').map((line, index) => {
    const trimmed = line.trim();
    const sourceAt = knownSourceTime(trimmed.match(/^\d{4}-\d{2}-\d{2}T\S+/u)?.[0]);
    const kind: RebirthPackageV6CognitiveArtifact['kind'] = trimmed.includes('⚠')
      ? 'hazard'
      : trimmed.includes('❓')
        ? 'question'
        : trimmed.includes('🏁')
          ? 'result'
          : 'discovery';
    return {
      provenanceId: stableTextIdentity('legacy-cognition', `${index}\0${trimmed}`),
      sourceAt,
      kind,
      text: trimmed,
      authority: 'legacy_unstructured',
      supersededBy: null,
    };
  }).filter((row) => row.text.length > 0);
}

function formatRuntimeChange(legacy: RebirthPackageV6LegacyShape): string | null {
  if (legacy.runtimeModel?.changed !== true) return null;
  const predecessor = legacy.runtimeModel.predecessor;
  const successor = legacy.runtimeModel.successor;
  return `${predecessor?.engine ?? 'unknown'}/${predecessor?.model ?? 'unknown'} -> ${successor?.engine ?? 'unknown'}/${successor?.model ?? 'unknown'}`;
}

function defaultRecoveryHandles(args: {
  instanceId: string;
  instanceName: string;
  workspace: string;
  captureId: string;
  sourceFrontier: string | null;
  editCaptureId: string | null;
}): RebirthPackageV6RecoveryHandle[] {
  const quotedId = JSON.stringify(args.instanceId);
  const quotedWorkspace = JSON.stringify(args.workspace);
  const hasIdentity = args.instanceId !== 'unknown';
  const hasCapture = args.captureId !== 'unknown';
  return [
    {
      id: 'transcript',
      label: 'complete transcript and raw canonical tail',
      handle: hasIdentity
        ? `tap_instance_messages action="canonical" target_instance_id=${quotedId}`
        : '',
      status: hasIdentity ? 'available' : 'unavailable',
      count: null,
      frontier: args.sourceFrontier,
    },
    {
      id: 'current-continuity-pov',
      label: 'current live rebirth/fold POV (not the complete episode or vault stores)',
      handle: hasIdentity
        ? `tap_instance_messages action="ghost" target_instance_id=${quotedId}`
        : '',
      status: hasIdentity ? 'partial' : 'unavailable',
      count: null,
      frontier: args.sourceFrontier,
    },
    {
      id: 'context-warp-stores',
      label: 'complete Context Warp episodes, bands, and User Message Vault',
      handle: '',
      status: 'unavailable',
      count: null,
      frontier: args.sourceFrontier,
    },
    {
      id: 'cognition',
      label: 'chronological cognitive artifact rolodex',
      handle: hasIdentity
        ? `tap_star action="rolodex" instance=${quotedId}`
        : '',
      status: hasIdentity ? 'available' : 'unavailable',
      count: null,
      frontier: args.sourceFrontier,
    },
    {
      id: 'task-rail',
      label: 'current task rail and execution receipts',
      handle: hasIdentity
        ? `task_rail mode="load" operation="detail" instance_id=${quotedId}`
        : '',
      status: hasIdentity ? 'available' : 'unavailable',
      count: null,
      frontier: args.sourceFrontier,
    },
    {
      id: 'atlas-history',
      label: 'Atlas source history',
      handle: hasIdentity && args.workspace !== 'unknown'
        ? `atlas_query action="history" workspace=${quotedWorkspace} author_instance_id=${quotedId}`
        : '',
      status: hasIdentity && args.workspace !== 'unknown' ? 'available' : 'unavailable',
      count: null,
      frontier: null,
    },
    {
      id: 'atlas-edit-capture',
      label: 'immutable Atlas edit capture',
      handle: args.editCaptureId && hasIdentity
        ? `atlas_agent_diff instance_id=${quotedId} capture_id=${JSON.stringify(args.editCaptureId)} mode="unified"`
        : '',
      status: args.editCaptureId && hasIdentity ? 'available' : 'unavailable',
      count: null,
      frontier: args.editCaptureId,
    },
    {
      id: 'atlas-edit-post-frontier',
      label: 'explicit edits observed after the immutable capture frontier',
      handle: args.editCaptureId && hasIdentity
        ? `atlas_agent_diff instance_id=${quotedId} capture_id=${JSON.stringify(args.editCaptureId)} include_post_frontier=true mode="unified"`
        : '',
      status: args.editCaptureId && hasIdentity ? 'available' : 'unavailable',
      count: null,
      frontier: args.editCaptureId,
    },
    {
      id: 'rebirth-package',
      label: 'captured package artifact',
      handle: hasIdentity && hasCapture
        ? `tap_instance_messages action="rebirth" target_instance_id=${quotedId} search=${JSON.stringify(args.captureId)}`
        : '',
      status: hasIdentity && hasCapture ? 'available' : 'unavailable',
      count: null,
      frontier: args.captureId,
    },
    {
      id: 'identity',
      label: `stable instance identity (${args.instanceName})`,
      handle: hasIdentity
        ? `tap_instance_messages action="summary" target_instance_id=${quotedId}`
        : '',
      status: hasIdentity ? 'available' : 'unavailable',
      count: null,
      frontier: null,
    },
  ];
}

function receiptFactSource(
  kind: RebirthPackageV6ExecutionFact['kind'],
  text: string,
  source: ContinuityLiveFieldSource | undefined,
): Pick<RebirthPackageV6ExecutionFact, 'provenanceId' | 'sourceAt' | 'status'> {
  const sourceId = nonEmpty(source?.id);
  return {
    provenanceId: sourceId
      ? `${sourceId}:${stableTextIdentity(kind, text)}`
      : stableTextIdentity(`receipt-${kind}`, text),
    sourceAt: knownSourceTime(source?.sourceTimestamp),
    status: sourceId && sourceId !== 'none' ? 'exact' : 'partial',
  };
}

function adaptReceiptEditDelta(
  receipt: ContinuityReceipt | undefined,
): RebirthPackageV6ActiveEditDelta | undefined {
  if (!receipt) return undefined;
  const editPaths = [...new Set(
    receipt.liveState?.edits.value ?? receipt.editClaim?.editEvidenceFiles ?? [],
  )].filter((filePath) => filePath.trim().length > 0);
  if (!receipt.editClaim?.supplied && editPaths.length === 0) return undefined;

  const editSource = receipt.liveState?.edits.source;
  const sourceAt = knownSourceTime(editSource?.sourceTimestamp);
  return {
    captureId: null,
    state: editPaths.length > 0 ? 'partial' : 'unknown',
    capturedSourceAt: sourceAt,
    completedObservedAt: null,
    inheritedCaptureIds: [],
    files: editPaths.map((filePath) => ({
      provenanceId: stableTextIdentity('receipt-edit', `${editSource?.id ?? 'unknown'}\0${filePath}`),
      sourceAt,
      filePath,
      changeKind: 'unknown',
      baselineQuality: 'baseline_unknown',
      ownership: 'baseline_unknown',
      state: 'partial',
      insertions: null,
      deletions: null,
      validationState: 'unknown',
      closureState: 'unknown',
      contributors: [],
      preview: null,
      diffHandle: null,
      snapshotHandle: null,
      reason: 'continuity receipt carried edit evidence without an immutable Atlas baseline',
    })),
    omittedFiles: 0,
    truncated: false,
    reasons: [
      editPaths.length > 0
        ? 'typed continuity receipt adapted without an immutable Atlas edit capture'
        : 'typed continuity receipt reported an Active Edit Delta without recoverable file rows',
    ],
  };
}

export function adaptLegacyRebirthPackageToV6(
  legacy: RebirthPackageV6LegacyShape,
  options: AdaptLegacyRebirthPackageV6Options = {},
): RebirthPackageV6Model {
  const receipt = legacy.continuityReceipt;
  const receiptInstance = receipt?.liveState?.instance.value;
  const lifecycle = legacy.lifecycleBoundary ?? receipt?.boundary ?? 'continuation';
  const instanceId = nonEmpty(options.instanceId ?? receiptInstance?.instanceId) ?? 'unknown';
  const instanceName = nonEmpty(options.instanceName ?? receiptInstance?.instanceName) ?? instanceId;
  const predecessorName = nonEmpty(options.predecessorName ?? legacy.predecessorName ?? receipt?.predecessorName);
  const workspaceObject = typeof legacy.workspaceContext === 'object' ? legacy.workspaceContext : undefined;
  const workspace = nonEmpty(options.workspace ?? workspaceObject?.currentWorkspace) ?? 'unknown';
  const cwd = nonEmpty(options.cwd ?? workspaceObject?.currentCwd);
  const captureId = nonEmpty(receipt?.captureSourceId) ?? 'unknown';
  const sourceFrontierValue = receipt?.liveState?.rawTailFrontier?.value;
  const sourceFrontier = nonEmpty(sourceFrontierValue?.id)
    ?? nonEmpty(receipt?.canonicalRange?.lastEventId)
    ?? (typeof sourceFrontierValue?.index === 'number'
      ? `event#${sourceFrontierValue.index}`
      : typeof receipt?.canonicalRange?.eventCount === 'number'
        ? `event#${receipt.canonicalRange.eventCount}`
        : null);
  const activeRequestText = nonEmpty(
    receipt?.activeRequest?.text
      ?? receipt?.liveState?.request.value?.text
      ?? legacy.triggeringUserMessage,
  );
  const pendingAssistantAction = receipt?.pendingAssistantAction?.status === 'unresolved'
    ? receipt.pendingAssistantAction
    : undefined;
  const assistantText = pendingAssistantAction?.text
    ?? extractLegacyAssistant(legacy.lastUserAiMessages);
  const requestSource = receipt?.liveState?.request?.source;
  const activeEditDelta = options.activeEditDelta ?? (nonEmpty(legacy.activeEditDelta)
    ? {
        captureId: null,
        state: 'partial' as const,
        capturedSourceAt: null,
        completedObservedAt: null,
        inheritedCaptureIds: [],
        files: [{
          provenanceId: stableTextIdentity('legacy-edit-delta', legacy.activeEditDelta ?? ''),
          sourceAt: null,
          filePath: '(legacy bounded edit evidence)',
          changeKind: 'unknown' as const,
          baselineQuality: 'baseline_unknown' as const,
          ownership: 'baseline_unknown' as const,
          state: 'unknown' as const,
          insertions: null,
          deletions: null,
          validationState: 'unknown' as const,
          closureState: 'unknown' as const,
          contributors: [],
          preview: {
            text: legacy.activeEditDelta ?? '',
            complete: false,
            omittedHunks: 0,
            omittedLines: 0,
          },
          diffHandle: null,
          snapshotHandle: null,
          reason: 'legacy edit-event text has no exact per-instance baseline',
        }],
        omittedFiles: 0,
        truncated: true,
        reasons: ['legacy Active Edit Delta adapted without an immutable Atlas capture'],
      }
    : adaptReceiptEditDelta(receipt));
  const executionFacts: RebirthPackageV6ExecutionFact[] = [];
  // Capsule authority order: a later genuine operator message outranks live
  // rail direction. The package cannot judge whether rail text AGREES with the
  // operator's latest line, but it can measure order: a rail/next_action row
  // whose known source time strictly predates the known active-request time is
  // flagged so renderExecution marks it for reconciliation instead of
  // presenting stale direction as current command (the rail-58fc5e71 failure:
  // a 17:11 rail row rendered as commanding after 17:18/17:22 operator
  // pivots). pending_assistant_action is deliberately NOT flagged here — the
  // slice-1 reducer settles superseded commitments upstream with an
  // operator-superseded tombstone. Either time unknown → no flag: absence of
  // evidence is never a staleness verdict (God Rule 8).
  const activeRequestSourceAt = knownSourceTime(requestSource?.sourceTimestamp);
  const activeRequestSourceMs = activeRequestSourceAt
    ? Date.parse(activeRequestSourceAt)
    : Number.NaN;
  const predatesActiveRequest = (source: ContinuityLiveFieldSource | undefined): boolean => {
    const rowAt = knownSourceTime(source?.sourceTimestamp);
    return rowAt !== null
      && Number.isFinite(activeRequestSourceMs)
      && Date.parse(rowAt) < activeRequestSourceMs;
  };
  if (pendingAssistantAction) {
    executionFacts.push({
      kind: 'pending_assistant_action',
      text: pendingAssistantAction.text,
      ...receiptFactSource(
        'pending_assistant_action',
        pendingAssistantAction.text,
        receipt?.liveState?.assistantAction?.source,
      ),
    });
  }
  if (receipt?.rail) {
    const railSource = receipt.liveState?.rail.source;
    executionFacts.push({
      kind: 'rail',
      text: [
        receipt.rail.railId,
        receipt.rail.title,
        receipt.rail.state,
        receipt.rail.activeStep?.title,
      ].filter(Boolean).join(' · '),
      ...receiptFactSource('rail', receipt.rail.railId, railSource),
      ...(predatesActiveRequest(railSource) ? { predatesActiveRequest: true as const } : {}),
    });
    const nextAction = nonEmpty(receipt.nextAction ?? receipt.rail.queuedStepTitle);
    if (nextAction && nextAction !== pendingAssistantAction?.text) {
      // buildContinuityReceipt mirrors the active request into nextAction.
      // Attribute that fact to the operator row itself; borrowing the older
      // rail-step source makes current operator text look stale relative to
      // its own timestamp. A genuinely rail-derived next action still uses
      // step/rail provenance and remains eligible for the chronology marker.
      const nextActionSource = nextAction === activeRequestText
        ? requestSource
        : receipt.liveState?.step.source ?? railSource;
      executionFacts.push({
        kind: 'next_action',
        text: nextAction,
        ...receiptFactSource('next_action', nextAction, nextActionSource),
        ...(predatesActiveRequest(nextActionSource) ? { predatesActiveRequest: true as const } : {}),
      });
    }
  } else if (nonEmpty(legacy.resumePoint ?? legacy.taskRailContext)) {
    const text = nonEmpty(legacy.resumePoint ?? legacy.taskRailContext)!;
    executionFacts.push({
      provenanceId: stableTextIdentity('legacy-execution', text),
      sourceAt: null,
      status: 'partial',
      kind: 'rail',
      text,
    });
  }
  if (receipt?.sourceStatus) {
    executionFacts.push({
      kind: 'runtime',
      text: receipt.sourceStatus,
      ...receiptFactSource('runtime', receipt.sourceStatus, receipt.liveState?.instance.source),
    });
  }
  for (const claim of receipt?.liveState?.claims.value ?? receipt?.editClaim?.claims ?? []) {
    executionFacts.push({
      kind: 'claim',
      text: claim,
      ...receiptFactSource('claim', claim, receipt?.liveState?.claims.source),
    });
  }
  const validation = nonEmpty(
    receipt?.liveState?.validation.value?.fact ?? receipt?.validation.fact,
  );
  if (validation) {
    const source = receipt?.liveState?.validation.source;
    executionFacts.push({
      kind: 'validation',
      text: validation,
      ...receiptFactSource('validation', validation, source),
    });
  }
  const hazards = new Set(receipt?.hazards ?? []);
  for (const hazard of hazards) {
    executionFacts.push({
      kind: 'blocker',
      text: hazard,
      ...receiptFactSource('blocker', hazard, undefined),
    });
  }
  for (const blocker of receipt?.liveState?.blockers.value ?? []) {
    if (hazards.has(blocker)) continue;
    executionFacts.push({
      kind: 'blocker',
      text: blocker,
      ...receiptFactSource('blocker', blocker, receipt?.liveState?.blockers.source),
    });
  }
  const reviewState = nonEmpty(receipt?.liveState?.review.value?.state);
  if (reviewState) {
    executionFacts.push({
      kind: 'review',
      text: reviewState,
      ...receiptFactSource('review', reviewState, receipt?.liveState?.review.source),
    });
  }
  for (const room of receipt?.liveState?.rooms.value ?? []) {
    const text = `room=${room}`;
    executionFacts.push({
      kind: 'coordination',
      text,
      ...receiptFactSource('coordination', text, receipt?.liveState?.rooms.source),
    });
  }
  for (const subscription of receipt?.liveState?.subscriptions.value ?? []) {
    const text = `subscription=${subscription}`;
    executionFacts.push({
      kind: 'coordination',
      text,
      ...receiptFactSource('coordination', text, receipt?.liveState?.subscriptions.source),
    });
  }
  const cognition = options.cognitiveArtifacts
    ?? legacyCognitiveRows(legacy.cognitiveArtifacts ?? legacy.starredMoments);
  const conversation = options.recentConversation
    ?? legacyConversationRows(legacy.currentThread);
  const recovery = options.recoveryIndex ?? defaultRecoveryHandles({
    instanceId,
    instanceName,
    workspace,
    captureId,
    sourceFrontier,
    editCaptureId: activeEditDelta?.captureId ?? null,
  });

  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle,
      lifecycleMeaning: REBIRTH_PACKAGE_V6_LIFECYCLE_PROFILES[lifecycle].identityMeaning,
      captureId,
      capturedAt: knownSourceTime(receipt?.capturedAt),
      sourceFrontier,
      instanceId,
      instanceName,
      predecessorInstanceId: nonEmpty(receiptInstance?.parentInstanceId),
      predecessorName,
      workspace,
      cwd,
      runtimeChange: formatRuntimeChange(legacy),
      activeRequest: activeRequestText ? {
        text: activeRequestText,
        chars: activeRequestText.length,
        source: {
          provenanceId: requestSource?.id ?? stableTextIdentity('active-request', activeRequestText),
          sourceAt: knownSourceTime(requestSource?.sourceTimestamp),
          status: requestSource?.id ? 'exact' : 'partial',
        },
      } : null,
      lastMaterialAssistant: assistantText ? {
        text: assistantText,
        chars: assistantText.length,
        source: {
          provenanceId: receipt?.liveState?.assistantAction?.source.id
            ?? pendingAssistantAction?.source.id
            ?? stableTextIdentity('last-assistant', assistantText),
          sourceAt: knownSourceTime(
            receipt?.liveState?.assistantAction?.source.sourceTimestamp
              ?? pendingAssistantAction?.source.timestamp,
          ),
          status: receipt?.liveState?.assistantAction?.source.id || pendingAssistantAction?.source.id
            ? 'exact'
            : 'partial',
        },
      } : null,
    },
    executionState: {
      facts: executionFacts.sort(compareSourceRows),
      unknownReasons: [
        ...(executionFacts.length === 0 ? ['no structured execution facts captured'] : []),
        ...(receipt?.disagreements ?? []),
      ],
    },
    activeEditDelta,
    cognitiveArtifacts: cognition,
    recentConversation: conversation,
    ...(options.operatorVault ? { operatorVault: options.operatorVault } : {}),
    ...(options.episodeChapterIndex ? { episodeChapterIndex: options.episodeChapterIndex } : {}),
    ...(options.lifeLedger ? { lifeLedger: options.lifeLedger } : {}),
    recoveryIndex: recovery,
  });
}

function formatSource(source: RebirthPackageV6SourceRef): string {
  return `source=${source.provenanceId} · source-time=${source.sourceAt ?? 'unknown'} · status=${source.status}`;
}

function boundedText(
  text: string,
  maxChars: number,
  recoveryHandle: string | null,
): { readonly text: string; readonly complete: boolean } {
  if (text.length <= maxChars) return { text, complete: true };
  const marker = recoveryHandle
    ? `\n[… ${text.length - maxChars} chars omitted; recover=${recoveryHandle} …]`
    : `\n[… ${text.length - maxChars} chars omitted; exact recovery unavailable …]`;
  const keep = Math.max(0, maxChars - marker.length);
  return { text: `${text.slice(0, keep)}${marker}`, complete: false };
}

function renderBoundary(model: RebirthPackageV6Model, maxChars: number): { text: string; complete: boolean } {
  const boundary = model.boundaryAndActiveTask;
  const lines = [
    `contract=${model.version}`,
    `lifecycle=${boundary.lifecycle} · ${boundary.lifecycleMeaning}`,
    `capture=${boundary.captureId} · captured-at=${boundary.capturedAt ?? 'unknown'} · frontier=${boundary.sourceFrontier ?? 'unknown'}`,
    `instance=${boundary.instanceName} (${boundary.instanceId}) · predecessor=${boundary.predecessorName ?? boundary.predecessorInstanceId ?? 'none'}`,
    `workspace=${boundary.workspace} · cwd=${boundary.cwd ?? 'unknown'}`,
  ];
  if (boundary.runtimeChange) lines.push(`runtime-change=${boundary.runtimeChange}`);
  if (boundary.forkContext) {
    // v6-native fork identity. Deliberately structured (not v4 prose banner):
    // the fact set an agent needs to reason about its lineage without phantom
    // post-fork coordination. Optional — rendered only when the caller provided
    // fork metadata at assembly time. No duplicate `for "<name>"` prose; the
    // predecessor identity already lives in the Boundary above.
    const fork = boundary.forkContext;
    const position = fork.index !== null && fork.count !== null
      ? ` position=${fork.index + 1}/${fork.count}`
      : '';
    const point = fork.pointMessageId ? ` · fork-point-message=${fork.pointMessageId}` : '';
    lines.push(
      `fork=${fork.isFreshFork ? 'fresh' : 'durable'}${fork.groupId ? ` · fork-group=${fork.groupId}` : ''}${position}${point}`,
    );
  }
  if (boundary.activeRequest) {
    lines.push(
      '',
      `[EXACT ACTIVE REQUEST · ${boundary.activeRequest.chars} chars · ${formatSource(boundary.activeRequest.source)}]`,
      boundary.activeRequest.text,
      '[/EXACT ACTIVE REQUEST]',
    );
  } else {
    lines.push('', 'active-request=unknown or unavailable at capture');
  }
  if (boundary.activeRequestClaims) {
    const claims = boundary.activeRequestClaims;
    const latestStatus = claims.latestStatus === 'current'
      ? 'CURRENT · non-authoritative · exact raw operator chronology wins'
      : claims.latestStatus === 'expired_by_newer_operator'
        ? 'EXPIRED BY NEWER RAW OPERATOR REQUEST · do not execute'
        : 'FALLBACK ONLY · operator frontier unknown · do not treat as instruction';
    lines.push(
      '',
      `[AGENT ACTIVE-REQUEST INTERPRETATION · ${latestStatus} · ${formatSource(claims.latest.source)}]`,
      claims.latest.text,
      '[/AGENT ACTIVE-REQUEST INTERPRETATION]',
    );
    if (claims.previous) {
      lines.push(
        '',
        `[PREVIOUS AGENT ACTIVE-REQUEST INTERPRETATION · EXPIRED BY ${claims.latest.source.provenanceId} · fallback context only · do not execute · ${formatSource(claims.previous.source)}]`,
        claims.previous.text,
        '[/PREVIOUS AGENT ACTIVE-REQUEST INTERPRETATION]',
      );
    }
  }
  if (boundary.lastMaterialAssistant) {
    const recovery = model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle ?? null;
    const assistantBudget = Math.max(512, maxChars - lines.join('\n').length - 320);
    const assistant = boundedText(boundary.lastMaterialAssistant.text, assistantBudget, recovery);
    lines.push(
      '',
      `[LAST MATERIAL ASSISTANT · ${boundary.lastMaterialAssistant.chars} chars · ${formatSource(boundary.lastMaterialAssistant.source)}]`,
      assistant.text,
      '[/LAST MATERIAL ASSISTANT]',
    );
    return { text: lines.join('\n'), complete: assistant.complete };
  }
  lines.push('', 'last-material-assistant=unknown');
  return { text: lines.join('\n'), complete: true };
}

function renderExecution(model: RebirthPackageV6Model, maxChars: number): { text: string; complete: boolean } {
  // God Rule 8: unknown source time never participates in the chronology. Known-time
  // execution facts stream chronologically; unknown-time facts are quarantined under
  // an explicit banner (mirroring renderCognition) where they make no recency claim.
  const known = model.executionState.facts.filter((fact) => fact.sourceAt);
  const unknown = model.executionState.facts.filter((fact) => !fact.sourceAt);
  const lines = known.map((fact) => (
    `- ${fact.kind} · ${fact.text} · source=${fact.provenanceId} · source-time=${fact.sourceAt} · status=${fact.status}${fact.predatesActiveRequest ? ' · authority=predates-active-request' : ''}`
  ));
  for (const reason of model.executionState.unknownReasons) lines.push(`- unknown: ${reason}`);
  if (unknown.length > 0) {
    lines.push('', 'Unknown source time (quarantined; not part of the chronology):');
    for (const fact of unknown) {
      lines.push(`- ${fact.kind} · ${fact.text} · source=${fact.provenanceId} · status=${fact.status}`);
    }
  }
  if (lines.length === 0) lines.push('- execution state captured as empty');
  return boundedText(lines.join('\n'), maxChars, model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle ?? null);
}

function contributorSummary(contributors: readonly RebirthPackageV6EditContributor[]): string {
  const known = contributors.filter((entry) => entry.sourceAt).sort(compareSourceRows);
  const unknown = contributors.filter((entry) => !entry.sourceAt)
    .sort((a, b) => a.provenanceId.localeCompare(b.provenanceId));
  const parts = known.map((entry) => `${entry.instanceId}:${entry.relation}@${entry.sourceAt}`);
  if (unknown.length > 0) {
    parts.push(`unknown-time-quarantine=[${unknown.map((entry) => `${entry.instanceId}:${entry.relation}:${entry.provenanceId}`).join(', ')}]`);
  }
  return parts.join('; ');
}

function editFileStats(file: RebirthPackageV6EditFile): string {
  return file.insertions === null || file.deletions === null
    ? '+?/−?'
    : `+${file.insertions}/−${file.deletions}`;
}

function editFileHeaderLine(file: RebirthPackageV6EditFile): string {
  return `${file.changeKind.toUpperCase()} ${file.filePath} · ${file.ownership} · baseline=${file.baselineQuality} · ${editFileStats(file)} · validation=${file.validationState} · closure=${file.closureState}`;
}

/** Exact per-file block the Active Edit Delta section renders for one capture row. */
function editFileBlockLines(file: RebirthPackageV6EditFile): string[] {
  const lines = [editFileHeaderLine(file)];
  if (file.state === 'withheld_sensitive' || file.baselineQuality === 'withheld_sensitive') {
    lines.push('  sensitive content withheld');
    return lines;
  }
  const contributors = contributorSummary(file.contributors);
  if (contributors) lines.push(`  contributors: ${contributors}`);
  if (file.preview?.text) {
    lines.push(file.preview.text.split('\n').map((line) => `  ${line}`).join('\n'));
    if (!file.preview.complete) {
      lines.push(`  preview partial: omitted-hunks=${file.preview.omittedHunks} omitted-lines=${file.preview.omittedLines} recover=${file.diffHandle ?? 'unavailable'}`);
    }
  } else {
    lines.push(`  preview=${file.state === 'unknown' ? 'unknown' : 'unavailable'}${file.reason ? ` · ${file.reason}` : ''}`);
  }
  if (file.diffHandle) lines.push(`  exact-diff=${file.diffHandle}`);
  if (file.snapshotHandle) lines.push(`  exact-snapshot=${file.snapshotHandle}`);
  return lines;
}

/**
 * Active Edit Delta collapse citizenship (kind 'edit'): each captured file row
 * becomes one collapse unit whose T0 verbatim is exactly the block the section
 * renders, so demotion receipts and ledger rows describe the bytes that would
 * have shipped. Mint gate: a receipt requires an exact Atlas diff or snapshot
 * handle — rows without exact recovery floor at the t2 era block, because a
 * dead pointer is worse than spent chars. Legacy bounded-log mode (no capture
 * id) carries no per-file identity and stays outside the collapse engine.
 */
export function buildActiveEditCollapseUnits(model: RebirthPackageV6Model): readonly CollapseUnit[] {
  const delta = model.activeEditDelta;
  if (delta.captureId === null) return [];
  const captureHandle = model.recoveryIndex.find((entry) => entry.id === 'atlas-edit-capture')?.handle ?? null;
  return delta.files.map((file) => {
    const verbatim = editFileBlockLines(file).join('\n');
    const exactHandle = file.diffHandle ?? file.snapshotHandle;
    const sourceAt = file.sourceAt ?? delta.capturedSourceAt ?? null;
    return {
      id: file.provenanceId,
      sourceAt,
      kind: 'edit' as const,
      verbatim,
      digest: editFileHeaderLine(file),
      eraKey: sourceAt ? sourceAt.slice(0, 10) : null,
      claim: `${file.changeKind} ${file.filePath} ${editFileStats(file)} validation=${file.validationState} closure=${file.closureState}`,
      recover: exactHandle ?? captureHandle ?? 'unavailable',
      sha256: exactHandle ? createHash('sha256').update(verbatim, 'utf8').digest('hex') : null,
      verified: Boolean(exactHandle),
    };
  });
}

function renderActiveEdits(model: RebirthPackageV6Model, maxChars: number): RenderedV6SectionBody {
  const delta = model.activeEditDelta;
  const recoveryHandle = model.recoveryIndex.find((entry) => entry.id === 'atlas-edit-capture')?.handle ?? null;
  // Legacy bounded-edit-log mode: when the immutable Atlas capture was
  // unavailable, the adapter wraps the raw edit log in one synthetic file row
  // whose every field is honestly unknown. Rendering those fields sprays the
  // same unknown seven ways; God Rule 8 wants the unknown declared once. The
  // timestamped edit log itself is real evidence and renders untouched.
  const legacyLog = delta.captureId === null
    && delta.files.length === 1
    && delta.files[0].provenanceId.startsWith('legacy-edit-delta:')
    ? delta.files[0]
    : null;
  if (legacyLog) {
    const reason = delta.reasons[0] ?? 'immutable Atlas edit capture unavailable';
    const legacyLines = [
      `evidence=bounded edit log; immutable capture unavailable: ${reason}`,
      ...(legacyLog.preview?.text ? [legacyLog.preview.text] : []),
    ];
    return boundedText(legacyLines.join('\n'), maxChars, recoveryHandle);
  }
  const lines = [
    `state=${delta.state} · capture=${delta.captureId ?? 'unknown'} · source-time=${delta.capturedSourceAt ?? 'unknown'} · observed-at=${delta.completedObservedAt ?? 'unknown'}`,
  ];
  if (delta.state === 'none' && delta.files.length === 0) {
    lines.push('Exact immutable capture proved zero open attributable diffs.');
  } else if (delta.state === 'unknown' && delta.files.length === 0) {
    lines.push('Active edit state is unknown; absence of evidence is not rendered as none.');
  }
  const trailer: string[] = [];
  if (delta.inheritedCaptureIds.length > 0) trailer.push(`inherited-captures=${delta.inheritedCaptureIds.join(',')}`);
  if (delta.truncated || delta.omittedFiles > 0) {
    trailer.push(`capture partial: omitted-files=${delta.omittedFiles} recover=${recoveryHandle || 'unavailable'}`);
  }
  for (const reason of delta.reasons) trailer.push(`reason=${reason}`);
  const units = buildActiveEditCollapseUnits(model);
  if (units.length === 0) {
    return boundedText([...lines, ...trailer].join('\n'), maxChars, recoveryHandle);
  }
  // Collapse citizenship: the state header and capture-honesty trailer stay
  // verbatim-protected; per-file blocks demote through the generational engine
  // so an over-budget AED leaves receipts and ledger rows, never a bare cut.
  const headerText = lines.join('\n');
  const trailerText = trailer.length > 0 ? `\n${trailer.join('\n')}` : '';
  const body = collapseWithReceipt(
    units,
    maxChars - headerText.length - 1 - trailerText.length,
    recoveryHandle,
  );
  return {
    text: `${headerText}\n${body.text}${trailerText}`,
    complete: body.complete,
    collapse: body.collapse,
  };
}

/**
 * Star-family provenance ids historically embedded the entire note as their
 * final path segment, so `source=` reprinted the row body and the section paid
 * roughly twice for every pointer-authority artifact. The embedded copy adds no
 * recovery power — instance, kind, and source time already resolve the star —
 * so the renderer keeps the resolving prefix and drops the duplicated body.
 * Identities are never rewritten; this is a render-surface compaction only,
 * which also heals persisted legacy models re-rendered at later boundaries.
 */
function compactCognitionSource(provenanceId: string, noteText: string): string {
  const note = noteText.trim();
  if (note.length < 24) return provenanceId;
  const probe = note.replace(/…+\s*$/u, '').slice(0, 120);
  if (probe.length < 24) return provenanceId;
  const index = provenanceId.indexOf(probe);
  if (index <= 8) return provenanceId;
  const head = provenanceId.slice(0, index).replace(/[\s/:]+$/u, '');
  return head ? `${head}/…` : provenanceId;
}

function renderCognition(model: RebirthPackageV6Model, maxChars: number): { text: string; complete: boolean } {
  const recoveryHandle = model.recoveryIndex.find((entry) => entry.id === 'cognition')?.handle ?? null;
  const recovery = recoveryHandle ? `recover=${recoveryHandle}` : 'exact recovery unavailable';
  const capture = model.cognitiveArtifactCapture;
  const known = model.cognitiveArtifacts
    .filter((row) => row.sourceAt)
    .sort((left, right) => right.sourceAt!.localeCompare(left.sourceAt!)
      || right.provenanceId.localeCompare(left.provenanceId));
  const unknown = model.cognitiveArtifacts.filter((row) => !row.sourceAt);
  const lines = known.map((row) => `${row.sourceAt} · ${row.kind} · ${row.text} · source=${compactCognitionSource(row.provenanceId, row.text)} · authority=${row.authority}`);
  if (unknown.length > 0) {
    lines.push('', 'Unknown source time (quarantined; not part of the chronology):');
    for (const row of unknown) lines.push(`- ${row.kind} · ${row.text} · source=${compactCognitionSource(row.provenanceId, row.text)} · authority=${row.authority}`);
  }
  if (lines.length === 0) {
    if (!capture) {
      lines.push(`Cognitive projection status is unknown for this persisted package; zero rendered rows do not prove artifact absence. ${recovery}`);
    } else if (capture.status === 'complete' && (capture.totalMatched ?? 0) === 0) {
      lines.push(`The bounded indexed cognitive projection returned zero current rows; this does not prove the underlying cognitive stores are empty. ${recovery}`);
    } else if (capture.status === 'complete') {
      lines.push(`The indexed cognitive projection matched ${capture.totalMatched} root(s), but no rows reached this section after selection or budgeting. ${recovery}`);
    } else {
      lines.push(`The indexed cognitive projection is ${capture.status}; zero rendered rows are not evidence that no current cognitive artifacts exist. ${recovery}`);
    }
  }
  if (capture) {
    lines.push('', [
      `Capture receipt: status=${capture.status}`,
      `captured-at=${capture.capturedAt ?? 'unknown'}`,
      `total-matched=${capture.totalMatched ?? 'unknown'}`,
      `overlay=${capture.overlayCount ?? 'unknown'}`,
    ].join(' · '));
    if (capture.missingFamilies.length > 0) {
      lines.push(`Missing indexed families: ${capture.missingFamilies.join(', ')}`);
    }
    if (capture.warnings.length > 0) {
      lines.push('Capture warnings:');
      for (const warning of capture.warnings) lines.push(`- ${warning}`);
    }
  }
  return boundedText(lines.join('\n'), maxChars, recoveryHandle);
}

function conversationRowText(row: RebirthPackageV6ConversationRow): string {
  return `[${row.role} · source=${row.provenanceId} · source-time=${row.sourceAt ?? 'unknown'}]\n${row.text}`;
}

function conversationOmissionMarker(args: {
  omittedKnown: readonly RebirthPackageV6ConversationRow[];
  omittedUnknown: readonly RebirthPackageV6ConversationRow[];
  retainedKnown: readonly RebirthPackageV6ConversationRow[];
  recoveryHandle: string | null;
  latestKnownTailOmitted?: boolean;
}): string {
  const parts: string[] = [];
  if (args.omittedKnown.length > 0) {
    const first = args.omittedKnown[0].sourceAt!;
    const last = args.omittedKnown.at(-1)!.sourceAt!;
    parts.push(
      `${args.omittedKnown.length} earlier known-time row${args.omittedKnown.length === 1 ? '' : 's'} omitted`,
      `source-time-range=${first}..${last}`,
    );
  }
  if (args.omittedUnknown.length > 0) {
    parts.push(
      `${args.omittedUnknown.length} unknown-time quarantine row${args.omittedUnknown.length === 1 ? '' : 's'} omitted`,
    );
  }
  const retainedFrom = args.retainedKnown[0]?.sourceAt;
  if (retainedFrom) parts.push(`retained-from=${retainedFrom}`);
  if (args.latestKnownTailOmitted) parts.push('latest-known-row-tail omitted');
  parts.push(args.recoveryHandle ? `recover=${args.recoveryHandle}` : 'exact recovery unavailable');
  return `[… ${parts.join(' · ')} …]`;
}

function renderTruncatedLatestKnownRow(args: {
  row: RebirthPackageV6ConversationRow;
  omittedKnown: readonly RebirthPackageV6ConversationRow[];
  omittedUnknown: readonly RebirthPackageV6ConversationRow[];
  maxChars: number;
  recoveryHandle: string | null;
}): string {
  const fullHeader = `[${args.row.role} · source=${args.row.provenanceId} · source-time=${args.row.sourceAt}]\n`;
  const compactHeader = `[latest ${args.row.role} · source=${args.row.provenanceId}]\n`;
  const fullMarker = conversationOmissionMarker({
    omittedKnown: args.omittedKnown,
    omittedUnknown: args.omittedUnknown,
    retainedKnown: [args.row],
    recoveryHandle: args.recoveryHandle,
    latestKnownTailOmitted: true,
  });
  const compactMarker = `[… earlier-known=${args.omittedKnown.length} · unknown-time=${args.omittedUnknown.length} · latest-tail=omitted …]`;
  const minimumBodyChars = Math.min(16, args.row.text.length);

  // Under a very small caller override, provenance plus the full omission
  // receipt can be larger than the entire section allowance. Try progressively
  // smaller envelopes, but never let either envelope displace the newest known
  // row's content. The Recovery Index remains the canonical recovery directory.
  for (const [header, marker] of [
    [fullHeader, fullMarker],
    [compactHeader, compactMarker],
    ['', compactMarker],
  ] as const) {
    const bodyChars = args.maxChars - header.length - marker.length - 2;
    if (bodyChars < minimumBodyChars) continue;
    return `${header}${args.row.text.slice(0, bodyChars)}\n\n${marker}`;
  }
  return args.row.text.slice(0, args.maxChars);
}

function renderConversation(model: RebirthPackageV6Model, maxChars: number): { text: string; complete: boolean } {
  // God Rule 8: unknown source time never participates in the chronology. Known-time
  // rows stream chronologically; unknown-time rows are quarantined under an explicit
  // banner (mirroring renderCognition and renderExecution) where they make no recency
  // claim and can never be mistaken for a continuous dialogue sequence.
  const known = model.recentConversation.filter((row) => row.sourceAt);
  const unknown = model.recentConversation.filter((row) => !row.sourceAt);
  const lines = known.map(conversationRowText);
  if (unknown.length > 0) {
    lines.push(
      '',
      'Unknown source time (quarantined; not part of the chronology):',
      ...unknown.map(conversationRowText),
    );
  }
  const fullText = lines.join('\n\n');
  if (fullText.length <= maxChars) return { text: fullText, complete: true };

  // Conversation is a chronological section, so overflow must retain its tail:
  // the newest known-source-time rows. Unknown-time rows are admitted only from
  // the remaining space and stay quarantined; they never displace known recency.
  const recoveryHandle = model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle ?? null;
  let retainedKnown: RebirthPackageV6ConversationRow[] = [];
  let retainedUnknown: RebirthPackageV6ConversationRow[] = [];
  const compose = (
    selectedKnown: readonly RebirthPackageV6ConversationRow[],
    selectedUnknown: readonly RebirthPackageV6ConversationRow[],
  ): string => {
    const omittedKnown = known.slice(0, known.length - selectedKnown.length);
    const omittedUnknown = unknown.slice(selectedUnknown.length);
    const blocks = [conversationOmissionMarker({
      omittedKnown,
      omittedUnknown,
      retainedKnown: selectedKnown,
      recoveryHandle,
    }), ...selectedKnown.map(conversationRowText)];
    if (selectedUnknown.length > 0) {
      blocks.push(
        'Unknown source time (quarantined; not part of the chronology):',
        ...selectedUnknown.map(conversationRowText),
      );
    }
    return blocks.join('\n\n');
  };

  for (let index = known.length - 1; index >= 0; index -= 1) {
    const candidate = [known[index], ...retainedKnown];
    if (compose(candidate, retainedUnknown).length > maxChars) break;
    retainedKnown = candidate;
  }
  for (const row of unknown) {
    const candidate = [...retainedUnknown, row];
    if (compose(retainedKnown, candidate).length > maxChars) break;
    retainedUnknown = candidate;
  }

  // If even the newest complete row cannot fit beside the structural omission
  // receipt, preserve that row's head explicitly instead of falling back to the
  // oldest section prefix. This is the only within-row truncation path.
  if (known.length > 0 && retainedKnown.length === 0) {
    const newest = known.at(-1)!;
    return { text: renderTruncatedLatestKnownRow({
      row: newest,
      omittedKnown: known.slice(0, -1),
      omittedUnknown: unknown,
      maxChars,
      recoveryHandle,
    }), complete: false };
  }
  if (known.length === 0 && unknown.length > 0 && retainedUnknown.length === 0) {
    const firstUnknown = unknown[0];
    const marker = conversationOmissionMarker({
      omittedKnown: [],
      omittedUnknown: unknown.slice(1),
      retainedKnown: [],
      recoveryHandle,
    });
    const prefix = `${marker}\n\nUnknown source time (quarantined; not part of the chronology):\n\n`;
    const row = boundedText(conversationRowText(firstUnknown), Math.max(0, maxChars - prefix.length), recoveryHandle);
    return { text: boundedText(`${prefix}${row.text}`, maxChars, recoveryHandle).text, complete: false };
  }

  return { text: compose(retainedKnown, retainedUnknown), complete: false };
}

function renderRecovery(model: RebirthPackageV6Model, maxChars: number): { text: string; complete: boolean } {
  const entries = model.recoveryIndex;
  if (entries.length === 0) return { text: '- recovery index unavailable', complete: true };
  // Recovery Index is a protected package section: its own renderer must never
  // slice it into "exact recovery unavailable" — that would delete the very
  // directory of recovery routes it exists to publish. Entry lines are
  // structurally bounded; overflow elides WHOLE entries at line boundaries and
  // appends the exact recovery command (the entry's own handle, or the
  // package-artifact command as fallback), which carries the complete index,
  // so every advertised route survives the cap. An overflowing entry with
  // bounded inline evidence retains its structural line and elides only the
  // evidence body — never emitting `unavailable` while the entry itself has an
  // exact Atlas/package handle.
  const packageHandle = entries.find((entry) => entry.id === 'rebirth-package')?.handle ?? null;
  const lines: string[] = [];
  let elided = false;
  for (const entry of entries) {
    const line = `- ${entry.id} · ${entry.label} · status=${entry.status} · count=${entry.count ?? 'unknown'} · frontier=${entry.frontier ?? 'unknown'} · recover=${entry.handle || 'unavailable'}`;
    // Optional inline evidence (e.g. a captured Atlas handoff card body) rides
    // beneath its own handle line as a bounded indented snapshot. It never
    // overloads `label` (which stays a short title). If the evidence cannot fit
    // the remaining budget, an explicit elision names the exact recovery handle
    // so the full body stays recoverable — a partial capture must not silently
    // look complete.
    const evidence = entry.inlineEvidence?.trim();
    let evidenceBlock: string | null = null;
    if (evidence) {
      const evidenceHeader = `  ${entry.id}.inline-evidence: root recovery=${entry.handle || packageHandle}`;
      const budget = Math.max(0, maxChars - evidenceHeader.length - 60);
      const ev = boundedText(
        evidence.split('\n').map((l) => `  ${l}`).join('\n'),
        budget,
        entry.handle || packageHandle,
      );
      evidenceBlock = `${evidenceHeader}\n${ev.text}`;
      if (!ev.complete) elided = true;
    }
    const block = evidenceBlock ? `${line}\n${evidenceBlock}` : line;
    const projected = lines.length === 0 ? block : `${lines.join('\n')}\n${block}`;
    // The structurally-bounded entry line always fits: a recovery handle is
    // short and the entry body is elided separately. Only the full block (entry
    // + evidence) can overflow, and on that path we keep the entry line and the
    // exact handle rather than dropping the whole route to an `unavailable`.
    const exactHandle = entry.handle || packageHandle;
    if (projected.length > maxChars) {
      if (evidenceBlock) {
        lines.push(line);
        lines.push(
          exactHandle
            ? `  ${entry.id}.inline-evidence: elided for budget; recover the complete evidence from the exact handle: ${exactHandle}`
            : `  ${entry.id}.inline-evidence: elided for budget; exact recovery handle unavailable`,
        );
      } else {
        const omitted = entries.length - lines.length;
        lines.push(
          exactHandle
            ? `- ${omitted} additional recovery entries elided for budget; recover the complete index from the exact handle: ${exactHandle}`
            : `- ${omitted} additional recovery entries elided for budget; exact recovery handle unavailable`,
        );
      }
      elided = true;
      break;
    }
    lines.push(line);
    if (evidenceBlock) lines.push(evidenceBlock);
  }
  // A partial section must not look complete to manifests/consumers: report
  // complete=false whenever any recovery entry (or inline evidence) was
  // elided, even though every elision is explicit and the exact handle
  // preserves the full content.
  return { text: lines.join('\n'), complete: !elided };
}

/**
 * Lineage sections render through the generational collapse engine: newest
 * units stay verbatim, older units demote one tier at a time (digest → era →
 * receipt → rollup) until the section fits. Nothing is dropped — every demotion
 * leaves an exact, mint-verified pointer (spec §5–§6).
 */
/**
 * Shared two-pass collapse for every section that owns collapse units. The
 * first pass spends the whole allowance. If nothing collapsed there is no
 * receipt line to emit, so the section keeps every char. Otherwise re-collapse
 * with the receipt line reserved: a collapse notice must never be the thing
 * that pushes a section past its cap. On the bounded path the second pass is
 * the one whose text ships, so its placements are the authoritative record of
 * where every unit actually landed.
 */
function collapseWithReceipt(
  units: readonly CollapseUnit[],
  budget: number,
  recover: string | null,
  renderOrder: 'oldest_first' | 'newest_first' = 'oldest_first',
): { text: string; collapse: CollapseResult; complete: boolean } {
  const collapse = (chars: number) => collapseUnits({
    units,
    maxChars: Math.max(0, chars),
    rangeRecover: recover,
    floorRecover: recover,
    renderOrder,
  });
  const tierReceipt = (result: CollapseResult): string => (
    `\n[COLLAPSE units=${units.length} t0=${result.tierCounts.t0}`
    + ` t1=${result.tierCounts.t1} t2=${result.tierCounts.t2}`
    + ` t3=${result.tierCounts.t3} t4=${result.tierCounts.t4}`
    + ` recover=${recover ?? 'unavailable'}]`
  );
  const full = collapse(budget);
  if (full.complete) return { text: full.text, collapse: full, complete: true };
  // +16 pads for digit-width drift between the two passes' tier counts.
  const reserve = tierReceipt(full).length + 16;
  const bounded = collapse(budget - reserve);
  return { text: `${bounded.text}${tierReceipt(bounded)}`, collapse: bounded, complete: false };
}

function renderLineage(
  section: RebirthPackageV7LineageSection,
  maxChars: number,
  fallbackRecover: string | null,
): RenderedV6SectionBody {
  const header: string[] = [];
  if (section.partialReason) header.push(`partial=${section.partialReason}`);
  if (section.units.length === 0) {
    header.push('No lineage units captured for this section.');
    return { text: header.join('\n'), complete: !section.partialReason, collapse: null };
  }
  const headerText = header.length > 0 ? `${header.join('\n')}\n` : '';
  const recover = section.rangeRecover ?? fallbackRecover;
  const body = collapseWithReceipt(
    section.units,
    maxChars - headerText.length,
    recover,
    'newest_first',
  );
  return {
    text: `${headerText}${body.text}`,
    complete: body.complete && !section.partialReason,
    collapse: body.collapse,
  };
}

function frameSection(id: RebirthPackageV6SectionId, body: string): string {
  return [
    `── ${SECTION_TITLES[id]} ──`,
    `${V6_SECTION_OPEN_PREFIX} id=${id} chars=${body.length}]`,
    body,
    V6_SECTION_CLOSE,
  ].join('\n');
}

/**
 * Persisted v6 packages predate the lineage sections and carry none of them, and
 * `isRebirthPackageV6Model` deliberately still accepts those. The renderer must
 * therefore read lineage through this accessor: an absent section is empty, not
 * a crash. Rendering a stored package is a continuity-recovery path — it must
 * never throw on the shape it was told is valid.
 */
const EMPTY_LINEAGE_SECTION: RebirthPackageV7LineageSection = Object.freeze({
  units: [],
  rangeRecover: null,
  partialReason: null,
});

function lineageSection(
  model: RebirthPackageV6Model,
  id: RebirthPackageV7LineageSectionId,
): RebirthPackageV7LineageSection {
  const section = model[id];
  if (!section || !Array.isArray(section.units)) return EMPTY_LINEAGE_SECTION;
  return section;
}

/**
 * One rendered section body. `collapse` is populated only by the lineage
 * renderer: it is the final CollapseResult whose text actually shipped (or
 * null when the section had no units), so downstream continuity-ledger capture
 * records what the render truly did rather than recomputing an approximation.
 */
interface RenderedV6SectionBody {
  readonly text: string;
  readonly complete: boolean;
  readonly collapse?: CollapseResult | null;
}

function renderSectionBodies(
  model: RebirthPackageV6Model,
  limits: Record<RebirthPackageV6SectionId, number>,
): Record<RebirthPackageV6SectionId, RenderedV6SectionBody> {
  const transcriptHandle = model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle || null;
  return {
    boundaryAndActiveTask: renderBoundary(model, limits.boundaryAndActiveTask),
    executionState: renderExecution(model, limits.executionState),
    activeEditDelta: renderActiveEdits(model, limits.activeEditDelta),
    cognitiveArtifacts: renderCognition(model, limits.cognitiveArtifacts),
    recentConversation: renderConversation(model, limits.recentConversation),
    operatorVault: renderLineage(
      lineageSection(model, 'operatorVault'),
      limits.operatorVault,
      transcriptHandle,
    ),
    episodeChapterIndex: renderLineage(
      lineageSection(model, 'episodeChapterIndex'),
      limits.episodeChapterIndex,
      model.recoveryIndex.find((entry) => entry.id === 'context-warp-stores')?.handle || null,
    ),
    lifeLedger: renderLineage(
      lineageSection(model, 'lifeLedger'),
      limits.lifeLedger,
      model.recoveryIndex.find((entry) => entry.id === 'rebirth-package')?.handle || null,
    ),
    recoveryIndex: renderRecovery(model, limits.recoveryIndex),
  };
}

function admittedSectionIds(model: RebirthPackageV6Model): readonly RebirthPackageV6SectionId[] {
  return REBIRTH_PACKAGE_V6_SECTION_IDS.filter((id) => {
    if (id === 'recentConversation') return model.recentConversation.length > 0;
    if ((REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS as readonly string[]).includes(id)) {
      const section = lineageSection(model, id as RebirthPackageV7LineageSectionId);
      return section.units.length > 0 || Boolean(section.partialReason);
    }
    return true;
  });
}

function packageBudgetChars(options: RenderRebirthPackageV6Options): number {
  return options.packageBudget ?? DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS;
}

function pushTargetChars(options: RenderRebirthPackageV6Options): number {
  const budget = packageBudgetChars(options);
  if (!Number.isFinite(budget) || budget <= 0) return budget;
  const configured = options.pushTargetChars;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) return budget;
  return Math.min(Math.floor(budget), Math.floor(configured));
}

/**
 * Adaptive Backfill (spec §7): after every section renders inside its cap, the
 * unspent global budget is handed out in priority order. Each grant raises one
 * section's cap by the entire remaining pool; the section takes only what its
 * next tier promotion needs, and the measured growth is what leaves the pool.
 * The result is a young lineage that ships nearly all-verbatim and an old
 * lineage that ships recent-verbatim plus a digest middle and an era/receipt
 * deep past — the O(log lifetime) curve emerging from one rule at every age.
 */
export function resolveAdaptiveSectionCaps(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): Record<RebirthPackageV6SectionId, number> {
  const limits = { ...DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS, ...options.sectionMaxChars };
  const budget = pushTargetChars(options);
  if (options.adaptiveBackfill === false || !Number.isFinite(budget) || budget <= 0) return limits;
  const envelopeChars = Number.isFinite(options.envelopeChars)
    ? Math.max(0, Math.floor(options.envelopeChars ?? 0))
    : 0;

  const admitted = admittedSectionIds(model);
  let bodies = renderSectionBodies(model, limits);
  const framedLength = (): number => admitted
    .map((id) => frameSection(id, bodies[id].text).length)
    .reduce((total, length, index) => total + length + (index > 0 ? 2 : 0), 0);

  let spare = budget
    - envelopeChars
    - REBIRTH_PACKAGE_V7_FRAMING_RESERVE_CHARS
    - framedLength();
  if (spare <= 0) return limits;

  // An explicitly supplied cap is a hard ceiling the caller asked for; backfill
  // may only grow the defaults. Silently inflating a requested cap would make
  // every caller-imposed bound advisory.
  const explicitCaps = new Set<RebirthPackageV6SectionId>(
    Object.keys(options.sectionMaxChars ?? {}) as RebirthPackageV6SectionId[],
  );

  for (const id of REBIRTH_PACKAGE_V7_BACKFILL_PRIORITY) {
    if (spare < 1) break;
    if (!admitted.includes(id)) continue;
    if (explicitCaps.has(id)) continue;
    if (bodies[id].complete) continue;
    const before = bodies[id].text.length;
    limits[id] += spare;
    bodies = renderSectionBodies(model, limits);
    // The section takes only what its next promotion needs; the unconsumed part
    // of the grant stays in the pool for the next section in priority order.
    // The inflated cap is kept because it is what produced this measured body.
    const growth = bodies[id].text.length - before;
    spare -= Math.max(0, growth);
  }
  return limits;
}

export function renderRebirthPackageV6Sections(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): readonly RenderedRebirthPackageV6Section[] {
  // Redaction lane: nothing republishes before it (pure, idempotent, cached).
  model = redactContinuityModel(model).model;
  const limits = resolveAdaptiveSectionCaps(model, options);
  return renderSectionsWithLimits(model, limits);
}

function renderSectionsWithLimits(
  model: RebirthPackageV6Model,
  limits: Record<RebirthPackageV6SectionId, number>,
): readonly RenderedRebirthPackageV6Section[] {
  const rendered = renderSectionBodies(model, limits);
  return admittedSectionIds(model).map((id) => ({
    id,
    title: SECTION_TITLES[id],
    text: frameSection(id, rendered[id].text),
    complete: rendered[id].complete,
    ...(rendered[id].collapse !== undefined ? { collapse: rendered[id].collapse } : {}),
  }));
}

/**
 * Per-lineage-section collapse outcome of one actual render: the exact
 * placements behind the shipped text plus whether the whole framed section was
 * omitted by the package-level budget compose. This is the record the
 * continuity ledger persists — computed once by the render, never re-derived.
 */
/** Sections owning collapse units: the v7 lineage trio plus the Active Edit Delta. */
export type RebirthPackageV7CollapseSectionId = RebirthPackageV7LineageSectionId | 'activeEditDelta';

export interface RebirthPackageV7SectionCollapseReport {
  readonly sectionId: RebirthPackageV7CollapseSectionId;
  readonly placements: readonly CollapseUnitPlacement[];
  readonly demotions: number;
  readonly droppedToFloorRollup: number;
  /** True when the composed package omitted this section entirely. */
  readonly sectionElided: boolean;
}

export interface RebirthPackageV7CollapseReport {
  readonly sections: readonly RebirthPackageV7SectionCollapseReport[];
  /** Every optional section the budget compose omitted (lineage or not). */
  readonly omittedSectionIds: readonly RebirthPackageV6SectionId[];
  /** Per-render counters from the graceful push-shrink and final compose. */
  readonly telemetry: RebirthPackageV7EvictionTelemetry;
}

export interface RebirthPackageV7EvictionTelemetry {
  readonly budgetChars: number;
  readonly pushTargetChars: number;
  readonly envelopeChars: number;
  readonly initialTotalChars: number;
  readonly finalTotalChars: number;
  readonly oversubscribedChars: number;
  readonly targetMissChars: number;
  readonly hardOverrunChars: number;
  readonly shrinkRenders: number;
  readonly sectionsShrunk: number;
  readonly capReductionChars: number;
  readonly unitsDemoted: number;
  readonly demotionSteps: number;
  readonly unitsFloorRolledUp: number;
  readonly unitsSectionElided: number;
  readonly sectionsElided: number;
  readonly evictionEnvelopes: number;
}

export interface RenderedRebirthPackageV6WithReport {
  readonly text: string;
  readonly collapse: RebirthPackageV7CollapseReport;
}

function buildCollapseReport(
  sections: readonly RenderedRebirthPackageV6Section[],
  omittedSectionIds: readonly RebirthPackageV6SectionId[],
  telemetry: RebirthPackageV7EvictionTelemetry,
): RebirthPackageV7CollapseReport {
  const omitted = new Set<RebirthPackageV6SectionId>(omittedSectionIds);
  const citizens = sections.filter((section): section is RenderedRebirthPackageV6Section & { collapse: CollapseResult } => (
    section.collapse != null
    && ((REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS as readonly string[]).includes(section.id)
      || section.id === 'activeEditDelta')
  ));
  return {
    sections: citizens.map((section) => ({
      sectionId: section.id as RebirthPackageV7CollapseSectionId,
      placements: section.collapse.placements,
      demotions: section.collapse.demotions,
      droppedToFloorRollup: section.collapse.droppedToFloorRollup,
      sectionElided: omitted.has(section.id),
    })),
    omittedSectionIds,
    telemetry,
  };
}

function oneLineClaim(value: string, maxChars = 140): string {
  const flattened = value.replace(/\s+/gu, ' ').replace(/"/gu, "'").trim();
  return flattened.length <= maxChars ? flattened : `${flattened.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Skeletal era census for an eviction envelope: one line per era (count, span,
 * one claim sample), oldest first, unknown-time quarantine last, bounded so an
 * envelope stays a signpost, never a second body. Overflowing eras fuse into a
 * declared tail count instead of silently vanishing.
 */
function buildEvictionEraCensus(units: readonly CollapseUnit[], maxChars: number): string[] {
  const eras = new Map<string, CollapseUnit[]>();
  for (const unit of units) {
    const key = unit.sourceAt ? (unit.eraKey ?? unit.sourceAt.slice(0, 10)) : 'unknown-time';
    const bucket = eras.get(key);
    if (bucket) bucket.push(unit); else eras.set(key, [unit]);
  }
  const keys = [...eras.keys()].sort((a, b) => (
    a === 'unknown-time' ? 1 : b === 'unknown-time' ? -1 : a.localeCompare(b)
  ));
  const lines: string[] = [];
  let spent = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const bucket = eras.get(keys[index])!;
    const times = bucket
      .map((unit) => unit.sourceAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const span = times.length > 0 ? `${times[0]}..${times.at(-1)}` : 'unknown';
    const line = `· era=${keys[index]} n=${bucket.length} span=${span} "${oneLineClaim(bucket[0].claim)}"`;
    if (spent + line.length + 1 > maxChars) {
      const remaining = keys.slice(index);
      const remainingUnits = remaining.reduce((total, key) => total + (eras.get(key)?.length ?? 0), 0);
      lines.push(`· … ${remaining.length} more era(s) (${remainingUnits} units)`);
      break;
    }
    lines.push(line);
    spent += line.length + 1;
  }
  return lines;
}

/**
 * Eviction envelope for a whole section the package-level budget omitted: unit
 * count, source span, a skeletal era census, and the one continuity-ledger
 * handle where every evicted unit's placement row lives (spec: per-section
 * pointers to the ledger, not per-unit receipt spam). A missing ledger handle
 * renders the declared degradation line — never a dead pointer.
 */
function buildSectionEvictionEnvelope(args: {
  sectionId: RebirthPackageV7CollapseSectionId;
  units: readonly CollapseUnit[];
  ledgerHandle: string | null;
  includeCensus: boolean;
}): string {
  const times = args.units
    .map((unit) => unit.sourceAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const span = times.length > 0 ? `${times[0]}..${times.at(-1)}` : 'unknown..unknown';
  const header = args.ledgerHandle
    ? `[EVICTED section=${args.sectionId} units=${args.units.length} span=${span} ledger=${args.ledgerHandle}]`
    : `[EVICTED section=${args.sectionId} units=${args.units.length} span=${span}]`
      + `\n${args.units.length} units evicted; ledger unreachable`;
  if (!args.includeCensus) return header;
  return [header, ...buildEvictionEraCensus(args.units, 900)].join('\n');
}

/** Reverse backfill order: deep lineage yields before operator truth and AED. */
const REBIRTH_PACKAGE_V7_SHRINK_PRIORITY = [
  'lifeLedger',
  'episodeChapterIndex',
  'operatorVault',
  'activeEditDelta',
] as const satisfies readonly RebirthPackageV7CollapseSectionId[];

function joinRenderedSections(
  sections: readonly RenderedRebirthPackageV6Section[],
  declaration: string | null,
): string {
  const sectionsText = sections.map((section) => section.text).join('\n\n');
  return declaration ? `${declaration}\n\n${sectionsText}` : sectionsText;
}

interface RebirthPackageV7ShrinkOutcome {
  readonly sections: readonly RenderedRebirthPackageV6Section[];
  readonly text: string;
  readonly shrinkRenders: number;
  readonly sectionsShrunk: number;
  readonly capReductionChars: number;
}

/**
 * Missing middle gear between adaptive backfill and package-level section
 * elision. The binary searches keep the largest cap that reaches the target,
 * so pressure demotes only as much history as the measured overflow requires.
 * Every collapse citizen keeps a 2k floor; fixed must-push sections are never
 * touched here, and Active Edit Delta remains protected by the final compose.
 */
function shrinkCollapseSectionsToTarget(args: {
  model: RebirthPackageV6Model;
  declaration: string | null;
  initialLimits: Record<RebirthPackageV6SectionId, number>;
  initialSections: readonly RenderedRebirthPackageV6Section[];
  initialText: string;
  targetChars: number;
}): RebirthPackageV7ShrinkOutcome {
  let limits = { ...args.initialLimits };
  let sections = args.initialSections;
  let rendered = args.initialText;
  let shrinkRenders = 0;
  const shrunk = new Set<RebirthPackageV7CollapseSectionId>();

  const evaluate = (
    id: RebirthPackageV7CollapseSectionId,
    cap: number,
  ): { limits: Record<RebirthPackageV6SectionId, number>; sections: readonly RenderedRebirthPackageV6Section[]; text: string } => {
    const candidateLimits = { ...limits, [id]: cap };
    const candidateSections = renderSectionsWithLimits(args.model, candidateLimits);
    shrinkRenders += 1;
    return {
      limits: candidateLimits,
      sections: candidateSections,
      text: joinRenderedSections(candidateSections, args.declaration),
    };
  };

  for (const id of REBIRTH_PACKAGE_V7_SHRINK_PRIORITY) {
    if (rendered.length <= args.targetChars) break;
    const section = sections.find((candidate) => candidate.id === id);
    if (!section?.collapse) continue;
    const startingCap = limits[id];
    const floorCap = Math.min(startingCap, REBIRTH_PACKAGE_V7_COLLAPSE_FLOOR_CHARS);
    if (startingCap <= floorCap) continue;

    const floor = evaluate(id, floorCap);
    // A collapse receipt can occasionally cost more than a tiny amount of body
    // text. Never commit a cap reduction that fails to reduce the package.
    if (floor.text.length >= rendered.length) continue;
    let best = floor;

    if (floor.text.length <= args.targetChars) {
      // Preserve the most content that still meets the target. Collapse output
      // is monotone by cap; the final exact render remains the authority.
      let low = floorCap + 1;
      let high = startingCap - 1;
      let probes = 0;
      while (low <= high && probes < 8) {
        const middle = low + Math.floor((high - low) / 2);
        const candidate = evaluate(id, middle);
        probes += 1;
        if (candidate.text.length <= args.targetChars) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
    }

    limits = best.limits;
    sections = best.sections;
    rendered = best.text;
    shrunk.add(id);
  }

  const capReductionChars = REBIRTH_PACKAGE_V7_SHRINK_PRIORITY.reduce(
    (total, id) => total + Math.max(0, args.initialLimits[id] - limits[id]),
    0,
  );
  return {
    sections,
    text: rendered,
    shrinkRenders,
    sectionsShrunk: shrunk.size,
    capReductionChars,
  };
}

export function renderRebirthPackageV6WithReport(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): RenderedRebirthPackageV6WithReport {
  // Redaction lane first: sections, eviction envelopes, and ledger capture
  // must all derive from the same redacted model, and the aggregate
  // declaration must ride INSIDE the budget math, never appended beyond it.
  const lane = redactContinuityModel(model);
  model = lane.model;
  const declaration = lane.declaration;
  const budget = packageBudgetChars(options);
  const pushTarget = pushTargetChars(options);
  const envelopeChars = Number.isFinite(options.envelopeChars)
    ? Math.max(0, Math.floor(options.envelopeChars ?? 0))
    : 0;
  const initialLimits = resolveAdaptiveSectionCaps(model, options);
  const initialSections = renderSectionsWithLimits(model, initialLimits);
  const initialRendered = joinRenderedSections(initialSections, declaration);
  const targetSectionChars = Number.isFinite(pushTarget) && pushTarget > 0
    ? Math.max(0, Math.floor(pushTarget) - envelopeChars)
    : Number.POSITIVE_INFINITY;
  const shrink = initialRendered.length > targetSectionChars
    ? shrinkCollapseSectionsToTarget({
      model,
      declaration,
      initialLimits,
      initialSections,
      initialText: initialRendered,
      targetChars: targetSectionChars,
    })
    : {
      sections: initialSections,
      text: initialRendered,
      shrinkRenders: 0,
      sectionsShrunk: 0,
      capReductionChars: 0,
    };
  const sections = shrink.sections;
  const rendered = shrink.text;
  const finish = (
    text: string,
    omittedSectionIds: readonly RebirthPackageV6SectionId[],
  ): RenderedRebirthPackageV6WithReport => {
    const citizens = sections.filter((section): section is RenderedRebirthPackageV6Section & { collapse: CollapseResult } => (
      section.collapse != null
    ));
    const omitted = new Set(omittedSectionIds);
    const finalTotalChars = text.length + envelopeChars;
    const initialTotalChars = initialRendered.length + envelopeChars;
    const telemetry: RebirthPackageV7EvictionTelemetry = {
      budgetChars: Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0,
      pushTargetChars: Number.isFinite(pushTarget) && pushTarget > 0 ? Math.floor(pushTarget) : 0,
      envelopeChars,
      initialTotalChars,
      finalTotalChars,
      oversubscribedChars: Number.isFinite(pushTarget) && pushTarget > 0
        ? Math.max(0, initialTotalChars - Math.floor(pushTarget))
        : 0,
      targetMissChars: Number.isFinite(pushTarget) && pushTarget > 0
        ? Math.max(0, finalTotalChars - Math.floor(pushTarget))
        : 0,
      hardOverrunChars: Number.isFinite(budget) && budget > 0
        ? Math.max(0, finalTotalChars - Math.floor(budget))
        : 0,
      shrinkRenders: shrink.shrinkRenders,
      sectionsShrunk: shrink.sectionsShrunk,
      capReductionChars: shrink.capReductionChars,
      unitsDemoted: citizens.reduce(
        (total, section) => total + section.collapse.placements.filter((placement) => placement.tier !== 't0').length,
        0,
      ),
      demotionSteps: citizens.reduce((total, section) => total + section.collapse.demotions, 0),
      unitsFloorRolledUp: citizens.reduce(
        (total, section) => total + section.collapse.droppedToFloorRollup,
        0,
      ),
      unitsSectionElided: citizens.reduce(
        (total, section) => total + (omitted.has(section.id) ? section.collapse.placements.length : 0),
        0,
      ),
      sectionsElided: omittedSectionIds.length,
      evictionEnvelopes: citizens.filter(
        (section) => omitted.has(section.id) && section.collapse.placements.length > 0,
      ).length,
    };
    return {
      text,
      collapse: buildCollapseReport(sections, omittedSectionIds, telemetry),
    };
  };
  if (!Number.isFinite(budget) || budget <= 0) return finish(rendered, []);

  // The protected lifecycle envelope (emitted by the relay above these sections)
  // is reserved from the section budget so the produced total never silently
  // exceeds the declared packageBudget. When the envelope alone consumes the
  // entire budget, record a protected-overrun and admit no optional sections —
  // the envelope is protected, so the overrun must be visible, never hidden.
  const envelopeOverrun = envelopeChars > budget;
  const sectionBudget = envelopeOverrun ? 0 : Math.max(0, budget - envelopeChars);
  if (!envelopeOverrun && rendered.length <= sectionBudget) return finish(rendered, []);

  // Authorization, execution truth, active edits, and recovery stay whole.
  // Never slice a framed section mid-line: that can hide an omitted-file or
  // truncation receipt and make partial evidence look complete. Optional
  // cognition/conversation are admitted only at complete section boundaries.
  const protectedIds = new Set<RebirthPackageV6SectionId>([
    'boundaryAndActiveTask',
    'executionState',
    'activeEditDelta',
    'recoveryIndex',
  ]);
  const optional = sections.filter((section) => !protectedIds.has(section.id));
  const recover = model.recoveryIndex.find((entry) => entry.id === 'rebirth-package')?.handle || 'unavailable';
  const ledgerHandle = model.recoveryIndex.find((entry) => entry.id === 'continuity-ledger')?.handle || null;
  const citizenUnits = (id: RebirthPackageV6SectionId): readonly CollapseUnit[] => {
    if (id === 'activeEditDelta') return buildActiveEditCollapseUnits(model);
    if ((REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS as readonly string[]).includes(id)) {
      return lineageSection(model, id as RebirthPackageV7LineageSectionId).units;
    }
    return [];
  };

  const compose = (
    includedOptional: ReadonlySet<RebirthPackageV6SectionId>,
    protectedOverrun = false,
  ): string => {
    const omitted = optional
      .filter((section) => !includedOptional.has(section.id))
      .map((section) => section.id);
    const blocks: string[] = declaration ? [declaration] : [];
    for (const section of sections) {
      if (section.id === 'recoveryIndex' && (omitted.length > 0 || protectedOverrun)) {
        blocks.push(
          `[REBIRTH-V6-PACKAGE-ELISION original-chars=${initialRendered.length} budget=${budget}`
          + ` envelope-chars=${envelopeChars} omitted-sections=${omitted.join(',') || 'none'}`
          + ` protected-overrun=${protectedOverrun || envelopeOverrun}`
          + ` recover=${recover}]`,
        );
      }
      if (protectedIds.has(section.id) || includedOptional.has(section.id)) {
        blocks.push(section.text);
        continue;
      }
      // A whole omitted collapse-citizen section leaves an eviction envelope at
      // its chronological slot: count + span + skeletal era census + the one
      // ledger handle. Under protected-overrun the census is dropped so the
      // declared overrun never grows an unbounded tail.
      const units = citizenUnits(section.id);
      if (units.length > 0) {
        blocks.push(buildSectionEvictionEnvelope({
          sectionId: section.id as RebirthPackageV7CollapseSectionId,
          units,
          ledgerHandle,
          includeCensus: !protectedOverrun,
        }));
      }
    }
    return blocks.join('\n\n');
  };

  const included = new Set<RebirthPackageV6SectionId>();
  const protectedOnly = compose(included);
  if (protectedOnly.length > sectionBudget) {
    return finish(compose(included, true), optional.map((section) => section.id));
  }

  for (const section of optional) {
    const candidate = new Set(included).add(section.id);
    if (compose(candidate).length > sectionBudget) continue;
    included.add(section.id);
  }
  return finish(
    compose(included),
    optional.filter((section) => !included.has(section.id)).map((section) => section.id),
  );
}

export function renderRebirthPackageV6(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): string {
  return renderRebirthPackageV6WithReport(model, options).text;
}

/** Why a ledger row is at its tier in the build that produced it. */
export type ContinuityLedgerTierBasis =
  | 'cap-overflow'
  | 'section-elision'
  | 'tier-demotion'
  | 'rendered'
  | 'tail-epoch-fold'
  | 'tail-epoch-retained'
  | 'hard-epoch-seed'
  | 'hard-epoch-live';

export type ContinuityLedgerLifecycle = 'rebirth' | 'tail-epoch' | 'hard-epoch';
export type ContinuityLedgerPlacement = 'rendered' | 'folded' | 'elided';
export type ContinuityLedgerCaptureSectionId =
  | RebirthPackageV7CollapseSectionId
  | 'tailEpoch'
  | 'hardEpoch';

/** One hash function for every Rebirth/tail/hard continuity-ledger row. */
export function sha256ContinuityLedgerVerbatim(verbatim: string): string {
  return createHash('sha256').update(verbatim, 'utf8').digest('hex');
}

/**
 * One persistable continuity-ledger row assembled from an actual render.
 * Field-for-field aligned with the relay worker's ContinuityLedgerUnitInput:
 * `verbatim` exists so the store can verify `sha256` at write and is then
 * discarded — the ledger persists placements and proofs, never bodies.
 */
export interface ContinuityLedgerCaptureUnit {
  readonly unitId: string;
  readonly kind: string;
  readonly sectionId: ContinuityLedgerCaptureSectionId;
  /** Stable source-row identity, or a declared capture-relative coordinate. */
  readonly sourceProvenanceId: string;
  readonly sourceIdentityAuthority: 'exact' | 'synthetic-position';
  readonly sourceIndex: number | null;
  readonly sourceInstanceId: string | null;
  readonly sourceTime: string | null;
  readonly sourceEndTime: string | null;
  readonly eraKey: string | null;
  readonly tier: string;
  readonly tierBasis: ContinuityLedgerTierBasis;
  readonly placement: ContinuityLedgerPlacement;
  readonly claim: string;
  readonly verbatim: string;
  readonly sha256: string;
  readonly origin: 'declared' | 'heuristic' | null;
  readonly recover: string;
  readonly workspace: string | null;
}

export interface ContinuityLedgerCaptureRecord {
  readonly ownerInstanceId: string;
  readonly captureId: string;
  readonly workspace: string | null;
  readonly lifecycle: ContinuityLedgerLifecycle;
  readonly sourceStartIndex: number | null;
  readonly sourceEndIndexExclusive: number | null;
  readonly sourceFirstTime: string | null;
  readonly sourceLastTime: string | null;
  readonly units: readonly ContinuityLedgerCaptureUnit[];
}

/**
 * Assemble the continuity-ledger record for one ACTUAL package render.
 *
 * The caller decides whether the render was real (delivered to a successor) —
 * previews and ghost taps simply never persist what this returns. Placements
 * come from the render's own CollapseResult, never recomputed, so the ledger
 * records what the shipped package truly did: every unit of every lineage
 * section, tagged with the tier it landed at and why ('rendered' rows keep the
 * census complete and let a later build's upsert supersede a stale demotion).
 * Returns null when the model carries no addressable identity or no units —
 * absence of a record, never an invented one.
 */
export function buildContinuityLedgerCaptureFromV6Render(
  model: RebirthPackageV6Model,
  report: RebirthPackageV7CollapseReport,
): ContinuityLedgerCaptureRecord | null {
  // Same lane as the render: capture rows must attest the shipped (redacted)
  // bytes even when the caller holds the pre-lane model reference.
  model = redactContinuityModel(model).model;
  const boundary = model.boundaryAndActiveTask;
  const ownerInstanceId = boundary.instanceId?.trim();
  const captureId = boundary.captureId?.trim();
  if (!ownerInstanceId || !captureId) return null;
  const workspace = boundary.workspace && boundary.workspace !== 'unknown'
    ? boundary.workspace
    : null;

  const units: ContinuityLedgerCaptureUnit[] = [];
  for (const sectionReport of report.sections) {
    const sectionUnits = sectionReport.sectionId === 'activeEditDelta'
      ? buildActiveEditCollapseUnits(model)
      : lineageSection(model, sectionReport.sectionId).units;
    if (sectionUnits.length === 0) continue;
    const byId = new Map(sectionUnits.map((unit) => [unit.id, unit]));
    for (const placement of sectionReport.placements) {
      const unit = byId.get(placement.id);
      // A placement without a matching unit would be a collapse-engine bug;
      // skipping is honest (the worker sees fewer rows), inventing is not.
      if (!unit) continue;
      const tierBasis: ContinuityLedgerTierBasis = sectionReport.sectionElided
        ? 'section-elision'
        : sectionReport.droppedToFloorRollup > 0
          ? 'cap-overflow'
          : placement.tier === 't0'
            ? 'rendered'
            : 'tier-demotion';
      units.push({
        unitId: unit.id,
        kind: unit.kind,
        sectionId: sectionReport.sectionId,
        sourceProvenanceId: unit.id,
        sourceIdentityAuthority: 'exact',
        sourceIndex: null,
        sourceInstanceId: unit.sourceInstanceId ?? null,
        sourceTime: unit.sourceAt ?? null,
        sourceEndTime: unit.sourceEndAt ?? null,
        eraKey: unit.eraKey ?? null,
        tier: placement.tier,
        tierBasis,
        placement: sectionReport.sectionElided
          ? 'elided'
          : placement.tier === 't0'
            ? 'rendered'
            : 'folded',
        claim: unit.claim,
        verbatim: unit.verbatim,
        sha256: sha256ContinuityLedgerVerbatim(unit.verbatim),
        origin: unit.origin ?? null,
        recover: unit.recover,
        workspace,
      });
    }
  }
  if (units.length === 0) return null;
  const sourceTimes = units
    .flatMap((unit) => [unit.sourceTime, unit.sourceEndTime])
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    ownerInstanceId,
    captureId,
    workspace,
    lifecycle: 'rebirth',
    sourceStartIndex: null,
    sourceEndIndexExclusive: null,
    sourceFirstTime: sourceTimes[0] ?? null,
    sourceLastTime: sourceTimes.at(-1) ?? null,
    units,
  };
}

export interface ContinuityLedgerFoldEpochCaptureInput {
  readonly lifecycle: 'tail-epoch' | 'hard-epoch';
  readonly ownerInstanceId: string;
  readonly captureId: string;
  readonly workspace?: string | null;
  readonly messages: readonly FoldMessage[];
  readonly sourceStartIndex: number;
  /** Exact source ordinal per message when filtering left gaps in the capture. */
  readonly sourceIndexes?: readonly number[];
  /** One exact placement per source message; defaults to folded. */
  readonly placements?: readonly ContinuityLedgerPlacement[];
  readonly recover?: (sourceIndex: number, message: FoldMessage) => string;
}

function foldMessageVerbatim(message: FoldMessage): string {
  // Fixed property order makes the canonical unit independent of host object
  // insertion order while preserving every FoldMessage field that can affect
  // provider-visible trace meaning.
  return JSON.stringify({
    role: message.role,
    content: message.content,
    ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.name !== undefined ? { name: message.name } : {}),
  });
}

function foldMessageSourceTime(message: FoldMessage): string | null {
  if (typeof message.tsMs !== 'number' || !Number.isFinite(message.tsMs)) return null;
  const date = new Date(message.tsMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function foldMessageProvenance(
  message: FoldMessage,
  captureId: string,
  sourceIndex: number,
): { id: string; authority: 'exact' | 'synthetic-position' } {
  const primary = message.sourceIdentityAuthority !== 'synthetic-position'
    ? message.sourceIdentity?.trim()
    : undefined;
  if (primary) return { id: primary, authority: 'exact' };
  const identities = [...new Set((message.sourceIdentities ?? []).map((value) => value.trim()).filter(Boolean))]
    .sort();
  if (identities.length === 1) return { id: identities[0]!, authority: 'exact' };
  if (identities.length > 1) {
    return {
      id: `source-set:${sha256ContinuityLedgerVerbatim(identities.join('\n'))}`,
      authority: 'exact',
    };
  }
  return { id: `${captureId}:message#${sourceIndex}`, authority: 'synthetic-position' };
}

/**
 * Build storage-neutral per-message rows for a committed FoldSession epoch.
 * The ledger callback is owned by FoldSession; this pure builder performs no
 * writes and is equally usable by relay and standalone hosts.
 */
export function buildContinuityLedgerCaptureFromFoldEpoch(
  input: ContinuityLedgerFoldEpochCaptureInput,
): ContinuityLedgerCaptureRecord | null {
  const ownerInstanceId = input.ownerInstanceId.trim();
  const captureId = input.captureId.trim();
  if (!ownerInstanceId || !captureId || input.messages.length === 0) return null;
  const workspace = input.workspace?.trim() || null;
  const sectionId: ContinuityLedgerCaptureSectionId = input.lifecycle === 'tail-epoch'
    ? 'tailEpoch'
    : 'hardEpoch';
  const units: ContinuityLedgerCaptureUnit[] = input.messages.map((message, offset) => {
    const explicitSourceIndex = input.sourceIndexes?.[offset];
    const sourceIndex = Number.isSafeInteger(explicitSourceIndex) && explicitSourceIndex! >= 0
      ? explicitSourceIndex!
      : input.sourceStartIndex + offset;
    const provenance = foldMessageProvenance(message, captureId, sourceIndex);
    const placement = input.placements?.[offset] ?? 'folded';
    const verbatim = foldMessageVerbatim(message);
    const sourceTime = foldMessageSourceTime(message);
    const tierBasis: ContinuityLedgerTierBasis = input.lifecycle === 'tail-epoch'
      ? placement === 'rendered' ? 'tail-epoch-retained' : 'tail-epoch-fold'
      : placement === 'rendered' ? 'hard-epoch-live' : 'hard-epoch-seed';
    return {
      unitId: provenance.id,
      kind: `message:${message.role}`,
      sectionId,
      sourceProvenanceId: provenance.id,
      sourceIdentityAuthority: provenance.authority,
      sourceIndex,
      sourceInstanceId: ownerInstanceId,
      sourceTime,
      sourceEndTime: null,
      eraKey: sourceTime?.slice(0, 10) ?? null,
      tier: placement === 'rendered' ? 't0' : placement === 'folded' ? 't2' : 't3',
      tierBasis,
      placement,
      claim: `${input.lifecycle} ${message.role} message ${provenance.id}`,
      verbatim,
      sha256: sha256ContinuityLedgerVerbatim(verbatim),
      origin: null,
      recover: input.recover?.(sourceIndex, message)
        ?? `fold_recall op="range" start_event=${sourceIndex} end_event_exclusive=${sourceIndex + 1}`,
      workspace,
    };
  });
  const sourceTimes = units.map((unit) => unit.sourceTime).filter((value): value is string => Boolean(value)).sort();
  const sourceIndexes = units.map((unit) => unit.sourceIndex).filter((value): value is number => value !== null);
  const sourceStartIndex = sourceIndexes.length > 0 ? Math.min(...sourceIndexes) : input.sourceStartIndex;
  const sourceEndIndexExclusive = sourceIndexes.length > 0
    ? Math.max(...sourceIndexes) + 1
    : input.sourceStartIndex + input.messages.length;
  return {
    ownerInstanceId,
    captureId,
    workspace,
    lifecycle: input.lifecycle,
    sourceStartIndex,
    sourceEndIndexExclusive,
    sourceFirstTime: sourceTimes[0] ?? null,
    sourceLastTime: sourceTimes.at(-1) ?? null,
    units,
  };
}

/**
 * Deterministic compatibility mapping for retained v1 context-package keys.
 * Existing profile IDs remain untouched; only their stored section slots gain
 * the canonical v6 bodies during the migration window.
 */
export function adaptRebirthPackageV6SectionsToLegacyKeys(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): Readonly<Record<string, string>> {
  const sections = new Map(renderRebirthPackageV6Sections(model, options).map((entry) => [entry.id, entry.text]));
  return Object.freeze({
    lastUserAiMessages: sections.get('boundaryAndActiveTask') ?? '',
    taskRailContext: sections.get('executionState') ?? '',
    activeEditDelta: sections.get('activeEditDelta') ?? '',
    starredMoments: sections.get('cognitiveArtifacts') ?? '',
    currentThread: sections.get('recentConversation') ?? '',
    atlasCrossRef: sections.get('recoveryIndex') ?? '',
  });
}
