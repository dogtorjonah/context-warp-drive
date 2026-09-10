/**
 * Canonical Rebirth Package v6 model and renderer.
 *
 * This module is deliberately pure: callers freeze every external fact before
 * construction, then every delivery surface renders the same immutable model.
 * It performs no filesystem, Git, Atlas, transcript, or relay-state reads.
 */

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  COMPACT_RECOVERY_PREAMBLE,
  COMPACT_RECOVERY_SUPPRESSED_ROWS,
  compactBoundary,
  continuityAnchor,
  currentTaskHazards,
  extractDeclaredOpenItems,
  historyCensus,
  OPEN_ITEMS_MAX_ITEM_CHARS,
} from './continuityPresentation.ts';

import type {
  ContinuityHazardDescriptor,
  ContinuityLiveFieldSource,
  ContinuityReceipt,
} from './continuityReceipt.ts';
import type { FoldMessage } from './rollingFold.ts';
import {
  COLLAPSE_TIERS,
  COLLAPSE_TIER_NAMES,
  collapseUnits,
  type CollapseResult,
  type CollapseUnit,
  type CollapseUnitKind,
  type CollapseUnitPlacement,
} from './generationalCollapse.ts';
import { redactContinuityModel } from './redactionLane.ts';
import { hotTailIdentity, selectRebirthHotTail, type RebirthHotTailRow } from './rebirthHotTail.ts';

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
  'brainMergeSynthesis',
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

export interface RebirthPackageV6NowCard {
  readonly forkPurpose: (RebirthPackageV6ExactMessage & {
    readonly sourceKind: string;
  }) | null;
  readonly parentIdentity: {
    readonly instanceId: string;
    readonly instanceName: string | null;
    readonly checkpointMessageId: string | null;
    readonly source: RebirthPackageV6SourceRef;
  } | null;
  readonly parentStatus: {
    readonly runtimeStatus: string;
    readonly source: RebirthPackageV6SourceRef;
  } | null;
  readonly currentRail: {
    readonly railId: string;
    readonly state: string;
    readonly activeStepId: string | null;
    readonly activeStepStatus: string | null;
    readonly source: RebirthPackageV6SourceRef;
  } | null;
  /** Additive capture outcome: absent means a legacy package that cannot distinguish none from unknown. */
  readonly currentRailAvailability?: {
    readonly status: 'current' | 'none' | 'unavailable';
    readonly reason: string | null;
    readonly source: RebirthPackageV6SourceRef;
  };
  /**
   * Optional durable lineage chain (plan feature 3, S16): the ordered chain of
   * instance identities from the lineage root to this instance, with each hop's
   * span and archive state. Supplied by the assembler/feeder; rendered as a
   * one-line chain in the Now card when present. Optional so retained v1 models
   * and existing constructors remain valid — absent means no chain was provided.
   */
  readonly lineageChain?: readonly {
    readonly instanceId: string;
    readonly instanceName: string | null;
    /**
     * The display name this identity had at THIS hop's EARLIEST span (audit-2
     * A11). When a current `instanceName` differs (the instance was renamed
     * mid-life over a sustained assignment), the renderer prints `born-as=`
     * beside the current name so a reader is not misled by a stale birth name
     * on an hop that was later renamed.
     */
    readonly bornAs?: string | null;
    readonly sourceAt: string | null;
    readonly sourceEndAt?: string | null;
    /** Null means the captured inputs did not carry an authoritative runtime state. */
    readonly archived: boolean | null;
  }[];
  /**
   * Captured operator-facing process facts. Repository cleanliness remains
   * explicitly unknown until a worker probe supplies it; registry-derived
   * child/squad/room facts are still useful and source-stamped at capture.
   */
  readonly ops?: {
    readonly repositoryState: 'clean' | 'dirty' | 'unknown';
    readonly repositoryReason: string | null;
    /**
     * Optional per-root repository capture (audit-2 A18): each entry names one
     * workspace root's branch, HEAD sha7, dirty/staged counts, and capture
     * time, or an explicit fail-open error. Rendered in place of the legacy
     * single `repositoryState` string when present.
     */
    readonly repositories?: readonly RebirthPackageV6RepositoryState[];
    /**
     * One spawn/parent-owned child instance at capture (audit-2 A2 → audit-3
     * A2 owned-children/v1). A legacy relay-native build feeds one flat
     * `{id,name}` child per legacy delegated row; when the capture supplies the
     * richer status facts, live/hibernated/done counts and teardown-pending
     * derive from them. All fields optional + additive — a `{id,name}` row is
     * still valid and renders byte-identically to a retained legacy package.
     */
    readonly ownedLiveChildren: readonly {
      readonly id: string;
      readonly name: string;
      /** Runtime status at capture. Absent on legacy parentId rows. */
      readonly status?: string | null;
      readonly engine?: string | null;
      readonly model?: string | null;
    }[];
    readonly squad: string | null;
    /**
     * Current room memberships at capture. A coordination row may carry source
     * chronology — the caller's real join time (`sourceTime`) and the snapshot
     * observation stamp (`observedAt`) are distinct (audit-3 A9); assembly may
     * mark a room stale when the snapshot recorded no activity within 24h
     * (`staleSince`, audit-3 B16). All optional: a flat string is a legacy
     * membership name and renders unchanged.
     */
    readonly rooms: readonly (string | RebirthPackageV6RoomMeta)[];
    readonly source: RebirthPackageV6SourceRef;
  };
}

/** Additive per-room metadata for ops.rooms (audit-3 A9/B16). */
export interface RebirthPackageV6RoomMeta {
  readonly name: string;
  readonly id?: string | null;
  /** Authoritative source time of THIS caller's join, when the store knows it. */
  readonly sourceTime?: string | null;
  /** Snapshot-observation stamp (membership read), distinct from sourceTime. */
  readonly observedAt?: string | null;
  /** Set when the room showed no recent activity (>24h) at the snapshot. */
  readonly staleSince?: string | null;
}

export interface RebirthPackageV6RuntimeModelSnapshot {
  readonly engine: string | null;
  readonly model: string | null;
}

/**
 * One repository root's captured git state (audit-2 A18). Feeder-populated from
 * a bounded off-thread probe per workspace root; error entries carry an honest
 * fail-open reason instead of synthesized values.
 */
export interface RebirthPackageV6RepositoryState {
  /** Workspace root display name (e.g. the Atlas workspace name). */
  readonly name: string;
  readonly branch: string | null;
  readonly sha7: string | null;
  readonly dirtyCount: number | null;
  readonly stagedCount: number | null;
  /** Bounded changed-path sample the counts were derived from; absent when clean or unread. */
  readonly dirtyPaths?: readonly string[] | null;
  /** Exact changed-path row count the sample was drawn from (the sample may be shorter). */
  readonly dirtyPathsTotal?: number | null;
  readonly capturedAt: string | null;
  /** Set when the probe failed; branch/sha/counts stay null. */
  readonly error: string | null;
}

/**
 * Optional runtime-model continuity carried into the v6 Boundary. The legacy
 * `── Runtime Model ──` heading block is retired — four framed lines for three
 * tokens of information — but the fact it carried is not: the transition
 * (predecessor → successor, and whether it changed) still renders in BOTH
 * modes, as `runtime-model=… -> … · changed=no` in the diagnostic view and as
 * `Runtime … → …; changed=no` in the delivered one. The assembler supplies
 * this context whenever the legacy package has it.
 * Optional so retained v1 models (and existing constructors that predate this
 * field) remain valid; absent means no runtime-model context was provided.
 */
export interface RebirthPackageV6RuntimeModelContext {
  readonly predecessor: RebirthPackageV6RuntimeModelSnapshot;
  readonly successor: RebirthPackageV6RuntimeModelSnapshot;
  readonly changed: boolean;
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
  readonly runtimeModelContext?: RebirthPackageV6RuntimeModelContext;
  readonly activeRequest: RebirthPackageV6ExactMessage | null;
  readonly activeRequestClaims?: RebirthPackageV6ActiveRequestClaims;
  readonly lastMaterialAssistant: RebirthPackageV6ExactMessage | null;
  /** Additive for persisted packages predating the factual boundary card. */
  readonly nowCard?: RebirthPackageV6NowCard;
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
  /**
   * Optional life/boundary facts (audit-2 A24): the trigger of THIS boundary,
   * the predecessor life identity, whether the predecessor produced material
   * output, and which life carried the last-material-assistant message.
   * Feeder-populated (assembler); absent/null = not supplied at assembly time,
   * rendering nothing rather than an invented value.
   */
  readonly lifeFacts?: {
    /**
     * Audit-3 A12 (boundary-trigger/v1): the trigger of THIS capture's boundary.
     * Populated from the request `boundary {trigger, requestedAt}` when the
     * builder forwarded it — never the newest-LEDGER row's trigger (which is
     * the predecessor, exposed separately as `predecessorBoundary`). Absent
     * (legacy request without the field) renders `boundary-trigger=unknown`,
     * never the ledger's. Audit-2 A24 semantics preserved: the predecessor life
     * identity rides `predecessorLifeId`.
     */
    readonly boundaryTrigger?: string | null;
    /** Audit-2 A24: the durable predecessor life artifact id. */
    readonly predecessorLifeId?: string | null;
    /** Audit-3 A12: the NEWEST-LEDGER-life trigger (the predecessor boundary),
     *  emitted separately from THIS boundary's `boundaryTrigger`. Absent on
     *  legacy models and when no known-time ledger life exists. */
    readonly predecessorBoundary?: string | null;
    readonly predecessorMaterialOutput?: 'yes' | 'no' | null;
    readonly lastMaterialAssistantLifeId?: string | null;
    /**
     * Authoritative source of the newest life artifact these facts derive from
     * (audit-2 freeze): a derived lifecycle claim never renders unstamped.
     */
    readonly source?: RebirthPackageV6SourceRef | null;
  } | null;
  /**
   * Identity of the builder process that produced this delivered package: which
   * build path ran (sidecar inline / sidecar worker pool / relay worker
   * fallback), where it is hosted, and the exact immutable source-tree identity
   * (rebirth-builder-source/v1) the process loaded. Optional for retained
   * models predating the stamp; the sidecar pipeline stamps every delivered
   * package, and the renderer emits an honest `built-by=unknown` line when the
   * field is absent so a package can never silently omit its provenance.
   */
  readonly builder?: {
    readonly path: string;
    readonly endpoint?: string | null;
    readonly treeSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    /**
     * Package-build phase duration (audit-2 A17). Renamed from the ambiguous
     * `builtMs`: only the pre-render package-build phase is knowable at stamp
     * time; prompt-render/context phases finish after the delivered bytes
     * exist and live in the build response timings, never here.
     */
    readonly packageBuildMs?: number | null;
    /** Legacy alias retained so persisted pre-A17 artifacts stay valid. */
    readonly builtMs?: number | null;
    /**
     * Audit-3 B4/C3: repo HEAD of the building process's cwd (sidecar repo root
     * or relay worker root), `git rev-parse --short HEAD` bounded read; `unknown`
     * when the read failed or didn't run. Answers "is the committed code live"
     * from the artifact alone.
     */
    readonly gitSha7?: string | null;
    /**
     * Audit-3 B4/C3: sidecar process boot instant (ISO). Present when a sidecar
     * actually built the package (worker pool or inline); absent on the relay
     * worker fallback / relay main thread. A sidecar booted BEFORE the current
     * repo HEAD commit never mislabels a stale process as fresh.
     */
    readonly sidecarBootedAt?: string | null;
    /**
     * Audit-3 B4/C3: relay process boot instant (ISO), always present — a rebirth
     * originates on the relay, and a relay booted before its own active code was
     * committed is exactly the "audit-2 code isn't live yet" case the artifact
     * must expose.
     */
    readonly relayBootedAt?: string | null;
    /**
     * Audit-3 B5: relay-side request-preparation stage timings (parallel draws +
     * serial repo probe + assembly), additive and optional; rendered as a stage
     * list that reconciles to requestPrep.totalMs with an explicit other=.
     */
    readonly requestPrep?: {
      readonly totalMs: number;
      readonly snapshotMs?: number | null;
      readonly frontierMs?: number | null;
      readonly builderSourceMs?: number | null;
      readonly executionStateMs?: number | null;
      readonly atlasLandedMs?: number | null;
      readonly repoStateMs?: number | null;
      readonly parallelMaxMs?: number | null;
      readonly otherMs?: number | null;
    } | null;
    /** Audit-3 B5: request→capture wall in ms (derived by the relay). */
    readonly requestToCaptureMs?: number | null;
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
    | 'life'
    | 'runtime'
    | 'coordination'
    /**
     * Newest tool operation observed after the last assistant PROSE row: the
     * call a successor must neither silently repeat nor forget. Additive;
     * persisted models predating this kind stay valid.
     */
    | 'pending_operation';
  readonly text: string;
  /**
   * Snapshot-time stamp (audit-2 A21): coordination/membership facts whose row
   * records a membership-snapshot observation time rather than the source row's
   * own event time. Rendered as ` · observed-at=` when present and never used
   * as the fact's chronology.
   */
  readonly observedAt?: string;
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
  /**
   * Blocking graduation gate when this row did NOT graduate to a hunks render
   * (audit-2 A5): `claim-held` | `no-frozen-atlas-row` | `cross-workspace` |
   * `capture-timeout` or a feeder-supplied value. Rendered as ` · gate=` on the
   * file header so a non-graduated edit names its gate instead of looking like
   * an omission. Absent on graduated rows and legacy rows.
   */
  readonly graduationGate?: string | null;
  /**
   * True when an atlas_landed closure graduated while an edit claim was held
   * (audit-2 A5 policy c) — settled bytes are Atlas-recoverable, so the
   * pointer renders `closure=atlas_landed(claim=held)`.
   */
  readonly graduatedUnderHeldClaim?: boolean;
  readonly reason: string | null;
}

export interface RebirthPackageV6ActiveEditDelta {
  readonly captureId: string | null;
  readonly state: RebirthPackageV6EditState;
  readonly capturedSourceAt: string | null;
  readonly completedObservedAt: string | null;
  /**
   * Optional Atlas-landed capture telemetry (audit-2 A5): the frozen
   * atlasLandedEntries capture envelope that graded per-file graduation.
   * Feeder-populated; absent = legacy bytes unchanged.
   */
  readonly atlasLandedCapture?: {
    readonly status: 'complete' | 'timeout' | 'error';
    readonly count: number;
    readonly elapsedMs: number;
  } | null;
  readonly inheritedCaptureIds: readonly string[];
  readonly files: readonly RebirthPackageV6EditFile[];
  readonly omittedFiles: number;
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

export interface RebirthPackageV6CognitiveArtifact {
  readonly provenanceId: string;
  /** Author identity from the source record; missing on legacy rows means unknown. */
  readonly sourceInstanceId?: string | null;
  readonly sourceAt: string | null;
  /** Registryglyph kind. `active_request` is S5 (audit-3 B7): a 🧭 continuity
   *  claim is an observation, never an instruction — so it is never painted as
   *  a `decision`. Additive: persisted v7 models carrying only the pre-S5
   *  kinds stay valid. */
  readonly kind: 'decision' | 'discovery' | 'hazard' | 'question' | 'result' | 'flow' | 'active_request';
  /** S5 (audit-3 B1): how this row earned admission. `lineage-floor` = kept
   *  only by the per-lineage recency floor, not by intrinsic currency — the
   *  renderer may label it kept-by=lineage-floor. `required-overlay` = a
   *  deliberately overlaid requirement. Absent = intrinsically current,
   *  ordinary admission. Additive; persisted rows stay valid. */
  readonly retention?: 'lineage-floor' | 'required-overlay';
  readonly text: string;
  readonly authority: string;
  readonly supersededBy: string | null;
  /**
   * Declared projection state. Present only when the stored artifact body
   * exceeded the per-entry cap and `text` therefore carries a prefix rather
   * than the whole artifact. Absent means `text` IS the complete body — the
   * distinction matters because an undeclared prefix reads as a complete
   * thought that simply ended mid-sentence.
   *
   * Optional so persisted models written before this field remain valid.
   */
  readonly projection?: 'truncated';
  /** Chars carried in `text`. Present only alongside `projection`. */
  readonly storedChars?: number;
  /** UTF-8 bytes carried in `text`. Present only alongside `projection`. */
  readonly storedBytes?: number;
  /** Chars in the source body before projection. Present only alongside `projection`. */
  readonly sourceChars?: number;
  /** UTF-8 bytes in the source body before projection. Present only alongside `projection`. */
  readonly sourceBytes?: number;
}

export interface RebirthPackageV6CognitiveArtifactCapture {
  /** Completeness of the indexed projection, not of the underlying stores. */
  readonly status: 'complete' | 'partial' | 'unavailable';
  /** Capture/ingestion time; never used as artifact chronology. */
  readonly capturedAt: string | null;
  readonly totalMatched: number | null;
  /** Rows retained by the relay selector before v7 adaptation/normalization. */
  readonly selectedCount?: number | null;
  readonly overlayCount: number | null;
  readonly missingFamilies: readonly string[];
  readonly warnings: readonly string[];
  /**
   * Addressable artifacts omitted by the relay selector's character/row cap.
   * They do not re-enter the visible cognition section; they exist so the
   * committed continuity ledger can enumerate every cap eviction by identity.
   * Optional for persisted packages captured before this lane existed.
   */
  readonly droppedByBudget?: readonly RebirthPackageV6CognitiveArtifact[];
  /**
   * Exact selector receipt. duplicate/frontier are upstream rejections and do
   * not participate in totalMatched; every other field reconciles
   * totalMatched→selectedCount.
   */
  readonly relaySuppression?: {
    readonly duplicate: number;
    readonly rootDuplicate: number;
    readonly superseded: number;
    readonly frontier: number;
    readonly crossSection: number;
    readonly unknownSourceTime: number;
    readonly overBudget: number;
    readonly unattributed: number;
  };
}

export interface RebirthPackageV6ConversationRow {
  readonly provenanceId: string;
  readonly sourceAt: string | null;
  readonly role: 'user' | 'assistant' | 'runtime';
  readonly text: string;
  /**
   * Segment coalescing (audit-2 A1): when persistence mints `:segment-N`
   * continuation rows for one streamed message, normalization joins the rows
   * into a single envelope whose `text` is the byte-exact concatenation of the
   * exact deltas in source order. `segmentOffsets` records the character offset
   * of each later segment's seam within `text` so the renderer can surface
   * visible `⟨segment-N⟩` markers without corrupting the attested bytes.
   * Absent on ordinary single-row messages and persisted legacy rows.
   */
  readonly segmentOffsets?: readonly number[];
  /**
   * Audit-3 A5/C6 (exchange grouping): the operator row id of the exchange
   * this row belongs to. The renderer selects/evicts WHOLE exchanges
   * (operator row + its material assistant replies) by this id so an operator
   * floor never survives without its reply (the audit-3 23-hour-hole defect).
   * Additive + optional: legacy rows and pre-exchange captures carry no tag and
   * are grouped by provenance fallback (single-row base), never mis-tagged.
   */
  readonly exchangeId?: string;
  /** Sparse capture did not hydrate the surrounding proposal/reply exchange. */
  readonly exchangeRecovery?: string;
}

export interface RebirthPackageV6RecoveryHandle {
  readonly id: string;
  readonly label: string;
  /** Exact tool command or durable URI. */
  readonly handle: string;
  /** What the route returns; absent legacy declarations are classified conservatively. */
  readonly recoveryScope?: 'exact-full' | 'exact-omitted-subset' | 'discovery';
  readonly status: 'available' | 'partial' | 'unavailable' | 'not-requested';
  readonly count: number | null;
  readonly frontier: string | null;
  /**
   * Optional explicit reason for a non-available status (unavailable, partial,
   * or not-requested). Rendered as `reason=` on the recovery line. Carries the
   * why of the status so a lane marked unavailable/not-requested is never a
   * silent black box. Optional so retained v1 models (entries without a reason)
   * remain valid.
   */
  readonly reason?: string;
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
  readonly rawHotTail?: readonly RebirthHotTailRow[];
  readonly version: RebirthPackageVersion;
  readonly boundaryAndActiveTask: RebirthPackageV6BoundaryAndActiveTask;
  /**
   * Merge-moment donor identity and cognition capsule. Optional so persisted
   * v6/v7 packages produced before this field remain valid; mandatory at the
   * execution boundary whenever lifecycle=brain_merge.
   */
  readonly brainMergeSynthesis?: string;
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
  readonly rawHotTail?: readonly RebirthHotTailRow[];
  readonly boundaryAndActiveTask: RebirthPackageV6BoundaryAndActiveTask;
  readonly brainMergeSynthesis?: string;
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

export interface RebirthPackageV6ActiveEditCaptureDisposition {
  readonly status: 'not-requested' | 'attempted-failed';
  readonly reason: string;
}

/**
 * Newest tool operation observed after the last assistant PROSE row. Rendered
 * as a `pending_operation` Execution State fact so an interrupted call is
 * neither silently repeated nor mistaken for the agent's last words.
 */
export interface RebirthPackageV6PendingOperation {
  /** Bounded operation text (compact `⟨tool …⟩` trace or a structured call summary). */
  readonly text: string;
  /**
   * `in-flight` = no result observed after the call; `result-received` = the
   * result arrived but no assistant prose interpreted it before the boundary.
   */
  readonly status: 'in-flight' | 'result-received';
  /** Exact persisted identity of the source row; absent/null yields a partial derived id. */
  readonly sourceId?: string | null;
  /** Authoritative source time of the source row; absent/null stays unknown. */
  readonly sourceAt?: string | null;
}

export interface AdaptLegacyRebirthPackageV6Options {
  readonly predecessorName?: string;
  readonly instanceId?: string;
  readonly instanceName?: string;
  readonly workspace?: string;
  readonly cwd?: string;
  /**
   * Structured newest assistant PROSE row (never a compact tool trace) with
   * its exact source identity/time. When supplied it outranks the legacy
   * `🤖 LAST AI MESSAGE` prose extraction and the pending assistant-action
   * text, which remains an Execution State fact of its own.
   */
  readonly lastMaterialAssistant?: RebirthPackageV6ExactMessage;
  /** Newest tool operation after the last assistant prose row. */
  readonly pendingOperation?: RebirthPackageV6PendingOperation;
  /** Capture receipt for caller-derived cognition (e.g. trace-only derivation). */
  readonly cognitiveArtifactCapture?: RebirthPackageV6CognitiveArtifactCapture;
  readonly activeEditDelta?: RebirthPackageV6ActiveEditDelta;
  /** Explicit truth for an absent immutable Active Edit capture. */
  readonly activeEditCaptureDisposition?: RebirthPackageV6ActiveEditCaptureDisposition;
  readonly cognitiveArtifacts?: readonly RebirthPackageV6CognitiveArtifact[];
  readonly recentConversation?: readonly RebirthPackageV6ConversationRow[];
  readonly operatorVault?: RebirthPackageV7LineageSection;
  readonly episodeChapterIndex?: RebirthPackageV7LineageSection;
  readonly lifeLedger?: RebirthPackageV7LineageSection;
  readonly recoveryIndex?: readonly RebirthPackageV6RecoveryHandle[];
}

export interface RenderRebirthPackageV6Options {
  /** Explicit audit view; delivery defaults to compact agent presentation. */
  readonly diagnostic?: boolean;
  /**
   * Soft total-package target (protected relay envelope included). When the
   * first render is larger, collapse-citizen sections are re-rendered at
   * reduced caps before the hard package ceiling is allowed to elide a whole
   * section. Defaults to `packageBudget`, preserving the lifecycle-specific
   * production ceiling while giving callers a lower push target when desired.
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
  /**
   * Measure cumulative CPU wall time for each canonical section across every
   * render pass (adaptive backfill, shrink probes, and final admission).
   * Disabled by default so preview/golden callers retain the prior zero-cost
   * pure render path.
   */
  readonly measureSectionTimings?: boolean;
  /** Deterministic test seam; production uses the monotonic performance clock. */
  readonly sectionTimingClock?: () => number;
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
  /** Exact source-unit disposition for non-collapse omission citizens. */
  readonly unitPlacements?: readonly RebirthPackageV6UnitPlacement[];
  /** Typed display rows; ledger ownership remains on the original section. */
  readonly timelineRows?: readonly RebirthTimelineRow[];
  readonly timelineSummary?: string;
  /**
   * Structured omission accounting for the unified timeline. The prose
   * `timelineSummary` stays for diagnostic renders; the agent-facing package
   * derives ONE census line from these numbers instead of re-parsing prose.
   */
  readonly timelineCensus?: RebirthTimelineCensus;
}

/**
 * One ledger command for the whole capture instead of one per section. The
 * section filter is the only difference between the per-section handles, so
 * dropping it yields a command that addresses every omitted unit at once —
 * the agent reads one route, not nine near-identical ones.
 */
function captureScopedLedgerCommand(handle: string | null): string | null {
  if (!handle) return null;
  const stripped = handle.replace(/\s*section_id="[^"]*"/u, '').replace(/\s{2,}/gu, ' ').trim();
  return stripped.length > 0 ? stripped : null;
}

/**
 * The timeline's one executable route back to what it did not render whole.
 *
 * God Rule 9: a census that declares omitted units without naming a recovery
 * command is negative evidence dressed as accounting. The ledger addresses
 * omitted rows by owner + capture id, so the command is derivable whenever
 * those two identities are known — it does not additionally depend on the
 * assembler having supplied a `continuity-ledger` directory row.
 */
function captureScopedOmissionCommand(model: RebirthPackageV6Model): string | null {
  const owner = model.boundaryAndActiveTask.instanceId?.trim();
  const captureId = model.boundaryAndActiveTask.captureId?.trim();
  if (!owner || owner === 'unknown' || !captureId || captureId === 'unknown') return null;
  return `continuity_ledger action="fetch" owner=${JSON.stringify(owner)}`
    + ` capture_id=${JSON.stringify(captureId)}`
    + ' omitted_only=true include_unknown_source_time=true limit=200';
}

/** Ledger-parity accounting for one timeline contributor section. */
interface RebirthTimelineCensus {
  readonly captured: number;
  readonly rendered: number;
  readonly matched: number | null;
  /** suppressed-whole + rendered-truncated; equals the ledger's omitted rows. */
  readonly incomplete: number;
  /** Capture-scoped ledger command, section filter stripped. Null when nothing was omitted. */
  readonly omissionCommand: string | null;
}

interface RebirthTimelineRow {
  readonly id: string;
  readonly sourceAt: string | null;
  readonly text: string;
  readonly compactText?: string;
}

export interface RebirthPackageV6UnitPlacement {
  readonly id: string;
  readonly placement: 'rendered' | 'elided';
  /** The rendered unit is a declared prefix of a longer source body. */
  readonly projected: boolean;
}

const SECTION_TITLES: Readonly<Record<RebirthPackageV6SectionId, string>> = Object.freeze({
  boundaryAndActiveTask: 'Boundary and Active Task',
  brainMergeSynthesis: '🧠 Brain Merge — Synthesis Mandate',
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
 * Ordinary content: boundary 5k, timeline 105k, execution/edits 15k,
 * recovery 10k, reserve 10k. Framing has a separate 5k allowance.
 * The reserve belongs to dialogue unless merge synthesis is present.
 * Every timeline citizen holds a budget (operator directive 2026-09-09):
 * distinct cognition — units no dialogue row owns — reserves up to
 * COGNITIVE_TIMELINE_FLOOR_CHARS, and only as much of it as it can actually
 * fill; dialogue draws the rest of the pool first and inherits whatever
 * cognition leaves. A cognitive artifact that IS a dialogue row (a register
 * glyph harvested from a pane message) is dialogue-owned: it is never budgeted,
 * rendered, or counted a second time (dialogueUnitKey).
 * These are phase ceilings, not scarcity weights that backfill can override.
 */
export const DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS: Readonly<
  Record<RebirthPackageV6SectionId, number>
> = Object.freeze({
  boundaryAndActiveTask: 5_000,
  brainMergeSynthesis: 10_000,
  executionState: 3_000,
  activeEditDelta: 12_000,
  cognitiveArtifacts: 0,
  recentConversation: 115_000,
  operatorVault: 0,
  episodeChapterIndex: 0,
  lifeLedger: 0,
  recoveryIndex: 10_000,
});

export const DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS = 200_000;

/**
 * The most the timeline pool reserves for distinct cognition ahead of dialogue.
 * Protect 50k for distinct cognition alongside 65k for dialogue in the active
 * 115k pool. Idle execution frees another 14k for dialogue. The reserve is
 * demand-bound: cognition takes only what it fills, never padding.
 */
export const COGNITIVE_TIMELINE_FLOOR_CHARS = 50_000;

/** Phase ceilings derive from captured rail facts; unknown is not idle. */
export type RebirthPackageExecutionPhase = 'rail-active' | 'rail-complete' | 'no-rail';

/** W1-ratified rail-complete / no-rail partition (plan §3 Q4). */
export const RAIL_COMPLETE_SECTION_OVERRIDES: Readonly<
  Partial<Record<RebirthPackageV6SectionId, number>>
> = Object.freeze({
  executionState: 500,
  activeEditDelta: 500,
  recentConversation: 129_000,
});

/** W1-ratified rail-complete / no-rail backfill priority (recovery/execution first). */
export const RAIL_COMPLETE_BACKFILL_PRIORITY: readonly RebirthPackageV6SectionId[] = [
  'recoveryIndex',
  'executionState',
  'operatorVault',
  'recentConversation',
  'cognitiveArtifacts',
  'lifeLedger',
  'episodeChapterIndex',
  'activeEditDelta',
] as const;

/**
 * Derive the current execution phase from the model's already-captured rail
 * facts (audit-3 C1). No new capture: a present currentRail with a terminal
 * `complete` state is rail-complete; a present/unknown-state rail is
 * rail-active; an absent rail (currentRailAvailability none/unavailable or no
 * currentRail card) is no-rail.
 */
export function deriveRebirthExecutionPhase(
  model: Pick<RebirthPackageV6Model, 'boundaryAndActiveTask'>,
): RebirthPackageExecutionPhase {
  const now = model.boundaryAndActiveTask.nowCard;
  const currentRail = now?.currentRail;
  const availability = now?.currentRailAvailability;
  if (!currentRail || !currentRail.state) {
    // currentRail card missing entirely.
    if (availability?.status === 'none' || availability?.status === 'unavailable') return 'no-rail';
    return 'rail-active';
  }
  const state = currentRail.state;
  if (state === 'complete' || state === 'review-closed' || state === 'all-resolved') return 'rail-complete';
  if (state === 'none') return 'no-rail';
  return 'rail-active';
}

/**
 * Overrides for a phase. rail-active returns an empty record (the generic
 * defaults already serve it); rail-complete and no-rail share the ratified
 * rail-complete partition.
 */
export function sectionOverridesForPhase(
  phase: RebirthPackageExecutionPhase,
): Readonly<Partial<Record<RebirthPackageV6SectionId, number>>> {
  return phase === 'rail-active' ? Object.freeze({}) : RAIL_COMPLETE_SECTION_OVERRIDES;
}

/** Machine-readable backfill order for the resolved phase. */
export function backfillPriorityForPhase(
  phase: RebirthPackageExecutionPhase,
): readonly RebirthPackageV6SectionId[] {
  return phase === 'rail-active'
    ? REBIRTH_PACKAGE_V7_BACKFILL_PRIORITY
    : RAIL_COMPLETE_BACKFILL_PRIORITY;
}

/**
 * Brain Merge alone receives a larger water-fill envelope because its merge-
 * moment donor synthesis is one-time continuity that later rebirths cannot
 * reconstruct. Ordinary rebirths retain the 150k default above, and an
 * explicit caller-supplied packageBudget remains authoritative for either
 * lifecycle.
 */
export const DEFAULT_BRAIN_MERGE_REBIRTH_PACKAGE_BUDGET_CHARS = 300_000;

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
 * B7 life-ledger recency floor: the newest 5 lives never demote below the t1
 * (digest) tier, so the OLDEST lives absorb floor pressure first and the reader
 * always sees the current lineage head per-row.
 */
export const LIFE_LEDGER_RECENCY_FLOOR_K = 5;

/**
 * Audit-2 A14: the Episode Chapter Index gets the same newest-K recency floor
 * as the life ledger — the newest 5 episodes never demote below digest, so the
 * current lineage head always stays per-row even when the partition is small.
 */
export const EPISODE_CHAPTER_RECENCY_FLOOR_K = 5;

/**
 * Adaptive Backfill priority (spec §7.1). Unspent budget flows left to right;
 * hard-pressure degradation (§8) returns it right to left.
 *
 * Dynamic fill (operator directive 2026-08-26): EVERY section is eligible —
 * a static default may never leave envelope room unused. The first five keep
 * their historical order, so scarcity behavior is unchanged; the appended tail
 * drinks only after them, ordered by how badly its loss hurts a successor:
 * Active Edit Delta (re-derivable from Atlas, but the common operator-visible
 * clip), then the Recovery Index (cheap, non-re-derivable in-context handles),
 * then the protected trio whose defaults rarely bind. Sections with explicit
 * caller caps and sections whose supply is exhausted (`complete`) never grow.
 */
export const REBIRTH_PACKAGE_V7_BACKFILL_PRIORITY = [
  'operatorVault',
  'cognitiveArtifacts',
  'recentConversation',
  'episodeChapterIndex',
  'lifeLedger',
  'activeEditDelta',
  'boundaryAndActiveTask',
  'brainMergeSynthesis',
  'executionState',
  'recoveryIndex',
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

/**
 * Deterministic content identity for a row that carries no persisted source
 * id (FNV-1a over the caller's disambiguated text). Shared with the raw seed's
 * trace-derived rows so both producers mint the same identity family.
 */
export function stableTextIdentity(prefix: string, value: string): string {
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

/**
 * Per-entry SCARCITY cap for a single cognitive artifact body.
 *
 * The section budget alone cannot protect the section under contention: one
 * pathological row (a pasted capsule, a long `#artifact` post) can consume the
 * whole allowance and starve dozens of small, high-value rows. Under pressure,
 * capping each ENTRY makes the section's capacity a count of thoughts rather
 * than a race won by whoever wrote the longest one.
 *
 * Dynamic fill (operator directive 2026-08-26): this cap is a scarcity floor
 * and the continuity ledger's storage economy, NOT a render mandate. While the
 * envelope has room, `renderCognition` ships full bodies untouched by this
 * cap; it binds only in the contended fallback and in the ledger's stored
 * projection of each row.
 */
export const REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS = 600;

/**
 * Audit-3 C7: per-entry SCARCITY cap by AGE TIER, layered on the audit-2 A22
 * KIND gate. High-value rows (result/hazard/decision) carry the age-tired
 * ladder — current life 900, previous 500, older 300 — with life boundaries
 * from the life ledger (or the 24h age-window fallback). Other kinds
 * (flow/discovery/question/...) keep the fixed 600 base cap: they could carry
 * a huge ad-hoc body, so they never get an unbounded recent window, and an old
 * small thought does not deserve shrinking below the ordinary body budget.
 * Reference geometry is the model's own `capturedAt` plus the life ledger's
 * known life-start instants (never the wall clock), so render and
 * ledger-capture projections stay byte-identical (deterministic).
 */
export const REBIRTH_PACKAGE_V6_COGNITION_RECENT_KIND_MAX_CHARS = 900;
const COGNITION_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Audit-3 C7: previous-life per-row cap (rows in the life before the current one). */
const COGNITION_PREVIOUS_LIFE_MAX_CHARS = 500;
/** Audit-3 C7: older-than-previous-life per-row cap. */
const COGNITION_OLDER_LIFE_MAX_CHARS = 300;

/**
 * Newest-first known life-start instants from the model's life ledger
 * (audit-3 C7). Known source times only (God Rule 8); a ledger without
 * datable life units yields no boundaries and the age-window fallback binds.
 */
function cognitiveLifeBoundaryStarts(
  model: Pick<RebirthPackageV6Model, 'lifeLedger'>,
): readonly string[] {
  return (model.lifeLedger?.units ?? [])
    .filter((unit) => unit.kind === 'life')
    .map((unit) => knownSourceTime(unit.sourceAt))
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left));
}

function cognitiveEntryCapChars(
  row: Pick<RebirthPackageV6CognitiveArtifact, 'kind' | 'sourceAt'>,
  referenceAt: string | null,
  lifeBoundaryStarts: readonly string[] = [],
): number {
  // Audit-2 A22 kind gate: only flagship register kinds (result/hazard/decision)
  // qualify for an age-elevated cap; other rows (flow/discovery/question/...)
  // stay at the fixed 600 base regardless of age so a non-flagship ad-hoc body
  // never gets an unbounded window. Audit-3 C7 makes the flagship tier AGE
  // dependent (current-life 900, previous 500, older 300) instead of the old
  // flat kind+24h rule.
  if (row.kind !== 'result' && row.kind !== 'hazard' && row.kind !== 'decision') {
    return REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS;
  }
  if (row.sourceAt && referenceAt) {
    const rowMs = Date.parse(row.sourceAt);
    const referenceMs = Date.parse(referenceAt);
    if (Number.isFinite(rowMs) && Number.isFinite(referenceMs)) {
      if (lifeBoundaryStarts.length > 0) {
        // Life tiers (audit-3 C7): count the newest-first life starts that are
        // NEWER than the row — 0 = current life, 1 = previous life, ≥2 = older.
        // The scan stops at the first life start at/before the row.
        let newerLives = 0;
        for (const start of lifeBoundaryStarts) {
          if (Date.parse(start) > rowMs) newerLives += 1;
          else break;
        }
        if (newerLives === 0) return REBIRTH_PACKAGE_V6_COGNITION_RECENT_KIND_MAX_CHARS;
        if (newerLives === 1) return COGNITION_PREVIOUS_LIFE_MAX_CHARS;
        return COGNITION_OLDER_LIFE_MAX_CHARS;
      }
      // No life ledger: fixed age-window fallback (24h current-life proxy,
      // 24-48h previous-life proxy, older 300) keeps the rule deterministic
      // for models that predate the lineage sections.
      const ageMs = referenceMs - rowMs;
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < COGNITION_RECENT_WINDOW_MS) {
        return REBIRTH_PACKAGE_V6_COGNITION_RECENT_KIND_MAX_CHARS;
      }
      if (Number.isFinite(ageMs) && ageMs >= COGNITION_RECENT_WINDOW_MS
        && ageMs < 2 * COGNITION_RECENT_WINDOW_MS) {
        return COGNITION_PREVIOUS_LIFE_MAX_CHARS;
      }
      return COGNITION_OLDER_LIFE_MAX_CHARS;
    }
  }
  // Undatable flagship rows (unknown source time) never claim an age tier; they
  // keep the ordinary flagship scarcity cap and quarantine under the
  // unknown-time banner.
  return REBIRTH_PACKAGE_V6_COGNITION_RECENT_KIND_MAX_CHARS;
}

/**
 * Apply the per-entry cap as a DECLARED projection.
 *
 * Dynamic fill (operator directive 2026-08-26): this no longer runs at
 * normalize time — the model carries FULL bodies so the render can ship them
 * whole while the envelope has room. The same pure, idempotent function now
 * runs at exactly two places: the contended render fallback (per-entry
 * fairness under pressure) and the continuity-ledger capture (storage
 * economy). Because both call the SAME function on the SAME row, a contended
 * render and its capture still produce identical bytes by construction — the
 * original reason this projection once lived at normalize time. A
 * full-fidelity render ships a body whose stored ledger copy is a byte-exact
 * declared PREFIX of it, so no sha256 ever attests bytes that are not a
 * declared projection or the entirety of real source bytes.
 *
 * `text` stays a byte-exact PREFIX of the source body — no ellipsis, no
 * summary — so a successor can recover the full artifact through its handle
 * and confirm the shipped prefix matches it exactly. The truncation is
 * declared in the rendered envelope, never inside the body.
 *
 * Idempotent: a row that already declares a projection is returned untouched,
 * so re-projecting a persisted model cannot truncate twice or lose the
 * original `sourceChars`.
 */
function projectCognitiveRow(
  row: RebirthPackageV6CognitiveArtifact,
  referenceAt: string | null,
  lifeBoundaryStarts: readonly string[] = [],
): RebirthPackageV6CognitiveArtifact {
  if (row.projection === 'truncated') return row;
  const cap = cognitiveEntryCapChars(row, referenceAt, lifeBoundaryStarts);
  const sourceChars = row.text.length;
  if (sourceChars <= cap) return row;
  // Audit-3 C7: cut at the last word boundary at/before the cap so a projected
  // row never ends mid-token. The retained prefix stays a byte-exact prefix of
  // the source body (no ellipsis inside the stored bytes), preserving sha256
  // attestation semantics; the projection receipt declares the truncation.
  const projected = cutAtWordBoundary(row.text, cap).replace(/\s+$/u, '');
  return {
    ...row,
    text: projected,
    projection: 'truncated',
    storedChars: projected.length,
    storedBytes: Buffer.byteLength(projected, 'utf8'),
    sourceChars,
    sourceBytes: Buffer.byteLength(row.text, 'utf8'),
  };
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
  // Audit-2 A22: near-duplicate collapse. Rows sharing kind + authority whose
  // normalized text opens with the same long bounded prefix are the same
  // thought re-emitted (e.g. a co-executor approval fan-out differing only in
  // a trailing rail id); keep the NEWEST known-time row of each head. The 80
  // normalized chars and kind+authority equality keep the rule conservative —
  // a genuine artifact that merely shares an opener with another row of a
  // different kind or authority is never suppressed.
  const headSeen = new Set<string>();
  const nearDeduped: RebirthPackageV6CognitiveArtifact[] = [];
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    const row = retained[index]!;
    const head = `${row.kind}\0${row.authority}\0${row.text.replace(/\s+/gu, ' ').trim().slice(0, 80)}`;
    if (headSeen.has(head)) continue;
    headSeen.add(head);
    nearDeduped.push(row);
  }
  nearDeduped.reverse();
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
  for (let index = 0; index < nearDeduped.length; index += 1) {
    const row = nearDeduped[index];
    if (row.kind !== 'flow' || !row.sourceAt) continue;
    newestKnownFlowIndex = index;
  }
  if (newestKnownFlowIndex < 0) return nearDeduped;
  // Keep exactly one live flow (the newest known-time one) plus every
  // unknown-time flow row (so renderCognition quarantines each under the
  // "not part of the chronology" banner); an older known-time flow drops.
  return nearDeduped
    .filter((row, index) => (
      row.kind !== 'flow' || index === newestKnownFlowIndex || !row.sourceAt
    ));
}

/**
 * Conversation segment coalescing (audit-2 A1).
 *
 * Persistence mints `id:segment-N` continuation rows when a streaming message
 * is interrupted by a tool boundary (`segmentTextForCumulativePatch` stores
 * the exact delta of each continuation). Rendering every fragment under its
 * own envelope spent a full provenance header per fragment AND let endpoint
 * selection pick a fragment (the last-material-assistant opened mid-token in
 * the audited package). All rows of one message coalesce into a single
 * envelope whose text is the byte-exact delta join and whose `segmentOffsets`
 * record the seams so the renderer can surface visible `⟨segment-N⟩` markers
 * without corrupting the attested bytes.
 */
export const CONVERSATION_SEGMENT_SUFFIX = /:segment-\d+$/u;

/** Stable message identity for a conversation row: the id minus any segment suffix. */
export function conversationRowBaseId(provenanceId: string): string {
  return provenanceId.replace(CONVERSATION_SEGMENT_SUFFIX, '');
}

/**
 * One unit, one owner. A register glyph harvested from a pane message and the
 * dialogue row for that same message are the SAME unit: cognition stores it as
 * `message:<id>`, dialogue as `<id>` (optionally `:segment-N`). This is the
 * single identity both timeline citizens compare on, so the dialogue owns the
 * unit and cognition never budgets, renders, or counts it a second time.
 */
export function dialogueUnitKey(id: string): string {
  return conversationRowBaseId(id.replace(/^message:/u, ''));
}

/** Segment ordinal of a row: 0 = the base row, N for `:segment-N`. */
function conversationSegmentOrdinal(provenanceId: string): number {
  const match = provenanceId.match(/:segment-(\d+)$/u);
  return match ? Number.parseInt(match[1]!, 10) : 0;
}

/**
 * Pure group-and-join over rows sharing one message identity. Rows that share
 * a base provenance id, role, AND source time are one streamed message's
 * fragments (persistence mints `:segment-N` continuation rows under the same
 * source time for one message), so they fuse into a single envelope. The
 * fusion is ORDER-ROBUST: fragments are grouped by identity and joined by
 * NUMERIC segment ordinal (base = 0, then 1..N) regardless of the order the
 * caller presents them in. That independence is load-bearing — a lexicographic
 * provenance sort orders `:segment-10` before `:segment-2`, so a single-pass
 * adjacent merge would transpose multi-digit fragments (audit-2 scramble
 * DECISIVE 1); grouping by identity and sorting by numeric ordinal keeps the
 * joined text base,1..N under any caller ordering. Rows of the same base id
 * but a different source time are NOT fused (a genuinely separate later
 * message), and a row of different role or time keeps its own envelope. A
 * group of one passes through unchanged (a lone `:segment-N` row keeps its own
 * provenance shape). A replayed fragment with the same identity, ordinal, and
 * time is deduplicated (first occurrence wins) so it cannot double-count. The
 * coalesced text is the exact concatenation of member deltas in ordinal order;
 * `segmentOffsets` records the seams so the renderer can surface visible
 * `⟨segment-N⟩` markers without corrupting the attested bytes. Exported as the
 * typed helper contract for assembler endpoint selection (Lane B): endpoint
 * keys dedupe on `conversationRowBaseId`, never on a fragment.
 */
export function coalesceConversationSegments(
  rows: readonly RebirthPackageV6ConversationRow[],
): RebirthPackageV6ConversationRow[] {
  interface FragmentGroup {
    entries: Map<number, RebirthPackageV6ConversationRow>;
  }
  const groups = new Map<string, FragmentGroup>();
  const order: string[] = [];
  for (const row of rows) {
    const baseId = conversationRowBaseId(row.provenanceId);
    const key = `${baseId}\u0000${row.role}\u0000${row.sourceAt ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { entries: new Map() };
      groups.set(key, group);
      order.push(key);
    }
    const ordinal = conversationSegmentOrdinal(row.provenanceId);
    // A replayed fragment with the same identity + ordinal + time would
    // otherwise double-count; the first occurrence in source order wins.
    if (!group.entries.has(ordinal)) group.entries.set(ordinal, row);
  }
  const out: RebirthPackageV6ConversationRow[] = [];
  for (const key of order) {
    const entries = groups.get(key)!.entries;
    if (entries.size === 1) {
      // A group of one passes through unchanged.
      out.push(entries.values().next().value!);
      continue;
    }
    const byOrdinal = [...entries.entries()].sort((left, right) => left[0] - right[0]);
    const first = byOrdinal[0]![1];
    const baseId = conversationRowBaseId(first.provenanceId);
    const offsets = first.segmentOffsets ? [...first.segmentOffsets] : [];
    let text = first.text;
    for (let index = 1; index < byOrdinal.length; index += 1) {
      // The seam offset is the joined-text length BEFORE this fragment appends,
      // so the renderer can surface `⟨segment-N⟩` collocation markers without
      // corrupting the attested bytes.
      offsets.push(text.length);
      text += byOrdinal[index]![1].text;
    }
    out.push({ ...first, provenanceId: baseId, text, segmentOffsets: offsets });
  }
  return out;
}

function normalizeConversationRows(
  rows: readonly RebirthPackageV6ConversationRow[],
  activeRequest: string | null,
  lastAssistant: string | null,
): RebirthPackageV6ConversationRow[] {
  const excluded = new Set([activeRequest, lastAssistant].filter((value): value is string => Boolean(value)));
  // Coalesce FIRST (audit-2 A1): promoted endpoints are whole messages, so
  // exclusion must compare coalesced text — comparing fragments would let a
  // coalesced message render twice (once in Boundary, once in Conversation).
  const coalesced = coalesceConversationSegments([...rows].sort(compareSourceRows));
  const seen = new Set<string>();
  const normalized = coalesced
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
    .filter((row) => {
      const identity = `${row.provenanceId}\0${row.text}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  return normalized;
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
    ...(input.rawHotTail ? { rawHotTail: input.rawHotTail.map((row) => ({ ...row })) } : {}),
    version: REBIRTH_PACKAGE_V7_VERSION,
    boundaryAndActiveTask: input.boundaryAndActiveTask,
    ...(nonEmpty(input.brainMergeSynthesis)
      ? { brainMergeSynthesis: input.brainMergeSynthesis!.trim() }
      : {}),
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
        ...(input.cognitiveArtifactCapture.relaySuppression
          ? { relaySuppression: { ...input.cognitiveArtifactCapture.relaySuppression } }
          : {}),
        missingFamilies: [...input.cognitiveArtifactCapture.missingFamilies],
        warnings: [...input.cognitiveArtifactCapture.warnings],
        ...(input.cognitiveArtifactCapture.droppedByBudget ? {
          droppedByBudget: input.cognitiveArtifactCapture.droppedByBudget
            .filter((row, index, rows) => (
              row.text.trim()
              && rows.findIndex((candidate) => candidate.provenanceId === row.provenanceId) === index
            ))
            .map((row) => ({ ...row })),
        } : {}),
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
    && (candidate.brainMergeSynthesis === undefined
      || typeof candidate.brainMergeSynthesis === 'string')
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
        && (candidate.cognitiveArtifactCapture.selectedCount === undefined
          || candidate.cognitiveArtifactCapture.selectedCount === null
          || (Number.isSafeInteger(candidate.cognitiveArtifactCapture.selectedCount)
            && candidate.cognitiveArtifactCapture.selectedCount >= 0))
        && (candidate.cognitiveArtifactCapture.overlayCount === null
          || (Number.isSafeInteger(candidate.cognitiveArtifactCapture.overlayCount)
            && candidate.cognitiveArtifactCapture.overlayCount >= 0))
        && Array.isArray(candidate.cognitiveArtifactCapture.missingFamilies)
        && candidate.cognitiveArtifactCapture.missingFamilies.every((family) => typeof family === 'string')
        && Array.isArray(candidate.cognitiveArtifactCapture.warnings)
        && candidate.cognitiveArtifactCapture.warnings.every((warning) => typeof warning === 'string')
        && (candidate.cognitiveArtifactCapture.droppedByBudget === undefined
          || (Array.isArray(candidate.cognitiveArtifactCapture.droppedByBudget)
            && candidate.cognitiveArtifactCapture.droppedByBudget.every((row) => (
              Boolean(row)
              && typeof row === 'object'
              && typeof row.provenanceId === 'string'
              && (row.sourceAt === null || typeof row.sourceAt === 'string')
              && ['decision', 'discovery', 'hazard', 'question', 'result', 'flow', 'active_request'].includes(row.kind)
              && typeof row.text === 'string'
              && typeof row.authority === 'string'
              && (row.supersededBy === null || typeof row.supersededBy === 'string')
            ))))
        && (candidate.cognitiveArtifactCapture.relaySuppression === undefined
          || (typeof candidate.cognitiveArtifactCapture.relaySuppression === 'object'
            && candidate.cognitiveArtifactCapture.relaySuppression !== null
            && [
              candidate.cognitiveArtifactCapture.relaySuppression.duplicate,
              candidate.cognitiveArtifactCapture.relaySuppression.rootDuplicate,
              candidate.cognitiveArtifactCapture.relaySuppression.superseded,
              candidate.cognitiveArtifactCapture.relaySuppression.frontier,
              candidate.cognitiveArtifactCapture.relaySuppression.crossSection,
              candidate.cognitiveArtifactCapture.relaySuppression.unknownSourceTime,
              candidate.cognitiveArtifactCapture.relaySuppression.overBudget,
              candidate.cognitiveArtifactCapture.relaySuppression.unattributed,
            ].every((count) => Number.isSafeInteger(count) && count >= 0)))))
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
    // A `⏸ INTERRUPTED/TRAILING OPERATION` block is tool activity, never
    // assistant prose: stop there so the boundary carries speech only.
    if (/^\s*(?:👤|🤖|⚠️|⏸)\s/u.test(lines[index])) break;
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
    // S5 (audit-3 B7): a 🧭 register claim is a continuity observation — map it
    // to `active_request`, never to the old `decision` fall-through below.
    const kind: RebirthPackageV6CognitiveArtifact['kind'] = trimmed.includes('🧭')
      ? 'active_request'
      : trimmed.includes('⚠')
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

function latestRecoveryRowFrontier(
  rows: readonly { readonly provenanceId: string; readonly sourceAt: string | null }[],
): string | null {
  const latest = rows
    .flatMap((row) => {
      const sourceAt = knownSourceTime(row.sourceAt);
      return sourceAt ? [{ provenanceId: row.provenanceId, sourceAt }] : [];
    })
    .sort((left, right) => (
      left.sourceAt.localeCompare(right.sourceAt)
      || left.provenanceId.localeCompare(right.provenanceId)
    ))
    .at(-1);
  return latest ? `${latest.provenanceId}@${latest.sourceAt}` : null;
}

function nonNegativeRecoveryCount(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : null;
}

function defaultRecoveryHandles(args: {
  instanceId: string;
  instanceName: string;
  workspace: string;
  captureId: string;
  sourceFrontier: string | null;
  editCaptureId: string | null;
  transcriptCount: number | null;
  currentPovCount: number | null;
  cognitionCount: number;
  cognitionFrontier: string | null;
  taskRailCount: number | null;
  taskRailFrontier: string | null;
  editCaptureCount: number | null;
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
      count: args.transcriptCount,
      frontier: args.sourceFrontier,
    },
    {
      id: 'current-continuity-pov',
      label: 'current continuity summary (not the complete transcript, episode, or vault stores)',
      handle: hasIdentity
        ? `tap_instance_messages action="summary" target_instance_id=${quotedId}`
        : '',
      status: hasIdentity ? 'partial' : 'unavailable',
      count: args.currentPovCount,
      frontier: args.sourceFrontier,
      reason: hasIdentity
        ? 'summary-only; exact rebirth artifacts and raw chronology are separately indexed'
        : 'stable instance identity unavailable',
    },
    {
      id: 'context-warp-stores',
      label: 'Context Warp episodes/bands (ambient recall; re-derived from the raw transcript); User Message Vault source rows use transcript recovery',
      handle: hasIdentity ? `tap_instance_messages action="recent" target_instance_id=${quotedId}` : '',
      status: hasIdentity ? 'partial' : 'unavailable',
      count: null,
      frontier: args.sourceFrontier,
      // Audit-2 A15: explicit truthful reason describing the re-derivation
      // contract (no invented frontier or omission phrase).
      reason: hasIdentity
        ? 'summary-only; re-derived from the raw transcript; exact rebirth artifacts are separately indexed'
        : undefined,
    },
    {
      id: 'cognition',
      label: 'chronological cognitive artifact rolodex',
      handle: hasIdentity
        ? `psychic_pov view="rolodex" instance=${quotedId}`
        : '',
      status: hasIdentity ? 'available' : 'unavailable',
      count: args.cognitionCount,
      frontier: args.cognitionFrontier,
    },
    {
      id: 'task-rail',
      label: 'current task rail and execution receipts',
      handle: hasIdentity
        ? `task_rail mode="load" operation="detail" instance_id=${quotedId}`
        : '',
      status: hasIdentity ? 'available' : 'unavailable',
      count: args.taskRailCount,
      frontier: args.taskRailFrontier,
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
      count: args.editCaptureCount,
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
      count: hasIdentity && hasCapture ? 1 : null,
      frontier: args.captureId,
    },
    {
      id: 'identity',
      label: `stable instance identity (${args.instanceName})`,
      handle: hasIdentity
        ? `tap_instance_messages action="summary" target_instance_id=${quotedId}`
        : '',
      status: hasIdentity ? 'available' : 'unavailable',
      count: hasIdentity ? 1 : null,
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
  // 'none' is a non-observation (capture lane reported no source), not a
  // provenance identity: prefixing a minted hash with it fabricates a
  // source-looking id for a row that asserts nothing was observed.
  const usableSourceId = sourceId && sourceId !== 'none' ? sourceId : null;
  return {
    provenanceId: usableSourceId
      ? `${usableSourceId}:${stableTextIdentity(kind, text)}`
      : stableTextIdentity(`receipt-${kind}`, text),
    sourceAt: knownSourceTime(source?.sourceTimestamp),
    status: usableSourceId ? 'exact' : 'partial',
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
  // A structured newest assistant PROSE row (raw hard-epoch path) outranks
  // both the legacy `🤖 LAST AI MESSAGE` prose extraction and the pending
  // assistant-action text: the pending action stays an Execution State fact,
  // while the boundary shows the newest thing the agent actually SAID.
  const structuredAssistant = options.lastMaterialAssistant && nonEmpty(options.lastMaterialAssistant.text)
    ? options.lastMaterialAssistant
    : undefined;
  const assistantText = structuredAssistant?.text
    ?? pendingAssistantAction?.text
    ?? extractLegacyAssistant(legacy.lastUserAiMessages);
  const requestSource = receipt?.liveState?.request?.source;
  // A receipt that could not name the request's row stamps the literal
  // `unknown`; that is an absent identity, never an exact one.
  const receiptRequestId = nonEmpty(requestSource?.id);
  const activeRequestSourceId = receiptRequestId && receiptRequestId !== 'unknown'
    ? receiptRequestId
    : undefined;
  const captureDispositionReason = nonEmpty(options.activeEditCaptureDisposition?.reason);
  const receiptEditDelta = adaptReceiptEditDelta(receipt);
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
        reasons: [captureDispositionReason ?? 'legacy Active Edit Delta adapted without an immutable Atlas capture'],
      }
    : receiptEditDelta
      ? (captureDispositionReason
          ? { ...receiptEditDelta, reasons: [captureDispositionReason] }
          : receiptEditDelta)
      : options.activeEditCaptureDisposition?.status === 'attempted-failed'
        ? {
            captureId: null,
            state: 'unknown' as const,
            capturedSourceAt: null,
            completedObservedAt: null,
            inheritedCaptureIds: [],
            files: [],
            omittedFiles: 0,
            truncated: false,
            reasons: [captureDispositionReason ?? 'immutable Atlas edit capture attempted but failed'],
          }
        : undefined);
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
  const pendingOperation = options.pendingOperation && nonEmpty(options.pendingOperation.text)
    ? options.pendingOperation
    : undefined;
  if (pendingOperation) {
    const operationSourceId = nonEmpty(pendingOperation.sourceId);
    const operationText = `${pendingOperation.text.trim()} · operation=${pendingOperation.status}`;
    executionFacts.push({
      provenanceId: operationSourceId ?? stableTextIdentity('pending-operation', operationText),
      sourceAt: knownSourceTime(pendingOperation.sourceAt),
      status: operationSourceId ? 'exact' : 'partial',
      kind: 'pending_operation',
      text: operationText,
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
    // The no-rail Resume Point fallback is UI decoration over a predecessor
    // thought bubble, not an observed rail state. Swallowing it as a structured
    // rail fact renders prose-as-data in Execution State; only a resume point
    // that carries actual rail structure (title/id/state line) is a fact.
    const isDecorationOnly = /^── Resume Point ──\s*\n💭\s*Last thought:/u.test(text)
      && !/^\[Task rail\]/mu.test(text);
    if (!isDecorationOnly) {
      executionFacts.push({
        provenanceId: stableTextIdentity('legacy-execution', text),
        sourceAt: null,
        status: 'partial',
        kind: 'rail',
        text,
      });
    }
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
  const bareHazards = receipt?.hazards ?? [];
  // Audit-2 A6 precedence repair (scramble-closeout DECISIVE, entered #42903):
  // the legacy string-array hazards mint unknown-time blockers, and the old
  // loop pre-seeded the seen-set with them, so a same-text source-carrying
  // descriptor (hazardsWithSource) was dropped as a "duplicate" — the
  // source-less row always won and every stamped blocker stayed quarantined
  // as unknown-time. Source-carrying descriptors now WIN same-text dedupe:
  // emit each winning descriptor FIRST (first descriptor text wins), then only
  // bare hazards not represented by one. `emitted` ends as the same
  // suppression surface the live-state blocker loop below has always seen
  // (bare texts ∪ descriptor texts), so that path's precedence is unchanged.
  const emitted = new Set<string>();
  for (const hazard of receipt?.hazardsWithSource ?? []) {
    if (emitted.has(hazard.text)) continue;
    emitted.add(hazard.text);
    const excerpt = typeof hazard.excerpt === 'string' && hazard.excerpt.trim()
      ? ` · excerpt=${JSON.stringify(hazard.excerpt.trim().slice(0, 140))}`
      : '';
    const text = `${hazard.text}${excerpt}`;
    // receiptFactSource reads only `id` + `sourceTimestamp`; the other
    // ContinuityLiveFieldSource fields (kind/capturedAt/coordinate) are
    // irrelevant to a descriptor that names its own source row, so a minimal
    // live-field-shaped object carries exactly those two.
    const source = hazard.sourceId || hazard.sourceTimestamp
      ? { kind: 'blocker-hazard', id: hazard.sourceId ?? '', sourceTimestamp: hazard.sourceTimestamp ?? '', capturedAt: '' }
      : undefined;
    executionFacts.push({
      kind: 'blocker',
      text,
      ...receiptFactSource('blocker', text, source),
    });
  }
  for (const hazard of bareHazards) {
    if (emitted.has(hazard)) continue;
    emitted.add(hazard);
    executionFacts.push({
      kind: 'blocker',
      text: hazard,
      ...receiptFactSource('blocker', hazard, undefined),
    });
  }
  for (const blocker of receipt?.liveState?.blockers.value ?? []) {
    if (emitted.has(blocker)) continue;
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
  // D2(e): room and subscription membership is ONE observation taken at ONE
  // capture instant, not N independently timed events. The audited specimen
  // rendered fourteen coordination rows that all carried the same stamp, which
  // reads as chronology and costs fourteen anchors for one fact. Collapse each
  // list into a single counted fact; the members stay named, so nothing is lost
  // but the repetition.
  const rooms = receipt?.liveState?.rooms.value ?? [];
  if (rooms.length > 0) {
    const text = `rooms=${rooms.length}: ${rooms.join(', ')}`;
    executionFacts.push({
      kind: 'coordination',
      text,
      ...receiptFactSource('coordination', text, receipt?.liveState?.rooms.source),
    });
  }
  const subscriptions = receipt?.liveState?.subscriptions.value ?? [];
  if (subscriptions.length > 0) {
    const text = `subscriptions=${subscriptions.length}: ${subscriptions.join(', ')}`;
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
    transcriptCount: nonNegativeRecoveryCount(receipt?.canonicalRange?.eventCount),
    currentPovCount: nonNegativeRecoveryCount(sourceFrontierValue?.exactCount),
    cognitionCount: cognition.length,
    cognitionFrontier: latestRecoveryRowFrontier(cognition),
    taskRailCount: nonNegativeRecoveryCount(receipt?.rail?.totalSteps),
    taskRailFrontier: nonEmpty(receipt?.liveState?.rail.source.coordinate)
      ?? nonEmpty(receipt?.liveState?.rail.source.id)
      ?? nonEmpty(receipt?.rail?.updatedAt)
      ?? null,
    editCaptureCount: activeEditDelta?.captureId
      ? activeEditDelta.files.length + activeEditDelta.omittedFiles
      : null,
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
          provenanceId: activeRequestSourceId ?? stableTextIdentity('active-request', activeRequestText),
          sourceAt: knownSourceTime(requestSource?.sourceTimestamp),
          status: activeRequestSourceId ? 'exact' : 'partial',
        },
      } : null,
      lastMaterialAssistant: structuredAssistant
        ? {
            text: structuredAssistant.text,
            chars: structuredAssistant.text.length,
            source: {
              provenanceId: nonEmpty(structuredAssistant.source.provenanceId)
                ?? stableTextIdentity('last-assistant', structuredAssistant.text),
              sourceAt: knownSourceTime(structuredAssistant.source.sourceAt),
              status: structuredAssistant.source.status,
            },
          }
        : assistantText ? {
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
    ...(options.cognitiveArtifactCapture
      ? { cognitiveArtifactCapture: options.cognitiveArtifactCapture }
      : {}),
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

/**
 * Audit-3 C5: compact DISPLAY rendering of a source instant for package
 * stamps. The store, sort keys, recover handles, and ledger proofs keep the
 * exact ms-precision ISO instant (God Rule 8 governs storage and ordering);
 * the RENDERED stamp drops sub-second precision and — when the instant shares
 * the capture year — the year itself, saving ~8-12 chars per stamp across the
 * package's hundreds of stamps. Deterministic: the same (value, referenceAt)
 * pair always renders the same bytes; an unparseable input renders 'unknown'
 * so no display path fabricates a time.
 */
function formatDisplayStamp(value: string | null | undefined, referenceAt: string | null): string {
  const iso = knownSourceTime(value);
  if (!iso) return 'unknown';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'unknown';
  const date = new Date(parsed);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const monthDay = `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
  const referenceIso = knownSourceTime(referenceAt);
  // TS strict-null: the const is not narrowed by `Boolean(x)` in an &&. Compare
  // the iso directly; a null referenceIso simply falls through to sameYear=false
  // (no year drop) which is the correct no-reference fallback.
  const sameYear = referenceIso !== null && iso.slice(0, 4) === referenceIso.slice(0, 4);
  return sameYear ? `${monthDay} ${clock}` : `${date.getUTCFullYear()}-${monthDay} ${clock}`;
}

/**
 * Audit-3 C7/B12: cut text at the last word boundary at or before `maxChars`
 * (append markers like '…' at call sites when the caller wants one). A cut
 * landing mid-token reads as a corrupted row; cutting at a word boundary
 * keeps the retained prefix a byte-exact prefix of the source body so ledger
 * sha256 attestation semantics are preserved.
 */
function cutAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cap = Math.max(0, Math.floor(maxChars));
  if (cap <= 0) return '';
  const head = text.slice(0, cap);
  const boundary = head.search(/\s+\S*$/u);
  return boundary > 0 ? head.slice(0, boundary) : head;
}

/**
 * Audit-3 B12: display clip for harvested agent active-request claims. The
 * model stores the whole message (attestation basis + cross-section dedupe
 * comparisons); the boundary renders only the '🧭 Active request:' line plus
 * at most one following sentence, bounded to 300 chars at a word boundary. A
 * text without the 🧭 marker is not a claim and renders unchanged.
 */
function activeRequestClaimClip(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('🧭')) return trimmed;
  const newline = trimmed.indexOf('\n');
  const firstLine = newline < 0 ? trimmed : trimmed.slice(0, newline).trim();
  const rest = newline < 0 ? '' : trimmed.slice(newline).trim();
  let clipped = firstLine;
  if (clipped.length < 300 && rest.length > 0) {
    const sentenceMatch = rest.match(/^(.{1,280}?[.!?])(?:\s|$)/u);
    if (sentenceMatch) {
      const sentence = sentenceMatch[1]!.trim();
      if (sentence.length <= 300 - clipped.length - 1) clipped = `${clipped} ${sentence}`;
    }
  }
  return clipped.length <= 300 ? clipped : `${cutAtWordBoundary(clipped, 299)}…`;
}

/**
 * One site-scoped command for the source units whose content was not fully
 * present in this exact committed render. The package never lists unit ids
 * here: the filtered ledger rows carry those identities and their per-unit
 * recovery commands after the reader deliberately opens the section lane.
 */
function continuityLedgerOmissionHandle(
  model: RebirthPackageV6Model,
  sectionId: RebirthPackageV6SectionId,
): string | null {
  const ledger = model.recoveryIndex.find((entry) => entry.id === 'continuity-ledger');
  const owner = model.boundaryAndActiveTask.instanceId?.trim();
  const captureId = model.boundaryAndActiveTask.captureId?.trim();
  if (!ledger?.handle || !owner || owner === 'unknown' || !captureId || captureId === 'unknown') return null;
  return `continuity_ledger action="fetch" owner=${JSON.stringify(owner)}`
    + ` capture_id=${JSON.stringify(captureId)} section_id=${JSON.stringify(sectionId)}`
    + ' omitted_only=true include_unknown_source_time=true limit=200';
}

interface RebirthRecoveryReferenceCatalog {
  readonly entries: readonly { readonly ref: string; handle: string }[];
  readonly refByHandle: ReadonlyMap<string, string>;
}

/**
 * Audit-3 B3 + audit-4 S7: deterministic, render-local handle dictionary with
 * usage tracking.
 *
 * The protected Recovery Index owns every repeated full command exactly once;
 * section receipts carry only a compact `R<n>` reference. The catalog is
 * derived exclusively from the immutable model and canonical section order,
 * so adaptive re-renders cannot renumber handles. Per-unit lineage handles
 * remain inline when unique; this dictionary targets the duplicated package /
 * section routes that dominated the audited specimen.
 *
 * Audit-4 S7: the audited specimen minted 20 legend rows of which 8 were never
 * cited by any section — handles are now REF'd only on first actual use
 * (`recoveryReference`), and the legend lists exactly the used set. Refs are
 * still assigned in deterministic catalog order, so a handle keeps its number
 * whether or not earlier handles went unused; `usedHandles` freezes the set
 * the legend will print.
 */
interface MutableRecoveryReferenceCatalog extends RebirthRecoveryReferenceCatalog {
  usedHandles: Set<string>;
}

function buildRecoveryReferenceCatalog(model: RebirthPackageV6Model): MutableRecoveryReferenceCatalog {
  const handles: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined): void => {
    const handle = value?.trim();
    if (!handle || seen.has(handle)) return;
    seen.add(handle);
    handles.push(handle);
  };
  for (const entry of model.recoveryIndex) add(entry.handle);
  for (const sectionId of REBIRTH_PACKAGE_V6_SECTION_IDS) {
    add(continuityLedgerOmissionHandle(model, sectionId));
  }
  for (const section of [model.operatorVault, model.episodeChapterIndex, model.lifeLedger]) {
    add(section?.rangeRecover);
  }
  const entries = handles.map((handle, index) => ({ ref: `R${index + 1}`, handle }));
  return {
    entries,
    refByHandle: new Map(entries.map((entry) => [entry.handle, entry.ref])),
    usedHandles: new Set<string>(),
  };
}

function recoveryReference(
  catalog: RebirthRecoveryReferenceCatalog,
  handle: string | null | undefined,
): string | null {
  const normalized = handle?.trim();
  if (!normalized) return null;
  const ref = catalog.refByHandle.get(normalized);
  if (ref && 'usedHandles' in catalog) {
    (catalog as MutableRecoveryReferenceCatalog).usedHandles.add(normalized);
  }
  return ref ?? normalized;
}

function omissionRecoveryClause(handle: string | null): string {
  return handle ? `recover=${handle}` : 'omitted units are ledger-unreachable';
}

function boundedProjectionFallback(
  text: string,
  maxChars: number,
  keepNewest: boolean,
): string {
  const cap = Math.max(0, Math.floor(maxChars));
  if (cap === 0) return '';
  if (cap === 1) return '…';
  const keep = cap - 1;
  return keepNewest ? `…${text.slice(-keep)}` : `${text.slice(0, keep)}…`;
}

function boundedText(
  text: string,
  maxChars: number,
  recoveryHandle: string | null,
): { readonly text: string; readonly complete: boolean } {
  if (text.length <= maxChars) return { text, complete: true };
  const markerFor = (stored: number): string => recoveryHandle
    ? `\n[… stored ${stored} of ${text.length} chars · recover: ${recoveryHandle} …]`
    : `\n[… stored ${stored} of ${text.length} chars · exact recovery unavailable …]`;
  if (markerFor(0).length > maxChars) {
    return { text: boundedProjectionFallback(text, maxChars, false), complete: false };
  }
  let keep = Math.max(0, maxChars - markerFor(0).length);
  // Digit-width can change after the first estimate. Two bounded iterations
  // reach a stable marker length for every practical section cap.
  keep = Math.max(0, maxChars - markerFor(keep).length);
  keep = Math.max(0, maxChars - markerFor(keep).length);
  const marker = markerFor(keep);
  if (marker.length > maxChars) {
    return { text: boundedProjectionFallback(text, maxChars, false), complete: false };
  }
  return { text: `${text.slice(0, keep)}${marker}`, complete: false };
}

/**
 * Bound a renderer-owned receipt to whole lines. Every line is one declared
 * unit (a header, a census row, a capture warning), so a character slice would
 * leave a torn header that reads as a complete fact (#41011). Leading lines are
 * admitted while they and the omission marker fit; when not even the marker
 * fits, the receipt yields entirely and the caller's census carries the truth.
 */
function boundedWholeLines(text: string, maxChars: number, recoveryHandle: string | null): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const marker = (omitted: number): string => (
    `[… ${omitted} receipt lines omitted${recoveryHandle ? ` · recover: ${recoveryHandle}` : ''} …]`
  );
  const kept: string[] = [];
  for (const line of lines) {
    if ([...kept, line, marker(lines.length)].join('\n').length > maxChars) break;
    kept.push(line);
  }
  const bounded = [...kept, marker(lines.length - kept.length)].join('\n');
  return bounded.length <= maxChars ? bounded : '';
}

/**
 * Heading the Active Edit Delta producer emits ahead of its lower-priority
 * Atlas snapshot enrichment (rebirthPackageBuilder buildAtlasSnapshotSection).
 * The renderer splits on it so a budget re-trim evicts enrichment before the
 * authoritative edit trail.
 */
const ATLAS_SNAPSHOT_SUPPLEMENT_HEADING = '## Atlas Snapshot Source (salient files)';

/**
 * Entry-aware newest retention (B5 / S11).
 *
 * A raw suffix slice of a timestamped edit log can land mid-line or mid-entry,
 * leaving a half header (e.g. "ed rows (item cap..." — the tail of a comment)
 * that reads as fresh while its opener is gone. When truncating newest-first we
 * advance the cut FORWARD to the first line-starting entry header ('[' at line
 * start) within the budget-fitted newest window, so the retained tail begins at
 * a clean entry boundary and is never longer than `maxChars`. The marker names
 * the omitted chars AND the number of whole entries dropped by the boundary
 * alignment. If no complete entry fits, omit the body rather than retaining
 * an unlabelled suffix of a record.
 */
function boundedNewestText(
  text: string,
  maxChars: number,
  authoritativeHistoryHandle: string | null,
): { readonly text: string; readonly complete: boolean } {
  if (text.length <= maxChars) return { text, complete: true };

  // Count whole `[…]` entry headers whose line begins inside
  // [startInclusive, endExclusive). A header is a line whose first char is '['.
  const countEntryHeaders = (startInclusive: number, endExclusive: number): number => {
    let count = 0;
    // If the body starts with a header at index 0, include it when in range.
    if (startInclusive === 0 && text.startsWith('[')) count += 1;
    let at = text.indexOf('\n[', startInclusive);
    while (at >= 0 && at + 1 < endExclusive) {
      count += 1;
      at = text.indexOf('\n[', at + 1);
    }
    return count;
  };

  // Build the AED omission marker + census for an exact retained body start.
  // Marker only ever appended when (marker + retained body) fit the cap.
  const buildMarker = (alignedStart: number): string => {
    const stored = text.length - alignedStart;
    const prefixEntries = countEntryHeaders(0, alignedStart);
    const keptEntries = countEntryHeaders(alignedStart, text.length);
    const totalEntries = prefixEntries + keptEntries;
    const censusBasenames = countEntryBasenames(text, 0, alignedStart);
    const census = censusBasenames.length > 0
      ? `\nomitted prefix touched ${censusBasenames.length} path(s): ${censusBasenames.slice(0, 3).join(', ')}${censusBasenames.length > 3 ? `, +${censusBasenames.length - 3} more` : ''}`
      : '';
    // When the log has no `[` entry-header structure (unstructured prose cut by
    // budget, e.g. a raw non-header body), the whole body is one unit: report
    // kept=1 (we retained a non-empty tail) of total=1; omitted-entries=0 is
    // honest because no whole entry was dropped, only chars. A body fully
    // omitted reports kept=0 of total=1. This keeps `kept <= total` in the v2
    // grammar for every shape. Structured logs report whole-entry counts only.
    const unstructured = totalEntries === 0;
    const kept = unstructured ? (stored > 0 ? 1 : 0) : keptEntries;
    const total = unstructured ? 1 : totalEntries;
    return `${formatOmissionMarkerV2({
      entries: prefixEntries,
      chars: alignedStart,
      kept,
      total,
      recover: authoritativeHistoryHandle,
    })}${census}\n`;
  };

  // Align a requested retained-byte count FORWARD to the next clean entry
  // header (never truncates mid-entry), bounded to [0, text.length].
  const align = (want: number): number => {
    let start = Math.max(0, Math.min(text.length, text.length - Math.max(0, want)));
    if (start > 0) {
      const firstHeader = text.indexOf('\n[', start);
      start = firstHeader >= 0 ? firstHeader + 1 : text.length;
    } else if (!text.startsWith('[')) {
      // advancing into a body that begins without a header — keep from the top
      const firstHeader = text.indexOf('\n[');
      if (firstHeader >= 0) start = firstHeader + 1;
    }
    return Math.max(0, Math.min(text.length, start));
  };

  // Fit: find the LARGEST retained body whose aligned body + full marker fit.
  // We search over retained byte counts monotonically and admission-check the
  // real marker at each candidate (binary search converges fast and exactly).
  let lo = 0;
  let hi = Math.max(0, maxChars); // bytes of body we might retain
  let chosen = align(0);
  for (let step = 0; step < 60 && lo <= hi; step += 1) {
    const mid = Math.floor((lo + hi) / 2);
    const aligned = align(mid);
    const markerLen = buildMarker(aligned).length;
    if (markerLen + (text.length - aligned) <= maxChars) {
      chosen = aligned;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Final admission check — never ship over cap.
  const finalMarker = buildMarker(chosen);
  if (finalMarker.length + (text.length - chosen) > maxChars) {
    return { text: boundedWholeLines(finalMarker.trimEnd(), maxChars, authoritativeHistoryHandle), complete: false };
  }
  return { text: `${finalMarker}${text.slice(chosen)}`, complete: false };
}

/** Basenames (deduped, bounded) of entry lines (`[…]` at line start) the AED
 *  cut front-omits, for the C9 census line. Callers pass the line start of each
 *  entry header (the `[` position). */
function countEntryBasenames(text: string, startInclusive: number, endExclusive: number): string[] {
  const seen = new Set<string>();
  const basenames: string[] = [];
  const consider = (lineStart: number): void => {
    const lineEnd = text.indexOf('\n', lineStart);
    const head = text.slice(
      lineStart,
      lineEnd < 0 || lineEnd > endExclusive ? endExclusive : lineEnd,
    );
    const m = /\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*(?:Edit|Write)\s*→\s*([^\s⟨]+)/u.exec(head);
    if (!m || m[1].includes('⌖')) return;
    const base = m[1].split('/').pop();
    if (base && base.length && !seen.has(base)) {
      seen.add(base);
      basenames.push(base);
    }
  };
  // Leading line may start at 0 without a preceding '\n'.
  if (text.startsWith('[', startInclusive)) consider(startInclusive);
  let idx = text.indexOf('\n[', startInclusive);
  while (idx >= 0 && idx + 1 < endExclusive) {
    consider(idx + 1);
    idx = text.indexOf('\n[', idx + 1);
  }
  return basenames;
}

/**
 * Capture-degradation predicate shared by the boundary renderer below and the
 * rebirth sidecar's build counter (via computeRebirthCaptureDegradedLanesFromPackage).
 * A lane is capture-degraded when its read explicitly failed
 * (store-unreachable-at-capture, capture-read-incomplete) OR when lineage
 * ancestors were deliberately omitted because no authoritative fork-capture
 * frontier resolved — both lineage-feeder paths (unfrontiered omission and
 * resolution failure) end their reason with "ancestor live tails were not
 * read", a phrase pinned by rebirthLineageFeeders tests. 2026-08-28 lesson:
 * the remote-mirror executor resolved zero frontiers for ~18h while
 * degradedResponses stayed 0 — the predicate and the counter must share one
 * definition so a lineage-truncated build can never look clean again.
 */
export const REBIRTH_CAPTURE_GAP_REASON_RE =
  /store-unreachable-at-capture|capture-read-incomplete|ancestor live tails were not read/i;

/** Structural minimum the degraded-lane computation needs from the v6 model. */
export interface RebirthCaptureDegradedLaneSource {
  operatorVault?: { readonly partialReason?: string | null } | null;
  episodeChapterIndex?: { readonly partialReason?: string | null } | null;
  lifeLedger?: { readonly partialReason?: string | null } | null;
  cognitiveArtifactCapture?: { readonly status?: string | null } | null;
  activeEditDelta?: {
    readonly state?: string;
    readonly files?: readonly unknown[];
    readonly reasons?: readonly unknown[];
  } | null;
  boundaryAndActiveTask?: {
    readonly nowCard?: {
      readonly currentRailAvailability?: {
        readonly status?: string;
        readonly reason?: string | null;
      } | null;
    } | null;
  } | null;
}

/**
 * Active Edit Delta reasons that record a capture that was NEVER attempted —
 * the sidecar/legacy path did not request an immutable Atlas edit capture, so
 * there is no failed attempt to report. These must not flag capture-degraded:
 * degraded is reserved for an ATTEMPTED capture that failed (unavailable,
 * failed, unreachable, transport truncation), not for a path that never asked.
 */
export const REBIRTH_ACTIVE_EDIT_NOT_REQUESTED_REASON_RE =
  /did not request an immutable Atlas edit capture|no immutable Atlas edit capture was supplied|without an immutable Atlas capture|not-requested|not requested/i;

/**
 * Canonical degraded-lane census: the package boundary header and the sidecar
 * degradation telemetry both consume this single selection, so a truncated
 * capture can never look clean on one surface and degraded on the other.
 */
export function computeRebirthCaptureDegradedLanes(model: RebirthCaptureDegradedLaneSource): string[] {
  const degradedLanes: string[] = [];
  const captureGap = REBIRTH_CAPTURE_GAP_REASON_RE;
  if (captureGap.test(model.operatorVault?.partialReason ?? '')) degradedLanes.push('operator-vault');
  if (captureGap.test(model.episodeChapterIndex?.partialReason ?? '')) degradedLanes.push('episode-chapter-index');
  if (captureGap.test(model.lifeLedger?.partialReason ?? '')) degradedLanes.push('life-ledger');
  if (model.cognitiveArtifactCapture?.status === 'partial'
    || model.cognitiveArtifactCapture?.status === 'unavailable') {
    degradedLanes.push('cognition');
  }
  const aed = model.activeEditDelta;
  if (
    aed
    && aed.state !== undefined
    && aed.state !== 'exact'
    && Array.isArray(aed.reasons)
    && aed.reasons.some((reason) => {
      if (typeof reason !== 'string') return false;
      // A never-requested capture is not a failed capture: exclude it before
      // the attempted-failure predicate, so the sidecar path (which by design
      // does not request an immutable Atlas edit capture) stays non-degraded.
      if (REBIRTH_ACTIVE_EDIT_NOT_REQUESTED_REASON_RE.test(reason)) return false;
      return /unavailable|capture.*(?:failed|unreachable)/i.test(reason);
    })
  ) {
    degradedLanes.push('active-edit-delta');
  }
  if (model.boundaryAndActiveTask?.nowCard?.currentRailAvailability?.status === 'unavailable') {
    degradedLanes.push('task-rail');
  }
  return degradedLanes;
}

function asLaneRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Cross-process entry point for the rebirth sidecar: accepts the built
 * package object (or its v6 model directly), unwraps pkg.rebirthV6 when
 * present, and applies the canonical lane census. Never throws — telemetry
 * must not fail a build.
 */
export function computeRebirthCaptureDegradedLanesFromPackage(pkg: unknown): string[] {
  const record = asLaneRecord(pkg);
  if (!record) return [];
  const model = asLaneRecord(record.rebirthV6) ?? record;
  const lane = (key: string): { partialReason: string | null } | null => {
    const value = asLaneRecord(model[key]);
    return value
      ? { partialReason: typeof value.partialReason === 'string' ? value.partialReason : null }
      : null;
  };
  const cognition = asLaneRecord(model.cognitiveArtifactCapture);
  const aed = asLaneRecord(model.activeEditDelta);
  const boundary = asLaneRecord(model.boundaryAndActiveTask);
  const nowCard = asLaneRecord(boundary?.nowCard);
  const railAvailability = asLaneRecord(nowCard?.currentRailAvailability);
  return computeRebirthCaptureDegradedLanes({
    operatorVault: lane('operatorVault'),
    episodeChapterIndex: lane('episodeChapterIndex'),
    lifeLedger: lane('lifeLedger'),
    cognitiveArtifactCapture: cognition
      ? { status: typeof cognition.status === 'string' ? cognition.status : null }
      : null,
    activeEditDelta: aed
      ? {
        state: typeof aed.state === 'string' ? aed.state : undefined,
        files: Array.isArray(aed.files) ? aed.files : [],
        reasons: Array.isArray(aed.reasons) ? aed.reasons : [],
      }
      : null,
    boundaryAndActiveTask: boundary
      ? {
        nowCard: nowCard
          ? {
            currentRailAvailability: railAvailability
              ? {
                status: typeof railAvailability.status === 'string' ? railAvailability.status : undefined,
                reason: typeof railAvailability.reason === 'string' ? railAvailability.reason : null,
              }
              : null,
          }
          : null,
      }
      : null,
  });
}

/**
 * One never-throws line declaring which builder process produced the delivered
 * package (2026-08-28 package-audit finding A1: a package that cannot say
 * whether a box-1 sidecar or a remote mirror built it makes dual-path
 * divergence undiagnosable from the artifact itself). Absent identity renders
 * an honest unknown — a missing stamp is a fact about provenance, not silence.
 */
function formatBuilderIdentityLine(builder: RebirthPackageV6BoundaryAndActiveTask['builder']): string {
  if (!builder || typeof builder !== 'object') {
    return 'built-by=unknown · builder identity was not stamped at capture';
  }
  const path = typeof builder.path === 'string' && builder.path.trim() ? builder.path.trim() : 'unknown';
  const endpoint = typeof builder.endpoint === 'string' && builder.endpoint.trim()
    ? ` @ ${builder.endpoint.trim()}`
    : '';
  // Audit-2 A17: the new producer stamp (`packageBuildMs`) earns the full
  // `sha256:<16 hex>` source identity; stored pre-A17 builder rows (legacy
  // `builtMs` only) keep their prior 12-char rendering byte-identically.
  const hasProducerStamp = typeof builder.packageBuildMs === 'number'
    && Number.isFinite(builder.packageBuildMs) && builder.packageBuildMs >= 0;
  const fullSha = typeof builder.treeSha256 === 'string' && /^[0-9a-f]{64}$/.test(builder.treeSha256);
  const treeSha = hasProducerStamp && fullSha
    ? `sha256:${builder.treeSha256.slice(0, 16)}`
    : fullSha
      ? `${builder.treeSha256.slice(0, 12)}…`
      : 'unknown';
  const files = Number.isSafeInteger(builder.fileCount) && builder.fileCount >= 0
    ? String(builder.fileCount)
    : 'unknown';
  const packageBuildMs = hasProducerStamp
    ? ` · package-build=${Math.round(builder.packageBuildMs)}ms`
    : '';
  const builtMs = typeof builder.builtMs === 'number' && Number.isFinite(builder.builtMs) && builder.builtMs >= 0
    ? ` · built=${Math.round(builder.builtMs)}ms`
    : '';
  // Audit-3 B4/C3: repo HEAD of the building repo (git=<sha7|unknown>, bounded
  // fail-open) plus both process boot instants — answers "did the relay/sidecar
  // restart since commit X" from the artifact alone, never inferred.
  const git = typeof builder.gitSha7 === 'string' && builder.gitSha7.trim()
    ? ` · git=${builder.gitSha7.trim()}`
    : ` · git=unknown`;
  const sidecarBoot = typeof builder.sidecarBootedAt === 'string' && builder.sidecarBootedAt.trim()
    ? ` · sidecar-boot=${builder.sidecarBootedAt.trim()}`
    : '';
  const relayBoot = typeof builder.relayBootedAt === 'string' && builder.relayBootedAt.trim()
    ? ` · relay-boot=${builder.relayBootedAt.trim()}`
    : '';
  // Audit-3 B5: relay-side request-preparation stage decomposition. When the
  // prep object is present render a stage list that names totalMs and each
  // measured stage plus an explicit other= remainder so the list ALWAYS
  // reconciles to its total (never a hidden gap). Parallel draws are reported
  // once as their true timeline occupancy (parallelMaxMs), not double-counted.
  let prepText = '';
  if (builder.requestPrep && typeof builder.requestPrep === 'object') {
    const prep = builder.requestPrep;
    const parts: string[] = [`${Math.round(prep.totalMs)}ms`];
    const add = (label: string, ms: number | null | undefined): void => {
      if (typeof ms === 'number' && Number.isFinite(ms)) parts.push(`${label}=${Math.round(ms)}ms`);
    };
    add('snapshot', prep.snapshotMs);
    add('frontier', prep.frontierMs);
    add('src', prep.builderSourceMs);
    add('exec', prep.executionStateMs);
    add('atlas', prep.atlasLandedMs);
    add('repo', prep.repoStateMs);
    if (typeof prep.parallelMaxMs === 'number' && Number.isFinite(prep.parallelMaxMs)) {
      parts.push(`parallelDraw=${Math.round(prep.parallelMaxMs)}ms`);
    }
    add('other', prep.otherMs);
    prepText = ` · request-prep=[${parts.join(' ')}]`;
  }
  const requestToCapture = typeof builder.requestToCaptureMs === 'number'
    && Number.isFinite(builder.requestToCaptureMs) && builder.requestToCaptureMs >= 0
    ? ` · request→capture=${Math.round(builder.requestToCaptureMs)}ms`
    : '';
  // Audit-4 S7: when both the prep decomposition AND the total wall are known,
  // name the un-attributed remainder explicitly instead of leaving a silent
  // gap a reader must reconstruct by subtraction (the audited specimen had
  // 2.2s between prep+build and request→capture with no term for it).
  const prepTotalMs = typeof builder.requestPrep?.totalMs === 'number'
    && Number.isFinite(builder.requestPrep.totalMs)
    ? Math.round(builder.requestPrep.totalMs)
    : null;
  const buildMsValue = typeof builder.packageBuildMs === 'number'
    && Number.isFinite(builder.packageBuildMs)
    ? Math.round(builder.packageBuildMs)
    : null;
  const totalWallMs = typeof builder.requestToCaptureMs === 'number'
    && Number.isFinite(builder.requestToCaptureMs) && builder.requestToCaptureMs >= 0
    ? Math.round(builder.requestToCaptureMs)
    : null;
  const unaccountedMs = prepTotalMs !== null && totalWallMs !== null
    ? totalWallMs - prepTotalMs - (buildMsValue ?? 0)
    : null;
  // S1: a residual reported as "cause unknown" tells an operator nothing it can
  // act on. The span is bounded by construction — request→capture minus the
  // instrumented prep stages minus package build — so name the UNINSTRUMENTED
  // stages that can live inside it instead of leaving the reader to guess. This
  // is a declaration of what is not yet measured, never an estimate: no share
  // is attributed to any named stage without its own measurement (GOD RULE 7).
  const unaccountedText = unaccountedMs !== null
    ? ` · unaccounted=${unaccountedMs}ms (${unaccountedMs < 0
      ? 'inconsistent measured spans; '
      : ''}uninstrumented: worker queue wait, request/response transport, capture persistence; capture only, not delivery/readiness)`
    : '';
  return `built-by=${path}${endpoint} · src=${treeSha} · files=${files}${packageBuildMs}${builtMs}${git}${sidecarBoot}${relayBoot}${prepText}${requestToCapture}${unaccountedText}`;
}

function boundedRailAvailabilityReason(value: string | null | undefined): string {
  return (value ?? 'unspecified').replace(/\s+/gu, '-').replace(/[^A-Za-z0-9:_.-]/gu, '').slice(0, 120)
    || 'unspecified';
}

/**
 * Audit-3 A2 owned-children/v1: reduce the owned-child statuses to one compact
 * `live=<a> hibernated=<b> done=<c> teardown-pending=<a+b>` suffix when the
 * capture stamped every child's runtime status. `teardown-pending` counts the
 * recoverable-but-unterminated statuses (hibernated + done) that still owe an
 * owner kill — the obligations surface B/C2 reads for the pending-obligations
 * block. Deterministic; unknown/empty statuses never fabricate a count.
 */
function renderOwnedStatusCounts(
  children: readonly { status?: string | null }[],
): string {
  const count = (value: string): number => children.reduce(
    (acc, child) => acc + (child.status?.trim() === value ? 1 : 0), 0,
  );
  const live = count('working') + count('idle') + count('active') + count('in_progress');
  const hibernated = count('hibernated');
  const done = count('done') + count('archived') + count('stopped');
  // Other statuses (error/blocked/…) don't collapse into a known bucket.
  const other = children.length - live - hibernated - done;
  const parts = [`live=${live}`, `hibernated=${hibernated}`, `done=${done}`];
  if (other > 0) parts.push(`other=${other}`);
  parts.push(`teardown-pending=${hibernated + done}`);
  return parts.join(' ');
}

/** Read an additive optional string field on a repo row (Lane-B A6 headCommittedAt). */
function readOptionalRepoString(
  repo: RebirthPackageV6RepositoryState,
  key: string,
): string | null {
  const value = (repo as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Omission-marker/v2 (audit-3 B9): ONE canonical grammar for section omission
 * receipts, replacing the six dialects (stored-newest / partial= / omitted-N /
 * ROLLUP / elided / omitted-entries) so a reader never re-learns markers per
 * section. Sections that elide whole entries — conversation exchanges, vault
 * eras, life rollups, AED newest-tail cuts, bounded-newest text — emit through
 * this helper and keep their recover handle inside the single `recover:`
 * clause. Exact shape (audit-3 lane contract):
 *
 *   [… omitted <n> entries · <chars> chars · kept newest <kept> of <total> · recover: <handle>]
 *
 * The `recover:` clause is present only when a handle exists; an elided body
 * without one must never render an empty `recover:` token (schema layers
 * reject bare tool-looking tokens, and an empty handle is a dead pointer).
 */
export interface RebirthOmissionMarkerV2 {
  /** Number of whole entries omitted (rows, units, exchanges, lives). */
  readonly entries: number;
  /** Omitted characters (source chars of the omitted body, when measurable). */
  readonly chars: number;
  /** Number of entries retained (kept newest). */
  readonly kept: number;
  /** Total entries considered before omission (kept + omitted, known basis). */
  readonly total: number;
  /** Executable recovery handle for the omitted entries, when one exists. */
  readonly recover?: string | null;
  /** Optional singular count noun; absent preserves the legacy `entries`. */
  readonly unit?: string;
  /** Optional chronological tile for the omitted and first-retained units. */
  readonly range?: {
    readonly from?: string | null;
    readonly to?: string | null;
    readonly retainedFrom?: string | null;
  };
}

export function formatOmissionMarkerV2(marker: RebirthOmissionMarkerV2): string {
  const unit = marker.unit?.trim();
  const omittedNoun = unit
    ? `${unit}${marker.entries === 1 ? '' : 's'}`
    : 'entries';
  const keptNoun = unit
    ? ` ${unit}${marker.kept === 1 ? '' : 's'}`
    : '';
  const from = marker.range?.from?.trim();
  const to = marker.range?.to?.trim();
  const retainedFrom = marker.range?.retainedFrom?.trim();
  const range = from || to
    ? ` · range=${from ?? 'unknown'}..${to ?? 'unknown'}`
    : '';
  const retained = retainedFrom ? ` · retained-from=${retainedFrom}` : '';
  const recover = marker.recover && marker.recover.trim()
    ? ` · recover: ${marker.recover.trim()}`
    : '';
  return `[… omitted ${marker.entries} ${omittedNoun} · ${marker.chars} chars`
    + ` · kept newest ${marker.kept}${keptNoun} of ${marker.total}`
    + `${range}${retained}${recover}]`;
}

/**
 * Partial-class/v2 (audit-3 A8): adds `merge` to the audit-2 vocabulary so an
 * EXPLAINED omission is never classified `unknown`. `merge` covers capture-side
 * duplicate-claim fusion ("121 duplicate chapter claim(s) merged …") and any
 * dedupe that deliberately collapses N rows into one survivor.
 */
type RebirthPartialReasonClass = 'horizon' | 'cap' | 'store' | 'merge' | 'not-requested' | 'unknown';

function classifyPartialReason(reason: string | null | undefined): RebirthPartialReasonClass {
  const text = reason?.trim() ?? '';
  if (REBIRTH_ACTIVE_EDIT_NOT_REQUESTED_REASON_RE.test(text)) return 'not-requested';
  if (REBIRTH_CAPTURE_GAP_REASON_RE.test(text)
    || /unavailable|unreadable|failed|failure|worker|transport|timeout|corrupt/u.test(text)) return 'store';
  if (/horizon|frontier|pre-horizon|capturedAt/u.test(text)) return 'horizon';
  // Partial-class/v2: a duplicate-claim fusion is an explained omission class
  // of its own ("121 duplicate chapter claim(s) merged into newest survivors")
  // — never the audit-2 fall-through `unknown`.
  if (/merge|merged|duplicate|dedup|coalesc/u.test(text)) return 'merge';
  if (/cap|ceiling|budget|truncat|omitt|selected|projection/u.test(text)) return 'cap';
  return 'unknown';
}

/**
 * Full partial-lane census is distinct from capture-degraded: horizon, cap,
 * store, merge, and deliberately not-requested lanes are incomplete but not
 * failed reads. Legacy model-only form used by non-render surfaces (sidecar
 * telemetry callers); the rendered Boundary derives its lanes from
 * computeSectionCompleteness (audit-3 A8/S6) so header, section partial=,
 * footer, and Recovery Index status= can never disagree.
 */
function partialLaneCensus(model: RebirthPackageV6Model): string[] {
  const lanes: string[] = [];
  const lineage = [
    ['operator-vault', model.operatorVault?.partialReason],
    ['episode-chapter-index', model.episodeChapterIndex?.partialReason],
    ['life-ledger', model.lifeLedger?.partialReason],
  ] as const;
  for (const [id, reason] of lineage) {
    if (reason?.trim()) lanes.push(`${id}:${classifyPartialReason(reason)}`);
  }
  const cognition = model.cognitiveArtifactCapture;
  if (cognition && cognition.status !== 'complete') {
    const reason = cognition.warnings.join(' ') || cognition.missingFamilies.join(' ');
    lanes.push(`cognition:${classifyPartialReason(reason) === 'unknown' ? 'store' : classifyPartialReason(reason)}`);
  }
  if (model.activeEditDelta.state !== 'exact' && model.activeEditDelta.state !== 'none') {
    const reason = model.activeEditDelta.reasons.join(' ');
    lanes.push(`active-edit-delta:${classifyPartialReason(reason)}`);
  }
  const rail = model.boundaryAndActiveTask.nowCard?.currentRailAvailability;
  if (rail && rail.status !== 'current') {
    lanes.push(`task-rail:${rail.status === 'none' ? 'not-requested' : classifyPartialReason(rail.reason)}`);
  }
  return [...new Set(lanes)];
}

/**
 * Audit-3 A8/S6: ONE completeness census derived from the ACTUAL rendered
 * section bodies, feeding the header `capture-partial-lanes=`, each section's
 * `partial=` surface (same reason text ⇒ same class), the footer
 * RENDER-INCOMPLETE list, and the Recovery Index `status=` of section rows.
 * Classification rules:
 *  - an explained capture-side omission classifies horizon|store|merge|cap|
 *    not-requested from its own reason text — an EXPLAINED omission is never
 *    `unknown`;
 *  - a section whose admitted body lost content (render-incomplete, demoted or
 *    rolled-up units) without a capture-side explanation classifies `cap`;
 *  - a section with both renders `class+cap` (e.g. duplicate-claims merged AND
 *    pressure rollup) so neither loss is hidden by the other.
 */
export interface RebirthSectionCompletenessEntry {
  readonly id: RebirthPackageV6SectionId;
  /** Primary class from the capture-side reason, when one exists. */
  readonly class: RebirthPartialReasonClass | null;
  /** The capture-side reason text (the same text `partial=` surfaces print). */
  readonly reason: string | null;
  /** True when the body render lost content (incomplete/demoted/rolled-up). */
  readonly renderLoss: boolean;
  /**
   * True when the delivery deliberately does not render this section (limit 0)
   * because D2 relocated its units to the continuity ledger.
   *
   * This is NOT a render loss, and calling it one is a lie with four mouths:
   * the `capture-partial-lanes=` header, the Recovery Index `reason=`, the
   * `RENDER-INCOMPLETE` trailer, and the section's own `partial=` surface all
   * read this census. A successor told `operator-vault:cap` believes its vault
   * was truncated under budget and goes looking for what it lost; the truth is
   * that every unit is intact and addressed in the ledger.
   */
  readonly relocated: boolean;
}

export type RebirthSectionCompleteness = ReadonlyMap<
  RebirthPackageV6SectionId,
  RebirthSectionCompletenessEntry
>;

const SECTION_LANE_IDS: Readonly<Record<RebirthPackageV6SectionId, string>> = {
  boundaryAndActiveTask: 'boundary',
  brainMergeSynthesis: 'brain-merge-synthesis',
  executionState: 'execution-state',
  activeEditDelta: 'active-edit-delta',
  cognitiveArtifacts: 'cognition',
  recentConversation: 'recent-conversation',
  operatorVault: 'operator-vault',
  episodeChapterIndex: 'episode-chapter-index',
  lifeLedger: 'life-ledger',
  recoveryIndex: 'recovery-index',
};

function hasCollapseLoss(body: RenderedV6SectionBody): boolean {
  const collapse = body.collapse;
  if (!collapse) return false;
  return collapse.placements.some((placement) => placement.tier !== 't0')
    || (collapse.droppedToFloorRollup ?? 0) > 0;
}

/**
 * Derives the census from rendered section bodies. Boundary/recovery are
 * structural and never partial (their own completeness is not model truth);
 * the remaining admitted sections classify per the doc above.
 */
export function computeSectionCompleteness(
  model: RebirthPackageV6Model,
  rendered: Readonly<Record<RebirthPackageV6SectionId, RenderedV6SectionBody>>,
  limits?: Readonly<Record<RebirthPackageV6SectionId, number>>,
): RebirthSectionCompleteness {
  const census = new Map<RebirthPackageV6SectionId, RebirthSectionCompletenessEntry>();
  const sectionReason = (id: RebirthPackageV6SectionId): { reason: string | null; explained: boolean } => {
    if (id === 'operatorVault' || id === 'episodeChapterIndex' || id === 'lifeLedger') {
      const reason = model[id]?.partialReason ?? null;
      return { reason, explained: Boolean(reason?.trim()) };
    }
    if (id === 'cognitiveArtifacts') {
      const capture = model.cognitiveArtifactCapture;
      if (capture && capture.status !== 'complete') {
        const reason = capture.warnings.join(' ') || capture.missingFamilies.join(' ');
        return { reason: reason || null, explained: Boolean(reason) };
      }
      return { reason: null, explained: false };
    }
    if (id === 'activeEditDelta' && model.activeEditDelta.state !== 'exact' && model.activeEditDelta.state !== 'none') {
      const reason = model.activeEditDelta.reasons.join(' ');
      return { reason: reason || null, explained: Boolean(reason) };
    }
    // recentConversation carries no typed capture-side partialReason: its
    // omission marker (audit-3 B9/v2 helper) is render-side, so it classifies
    // purely from render loss (cap) in the census.
    return { reason: null, explained: false };
  };
  for (const id of REBIRTH_PACKAGE_V6_SECTION_IDS) {
    if (id === 'boundaryAndActiveTask' || id === 'recoveryIndex') continue;
    const body = rendered[id];
    if (!body) continue;
    const { reason, explained } = sectionReason(id);
    const loss = !body.complete || hasCollapseLoss(body);
    const relocated = limits !== undefined && limits[id] <= 0;
    if (!explained && !loss && !relocated) continue;
    const cls: RebirthPartialReasonClass | null = explained
      ? (id === 'cognitiveArtifacts' && classifyPartialReason(reason) === 'unknown'
        // Cognitive capture warnings are store-family even when their wording
        // misses the classifier vocabulary (legacy forced-store semantics).
        ? 'store'
        : classifyPartialReason(reason))
      : null;
    census.set(id, { id, class: cls, reason, renderLoss: loss, relocated });
  }
  return census;
}

/** Kebab lane label + optional multi-class (`merge+cap`) for header lines. */
function censusLaneLabel(entry: RebirthSectionCompletenessEntry): string {
  const classes: string[] = [];
  // Capture-side partiality survives relocation: units merged or horizon-cut
  // BEFORE the render are still merged or horizon-cut in the ledger, so the
  // capture class always leads.
  if (entry.class) classes.push(entry.class);
  // Relocation replaces only the render-loss component. A section the delivery
  // deliberately does not render is complete, elsewhere — saying `cap` sends a
  // successor hunting for bytes that were never lost.
  if (entry.relocated) classes.push('relocated');
  else if (entry.renderLoss && entry.class !== 'cap') classes.push('cap');
  return `${SECTION_LANE_IDS[entry.id]}:${classes.join('+') || 'cap'}`;
}

function boundaryPartialLanes(census: RebirthSectionCompleteness): string[] {
  const lanes: string[] = [];
  for (const id of REBIRTH_PACKAGE_V6_SECTION_IDS) {
    const entry = census.get(id);
    if (entry) lanes.push(censusLaneLabel(entry));
  }
  return lanes;
}

/**
 * Section-absence census (audit-2 A28): every model-declared section id that
 * this render will NOT admit, with its canonical order and the reason. Absence
 * from the rendered package is explicit, so a successor reading `order=N`
 * frame headers can distinguish a never-captured section from a dropped one.
 * Structural sections (boundary/execution/AED/cognition/recovery) are always
 * admitted and never listed.
 */
function omittedSectionList(model: RebirthPackageV6Model): string[] {
  const admitted = new Set(admittedSectionIds(model));
  const entries: string[] = [];
  for (const id of REBIRTH_PACKAGE_V6_SECTION_IDS) {
    if (admitted.has(id)) continue;
    const order = REBIRTH_PACKAGE_V6_SECTION_IDS.indexOf(id) + 1;
    let reason: string;
    if (id === 'brainMergeSynthesis') {
      reason = 'no-donor';
    } else if (id === 'recentConversation') {
      reason = 'no-dialogue-captured';
    } else if (id === 'operatorVault' || id === 'episodeChapterIndex' || id === 'lifeLedger') {
      reason = model[id] === undefined ? 'predates-v7-model' : 'captured-empty';
    } else {
      continue;
    }
    entries.push(`${id}(order=${order},reason=${reason})`);
  }
  return entries;
}

/**
 * Audit-3 C8 hazards tri-state for the Boundary, derived from the blocker
 * facts Execution State actually renders (assembler folds the continuity
 * receipt's hazard/blocker rows into execution facts):
 *  - `hazards=unknown` — execution-state is the vacuous "capture unavailable"
 *    default (the receipt scan never ran);
 *  - `hazards=none` — the scan produced zero blocker rows;
 *  - `hazards=<n>` — the scan produced n blocker rows, rendered below;
 *  - `hazards=elided (n)` — n rows were produced but the Execution State body
 *    lost content under its budget, so the boundary cannot claim full render.
 * Derived from the model's adapted facts only — never fabricated.
 */
/**
 * CONTINUATION RECORD: the compact working-state digest a successor most
 * often had to rebuild by hand (folding assessment, 2026-09-06): active
 * request → latest verified checkpoint → latest decision → unresolved
 * blockers → owned paths → pending operation → next action → recovery
 * handles. Every line is DERIVED from facts already captured on the model and
 * names its source; an absent fact renders `unknown` / `none-captured`, never
 * a guess, and `none-captured` deliberately does not claim the thing is
 * absent in the world. Additive: a persisted model renders it from whatever
 * facts it carries.
 */
function renderContinuationRecord(
  model: RebirthPackageV6Model,
  references: RebirthRecoveryReferenceCatalog,
): string[] {
  const boundary = model.boundaryAndActiveTask;
  const referenceAt = boundary.capturedAt;
  const facts = model.executionState?.facts ?? [];
  const clip = (text: string, max = 160): string => {
    if (boundary.activeRequest && text.trim() === boundary.activeRequest.text.trim()) {
      return `[EXACT ACTIVE REQUEST · source=${boundary.activeRequest.source.provenanceId}]`;
    }
    const flat = text.replace(/\s+/gu, ' ').trim();
    return flat.length <= max ? flat : `${cutAtWordBoundary(flat, max - 1)}…`;
  };
  const stamp = (source: { readonly provenanceId: string; readonly sourceAt: string | null }): string => (
    `source=${source.provenanceId} · source-time=${formatDisplayStamp(source.sourceAt, referenceAt)}`
  );
  // God Rule 8: "newest" is meaningful only among known-time rows; an
  // unknown-time row is used solely when no known-time row exists, and it is
  // stamped unknown rather than ordered.
  const newest = <T extends { readonly provenanceId: string; readonly sourceAt: string | null }>(
    rows: readonly T[],
  ): T | null => {
    const known = rows.filter((row) => knownSourceTime(row.sourceAt)).sort(compareSourceRows);
    return known[known.length - 1] ?? rows[0] ?? null;
  };
  const byKind = (kind: RebirthPackageV6ExecutionFact['kind']): RebirthPackageV6ExecutionFact[] => (
    facts.filter((fact) => fact.kind === kind)
  );
  const lines: string[] = [
    '[CONTINUATION RECORD · derived from captured facts · each line names its source · unknown/none-captured = not captured, never absent]',
  ];
  // The request body renders verbatim a few lines below (EXACT ACTIVE REQUEST);
  // the record points at it instead of repeating it, so promoted dialogue stays
  // single-sourced (the boundary de-dup invariant) and a long request is never
  // paid for twice.
  lines.push(boundary.activeRequest
    ? `active-request=[same bytes as EXACT ACTIVE REQUEST below] · ${boundary.activeRequest.chars} chars · ${stamp(boundary.activeRequest.source)}`
    : 'active-request=unknown');
  // Git checkpoint at capture, from the NOW card's per-root repository probe
  // (never a synthesized sha); an errored or sha-less probe contributes nothing.
  const ops = boundary.nowCard?.ops;
  const repos = ops?.repositories ?? [];
  const repoCheckpoints = repos.flatMap((repo) => (repo.error || !repo.sha7 ? [] : [
    `${repos.length > 1 ? `${repo.name}:` : ''}${repo.branch ?? 'unknown'}@${repo.sha7} dirty=${repo.dirtyCount ?? '?'} staged=${repo.stagedCount ?? '?'}`,
  ]));
  lines.push(repoCheckpoints.length > 0 && ops
    ? `checkpoint=${repoCheckpoints.join(' · ')} · ${stamp(ops.source)}`
    : 'checkpoint=none-captured');
  // Newest validation fact as captured — its own text carries the outcome
  // (a completed call with an unknown outcome is still only a validation call).
  const validation = newest(byKind('validation'));
  lines.push(validation
    ? `latest-validation=${clip(validation.text)} · ${stamp(validation)}`
    : 'latest-validation=none-captured');
  const decision = newest(model.cognitiveArtifacts.filter((row) => row.kind === 'decision'
    && row.sourceInstanceId === boundary.instanceId && !row.supersededBy
    && boundary.nowCard?.currentRailAvailability?.status !== 'none'
    && !['complete', 'review-closed', 'all-resolved', 'none'].includes(boundary.nowCard?.currentRail?.state ?? '')
    && (!boundary.activeRequest?.source.sourceAt || (row.sourceAt && Date.parse(row.sourceAt) >= Date.parse(boundary.activeRequest.source.sourceAt)))
    && row.sourceAt && Number.isFinite(Date.parse(row.sourceAt))));
  lines.push(decision
    ? `latest-decision=${clip(decision.text)} · ${stamp(decision)}`
    : 'latest-decision=none-captured');
  const blockers = byKind('blocker');
  const newestBlocker = newest(blockers);
  lines.push(newestBlocker
    ? `unresolved-blockers=${blockers.length} · newest: ${clip(newestBlocker.text)} · ${stamp(newestBlocker)}`
    : 'unresolved-blockers=none-captured');
  // S6: declared open items — the signpost/checklist labels the assistant left
  // in the delivered pool, newest-first and source-linked. A declaration
  // trace, never a resolution claim; none-declared states the check ran.
  const openItems = extractDeclaredOpenItems(model.recentConversation ?? []);
  if (openItems.length > 0) {
    lines.push(`open-items=${openItems.length} declared · ${openItems.map((item, index) => (
      `[${index + 1}] ${clip(item.text, OPEN_ITEMS_MAX_ITEM_CHARS)} ⟨${item.provenanceId} @${formatDisplayStamp(item.sourceAt, referenceAt)}⟩`
    )).join(' · ')}`);
  } else {
    lines.push('open-items=none-declared');
  }
  const ownedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const addPath = (label: string): void => {
    if (seenPaths.has(label)) return;
    seenPaths.add(label);
    ownedPaths.push(label);
  };
  for (const file of model.activeEditDelta.files) {
    if (file.ownership === 'mine') addPath(`${file.filePath} (${file.closureState})`);
  }
  for (const claim of byKind('claim')) addPath(clip(claim.text, 120));
  const ownedShown = ownedPaths.slice(0, 6);
  lines.push(ownedPaths.length > 0
    ? `owned-paths=${ownedShown.join(' · ')}${ownedPaths.length > ownedShown.length ? ` (+${ownedPaths.length - ownedShown.length} more)` : ''}`
    : 'owned-paths=none-captured');
  const operation = newest(byKind('pending_operation'));
  const assistantAction = newest(byKind('pending_assistant_action'));
  lines.push(operation
    ? `pending-operation=${clip(operation.text)} · ${stamp(operation)}`
    : assistantAction
      ? `pending-operation=none-captured · pending-assistant-action=${clip(assistantAction.text)} · ${stamp(assistantAction)}`
      : 'pending-operation=none-captured');
  const nextAction = newest(byKind('next_action'));
  const rail = boundary.nowCard?.currentRail;
  const railFact = newest(byKind('rail'));
  lines.push(nextAction
    ? `next-action=${clip(nextAction.text)}${nextAction.predatesActiveRequest ? ' · authority=predates-active-request' : ''} · ${stamp(nextAction)}`
    : rail
      ? `next-action=rail ${rail.railId} · step=${rail.activeStepId ?? 'none'} (${rail.activeStepId ? (rail.activeStepStatus ?? 'unknown') : 'n/a'}) · state=${rail.state} · ${stamp(rail.source)}`
      : railFact
        ? `next-action=${clip(railFact.text)}${railFact.predatesActiveRequest ? ' · authority=predates-active-request' : ''} · ${stamp(railFact)}`
        : 'next-action=unknown');
  const recoveryRefs = ([
    ['transcript', 'transcript'],
    ['task-rail', 'task-rail'],
    ['edits', 'atlas-edit-capture'],
    ['cognition', 'cognition'],
  ] as const).flatMap(([label, id]) => {
    const entry = model.recoveryIndex.find((candidate) => candidate.id === id);
    const ref = entry && entry.status !== 'unavailable' && entry.status !== 'not-requested'
      ? recoveryReference(references, entry.handle)
      : null;
    return ref ? [`${label}=${ref}`] : [];
  });
  lines.push(recoveryRefs.length > 0 ? `recover: ${recoveryRefs.join(' · ')}` : 'recover: no exact route advertised');
  lines.push('[/CONTINUATION RECORD]');
  return lines;
}

function boundaryHazardsLine(
  model: RebirthPackageV6Model,
  completeness: RebirthSectionCompleteness | undefined,
): string | null {
  const facts = model.executionState?.facts ?? [];
  const blockerFacts = facts.filter((fact) => fact.kind === 'blocker');
  // The receipt scan surface exists whenever execution facts were folded into
  // the model (the assembler adapts the receipt's hazards/blocks into facts).
  // `unknown` is reserved for a model whose execution-state is the vacuous
  // "capture unavailable" default (receipt scan never ran).
  const captureUnavailable = model.executionState?.unknownReasons?.some(
    (reason) => /capture unavailable/iu.test(reason),
  ) === true
    && facts.length === 0;
  if (captureUnavailable) return 'execution-blockers=unknown · receipt scan did not run';
  if (blockerFacts.length === 0) return 'execution-blockers=none · capture/index/render health reported separately';
  const executionLost = completeness?.get('executionState')?.renderLoss === true;
  return executionLost
    ? `execution-blockers=elided (${blockerFacts.length})`
    : `execution-blockers=${blockerFacts.length}`;
}

/**
 * D1 density: the agent-facing Boundary.
 *
 * Same facts, same source ids and source times, one short anchor per row
 * instead of five `key=value` clauses. The endpoint bodies (exact active
 * request, last material assistant) stay verbatim and take the section's
 * remaining budget; when the assistant body cannot fit whole it degrades
 * through the ordinary bounded-projection path with its transcript handle, so
 * a clipped answer is never presented as a complete one.
 */
function renderCompactBoundary(
  model: RebirthPackageV6Model,
  maxChars: number,
  references: RebirthRecoveryReferenceCatalog,
): { text: string; complete: boolean } {
  const recovery = recoveryReference(
    references,
    model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle,
  );
  const assistantSource = model.boundaryAndActiveTask.lastMaterialAssistant;
  const frameOnly = compactBoundary(model, '');
  const assistantBudget = Math.max(512, maxChars - frameOnly.length - 64);
  const assistant = assistantSource
    ? boundedText(assistantSource.text, assistantBudget, recovery)
    : null;
  const text = compactBoundary(model, assistant?.text ?? null);
  return { text: boundedWholeLines(text, maxChars, recovery), complete: text.length <= maxChars && (assistant?.complete ?? true) };
}

function renderBoundary(
  model: RebirthPackageV6Model,
  maxChars: number,
  completeness?: RebirthSectionCompleteness,
  references: RebirthRecoveryReferenceCatalog = buildRecoveryReferenceCatalog(model),
  compact = false,
): { text: string; complete: boolean } {
  const boundary = model.boundaryAndActiveTask;
  // D1: the delivered boundary is prose the agent reads, but it is budgeted by
  // the same allocator as every other section. Rendering it here — rather than
  // substituting it after sections were sized — is what keeps the section cap
  // binding instead of advisory.
  if (compact) return renderCompactBoundary(model, maxChars, references);
  // Capture-degraded (store failures) is distinct from the completeness census
  // (audit-3 A8): both stay single-source, the header cannot drift from the
  // section bodies it describes.
  const degradedLanes = computeRebirthCaptureDegradedLanes(model);
  const partialLanes = completeness
    ? boundaryPartialLanes(completeness)
    : partialLaneCensus(model);
  const hazardsLine = boundaryHazardsLine(model, completeness);
  const lines = [
    // Audit-3 B8: ONE versions= line names every version-bearing vocabulary in
    // the envelope; frame literals and the provenance envelope stay unchanged
    // so stored-package parsers keep accepting legacy frames.
    `versions=model:${model.version} · render:v6-sections · capture-id:naming-v2 · provenance:v1 · frame:rebirth-v6-section`,
    `lifecycle=${boundary.lifecycle} · ${boundary.lifecycleMeaning}`,
    `capture-artifact=${boundary.captureId} · captured-at=${boundary.capturedAt ?? 'unknown'} · frontier=${boundary.sourceFrontier ?? 'unknown'}`,
    // Audit-3 C1: name the derived execution phase so a successor can read at a
    // glance which section partition governed this render (rail-active keeps
    // the generic defaults; rail-complete/no-rail ship the ratified dense
    // partition). Derived from rail state already on the model — never a new
    // capture.
    `budget-phase=${deriveRebirthExecutionPhase(model)}`,
    ...(partialLanes.length > 0
      ? [`capture-partial-lanes=${partialLanes.join(',')} · class-vocabulary=horizon|cap|store|merge|relocated|not-requested|unknown`]
      : []),
    ...(degradedLanes.length > 0
      ? [`capture-degraded=${degradedLanes.join(',')} · status=partial · per-lane recovery truth renders in each affected section`]
      : []),
    ...(omittedSectionList(model).length > 0
      ? [`sections-omitted=${omittedSectionList(model).join(',')}`]
      : []),
    ...(hazardsLine ? [hazardsLine] : []),
    `instance=${boundary.instanceName} (${boundary.instanceId}) · predecessor=${boundary.predecessorName ?? boundary.predecessorInstanceId ?? 'none'}`,
    `workspace=${boundary.workspace} · cwd=${boundary.cwd ?? 'unknown'}`,
  ];
  if (boundary.runtimeChange) lines.push(`runtime-change=${boundary.runtimeChange}`);
  if (boundary.runtimeModelContext) {
    // D2(g): the model transition is a Now-card fact, not its own block. Four
    // lines and a rule carried three values; one line carries the same three
    // and stops competing with the section headings an agent scans for.
    // Rendering is keyed on supplied context (present whenever the assembler
    // had a legacy runtime model), NOT on `changed===true`, so an unchanged
    // transition still states `changed=no`.
    const snap = (s: RebirthPackageV6RuntimeModelSnapshot): string => (
      s.engine ? `${s.engine}/${s.model ?? 'unknown'}` : (s.model ?? 'unknown')
    );
    lines.push(
      `runtime-model=${snap(boundary.runtimeModelContext.predecessor)}`
      + ` -> ${snap(boundary.runtimeModelContext.successor)}`
      + ` · changed=${boundary.runtimeModelContext.changed ? 'yes' : 'no'}`,
    );
  }
  lines.push(formatBuilderIdentityLine(boundary.builder));
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
  const now = boundary.nowCard;
  const unknownSource = 'source=unknown · source-time=unknown · status=unknown';
  lines.push('', '[FACTUAL NOW CARD · descriptive boundary facts]');
  if (boundary.lifecycle === 'fresh_fork') {
    if (now?.forkPurpose) {
      const purposeText = now.forkPurpose.text === boundary.activeRequest?.text
        ? '[same bytes as EXACT ACTIVE REQUEST below]'
        : JSON.stringify(now.forkPurpose.text);
      lines.push(
        `fork-purpose=${purposeText} · source-kind=${now.forkPurpose.sourceKind} · ${formatSource(now.forkPurpose.source)}`,
      );
    } else {
      lines.push(`fork-purpose=unknown · ${unknownSource}`);
    }
  }
  if (now?.parentIdentity) {
    lines.push(
      `parent-identity=${now.parentIdentity.instanceName ?? 'unknown'} (${now.parentIdentity.instanceId}) · checkpoint=${now.parentIdentity.checkpointMessageId ?? 'unknown'} · ${formatSource(now.parentIdentity.source)}`,
    );
  } else {
    lines.push(`parent-identity=unknown · checkpoint=unknown · ${unknownSource}`);
  }
  if (now?.parentStatus) {
    lines.push(
      `parent-status=${now.parentStatus.runtimeStatus} · ${formatSource(now.parentStatus.source)}`,
    );
  } else {
    lines.push(`parent-status=unknown · ${unknownSource}`);
  }
  if (now?.currentRail) {
    lines.push(
      `current-rail=${now.currentRail.railId} · state=${now.currentRail.state} · active-step=${now.currentRail.activeStepId ?? 'none'} · step-status=${now.currentRail.activeStepId ? (now.currentRail.activeStepStatus ?? 'unknown') : 'n/a'} · ${formatSource(now.currentRail.source)}`,
    );
  } else if (now?.currentRailAvailability?.status === 'none') {
    lines.push(
      `current-rail=none · state=n/a · active-step=n/a · step-status=n/a · ${formatSource(now.currentRailAvailability.source)}`,
    );
  } else if (now?.currentRailAvailability?.status === 'unavailable') {
    const reason = boundedRailAvailabilityReason(now.currentRailAvailability.reason);
    lines.push(
      `current-rail=unavailable:${reason} · state=unavailable · active-step=unavailable · step-status=unavailable · ${formatSource(now.currentRailAvailability.source)}`,
    );
  } else {
    lines.push(`current-rail=unknown · state=unknown · ${unknownSource}`);
  }
  if (now?.lineageChain && now.lineageChain.length > 0) {
    // Plan feature 3 (S16): one ordered chain of instance identities from the
    // lineage root to this instance, with each hop's span and archive state.
    // Rendered only when the assembler supplied it (absent = none provided).
    const chain = now.lineageChain
      .map((hop) => {
        const label = hop.instanceName ? `${hop.instanceName} (${hop.instanceId})` : hop.instanceId;
        // Audit-2 A11: when the birth name differs from the current display
        // name at this hop, surface born-as so a rename never reads as a stale
        // hop or a mislabeled identity.
        const bornAs = hop.bornAs && hop.bornAs.trim() && hop.bornAs.trim() !== hop.instanceName
          ? ` · born-as=${hop.bornAs.trim()}`
          : '';
        const span = hop.sourceAt
          ? `${hop.sourceAt.slice(0, 10)}→${hop.sourceEndAt?.slice(0, 10) ?? 'now'}`
          : 'span=unknown';
        const runtimeState = hop.archived === true
          ? 'archived'
          : hop.archived === false ? 'live-at-capture' : 'state=unknown';
        return `${label}${bornAs} · ${span} · ${runtimeState}`;
      })
      .join(' → ');
    lines.push(`lineage-chain=${chain}`);
  }
  if (now?.ops) {
    // Audit-3 A2/owned-children/v1: flat legacy `{id,name}` rows render the
    // joined `name(id)` list only; when the capture supplies richer per-child
    // status, the list is annotated with status counts so teardown obligations
    // stay visible (hibernated + done children are still owned and pending
    // teardown until killed).
    const children = now.ops.ownedLiveChildren;
    const owned = children.length > 0
      ? children.map((child) => `${child.name}(${child.id})`).join(',')
      : 'none';
    const statuses = children.map((child) => child.status?.trim()).filter(Boolean) as string[];
    const statusCount = statuses.length === children.length && statuses.length > 0
      ? renderOwnedStatusCounts(children)
      : null;
    const ownedLabel = statusCount
      ? `owned-children=${owned} (${statusCount})`
      : owned;
    // Audit-3 A9/B16: rooms may be flat membership names or typed room entries.
    // A flat entry renders its name; a typed entry renders name(id) and, when
    // the snapshot marked it stale (>24h no activity), appends `[stale-since=…]`
    // (B16) while its authoritative source time / observation stamp ride the
    // coordination facts rather than being re-stamped here (A9).
    const rooms = now.ops.rooms.length > 0
      ? now.ops.rooms.map((room) => {
        if (typeof room === 'string') return room;
        const base = room.id ? `${room.name}(${room.id})` : room.name;
        return room.staleSince ? `${base}[stale-since=${room.staleSince}]` : base;
      }).join(',')
      : 'none';
    // Audit-2 A18 / audit-3 A6 (Lane B spec): per-root repo captures render the
    // measured branch/sha/dirty/staged facts plus `head-committed=` when the
    // row carried it and `as-of=` on both healthy and error rows; the legacy
    // single-string disposition stays byte-identical when no capture rode it.
    const repos = now.ops.repositories ?? [];
    const git = repos.length > 0
      ? `git:${(() => {
        // Audit-4 S7: one shared submit deadline fails every root with the
        // same elapsed figure — 26 identical `timed-out-Nms` rows carried one
        // bit of information and ~3K chars. The roll-up keys on the ERROR
        // SIGNATURE (bounded reason + as-of), because per-root labels embed
        // the repo name and never compare equal: identical-signature error
        // runs collapse to `<count>x <first-repo>:error:<reason> (+N more
        // roots)`, healthy rows stay per-root.
        const labelFor = (repo: typeof repos[number]): string => {
          const head = readOptionalRepoString(repo, 'headCommittedAt');
          if (repo.error) {
            return `${repo.name}:error:${boundedRailAvailabilityReason(repo.error)} as-of=${repo.capturedAt ?? 'unknown'}`;
          }
          // Bounded changed-path sample from the same probe as the counts;
          // `(+N more)` is the exact remainder, so a truncated sample is never
          // read as the whole set. A root without a sample renders
          // byte-identically to the pre-sample checkpoint line.
          const sample = repo.dirtyPaths && repo.dirtyPaths.length > 0 ? repo.dirtyPaths : null;
          const remainder = sample && repo.dirtyPathsTotal != null && repo.dirtyPathsTotal > sample.length
            ? ` (+${repo.dirtyPathsTotal - sample.length} more)`
            : '';
          return `${repos.length > 1 ? `${repo.name}:` : ''}${repo.branch ?? 'unknown'}@${repo.sha7 ?? '…'} dirty=${repo.dirtyCount ?? '?'} staged=${repo.stagedCount ?? '?'}${head ? ` head-committed=${head}` : ''} as-of=${repo.capturedAt ?? 'unknown'}${sample ? ` changed-paths=${sample.join(' ')}${remainder}` : ''}`;
        };
        const errorSignature = (repo: typeof repos[number]): string | null => (
          repo.error
            ? `${boundedRailAvailabilityReason(repo.error)}\u0000${repo.capturedAt ?? 'unknown'}`
            : null
        );
        const rolled: string[] = [];
        let index = 0;
        while (index < repos.length) {
          const signature = errorSignature(repos[index]!);
          if (signature === null) {
            rolled.push(labelFor(repos[index]!));
            index += 1;
            continue;
          }
          let run = 1;
          while (
            index + run < repos.length
            && errorSignature(repos[index + run]!) === signature
          ) run += 1;
          const first = labelFor(repos[index]!);
          rolled.push(run > 1 ? `${first} (+${run - 1} more roots with the same error)` : first);
          index += run;
        }
        return rolled.join(' | ');
      })()}`
      : `git:${now.ops.repositoryState}${now.ops.repositoryReason ? `:${boundedRailAvailabilityReason(now.ops.repositoryReason)}` : ''}`;
    lines.push(
      `ops=${git} · owned-live-children=${ownedLabel} · squad=${now.ops.squad ?? 'none'} · rooms=${rooms} · ${formatSource(now.ops.source)}`,
    );
  }
  if (boundary.lifeFacts) {
    const lf = boundary.lifeFacts;
    const parts: string[] = [];
    // A12 (boundary-trigger/v1): `boundary-trigger=` is THIS capture's trigger
    // (from the request when the builder forwarded it); the newest-LEDGER-life
    // trigger is the separate `predecessor-boundary=` ancestor key — never
    // conflated. Absent this-boundary renders unknown via boundaryTrigger null.
    if (lf.boundaryTrigger != null) parts.push(`boundary-trigger=${lf.boundaryTrigger}`);
    if (lf.predecessorBoundary != null) parts.push(`predecessor-boundary=${lf.predecessorBoundary}`);
    if (lf.predecessorLifeId != null) parts.push(`predecessor-life=${lf.predecessorLifeId}`);
    if (lf.predecessorMaterialOutput != null) {
      parts.push(`predecessor-material-output=${lf.predecessorMaterialOutput}`);
    }
    if (lf.lastMaterialAssistantLifeId != null) {
      parts.push(`last-material-assistant-life=${lf.lastMaterialAssistantLifeId}`);
    }
    if (parts.length > 0) {
      const stamp = lf.source ? ` · ${formatSource(lf.source)}` : ' · source=unknown · source-time=unknown';
      lines.push(`life-facts=${parts.join(' · ')}${stamp}`);
    }
  }
  const vaultNewest = model.operatorVault?.units
    .flatMap((unit) => knownSourceTime(unit.sourceAt) ? [knownSourceTime(unit.sourceAt)!] : [])
    .sort()
    .at(-1) ?? null;
  if (vaultNewest || boundary.activeRequest?.source.sourceAt) {
    lines.push(`vault-newest=${vaultNewest ?? 'unknown'} · active-request=${boundary.activeRequest?.source.sourceAt ?? 'unknown'}`);
  }
  lines.push('[/FACTUAL NOW CARD]');
  lines.push('', ...renderContinuationRecord(model, references));
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
    // God Rule 11 expiry attribution: an agent claim is expired only by a LATER
    // genuine raw operator message — never by another agent claim, and never by
    // the agent's own later interpretation. The newest operator message in the
    // boundary is the EXACT ACTIVE REQUEST; when it postdates a claim it is the
    // expirer to name (audit-3 B12). Absent a derivable expirer the label stays
    // unnamed-but-honest rather than naming the wrong authority.
    const expiringOperator = (claimSourceAt: string | null): {
      provenanceId: string;
      sourceAt: string | null;
    } | null => {
      if (!boundary.activeRequest?.source?.sourceAt || !claimSourceAt) return null;
      const claimMs = Date.parse(claimSourceAt);
      const operatorMs = Date.parse(boundary.activeRequest.source.sourceAt);
      if (!Number.isFinite(claimMs) || !Number.isFinite(operatorMs) || operatorMs <= claimMs) return null;
      return {
        provenanceId: boundary.activeRequest.source.provenanceId,
        sourceAt: boundary.activeRequest.source.sourceAt,
      };
    };
    const expiryLabel = (claimSourceAt: string | null): string => {
      const expirer = expiringOperator(claimSourceAt);
      return expirer
        ? `EXPIRED BY ${expirer.provenanceId}@${formatDisplayStamp(expirer.sourceAt, boundary.capturedAt)}`
        : 'EXPIRED BY NEWER RAW OPERATOR REQUEST';
    };
    const latestStatus = claims.latestStatus === 'current'
      ? 'CURRENT · non-authoritative · exact raw operator chronology wins'
      : claims.latestStatus === 'expired_by_newer_operator'
        ? `${expiryLabel(claims.latest.source.sourceAt)} · do not execute`
        : 'FALLBACK ONLY · operator frontier unknown · do not treat as instruction';
    lines.push(
      '',
      `[AGENT ACTIVE-REQUEST INTERPRETATION · ${latestStatus} · ${formatSource(claims.latest.source)}]`,
      // Audit-3 B12: display clips the harvested claim to its 🧭 line (+ at most
      // one following sentence, ≤300 chars) so the boundary never reprints the
      // whole message; the model keeps the full text for attestation/dedupe.
      activeRequestClaimClip(claims.latest.text),
      '[/AGENT ACTIVE-REQUEST INTERPRETATION]',
    );
    // Audit-3 B12: the predecessor claim renders only while the newest claim is
    // NOT expired — an expired newest claim makes the stale predecessor noise.
    if (claims.previous && claims.latestStatus !== 'expired_by_newer_operator') {
      lines.push(
        '',
        `[PREVIOUS AGENT ACTIVE-REQUEST INTERPRETATION · ${expiryLabel(claims.previous.source.sourceAt)} · fallback context only · do not execute · ${formatSource(claims.previous.source)}]`,
        activeRequestClaimClip(claims.previous.text),
        '[/PREVIOUS AGENT ACTIVE-REQUEST INTERPRETATION]',
      );
    }
  }
  if (boundary.lastMaterialAssistant) {
    const recovery = recoveryReference(
      references,
      model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle,
    );
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

/**
 * D2(e): room-membership facts are stamped with the capture instant, not with
 * when each room was actually joined. Rendered one-per-line they read as a
 * burst of coordination that never happened, and they crowd out the execution
 * facts that do carry real chronology. When a run of them shares one instant,
 * they collapse to a single as-of census that names every room and claims no
 * ordering. A coordination fact with its own distinct time is left alone.
 */
function renderExecutionKnownFacts(
  known: readonly RebirthPackageV6ExecutionFact[],
  renderFact: (fact: RebirthPackageV6ExecutionFact) => string,
): string[] {
  const coordination = known.filter((fact) => fact.kind === 'coordination');
  const instant = coordination[0]?.sourceAt ?? null;
  const collapsible = coordination.length >= 2
    && instant !== null
    && coordination.every((fact) => fact.sourceAt === instant);
  if (!collapsible) return known.map(renderFact);
  const rooms = coordination
    .map((fact) => fact.text.replace(/^room=/u, '').trim())
    .filter(Boolean);
  const census = `- coordination · rooms=${rooms.length} as-of ${instant}`
    + ` (capture instant, not join time): ${rooms.join(', ')}`;
  const lines: string[] = [];
  let censusEmitted = false;
  for (const fact of known) {
    if (fact.kind === 'coordination') {
      // Hold the census at the first member's slot so the surrounding facts
      // keep their real chronological neighbours.
      if (!censusEmitted) { lines.push(census); censusEmitted = true; }
      continue;
    }
    lines.push(renderFact(fact));
  }
  return lines;
}

function renderExecution(
  model: RebirthPackageV6Model,
  maxChars: number,
  references: RebirthRecoveryReferenceCatalog,
): { text: string; complete: boolean } {
  // God Rule 8: unknown source time never participates in the chronology. Known-time
  // execution facts stream chronologically; unknown-time facts are quarantined under
  // an explicit banner (mirroring renderCognition) where they make no recency claim.
  const known = model.executionState.facts.filter((fact) => fact.sourceAt);
  const unknown = model.executionState.facts.filter((fact) => !fact.sourceAt);
  const factPrefix = (fact: RebirthPackageV6ExecutionFact): string => {
    const request = model.boundaryAndActiveTask.activeRequest;
    const text = request && fact.text.trim() === request.text.trim()
      ? `[EXACT ACTIVE REQUEST · source=${request.source.provenanceId}]`
      : fact.text;
    // Audit-2 A12: the label describes the fact's kind, not a demand claim.
    return fact.kind === 'review' ? `rail-review-state=${text}` : `${fact.kind} · ${text}`;
  };
  // D1 density: source id and source time survive on every row, but as ONE
  // trailing anchor instead of five `key=value` clauses. `[partial]` and
  // `[predates-active-request]` are single tokens the package legend defines.
  // Ingestion `observed-at` is processing time — telemetry, not chronology —
  // and no longer competes with the fact itself for the reader's attention.
  const factLabels = (fact: RebirthPackageV6ExecutionFact): string => (
    `${fact.status === 'exact' ? '' : ` [${fact.status}]`}${fact.predatesActiveRequest ? ' [predates-active-request]' : ''}`
  );
  const renderFact = (fact: RebirthPackageV6ExecutionFact): string => (
    `- ${factPrefix(fact)}${factLabels(fact)} ${continuityAnchor(fact.provenanceId, fact.sourceAt, model.boundaryAndActiveTask.capturedAt)}`
  );
  const lines = renderExecutionKnownFacts(known, renderFact);
  for (const reason of model.executionState.unknownReasons) {
    // Audit-2 A21: an unresolved disagreement between captured facts is a
    // conflict, not an unknown; a genuinely unknown reason keeps its label.
    lines.push(/conflicts?\b/iu.test(reason) ? `- conflict: ${reason}` : `- unknown: ${reason}`);
  }
  if (unknown.length > 0) {
    lines.push('', 'Unknown source time (quarantined; not part of the chronology):');
    for (const fact of unknown) lines.push(renderFact(fact));
  }
  if (lines.length === 0) lines.push('- execution state captured as empty');
  const full = lines.join('\n');
  if (full.length <= maxChars) return { text: full, complete: true };
  const recovery = recoveryReference(references, model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle);
  const omitted = (count: number) => `[… ${count} execution entries omitted${recovery ? ` · recover: ${recovery}` : ''} …]`;
  const kept: string[] = [];
  // Admit complete rows. An oversized room roster must not consume the cap
  // before a short unresolved operation or validation can be shown.
  for (const line of lines) {
    if ([...kept, line, omitted(lines.length)].join('\n').length <= maxChars) kept.push(line);
  }
  const text = [...kept, omitted(lines.length - kept.length)].join('\n');
  return { text: text.length <= maxChars ? text : '', complete: false };
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
  // Audit-2 A5: an atlas_landed closure that graduated under a held claim
  // carries the pointer; a non-graduated row names its blocking gate.
  const closure = file.closureState === 'atlas_landed' && file.graduatedUnderHeldClaim
    ? 'atlas_landed(claim=held)'
    : file.closureState;
  const gate = file.graduationGate ? ` · gate=${file.graduationGate}` : '';
  return `${file.changeKind.toUpperCase()} ${file.filePath} · ${file.ownership} · baseline=${file.baselineQuality} · ${editFileStats(file)} · validation=${file.validationState} · closure=${closure}${gate}`;
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

function renderActiveEdits(
  model: RebirthPackageV6Model,
  maxChars: number,
  references: RebirthRecoveryReferenceCatalog,
): RenderedV6SectionBody {
  const delta = model.activeEditDelta;
  const recoveryHandle = recoveryReference(
    references,
    model.recoveryIndex.find((entry) => entry.id === 'atlas-edit-capture')?.handle,
  );
  const historyRecoveryHandle = recoveryReference(
    references,
    model.recoveryIndex.find((entry) => entry.id === 'atlas-history')?.handle,
  );
  const omissionHandle = recoveryReference(
    references,
    continuityLedgerOmissionHandle(model, 'activeEditDelta'),
  );
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
    // Honest capture disposition: a path that never requested the capture is
    // `not-requested`, not `unavailable`. Only an ATTEMPTED capture that failed
    // is `unavailable`. This keeps the sidecar build path (which by design does
    // not request an immutable Atlas edit capture) from reading as a failed
    // capture that never happened.
    const disposition = REBIRTH_ACTIVE_EDIT_NOT_REQUESTED_REASON_RE.test(reason)
      ? 'not-requested'
      : 'unavailable';
    const banner = `current-attributable-edits=unknown · immutable capture=${disposition}: ${reason}\nevidence=bounded historical edit log; paths below are historical touches, not current ownership or pending work. Shared checkout counts are separate repository observations.`;
    // AUDIT-3 A1(e): the legacy layout appends a `Provenance: ⌖c…` line to the
    // AED artifact for its coordinate-closet appendix, which the v6 renderer
    // has no appendix for — strip that single generated trailing marker line so
    // no session renders a dangling coordinate ref (substantive prose/source is
    // never rewritten).
    const rawEditLog = legacyLog.preview?.text ?? '';
    const linesOfLog = rawEditLog.split('\n');
    const lastLogLine = (linesOfLog[linesOfLog.length - 1] ?? '').trim();
    if (/^Provenance:\s+⌖c[0-9]+/u.test(lastLogLine)) linesOfLog.pop();
    const editLog = linesOfLog.join('\n').trimEnd();
    if (!editLog || maxChars <= banner.length + 1) {
      return { text: boundedWholeLines(banner, maxChars, historyRecoveryHandle), complete: banner.length <= maxChars };
    }
    const bodyBudget = maxChars - banner.length - 1;
    // Atlas #33488 invariant, re-asserted at the renderer. The timestamped edit
    // trail is the authoritative handoff state; the trailing Atlas snapshot
    // block is lower-priority enrichment. The producer already arbitrates that
    // way, but this renderer re-trims the ALREADY-COMPOSED string against the
    // v6 section cap, and a plain newest-tail slice keeps the byte SUFFIX --
    // which is the enrichment. Once the cap fell below the composed length the
    // suffix stopped reaching back past the enrichment heading, so every edit
    // row was evicted while lower-priority snapshots survived and the omission
    // marker still called them "newest". Split the two bodies and spend the
    // budget on the trail first so both trims agree.
    const supplementAt = editLog.indexOf(ATLAS_SNAPSHOT_SUPPLEMENT_HEADING);
    const editTrail = (supplementAt >= 0 ? editLog.slice(0, supplementAt) : editLog).trimEnd();
    const enrichment = supplementAt >= 0 ? editLog.slice(supplementAt).trimEnd() : '';
    if (!enrichment || !editTrail) {
      const body = boundedNewestText(editLog, bodyBudget, historyRecoveryHandle);
      return { text: `${banner}\n${body.text}`, complete: body.complete };
    }
    if (editTrail.length + 1 < bodyBudget) {
      // Trail fits whole: spend the remainder on enrichment from its START, so
      // the reader keeps the enrichment heading and knows what those blocks are.
      const supplementBudget = bodyBudget - editTrail.length - 1;
      const supplement = {
        text: boundedWholeLines(enrichment, supplementBudget, historyRecoveryHandle),
        complete: enrichment.length <= supplementBudget,
      };
      return {
        text: `${banner}\n${editTrail}\n${supplement.text}`,
        complete: supplement.complete,
      };
    }
    // Trail alone is at or over budget: discard the lower-priority enrichment
    // before losing a single edit row, and name the discard rather than letting
    // it read as absence.
    const discardNote = `\n[... atlas snapshot enrichment omitted . ${enrichment.length} chars . lower priority than the edit trail]`;
    const noteFits = discardNote.length < bodyBudget;
    const body = boundedNewestText(
      editTrail,
      noteFits ? bodyBudget - discardNote.length : bodyBudget,
      historyRecoveryHandle,
    );
    return {
      text: `${banner}\n${body.text}${noteFits ? discardNote : ''}`,
      complete: false,
    };
  }
  const lines = [
    `state=${delta.state} · capture=${delta.captureId ?? 'unknown'} · source-time=${delta.capturedSourceAt ?? 'unknown'} · observed-at=${delta.completedObservedAt ?? 'unknown'}${delta.atlasLandedCapture ? ` · atlas-landed-capture=${delta.atlasLandedCapture.status} rows=${delta.atlasLandedCapture.count} elapsed=${delta.atlasLandedCapture.elapsedMs}ms` : ''}`,
  ];
  // E1 idle collapse: with no attributable file, the capture header and its
  // one-sentence disposition are the same fact stated twice. Idle mode ships a
  // single line carrying the state, the capture identity, and the honest
  // disposition — `unknown` still never reads as `none`.
  if (delta.files.length === 0 && (delta.state === 'none' || delta.state === 'unknown')) {
    const disposition = delta.state === 'none'
      ? 'Exact immutable capture proved zero open attributable diffs.'
      : 'Active edit state is unknown; absence of evidence is not rendered as none.';
    lines[0] = `state=${delta.state} · capture=${delta.captureId ?? 'unknown'} · ${disposition}`;
  }
  const trailer: string[] = [];
  if (delta.inheritedCaptureIds.length > 0) trailer.push(`inherited-captures=${delta.inheritedCaptureIds.join(',')}`);
  if (delta.truncated || delta.omittedFiles > 0) {
    trailer.push(`capture partial: omitted-files=${delta.omittedFiles} recover=${recoveryHandle || 'unavailable'}`);
  }
  for (const reason of delta.reasons) trailer.push(`reason=${reason}`);
  const units = buildActiveEditCollapseUnits(model);
  if (units.length === 0) {
    const text = [...lines, ...trailer].join('\n');
    return { text: boundedWholeLines(text, maxChars, recoveryHandle), complete: text.length <= maxChars };
  }
  // Collapse citizenship: the state header and capture-honesty trailer stay
  // verbatim-protected; per-file blocks demote through the generational engine
  // so an over-budget AED leaves receipts and ledger rows, never a bare cut.
  const headerText = lines.join('\n');
  const trailerText = trailer.length > 0 ? `\n${trailer.join('\n')}` : '';
  const body = collapseWithReceipt(
    units,
    maxChars - headerText.length - 1 - trailerText.length,
    omissionHandle ?? recoveryHandle,
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

/**
 * Budget-pressure survival order for cognitive rows; highest survives.
 *
 * A deliberately coarser projection of the relay harvester's
 * `artifactProjectionPriority` ladder (rebirthCognitiveArtifacts.ts), and
 * coarser by necessity: a v6 row carries only `kind`, which is already a lossy
 * mapping of the upstream (type, label, glyph) triple. This is defense in
 * depth, not a competing policy — the v7 lane must degrade sanely for rows
 * from ANY source (persisted legacy models, standalone lineage, callers that
 * never ran the relay's priority pass), and a lane that only behaves when its
 * usual feeder behaves is not a guarantee.
 *
 * `question` leads because an unresolved open loop is the most expensive thing
 * for a successor to rediscover; `flow` trails because in-progress process
 * voice is superseded by design.
 */
const COGNITION_KIND_PRIORITY: Record<RebirthPackageV6CognitiveArtifact['kind'], number> = {
  question: 100,
  decision: 88,
  hazard: 84,
  result: 82,
  // S5 (audit-3 B7/B1): a 🧭 active-request row carries continuity intent and
  // survives above ordinary discoveries/flow, but below terminal verdicts —
  // it is an observation, never a decision (Decisions rank above it).
  active_request: 80,
  discovery: 76,
  flow: 55,
};

/** Age demotion: two points per 12 h of age since capture, capped at 24, so a
 *  week-old decision (88 − 24 = 64) yields to a fresh discovery (76) and a
 *  two-day-old decision (80) to a fresh result (82). Kind still leads inside
 *  one age band. Without a capture reference no demotion applies (no recency
 *  claim can be made against an unknown clock — GOD RULE 8). */
const COGNITION_AGE_DEMOTION_STEP_MS = 12 * 60 * 60 * 1000;
const COGNITION_AGE_DEMOTION_PER_STEP = 2;
const COGNITION_AGE_DEMOTION_CAP = 24;
/** Floor-protected rows (`retention=lineage-floor`) are admitted ahead of
 *  every unprotected row: the selector kept them alive deliberately, and a
 *  render-stage budget pass dropping them whole silently defeated that floor
 *  (audit-4 C1: zero `kept-by=` rows survived a 63-row render). */
const COGNITION_RETENTION_ADMISSION_BONUS = 1_000;

function cognitionAdmissionScore(
  row: RebirthPackageV6CognitiveArtifact,
  referenceMs: number,
): number {
  const base = COGNITION_KIND_PRIORITY[row.kind];
  if (row.retention) return base + COGNITION_RETENTION_ADMISSION_BONUS;
  const sourceMs = row.sourceAt ? Date.parse(row.sourceAt) : Number.NaN;
  if (!Number.isFinite(referenceMs) || !Number.isFinite(sourceMs) || referenceMs <= sourceMs) return base;
  const steps = Math.floor((referenceMs - sourceMs) / COGNITION_AGE_DEMOTION_STEP_MS);
  return base - Math.min(COGNITION_AGE_DEMOTION_CAP, steps * COGNITION_AGE_DEMOTION_PER_STEP);
}

/**
 * Admission order under pressure: retention floor, then age-demoted kind
 * priority, then newest-first source time, then provenance id. Unknown-time
 * rows sort after known-time peers of the same score — not because they are
 * less valuable, but because they make no recency claim, so preferring a dated
 * peer is the only defensible tie-break (GOD RULE 8). Total and pure, so two
 * identical builds admit an identical set.
 */
function compareCognitionAdmission(
  left: RebirthPackageV6CognitiveArtifact,
  right: RebirthPackageV6CognitiveArtifact,
  referenceMs: number = Number.NaN,
): number {
  const byPriority = cognitionAdmissionScore(right, referenceMs) - cognitionAdmissionScore(left, referenceMs);
  if (byPriority !== 0) return byPriority;
  const leftMs = left.sourceAt ? Date.parse(left.sourceAt) : Number.NaN;
  const rightMs = right.sourceAt ? Date.parse(right.sourceAt) : Number.NaN;
  const leftKnown = Number.isFinite(leftMs);
  const rightKnown = Number.isFinite(rightMs);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (leftKnown && rightKnown && leftMs !== rightMs) return rightMs - leftMs;
  return left.provenanceId.localeCompare(right.provenanceId);
}

function cognitionRowBody(
  row: RebirthPackageV6CognitiveArtifact,
  referenceAt: string | null,
  sourceText?: string,
  recovery?: string | null,
  compact = false,
): string {
  const declared = row.projection === 'truncated'
    ? ` · projection=truncated stored=${row.storedChars ?? row.text.length}/${row.sourceChars ?? 'unknown'} chars`
    : '';
  const retention = row.retention ? ` · kept-by=${row.retention}` : '';
  const stamp = row.sourceAt ? formatDisplayStamp(row.sourceAt, referenceAt) : 'unknown';
  let excerpt = '';
  if (row.projection === 'truncated' && sourceText?.startsWith(row.text)
    && ['decision', 'hazard', 'result', 'question'].includes(row.kind)) {
    // Supplement the legacy attested prefix with an explicitly separate,
    // exact-source closing paragraph. Never pass this display supplement off
    // as the ledger's stored prefix or as a generated historical conclusion.
    const lower = Math.max(row.text.length, sourceText.length - 900);
    const paragraph = sourceText.indexOf('\n\n', lower);
    const start = paragraph >= lower && paragraph + 2 < sourceText.length
      ? paragraph + 2 : sourceText.indexOf(' ', lower) + 1;
    if (start > row.text.length && start < sourceText.length) {
      const tail = sourceText.slice(start);
      const hash = createHash('sha256').update(tail).digest('hex');
      excerpt = compact
        ? `\n[exact closing excerpt · characters ${start}..${sourceText.length}]\n${tail}\n[/exact closing excerpt]`
        : `\n[exact-source-excerpt/v1 · source=${row.provenanceId} · utf16-range=${start}..${sourceText.length} · sha256=${hash} · recover=${recovery ?? 'unavailable'}]\n${tail}\n[/exact-source-excerpt]`;
    }
  }
  // D1: the compact row keeps the body and every attestation that rides with
  // it (including the exact-source excerpt of a late ruling) and moves the
  // provenance to one trailing anchor. `retention` is selector diagnostics and
  // does not survive; `projection=truncated` becomes the `[partial]` token the
  // package legend defines.
  if (compact) {
    const labels = `${row.projection === 'truncated' ? ' [partial]' : ''}`
      + `${row.supersededBy ? ` [EXPIRED → ${row.supersededBy}]` : ''}`
      + (row.authority === 'historical_observation' ? '' : ` [${row.authority}]`);
    return `${row.kind}${labels}\n${row.text}${excerpt}\n${continuityAnchor(compactCognitionSource(row.provenanceId, sourceText ?? row.text), row.sourceAt, referenceAt)}`;
  }
  return `${row.kind} · ${row.text} · source=${compactCognitionSource(row.provenanceId, row.text)} · source-time=${stamp} · authority=${row.authority}${retention}${declared}${excerpt}`;
}

function cognitionSuppressionHeader(
  total: number,
  shown: number,
  suppressed: readonly RebirthPackageV6CognitiveArtifact[],
  boundaryDedupedCount: number,
  renderedTruncatedCount: number,
  incompleteCount: number,
  totalMatched: number | null,
  omissionHandle: string | null,
  capture: RebirthPackageV6CognitiveArtifactCapture | undefined,
  relayRecoveryHandle: string | null,
): string {
  const byKind = new Map<string, number>();
  for (const row of suppressed) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  const parts = [
    `cognition: rendered=${shown} captured=${total} matched=${totalMatched ?? 'unknown'}`,
    // These are disjoint rendered populations: every dropped-whole row plus
    // every kept row whose body is truncated. A truncated row that was also
    // dropped belongs only to suppressed-whole, so the two visible counters
    // add exactly to incomplete-rows without a hidden overlap.
    `incomplete-rows=${incompleteCount} (=suppressed-whole + rendered-truncated)`,
  ];
  if (suppressed.length > 0) {
    const counts = [...byKind.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([kind, count]) => `${kind}:${count}`)
      .join(', ');
    parts.push(`suppressed{${counts}} dropped-whole by lowest budget priority`);
  }
  if (boundaryDedupedCount > 0) parts.push(`dedupe{boundary:${boundaryDedupedCount}}`);
  if (renderedTruncatedCount > 0) {
    parts.push(`projected{rendered-truncated:${renderedTruncatedCount}}`);
  }
  const relaySuppression = capture?.relaySuppression;
  if (relaySuppression) {
    const relaySelectionSuppressed = relaySuppression.rootDuplicate
      + relaySuppression.superseded
      + relaySuppression.crossSection
      + relaySuppression.unknownSourceTime
      + relaySuppression.overBudget
      + relaySuppression.unattributed;
    const upstreamRejected = relaySuppression.duplicate + relaySuppression.frontier;
    // `captured` above is the relay-selected count, so repeating it here would
    // spend scarce cognition budget without adding information. Keep every
    // suppression class explicit, but let the visible matched→captured
    // arithmetic carry the selection total.
    parts.push(
      'relay-drops{'
      + `root:${relaySuppression.rootDuplicate},`
      + `superseded:${relaySuppression.superseded},`
      + `thread:${relaySuppression.crossSection},`
      + `unknown-time:${relaySuppression.unknownSourceTime},`
      + `budget:${relaySuppression.overBudget},`
      + `other:${relaySuppression.unattributed}}`,
    );
    parts.push(
      'upstream-rejects{'
      + `duplicate:${relaySuppression.duplicate},`
      + `frontier:${relaySuppression.frontier}}`,
    );
    const adapterDropped = Math.max(0, (capture?.selectedCount ?? total) - total);
    if (adapterDropped > 0) parts.push(`adapter-dropped=${adapterDropped}`);
    if (relaySelectionSuppressed > 0 || upstreamRejected > 0 || adapterDropped > 0) {
      parts.push(`relay-recover=${relayRecoveryHandle ?? 'unavailable'}`);
    }
  }
  if (incompleteCount > 0) parts.push(omissionRecoveryClause(omissionHandle));
  return `[${parts.join(' · ')}]`;
}

/**
 * Render the cognition section, degrading by WHOLE units rather than by
 * characters.
 *
 * The previous implementation joined every row and handed the result to
 * `boundedText`, which slices at the character budget. That slice lands
 * wherever it lands: mid-body, mid-provenance, mid-timestamp. A body cut
 * mid-sentence still reads as a finished thought, and a row whose provenance
 * tail was cut off is unrecoverable — the reader cannot tell it was truncated,
 * and cannot look it up. Dropping the whole unit and counting it in the header
 * is strictly more honest: the successor learns exactly what is missing, in
 * what class, and how to get it.
 *
 * Newest-first presentation for timestamped cognition is preserved
 * deliberately (Atlas #40280); pressure therefore costs the oldest rows within
 * a priority band, which is the intended semantic.
 */
/**
 * Dialogue ownership handed to renderCognition. `candidates` are the dialogue
 * identities the Timeline may render (dialogueCandidateKeys); `placements` are
 * the conversation section's actual unit placements when that section has
 * already rendered, so a dialogue-owned artifact can report where its one
 * rendering went instead of claiming a second one.
 */
interface CognitionDialogueOwnership {
  readonly candidates: ReadonlySet<string>;
  readonly placements?: ReadonlyMap<string, RebirthPackageV6UnitPlacement>;
}

function renderCognition(
  model: RebirthPackageV6Model,
  maxChars: number,
  references: RebirthRecoveryReferenceCatalog,
  compact = false,
  dialogue?: CognitionDialogueOwnership,
): RenderedV6SectionBody {
  const recoveryHandle = recoveryReference(
    references,
    model.recoveryIndex.find((entry) => entry.id === 'cognition')?.handle,
  );
  const omissionHandle = recoveryReference(
    references,
    continuityLedgerOmissionHandle(model, 'cognitiveArtifacts'),
  );
  const recovery = recoveryHandle ? `recover=${recoveryHandle}` : 'exact recovery unavailable';
  const capture = model.cognitiveArtifactCapture;
  const boundaryBodies = new Set<string>();
  const addBoundaryBody = (value: string | null | undefined): void => {
    const body = value?.trim();
    if (body) boundaryBodies.add(body);
  };
  addBoundaryBody(model.boundaryAndActiveTask.activeRequest?.text);
  addBoundaryBody(model.boundaryAndActiveTask.lastMaterialAssistant?.text);
  addBoundaryBody(model.boundaryAndActiveTask.activeRequestClaims?.latest.text);
  addBoundaryBody(model.boundaryAndActiveTask.activeRequestClaims?.previous?.text);
  // One unit, one owner: an artifact whose identity is a dialogue candidate is
  // the dialogue's unit. It leaves this section's budget, header counts and
  // census entirely; its placement below mirrors the dialogue row's, so the
  // ledger records the single rendering it actually received.
  const dialogueOwnedRows = model.cognitiveArtifacts.filter((row) => (
    dialogue?.candidates.has(dialogueUnitKey(row.provenanceId)) ?? false
  ));
  const dialogueOwnedIds = new Set(dialogueOwnedRows.map((row) => row.provenanceId));
  const dialogueOwnedPlacements: RebirthPackageV6UnitPlacement[] = dialogueOwnedRows.map((row) => {
    const mirrored = dialogue?.placements?.get(dialogueUnitKey(row.provenanceId));
    return {
      id: row.provenanceId,
      placement: mirrored?.placement ?? 'elided',
      projected: mirrored?.projected ?? false,
    };
  });
  const allSourceRows = model.cognitiveArtifacts.filter((row) => !dialogueOwnedIds.has(row.provenanceId));
  const rawIds = new Set(selectRebirthHotTail(model.rawHotTail ?? []).rows.map((row) => hotTailIdentity(row.id)));
  const sourceRows = allSourceRows.filter((row) => !boundaryBodies.has(row.text.trim()))
    .map((row) => rawIds.has(hotTailIdentity(row.provenanceId))
      ? { ...row, text: '→ Exact source appears in Raw hot tail.', projection: undefined } : row);
  const fullTextById = new Map(sourceRows.filter((row) => row.projection !== 'truncated').map((row) => [row.provenanceId, row.text]));
  const boundaryDedupedCount = allSourceRows.length - sourceRows.length;

  // Protected tail. The capture receipt is what stops "few rows" from reading
  // as "this agent barely thought", so it survives pressure that rows do not.
  const tail: string[] = [];
  if (capture) {
    tail.push([
      `Capture receipt: status=${capture.status}`,
      `captured-at=${capture.capturedAt ?? 'unknown'}`,
      `total-matched=${capture.totalMatched ?? 'unknown'}`,
      `overlay=${capture.overlayCount ?? 'unknown'}`,
    ].join(' · '));
    if (capture.missingFamilies.length > 0) {
      // Honest rendering of the missing-family signal: a COMPLETE indexed
      // selection that merely lacks backfill watermark attestation (the
      // scheduler was disabled, relay/src/index.ts:1345 #41961) is not a
      // failed capture. Only a partial/unavailable capture is genuine non-
      // completeness, and even then a family with matched rows is present
      // (measured), not absent. Both cases render factually, never as the old
      // bare "Missing indexed families" that read as data loss.
      if (capture.status === 'complete') {
        tail.push(
          `Backfill watermarks not attested for: ${capture.missingFamilies.join(', ')} (indexed capture complete; backfill scheduler disabled since #41961)`,
        );
      } else if ((capture.totalMatched ?? 0) > 0) {
        tail.push(
          `Backfill watermarks not attested for: ${capture.missingFamilies.join(', ')} (matched ${capture.totalMatched} root(s) — non-attestation is measured, not absence)`,
        );
      } else {
        tail.push(`Missing indexed families: ${capture.missingFamilies.join(', ')}`);
      }
    }
    if (capture.warnings.length > 0) {
      tail.push('Capture warnings:');
      for (const warning of capture.warnings) tail.push(`- ${warning}`);
    }
  }

  const renderRows = (
    rows: readonly RebirthPackageV6CognitiveArtifact[],
    demandProbe: boolean,
  ): RenderedV6SectionBody | null => {
    const referenceAt = model.boundaryAndActiveTask.capturedAt;
    const rowBodies = new Map(rows.map((row) => [row.provenanceId,
      cognitionRowBody(row, referenceAt, fullTextById.get(row.provenanceId), recoveryHandle)]));
    const compactRowBodies = new Map(rows.map((row) => [row.provenanceId,
      cognitionRowBody(row, referenceAt, fullTextById.get(row.provenanceId), recoveryHandle, true)]));
    const assemble = (keep: readonly RebirthPackageV6CognitiveArtifact[]): string => {
      const kept = new Set(keep.map((row) => row.provenanceId));
      const suppressed = rows.filter((row) => !kept.has(row.provenanceId));
      const renderedTruncatedCount = keep.filter((row) => row.projection === 'truncated').length;
      const incompleteCount = suppressed.length + renderedTruncatedCount;
      const lines: string[] = [];
      lines.push(
        cognitionSuppressionHeader(
          allSourceRows.length,
          keep.length,
          suppressed,
          boundaryDedupedCount,
          renderedTruncatedCount,
          incompleteCount,
          capture?.totalMatched ?? null,
          incompleteCount > 0 ? omissionHandle : null,
          capture,
          recoveryHandle,
        ),
        '',
      );
      const known = keep
        .filter((row) => row.sourceAt)
        .sort((left, right) => right.sourceAt!.localeCompare(left.sourceAt!)
          || right.provenanceId.localeCompare(left.provenanceId));
      const unknown = keep.filter((row) => !row.sourceAt);
      const referenceAt = model.boundaryAndActiveTask.capturedAt;
      for (const row of known) lines.push(compact ? compactRowBodies.get(row.provenanceId)!
        : `${formatDisplayStamp(row.sourceAt, referenceAt)} · ${rowBodies.get(row.provenanceId)}`);
      if (unknown.length > 0) {
        lines.push('', 'Unknown source time (quarantined; not part of the chronology):');
        for (const row of unknown) lines.push(compact ? compactRowBodies.get(row.provenanceId)! : `- ${rowBodies.get(row.provenanceId)}`);
      }
      if (keep.length === 0) {
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
      if (tail.length > 0) lines.push('', ...tail);
      return lines.join('\n');
    };

    // Drop whole units, lowest admission priority first. The header shrinks as
    // counts change, so the fit is re-evaluated against the real assembled text
    // rather than an estimate that could overshoot the cap.
    const admissionReferenceMs = Date.parse(model.boundaryAndActiveTask.capturedAt ?? '');
    let keep = [...rows].sort((left, right) => compareCognitionAdmission(left, right, admissionReferenceMs));
    let text = assemble(keep);
    // A demand probe claims full fidelity only when EVERY row ships whole; any
    // overflow abandons the probe instead of silently degrading inside it.
    if (demandProbe && text.length > maxChars) return null;
    while (keep.length > 0 && text.length > maxChars) {
      keep = keep.slice(0, -1);
      text = assemble(keep);
    }
    // Scarcity projections are a starting point, not a permanent ceiling.
    // Restore newest retained source bodies while space remains, without
    // evicting another admitted artifact to pay for an expansion.
    const expandedIds = new Set<string>();
    if (!demandProbe) {
      const newest = [...keep].sort((a, b) => (b.sourceAt ?? '').localeCompare(a.sourceAt ?? '')
        || a.provenanceId.localeCompare(b.provenanceId));
      for (const row of newest) {
        if (row.projection !== 'truncated') continue;
        const original = sourceRows.find((candidate) => candidate.provenanceId === row.provenanceId && candidate.projection !== 'truncated');
        if (!original) continue;
        const bodies = compact ? compactRowBodies : rowBodies;
        const previousBody = bodies.get(row.provenanceId)!;
        const restoredBody = cognitionRowBody(original, referenceAt, undefined, recoveryHandle, compact);
        if (text.length + restoredBody.length - previousBody.length > maxChars) continue;
        bodies.set(row.provenanceId, restoredBody);
        const candidate = keep.map((entry) => entry.provenanceId === row.provenanceId ? original : entry);
        const restored = assemble(candidate);
        if (restored.length > maxChars) {
          bodies.set(row.provenanceId, previousBody);
          continue;
        }
        keep = candidate;
        text = restored;
        expandedIds.add(row.provenanceId);
        rowBodies.set(row.provenanceId, cognitionRowBody(original, referenceAt, undefined, recoveryHandle));
        compactRowBodies.set(row.provenanceId, cognitionRowBody(original, referenceAt, undefined, recoveryHandle, true));
      }
    }
    const keptIds = new Set(keep.map((row) => row.provenanceId));
    // Distinct units carry this section's own outcome; dialogue-owned units
    // carry the mirrored dialogue outcome and stay out of every count below.
    const unitPlacements: RebirthPackageV6UnitPlacement[] = [
      ...rows.map((row) => ({
        id: row.provenanceId,
        placement: keptIds.has(row.provenanceId) ? 'rendered' as const : 'elided' as const,
        projected: row.projection === 'truncated' && !expandedIds.has(row.provenanceId),
      })),
      ...dialogueOwnedPlacements,
    ];
    const incomplete = rows.length - keep.length + keep.filter((row) => row.projection === 'truncated').length;
    const timeline = {
      timelineRows: keep.map((row) => ({
        id: dialogueUnitKey(row.provenanceId),
        sourceAt: row.sourceAt,
        text: rowBodies.get(row.provenanceId)!,
        compactText: compactRowBodies.get(row.provenanceId)!,
      })),
      timelineSummary: [
        cognitionSuppressionHeader(
          allSourceRows.length, keep.length,
          rows.filter((row) => !keptIds.has(row.provenanceId)),
          boundaryDedupedCount,
          keep.filter((row) => row.projection === 'truncated').length,
          incomplete,
          capture?.totalMatched ?? null,
          incomplete > 0 ? omissionHandle : null,
          capture, recoveryHandle,
        ),
        ...tail,
      ].join('\n'),
      timelineCensus: {
        captured: allSourceRows.length,
        rendered: keep.length,
        matched: capture?.totalMatched ?? null,
        incomplete,
        omissionCommand: incomplete > 0
          ? captureScopedLedgerCommand(continuityLedgerOmissionHandle(model, 'cognitiveArtifacts'))
            ?? captureScopedOmissionCommand(model)
          : null,
      },
    };
    // Even the protected tail can exceed a pathologically small cap (or the
    // whole-exchange slack the conversation-first allocator leaves behind).
    // The section contract (never exceed maxChars) is kept with whole receipt
    // lines, never a character slice, and the timeline census still counts
    // every evicted unit with its ledger route — an empty body is declared
    // eviction, not silent absence.
    if (text.length > maxChars) {
      return {
        text: boundedWholeLines(text, maxChars, recoveryHandle),
        complete: false,
        unitPlacements,
        ...timeline,
      };
    }
    return {
      text,
      complete: keep.length === rows.length
        && keep.every((row) => row.projection !== 'truncated'),
      unitPlacements,
      ...timeline,
    };
  };

  // Demand-first fill (dynamic fill, operator directive 2026-08-26): while the
  // allocation covers the section's full demand, every body ships whole — no
  // per-entry projection, no drops. The bodies-only sum is a cheap lower bound
  // that skips the full assembly under obvious contention, so contended
  // renders never build a throwaway megastring inside the water-fill loop.
  const fullBodyFloor = sourceRows.reduce((total, row) => total + row.text.length, 0);
  if (fullBodyFloor <= maxChars) {
    const full = renderRows(sourceRows, true);
    if (full) return full;
  }
  // Contention: the pre-dynamic scarcity behavior, unchanged (#41011) — every
  // row at its declared per-entry projection, then whole-unit drops by
  // admission priority. projectCognitiveRow is idempotent, so persisted
  // pre-projected rows pass through byte-identically. The projection reference
  // instant is the model's own capturedAt (audit-2 A22), so a contended render
  // and its ledger capture agree byte-for-byte for the same model.
  const referenceAt = model.boundaryAndActiveTask.capturedAt;
  const lifeBoundaryStarts = cognitiveLifeBoundaryStarts(model);
  return renderRows(sourceRows.map((row) => projectCognitiveRow(row, referenceAt, lifeBoundaryStarts)), false)!;
}

function conversationRowText(
  row: RebirthPackageV6ConversationRow,
  referenceAt: string | null,
  recoveryHandle: string | null,
  compactAnchor?: string,
): string {
  const baseProvenance = conversationRowBaseId(row.provenanceId);
  // Audit-2 A1: a coalesced message keeps one envelope on the base id and
  // renders visible `⟨segment-N⟩` seam markers at the recorded offsets. The
  // model text stays the byte-exact delta join; markers are render-only.
  const seamMarkers = row.segmentOffsets?.length
    ? renderConversationSeams(row.text, row.segmentOffsets)
    : null;
  const text = seamMarkers ?? row.text;
  // Measure real demand. Only the exchange allocator may omit source text;
  // a fixed row cap must not discard reasoning while capacity sits unused.
  const renderedText = text;
  const projectedReply = false;
  const projection = '';
  // Presentation changes the envelope, never the excerpt admitted by budget.
  if (compactAnchor !== undefined) {
    return `${row.role}${projectedReply ? ' [partial]' : ''}\n${renderedText}\n${compactAnchor}`;
  }
  const segments = row.segmentOffsets?.length
    ? ` · segments=${row.segmentOffsets.length + 1}`
    : '';
  // Audit-3 C5: display stamp compaction; the store keeps exact ms.
  const stamp = row.sourceAt ? formatDisplayStamp(row.sourceAt, referenceAt) : 'unknown';
  return `[${row.role} · source=${baseProvenance}${segments} · source-time=${stamp}]\n${renderedText}${projection}`;
}

/** Render-only seam markers for a coalesced segmented message (audit-2 A1). */
function renderConversationSeams(text: string, offsets: readonly number[]): string {
  let out = '';
  let cursor = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index];
    if (offset < cursor || offset > text.length) continue;
    out += text.slice(cursor, offset);
    out += `⟨segment-${index + 1}⟩`;
    cursor = offset;
  }
  return `${out}${text.slice(cursor)}`;
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
    const exchangeKey = (row: RebirthPackageV6ConversationRow): string => (
      row.exchangeId ?? `${row.role}:${conversationRowBaseId(row.provenanceId)}`
    );
    const countExchanges = (rows: readonly RebirthPackageV6ConversationRow[]): number => (
      new Set(rows.map(exchangeKey)).size
    );
    const retainedKeys = new Set(args.retainedKnown.map(exchangeKey));
    const omittedExchanges = new Set(
      args.omittedKnown.map(exchangeKey).filter((key) => !retainedKeys.has(key)),
    ).size;
    const retainedExchanges = countExchanges(args.retainedKnown);
    const omittedChars = args.omittedKnown.reduce((total, row) => total + row.text.length, 0);
    const retainedFrom = args.retainedKnown[0]?.sourceAt ?? null;
    const recover = args.recoveryHandle
      ? `${args.recoveryHandle} after=${last}`
      : null;
    const marker = formatOmissionMarkerV2({
      entries: omittedExchanges,
      chars: omittedChars,
      kept: retainedExchanges,
      total: omittedExchanges + retainedExchanges,
      unit: 'exchange',
      range: { from: first, to: last, retainedFrom },
      recover,
    });
    // S2's exchange receipt carries both selection units and physical rows.
    // Keep B9's canonical helper as the grammar owner and add the row census at
    // its stable chars seam rather than minting a second marker dialect.
    parts.push(marker.replace(
      ` · ${omittedChars} chars`,
      ` · omitted-rows=${args.omittedKnown.length} · ${omittedChars} chars`,
    ).slice(3, -1));
  }
  if (args.omittedUnknown.length > 0) {
    parts.push(
      `${args.omittedUnknown.length} unknown-time quarantine row${args.omittedUnknown.length === 1 ? '' : 's'} omitted`,
    );
  }
  if (args.latestKnownTailOmitted) parts.push('latest-known-row-tail omitted');
  if (args.omittedKnown.length === 0) {
    parts.push(args.recoveryHandle ? `recover: ${args.recoveryHandle}` : 'exact recovery unavailable');
  }
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
  const minimalMarker = '[… latest-tail=omitted …]';
  const minimumBodyChars = Math.min(16, args.row.text.length);

  // Under a very small caller override, provenance plus the full omission
  // receipt can be larger than the entire section allowance. Try progressively
  // smaller envelopes, but never let either envelope displace the newest known
  // row's content. The Recovery Index remains the canonical recovery directory.
  for (const [header, marker] of [
    [fullHeader, fullMarker],
    [compactHeader, compactMarker],
    ['', compactMarker],
    ['', minimalMarker],
  ] as const) {
    const bodyChars = args.maxChars - header.length - marker.length - 2;
    if (bodyChars < minimumBodyChars) continue;
    return `${header}${args.row.text.slice(0, bodyChars)}\n\n${marker}`;
  }
  return args.row.text.slice(0, args.maxChars);
}

function conversationEndpointReceipt(model: RebirthPackageV6Model): string {
  const endpoints: string[] = [];
  const activeRequest = model.boundaryAndActiveTask.activeRequest;
  if (activeRequest) {
    endpoints.push(
      `- active-request · rendered-as=EXACT ACTIVE REQUEST · ${formatSource(activeRequest.source)}`,
    );
  }
  const lastAssistant = model.boundaryAndActiveTask.lastMaterialAssistant;
  if (lastAssistant) {
    endpoints.push(
      `- last-material-assistant · rendered-as=LAST MATERIAL ASSISTANT · ${formatSource(lastAssistant.source)}`,
    );
  }
  if (endpoints.length === 0) return '';
  return [
    'Endpoint relocation receipt (message bodies render exactly once in Boundary and Active Task):',
    ...endpoints,
    `Additional recent-dialogue rows retained here: ${model.recentConversation.length}.`,
  ].join('\n');
}

/**
 * S29 — chronological pointer stubs for the promoted endpoint messages.
 *
 * `normalizeConversationRows` removes the active-request and last-material-assistant
 * BODIES from this section so each renders exactly once (Boundary and Active Task).
 * Dropping the ROW as well ends the delivered chronology at a SUPERSEDED message:
 * on the 2026-09-09T09:21Z package a blinded probe lane read the operator's
 * second-newest words back as their latest instruction. Precedent #27966 fixed this
 * same class in the thinking trail by restoring skipped rows as one-line pointer
 * breadcrumbs — chronological completeness without duplicating the body. These
 * stubs are that breadcrumb, carrying the endpoint's own authoritative identity.
 *
 * God Rule 8: an endpoint whose source time is unknown makes no recency claim and
 * is omitted here rather than guessed into the order; the endpoint relocation
 * receipt still names it. Stub ids reuse the message's base id so the timeline's
 * one-row-per-message dedupe can never place a stub beside its own body.
 */
function conversationEndpointStubs(
  model: RebirthPackageV6Model,
  referenceAt: string | null,
): RebirthTimelineRow[] {
  const stubs: RebirthTimelineRow[] = [];
  const add = (
    message: RebirthPackageV6ExactMessage | null,
    role: 'user' | 'assistant',
    promotedAs: string,
    note: string,
  ): void => {
    if (!message) return;
    const sourceAt = knownSourceTime(message.source.sourceAt);
    if (!sourceAt) return;
    const id = dialogueUnitKey(message.source.provenanceId);
    const body = `\u2192 ${note}; source ${message.chars} chars. See ${promotedAs} in Boundary (any truncation is declared there).`;
    stubs.push({
      id,
      sourceAt,
      text: `[${role} \u00b7 source=${id} \u00b7 source-time=${formatDisplayStamp(sourceAt, referenceAt)}`
        + ` \u00b7 promoted=${promotedAs}]\n${body}`,
      compactText: `${role}\n${body}\n${continuityAnchor(id, sourceAt, referenceAt)}`,
    });
  };
  add(model.boundaryAndActiveTask.activeRequest, 'user', 'EXACT ACTIVE REQUEST', 'newest operator message');
  add(
    model.boundaryAndActiveTask.lastMaterialAssistant,
    'assistant',
    'LAST MATERIAL ASSISTANT',
    'newest material assistant message',
  );
  return stubs;
}

/**
 * Merge endpoint stubs into an ascending rendered-row list at their source-time
 * position. Existing rows keep their order and bytes exactly; a stub only claims
 * the first slot where a later-stamped row would follow it.
 */
function mergeEndpointStubText(
  renderedRows: readonly string[],
  rows: readonly RebirthPackageV6ConversationRow[],
  stubs: readonly RebirthTimelineRow[],
): string[] {
  if (stubs.length === 0) return [...renderedRows];
  const stubMs = (stub: RebirthTimelineRow): number => Date.parse(stub.sourceAt ?? '');
  const ordered = [...stubs].sort((left, right) => stubMs(left) - stubMs(right));
  const out: string[] = [];
  let cursor = 0;
  for (const stub of ordered) {
    while (cursor < renderedRows.length) {
      const rowAt = knownSourceTime(rows[cursor]?.sourceAt);
      const rowMs = rowAt ? Date.parse(rowAt) : Number.NaN;
      if (Number.isFinite(rowMs) && rowMs > stubMs(stub)) break;
      out.push(renderedRows[cursor]!);
      cursor += 1;
    }
    out.push(stub.text);
  }
  for (; cursor < renderedRows.length; cursor += 1) out.push(renderedRows[cursor]!);
  return out;
}

/**
 * Identities of every dialogue candidate the Timeline may render — recent
 * conversation rows plus (when the vault is folded into the chronology) the
 * frontier-checked vault-only operator units. Cognition consults this set to
 * decide which of its artifacts the dialogue already owns.
 */
function dialogueCandidateKeys(model: RebirthPackageV6Model, includeVault: boolean): ReadonlySet<string> {
  const rows = includeVault ? conversationWithVault(model) : model.recentConversation;
  return new Set(rows.map((row) => dialogueUnitKey(row.provenanceId)));
}

function conversationWithVault(model: RebirthPackageV6Model): readonly RebirthPackageV6ConversationRow[] {
  const rows = [...model.recentConversation];
  const key = dialogueUnitKey;
  const seen = new Set(rows.map((row) => key(row.provenanceId)));
  for (const endpoint of [model.boundaryAndActiveTask.activeRequest, model.boundaryAndActiveTask.lastMaterialAssistant]) {
    if (endpoint) seen.add(key(endpoint.source.provenanceId));
  }
  // These units have already passed capture's lineage/frontier gate. Never
  // query additional owners or expand ancestry while preparing a render.
  for (const unit of model.operatorVault?.units ?? []) {
    if (unit.kind !== 'operator' || seen.has(key(unit.id))) continue;
    const text = unit.verbatim.replace(/^\[operator · source=[^\n]+\]\n/u, '');
    if (!text.trim()) continue;
    seen.add(key(unit.id));
    rows.push({ provenanceId: unit.id, sourceAt: knownSourceTime(unit.sourceAt), role: 'user',
      text: unit.projection ? `${text}\n[partial historical operator source]` : text,
      exchangeId: unit.id });
  }
  return rows.sort((a, b) => {
    const left = knownSourceTime(a.sourceAt);
    const right = knownSourceTime(b.sourceAt);
    return left && right ? Date.parse(left) - Date.parse(right) || a.provenanceId.localeCompare(b.provenanceId)
      : left ? -1 : right ? 1 : a.provenanceId.localeCompare(b.provenanceId);
  });
}

function renderConversation(
  model: RebirthPackageV6Model,
  maxChars: number,
  references: RebirthRecoveryReferenceCatalog,
  compact = false,
  includeVault = true,
): RenderedV6SectionBody {
  // God Rule 8: unknown source time never participates in the chronology. Known-time
  // rows stream chronologically; unknown-time rows are quarantined under an explicit
  // banner (mirroring renderCognition and renderExecution) where they make no recency
  // claim and can never be mistaken for a continuous dialogue sequence.
  const rawIds = new Set(selectRebirthHotTail(model.rawHotTail ?? []).rows.map((row) => hotTailIdentity(row.id)));
  const conversation = (includeVault ? conversationWithVault(model) : model.recentConversation)
    .map((row) => rawIds.has(hotTailIdentity(row.provenanceId))
      ? { ...row, text: '→ Exact source appears in Raw hot tail.' } : row);
  const known = conversation.filter((row) => row.sourceAt);
  const unknown = conversation.filter((row) => !row.sourceAt);
  // Audit-3 C5: display stamps trim ms (and year when it matches capture); the
  // reference instant is the model's own capturedAt for determinism.
  const referenceAt = model.boundaryAndActiveTask.capturedAt;
  const recoveryHandle = recoveryReference(
    references,
    model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle,
  );
  const renderRow = (row: RebirthPackageV6ConversationRow): string => (
    conversationRowText(row, referenceAt, recoveryHandle, compact
      ? continuityAnchor(conversationRowBaseId(row.provenanceId), row.sourceAt, referenceAt) : undefined)
  );
  const endpointStubs = conversationEndpointStubs(model, referenceAt);
  // Stubs are structural, but they are not free. Under extreme pressure the
  // overflow path below drops them rather than let a two-line pointer evict a
  // real exchange from the section the operator ranked highest.
  let activeStubs: readonly RebirthTimelineRow[] = endpointStubs;
  const placementsFor = (
    renderedRows: readonly RebirthPackageV6ConversationRow[],
    projectedIds: ReadonlySet<string> = new Set(),
  ): RebirthPackageV6UnitPlacement[] => {
    const renderedIds = new Set(renderedRows.map((row) => conversationRowBaseId(row.provenanceId)));
    return conversation.map((row) => {
      const id = conversationRowBaseId(row.provenanceId);
      return {
        id,
        placement: renderedIds.has(id) ? 'rendered' : 'elided',
        projected: projectedIds.has(id) || Boolean(model.operatorVault?.units.find((unit) => unit.id === id)?.projection),
      };
    });
  };
  const censusFor = (
    placements: readonly RebirthPackageV6UnitPlacement[],
  ): RebirthTimelineCensus => ({
    captured: conversation.length,
    rendered: placements.filter((placement) => placement.placement === 'rendered').length,
    matched: null,
    incomplete: placements.filter((placement) => placement.placement !== 'rendered' || placement.projected).length,
    omissionCommand: placements.some((placement) => placement.placement !== 'rendered' || placement.projected)
      ? captureScopedLedgerCommand(continuityLedgerOmissionHandle(model, 'recentConversation'))
        ?? captureScopedOmissionCommand(model)
        ?? model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle
        ?? null
      : null,
  });
  const timelineRowsFor = (rows: readonly RebirthPackageV6ConversationRow[]): RebirthTimelineRow[] => [
    ...endpointStubs,
    ...rows.map((row) => ({
      id: dialogueUnitKey(row.provenanceId),
      sourceAt: row.sourceAt,
      text: renderRow(row),
      compactText: conversationRowText(row, referenceAt, recoveryHandle, continuityAnchor(conversationRowBaseId(row.provenanceId), row.sourceAt, referenceAt)),
    })),
  ];
  const lines = mergeEndpointStubText(known.map(renderRow), known, activeStubs);
  if (unknown.length > 0) {
    lines.push(
      '',
      'Unknown source time (quarantined; not part of the chronology):',
      ...unknown.map(renderRow),
    );
  }
  const fullEndpointReceipt = conversationEndpointReceipt(model);
  const dialogueText = lines.join('\n\n');
  const fullText = [fullEndpointReceipt, dialogueText].filter(Boolean).join('\n\n');
  if (fullText.length <= maxChars) {
    const placements = placementsFor(conversation);
    return {
      text: fullText,
      complete: true,
      unitPlacements: placements,
      timelineRows: timelineRowsFor(conversation),
      timelineCensus: censusFor(placements),
    };
  }

  // Conversation is a chronological section, so overflow must retain its tail:
  // the newest known-source-time rows. Unknown-time rows are admitted only from
  // the remaining space and stay quarantined; they never displace known recency.
  // The relocation receipt is structural proof that promoted endpoint bodies
  // were intentionally removed from this section, so it must survive whenever
  // Recent Conversation is admitted. Under pressure its full source-coordinate
  // detail yields to a compact pointer; the protected Boundary section carries
  // the exact endpoint identities, timestamps, and bytes.
  // S29: when the chronological stubs render they ARE the relocation
  // declaration — carrying exact identity, source time, and position — so the
  // compact one-liner would only repeat them and is spent on dialogue instead.
  const compactEndpointReceipt = fullEndpointReceipt
    ? 'endpoint rows: rendered in Boundary (active request + last assistant)'
    : '';
  let endpointReceipt = activeStubs.length > 0 ? '' : compactEndpointReceipt;
  const budgetFor = (receipt: string): number => (
    Math.max(0, maxChars - receipt.length - (receipt && dialogueText ? 2 : 0))
  );
  let dialogueBudget = budgetFor(endpointReceipt);
  const withEndpointReceipt = (body: string): string => (
    [endpointReceipt, body].filter(Boolean).join('\n\n')
  );
  if (known.length === 0 && unknown.length === 0) {
    return { text: boundedWholeLines(fullEndpointReceipt, maxChars, recoveryHandle), complete: fullEndpointReceipt.length <= maxChars, unitPlacements: [] };
  }
  if (dialogueBudget === 0) {
    return { text: boundedWholeLines(endpointReceipt, maxChars, recoveryHandle), complete: false, unitPlacements: placementsFor([]) };
  }
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
    }), ...mergeEndpointStubText(selectedKnown.map(renderRow), selectedKnown, activeStubs)];
    if (selectedUnknown.length > 0) {
      blocks.push(
        'Unknown source time (quarantined; not part of the chronology):',
        ...selectedUnknown.map(renderRow),
      );
    }
    return blocks.join('\n\n');
  };

  // Audit-3 A5/C6: eviction must not strand an operator row's material replies.
  // Partition known rows into EXCHANGE GROUPS — consecutive rows sharing the
  // same `exchangeId` (an operator row + its material assistant replies), or,
  // for untagged legacy rows, each row is its own group. Reverse iterating over
  // groups (newest group first, in render/desc input order `known`) means the
  // budget trims WHOLE exchanges oldest-first: a kept operator row always keeps
  // whatever material reply was captured with it, so the 23-hour-hole defect can
  // never reappear. Leading assistant rows before any operator row have no reply
  // pairing and naturally stand alone (reviewer tolerance for absent-tag rows).
  const exchangeGroupOf = (row: RebirthPackageV6ConversationRow): string => (
    row.exchangeId ?? `${row.role}:${conversationRowBaseId(row.provenanceId)}`
  );
  const exchangeGroups: RebirthPackageV6ConversationRow[][] = [];
  for (const row of known) {
    const key = exchangeGroupOf(row);
    const prev = exchangeGroups[exchangeGroups.length - 1];
    if (prev && prev[0] && exchangeGroupOf(prev[0]) === key) prev.push(row);
    else exchangeGroups.push([row]);
  }
  const applyBudget = (groups: readonly RebirthPackageV6ConversationRow[][]): void => {
    // Groups are in chronological (asc) order; the newest are at the tail.
    // Keep the newest groups while the composed text fits.
    let selected: RebirthPackageV6ConversationRow[] = [];
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const candidate = [...groups[i]!, ...selected];
      if (compose(candidate, retainedUnknown).length > dialogueBudget) break;
      selected = candidate;
    }
    retainedKnown = selected;
  };
  applyBudget(exchangeGroups);
  // A pointer must never cost a real exchange. Select once WITH the stubs and
  // once without; the stubs are kept only when they evict no dialogue from the
  // section the operator ranked highest. When they yield, the compact
  // relocation receipt carries the declaration and the Boundary section still
  // holds the exact endpoint identities, timestamps, and bytes.
  if (activeStubs.length > 0) {
    const stubbedRows = retainedKnown;
    const stubbedReceipt = endpointReceipt;
    const stubbedBudget = dialogueBudget;
    activeStubs = [];
    endpointReceipt = compactEndpointReceipt;
    dialogueBudget = budgetFor(endpointReceipt);
    applyBudget(exchangeGroups);
    // stubbedRows empty means nothing fit beside the stubs at all: that render
    // falls through to the truncated-latest-row receipt, which shows no stub,
    // so the compact declaration must come back rather than vanish.
    if (stubbedRows.length > 0 && retainedKnown.length <= stubbedRows.length) {
      activeStubs = endpointStubs;
      endpointReceipt = stubbedReceipt;
      dialogueBudget = stubbedBudget;
      retainedKnown = stubbedRows;
    }
  }

  for (const row of unknown) {
    const candidate = [...retainedUnknown, row];
    if (compose(retainedKnown, candidate).length > dialogueBudget) break;
    retainedUnknown = candidate;
  }

  // If even the newest complete row cannot fit beside the structural omission
  // receipt, preserve that row's head explicitly instead of falling back to the
  // oldest section prefix. This is the only within-row truncation path.
  if (known.length > 0 && retainedKnown.length === 0) {
    const newest = known.at(-1)!;
    return { text: withEndpointReceipt(renderTruncatedLatestKnownRow({
      row: newest,
      omittedKnown: known.slice(0, -1),
      omittedUnknown: unknown,
      maxChars: dialogueBudget,
      recoveryHandle,
    })), complete: false, unitPlacements: placementsFor([newest], new Set([conversationRowBaseId(newest.provenanceId)])) };
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
    const row = boundedText(renderRow(firstUnknown), Math.max(0, dialogueBudget - prefix.length), recoveryHandle);
    return {
      text: withEndpointReceipt(boundedText(`${prefix}${row.text}`, dialogueBudget, recoveryHandle).text),
      complete: false,
      unitPlacements: placementsFor([firstUnknown], new Set([conversationRowBaseId(firstUnknown.provenanceId)])),
    };
  }

  const retainedPlacements = placementsFor([...retainedKnown, ...retainedUnknown]);
  return {
    text: withEndpointReceipt(compose(retainedKnown, retainedUnknown)),
    complete: false,
    unitPlacements: retainedPlacements,
    timelineRows: timelineRowsFor([...retainedKnown, ...retainedUnknown]),
    timelineCensus: censusFor(retainedPlacements),
  };
}

/**
 * Map a Recovery Index row id to the section it describes (audit-3 A8). Only
 * rows that ARE rendered sections participate in the census override; storage
 * lanes (transcript, atlas-history, ledger, identity, …) keep their own status.
 */
function recoveryRowSectionId(rowId: string): RebirthPackageV6SectionId | null {
  const exact = rowId as RebirthPackageV6SectionId;
  if ((REBIRTH_PACKAGE_V6_SECTION_IDS as readonly string[]).includes(rowId)) return exact;
  const kebabToSection = Object.entries(SECTION_LANE_IDS).find(([, lane]) => lane === rowId);
  if (kebabToSection) return kebabToSection[0] as RebirthPackageV6SectionId;
  if (rowId === 'cognition') return 'cognitiveArtifacts';
  return null;
}

/**
 * Delivered-package declaration that a capture lane came back degraded.
 *
 * The `capture-degraded=` roll-up lives in the diagnostic header, and D2
 * retired the hidden lineage sections' per-lane recovery rows. Together those
 * two correct decisions left the DELIVERED package with no way to say that a
 * lane was truncated — which is the 2026-08-28 outage exactly: eighteen hours
 * of builds resolved zero lineage frontiers and every package still read
 * clean. This line exists only when a lane is genuinely degraded, and it reads
 * the same helper the diagnostic header reads so the two surfaces cannot drift.
 */
function compactDegradedCaptureLines(model: RebirthPackageV6Model): string[] {
  const lanes = computeRebirthCaptureDegradedLanes(model);
  if (lanes.length === 0) return [];
  const reasonByLane: Readonly<Record<string, string | null | undefined>> = {
    'operator-vault': model.operatorVault?.partialReason,
    'episode-chapter-index': model.episodeChapterIndex?.partialReason,
    'life-ledger': model.lifeLedger?.partialReason,
    cognition: model.cognitiveArtifactCapture?.warnings.join(' ')
      || model.cognitiveArtifactCapture?.missingFamilies.join(' '),
    'active-edit-delta': model.activeEditDelta.reasons.join(' '),
    'task-rail': model.boundaryAndActiveTask.nowCard?.currentRailAvailability?.reason,
  };
  return [`⚠ Degraded capture: ${lanes.map((lane) => {
    const reason = reasonByLane[lane]?.trim();
    return reason ? `${lane} (${oneLineClaim(reason, 160)})` : lane;
  }).join(' · ')}`];
}

function renderRecovery(
  model: RebirthPackageV6Model,
  maxChars: number,
  completeness?: RebirthSectionCompleteness,
  references: RebirthRecoveryReferenceCatalog = buildRecoveryReferenceCatalog(model),
  compact = false,
): { text: string; complete: boolean } {
  // D2: the hidden lineage sections no longer render a body, so their
  // per-section ledger routes would be four near-identical commands. The
  // ledger index handle already addresses every one of their units, and the
  // timeline census carries the capture-scoped fetch for what it omitted.
  const entries = compact
    ? model.recoveryIndex.filter((entry) => !COMPACT_RECOVERY_SUPPRESSED_ROWS.has(entry.id))
    : model.recoveryIndex;
  // Hazards, the degraded-capture declaration, and the lineage-history census
  // are the things a successor acts on that no entry row carries. They are
  // computed and reserved out of the cap BEFORE the entry loop so a long index
  // cannot silently delete them — and before the empty-index early return, so
  // an index that is absent (or contains only D2-suppressed lineage rows)
  // cannot delete them either. That path is exactly how a truncated capture
  // would go quiet again: no rows to carry a status, no roll-up header, and
  // formerly no tail.
  const tail = compact
    ? [
      ...currentTaskHazards(
        model.recoveryIndex.find((entry) => entry.id === 'atlas-handoff-card')?.inlineEvidence ?? '',
      ),
      ...compactDegradedCaptureLines(model),
      historyCensus(model),
    ]
    : [];
  if (entries.length === 0) {
    return {
      text: ['- recovery index unavailable', ...tail].join('\n'),
      complete: true,
    };
  }
  const tailText = tail.length > 0 ? `\n${tail.join('\n')}` : '';
  const entryBudget = tailText.length > 0 && tailText.length < maxChars
    ? maxChars - tailText.length
    : maxChars;
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
  const packageRef = recoveryReference(references, packageHandle);
  // Audit-4 S7: every recovery row cites its own handle on its line, so those
  // references are inherently used; mark them before freezing the legend set.
  // The legend then lists ONLY handles some section actually cites — the
  // audited specimen carried 8 never-cited legend rows (empty ledger-fetch
  // handles for omitted sections) that cost budget and reader attention.
  for (const entry of entries) {
    if (entry.handle) recoveryReference(references, entry.handle);
  }
  const usedEntries = references.entries.filter((entry) => (
    'usedHandles' in references && (references as MutableRecoveryReferenceCatalog).usedHandles.has(entry.handle)
  ));
  const lines: string[] = compact ? [COMPACT_RECOVERY_PREAMBLE] : [];
  if (usedEntries.length > 0) {
    lines.push(
      'Recovery handle legend (expand R<n> before execution):',
      ...usedEntries.map((entry) => `- ${entry.ref} = ${entry.handle}`),
      '',
    );
  }
  let elided = false;
  let renderedEntries = 0;
  for (const entry of entries) {
    // Audit-3 A8: section rows take their status from the completeness census
    // (partial whenever the section was explained-partial OR lost content), so
    // the Recovery Index never reports `available` for a section whose body
    // rolled up or merged under its cap. Storage/identity rows keep the
    // entry-declared status.
    const censusSection = recoveryRowSectionId(entry.id);
    const censusEntry = censusSection ? completeness?.get(censusSection) : undefined;
    const censusPartial = censusEntry !== undefined;
    const reasonSuffix = censusPartial
      ? ` · reason=${censusEntry?.reason?.trim()
        || (censusEntry?.relocated
          ? 'relocated to the continuity ledger; units intact and addressed there'
          : censusEntry?.renderLoss ? 'render loss (demoted/rolled-up/truncated under budget)' : 'capture-side partiality; see section body')}`
      : entry.status !== 'available'
        ? ` · reason=${entry.reason?.trim() || 'unspecified'}`
        : '';
    // Honest recovery disposition: a nonempty handle is rendered verbatim; an
    // empty handle on a not-requested lane is `not-requested`, and an empty
    // handle on any other non-available lane is `unavailable` — never a
    // contradictory fake handle for a capture that was never requested.
    let recoverLabel = recoveryReference(references, entry.handle) || 'unavailable';
    if (!entry.handle && entry.status === 'not-requested') recoverLabel = 'not-requested';
    const countLabel = entry.id === 'task-rail' ? 'steps' : 'count';
    const frontier = entry.id === 'identity' && entry.frontier === null
      ? ''
      : ` · frontier=${entry.frontier ?? 'unknown'}`;
    const rowStatus = censusPartial ? 'partial' : entry.status;
    const recoveryScope = entry.recoveryScope ?? (
      entry.handle.startsWith('continuity_ledger ') && /\bomitted_only=true\b/u.test(entry.handle)
        ? 'exact-omitted-subset'
        : entry.id === 'rebirth-package' && /\bsearch=/u.test(entry.handle)
          ? 'exact-full'
          : 'discovery'
    );
    // D1: the verbose row spends ~120 chars on six labelled clauses. The
    // compact row keeps every decision-relevant fact — which route, whether it
    // is available/partial and why, how much it addresses, whether it returns
    // exact bytes or pointers, and the executable handle — and drops the
    // restated human label and the ingestion-side frontier diagnostic.
    const line = compact
      ? `- ${entry.id} · ${rowStatus}`
        + `${entry.count === null || entry.count === undefined ? '' : ` · ${countLabel}=${entry.count}`}`
        + `${recoveryScope === 'discovery' ? '' : ` · ${recoveryScope}`}`
        + ` · recover=${recoverLabel}${reasonSuffix}`
      : `- ${entry.id} · ${entry.label} · status=${rowStatus} · ${countLabel}=${entry.count ?? 'unknown'}${frontier}${reasonSuffix} · scope=${recoveryScope} · recover=${recoverLabel}`;
    // Optional inline evidence (e.g. a captured Atlas handoff card body) rides
    // beneath its own handle line as a bounded indented snapshot. It never
    // overloads `label` (which stays a short title). If the evidence cannot fit
    // the remaining budget, an explicit elision names the exact recovery handle
    // so the full body stays recoverable — a partial capture must not silently
    // look complete.
    const evidence = entry.inlineEvidence?.trim();
    let evidenceBlock: string | null = null;
    if (evidence) {
      const evidenceRecovery = recoveryReference(references, packageHandle || entry.handle);
      const evidenceHeader = `  ${entry.id}.inline-evidence: root recovery=${evidenceRecovery}`;
      const budget = Math.max(0, entryBudget - evidenceHeader.length - 60);
      const ev = boundedText(
        evidence.split('\n').map((l) => `  ${l}`).join('\n'),
        budget,
        evidenceRecovery,
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
    const exactHandle = recoveryReference(references, packageHandle || entry.handle) || packageRef;
    if (projected.length > entryBudget) {
      if (evidenceBlock) {
        lines.push(line);
        lines.push(
          exactHandle
            ? `  ${entry.id}.inline-evidence: elided for budget; recover the complete evidence from the exact handle: ${exactHandle}`
            : `  ${entry.id}.inline-evidence: elided for budget; exact recovery handle unavailable`,
        );
      } else {
        const omitted = entries.length - renderedEntries;
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
    renderedEntries += 1;
  }
  lines.push(...tail);
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
  recencyFloorK = 0,
  recencyFloorKind?: CollapseUnitKind,
): { text: string; collapse: CollapseResult; complete: boolean } {
  const collapse = (chars: number) => collapseUnits({
    units,
    maxChars: Math.max(0, chars),
    rangeRecover: recover,
    floorRecover: recover,
    renderOrder,
    ...(recencyFloorK > 0 ? { recencyFloorK, recencyFloorKind } : {}),
  });
  const tierReceipt = (result: CollapseResult): string => (
    `\n[COLLAPSE units=${units.length} t0=${result.tierCounts.t0}`
    + ` t1=${result.tierCounts.t1} t2=${result.tierCounts.t2}`
    + ` t3=${result.tierCounts.t3} t4=${result.tierCounts.t4}`
    + ` tiers=${COLLAPSE_TIERS.map((tier) => `${tier}:${COLLAPSE_TIER_NAMES[tier]}`).join(',')}`
    + ` recover=${recover ?? 'unavailable'}]`
  );
  const full = collapse(budget);
  if (full.complete) return { text: full.text, collapse: full, complete: true };
  // +16 pads for digit-width drift between the two passes' tier counts.
  const reserve = tierReceipt(full).length + 16;
  const bounded = collapse(budget - reserve);
  // The second pass re-collapses at `budget - reserve` purely to make room for
  // the appended receipt. collapseUnits' floor branch is handle-safe (it never
  // character-slices a recover command), so bounded.text at a floor clamp is a
  // whole handle-free rollup — safe to append the receipt beside.
  return { text: `${bounded.text}${tierReceipt(bounded)}`, collapse: bounded, complete: false };
}

function renderLineage(
  section: RebirthPackageV7LineageSection,
  maxChars: number,
  fallbackRecover: string | null,
  omissionHandle: string | null,
  references: RebirthRecoveryReferenceCatalog,
  recencyFloorK = 0,
  recencyFloorKind?: CollapseUnitKind,
  headerLines: readonly string[] = [],
): RenderedV6SectionBody {
  const header: string[] = [...headerLines];
  if (section.partialReason) {
    // Audit-4 S7: the partial line names the exact ledger omission handle
    // (R<n>), not just "ledger-addressable" — the audited specimen's vault
    // partial line pointed nowhere while R17 existed unused in the legend.
    const omissionRef = recoveryReference(references, omissionHandle);
    header.push(
      omissionRef
        ? `partial=${section.partialReason} · omitted units are ledger-addressable · recover=${omissionRef}`
        : `partial=${section.partialReason} · omitted-units=unknown · omitted units are ledger-unreachable`,
    );
  }
  const projected = section.units.filter((unit) => unit.projection);
  if (projected.length > 0) {
    const storedChars = projected.reduce((total, unit) => total + (unit.projection?.storedChars ?? 0), 0);
    const sourceChars = projected.reduce((total, unit) => total + (unit.projection?.sourceChars ?? 0), 0);
    header.push(
      `projected-units=${projected.length} · stored=${storedChars} of ${sourceChars} chars · `
      + omissionRecoveryClause(recoveryReference(references, omissionHandle)),
    );
  }
  if (section.units.length === 0) {
    header.push('No lineage units captured for this section.');
    return { text: header.join('\n'), complete: !section.partialReason, collapse: null };
  }
  const headerText = header.length > 0 ? `${header.join('\n')}\n` : '';
  // Audit-4 S7: resolve to an R<n> ref HERE (emit point) so usage marking
  // reflects a handle this section's shipped text actually cites.
  const recover = recoveryReference(references, omissionHandle)
    ?? recoveryReference(references, section.rangeRecover)
    ?? fallbackRecover;
  const body = collapseWithReceipt(
    section.units,
    maxChars - headerText.length,
    recover,
    'newest_first',
    recencyFloorK,
    recencyFloorKind,
  );
  return {
    text: `${headerText}${body.text}`,
    complete: body.complete && !section.partialReason,
    collapse: body.collapse,
  };
}

/**
 * Content sort direction per section (audit-2 A27): renders `dir=` on the
 * section frame header so a successor knows whether the section streams
 * oldest-first (asc) or newest-first (desc) without reading the body. Sections
 * whose body is not a time-ordered stream (boundary, merge synthesis, recovery
 * directory) carry no dir.
 */
const SECTION_SORT_DIRECTION: Readonly<Partial<Record<RebirthPackageV6SectionId, 'asc' | 'desc'>>> =
  Object.freeze({
    executionState: 'asc',
    activeEditDelta: 'asc',
    cognitiveArtifacts: 'desc',
    recentConversation: 'asc',
    operatorVault: 'desc',
    episodeChapterIndex: 'desc',
    lifeLedger: 'desc',
    recoveryIndex: 'asc',
  });

function frameSection(id: RebirthPackageV6SectionId, body: string): string {
  const order = REBIRTH_PACKAGE_V6_SECTION_IDS.indexOf(id) + 1;
  const direction = SECTION_SORT_DIRECTION[id];
  return [
    `── ${SECTION_TITLES[id]} ──`,
    `${V6_SECTION_OPEN_PREFIX} id=${id} order=${order}${direction ? ` dir=${direction}` : ''} chars=${body.length}]`,
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

/** Render-only vault dedupe; the immutable model remains ledger-byte truth. */
function operatorVaultWithConversationPointers(
  section: RebirthPackageV7LineageSection,
  renderedOperatorIds: ReadonlySet<string>,
): RebirthPackageV7LineageSection {
  if (renderedOperatorIds.size === 0) return section;
  // The section header explains relocation before any rows, independently of
  // source order or tier demotion. Keep immutable model units untouched.
  let changed = false;
  const units = section.units.map((unit) => {
    if (unit.kind !== 'operator' || !renderedOperatorIds.has(unit.id)) return unit;
    changed = true;
    const pointer = `[operator · source=${unit.id}]`;
    const { projection: _projection, ...rest } = unit;
    return {
      ...rest,
      verbatim: pointer,
      digest: pointer,
      claim: pointer,
    };
  });
  return changed ? { ...section, units } : section;
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
  readonly unitPlacements?: readonly RebirthPackageV6UnitPlacement[];
  readonly timelineRows?: readonly RebirthTimelineRow[];
  readonly timelineSummary?: string;
  readonly timelineCensus?: RebirthTimelineCensus;
}

/** Audit-3 B11: the newest K life rows stay verbatim through RLE. */
export const LIFE_LEDGER_RLE_KEEP_NEWEST = 5;

/**
 * Audit-3 B11: run-length-encode an ENTIRELY-t0-verbatim Life Ledger body.
 *
 * The audited un-contended Life Ledger ships dozens of consecutive rows that
 * differ only in life id/span/package size (the 41 identical
 * `cli-hard-epoch/working` boundaries ~9.4k chars). This fuses runs of rows
 * that are byte-close in the identity detail (boundary · prior-status ·
 * runtime · by) into one RLE line, dropping their repeated keys to a single
 * occurrence while preserving the full span and package-chars range.
 *
 * SAFETY PRECONDITION (caller guarantees): the caller invokes this ONLY when
 * every collapse placement is tier t0 with kind 'life' — i.e. the section
 * rendered ENTIRELY verbatim and `body.text` is precisely one full v3 `life …`
 * row per line with NO digest/era/rollup demotion mixed in. Under that
 * precondition a line-split + run-fuse cannot mis-fuse a demoted row (there
 * are none). When any unit demoted (contended budget), this helper is skipped
 * and the rendered text is byte-unchanged.
 *
 * - Rendering order is newest-first (desc). The newest
 *   `LIFE_LEDGER_RLE_KEEP_NEWEST` rows are never fused (a successor still sees
 *   the true recent lineage head per-row).
 * - A run's identity key is `boundary · prior-status · runtime · by` + the
 *   per-life package chars within ±500 (so a single capped-build drift does
 *   not split a run).
 * - The fused line keeps the run's FIRST id as its anchor and reports the
 *   count, the outer span, and the shared keys once.
 *
 * This is a DISPLAY transform over the already-rendered verbatim text: each
 * unit's `verbatim` (what the continuity ledger attests) and the collapse
 * report/placements are untouched — ledger-safe by construction, complete and
 * failure semantics preserved.
 */
export function applyLifeLedgerVerbatinRle(text: string): string {
  // Operate on a full rendered Life Ledger section body (header lines first,
  // then the collapse body, optionally a trailing [COLLAPSE …] footer). We fuse
  // only the maximal CONTIGUOUS run of verbatim `life …` rows — the header
  // (legend/cadence) may precede it and a collapse footer may follow; neither
  // is a `life ` row so they are preserved untouched.
  const lines = text.split('\n');
  let lifeStart = -1;
  let lifeEnd = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('life ')) {
      if (lifeStart < 0) lifeStart = i;
      lifeEnd = i;
    }
  }
  if (lifeStart < 0 || lifeEnd < lifeStart) return text; // no verbatim life rows
  const fused = fuseConsecutiveVerbatinLifeLines(lines.slice(lifeStart, lifeEnd + 1));
  return [...lines.slice(0, lifeStart), ...fused, ...lines.slice(lifeEnd + 1)].join('\n');
}

/** Fuse consecutive verbatim `life ` rows sharing identity detail (B11). */
function fuseConsecutiveVerbatinLifeLines(lifeLines: readonly string[]): string[] {
  interface Row { line: string; id: string; boundary: string; prior: string; runtime: string; by: string; spanStart: string; spanEnd: string; pkg: number | null; }
  const parse = (line: string): Row | null => {
    const m = line.trim().match(/^life\s+(\S+?)\s+·\s+span=(.*?)\.\.(.*?)(?=\s·\s|$)(.*)$/u);
    if (!m) return null;
    const after = m[4] ?? '';
    const f = (re: RegExp): string => { const x = after.match(re); return x ? x[1]!.trim() : ''; };
    const pkgS = f(/\b(?:package_chars|package-chars)=(\S+?)(?=\s·\s|$)/u);
    const pkg = /^\d+$/u.test(pkgS) ? Number(pkgS) : null;
    return {
      line: line.trim(), id: m[1]!.trim(), spanStart: m[2]!.trim(), spanEnd: m[3]!.trim(),
      boundary: f(/\bboundary=(\S+?)(?=\s·\s|$)/u), prior: f(/\bprior-status=(\S+?)(?=\s·\s|$)/u),
      runtime: f(/\bruntime=(\S+?)(?=\s·\s|$)/u), by: f(/\bby=(\S+?)(?=\s·\s|$)/u), pkg,
    };
  };
  // Rows render newest-first (desc). Parse every verbatim line; if any fails to
  // parse cleanly, bail (leave the whole run verbatim) rather than corrupt.
  const rows: Row[] = [];
  for (const line of lifeLines) {
    const p = parse(line);
    if (!p) return [...lifeLines];
    rows.push(p);
  }
  if (rows.length === 0) return [...lifeLines];

  // Keep the newest K rows verbatim (they carry the true lineage head).
  const kept = rows.slice(0, Math.min(LIFE_LEDGER_RLE_KEEP_NEWEST, rows.length));
  const fusable = rows.slice(kept.length);

  const keyOf = (r: Row): string => `${r.boundary}\u0000${r.prior}\u0000${r.runtime}\u0000${r.by}`;
  const runs: Row[][] = [];
  let current: Row[] = [];
  for (const row of fusable) {
    if (current.length > 0) {
      const head = current[0]!;
      const pkgClose = (head.pkg === null || row.pkg === null) || Math.abs((row.pkg - head.pkg)) <= 500;
      if (keyOf(head) === keyOf(row) && pkgClose) { current.push(row); continue; }
      runs.push(current); current = [row];
    } else { current = [row]; }
  }
  if (current.length > 0) runs.push(current);

  const out = kept.map((r) => r.line);
  for (const run of runs) {
    if (run.length === 1) { out.push(run[0]!.line); continue; }
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const starts = run.map((r) => r.spanStart).sort();
    const ends = run.map((r) => r.spanEnd).sort();
    const minChars = run.reduce<number | null>((acc, r) => (
      r.pkg === null ? acc : (acc === null ? r.pkg : Math.min(acc, r.pkg))
    ), null);
    const maxChars = run.reduce<number | null>((acc, r) => (
      r.pkg === null ? acc : (acc === null ? r.pkg : Math.max(acc, r.pkg))
    ), null);
    const pkgPart = minChars === null
      ? ''
      : ` · package-chars=${minChars}${maxChars !== null && minChars !== maxChars ? `..${maxChars}` : ''}`;
    const fields = [
      `life ${first.id}…${last.id}`,
      `×${run.length}`,
      `span=${starts[0]}..${ends[ends.length - 1]}`,
    ];
    if (last.boundary) fields.push(`boundary=${last.boundary}`);
    if (last.prior) fields.push(`prior-status=${last.prior}`);
    fields.push(`runtime=${last.runtime || 'unknown'}`);
    if (last.by) fields.push(`by=${last.by}`);
    if (pkgPart) fields.push(pkgPart.trim().replace(/^· /u, ''));
    out.push(fields.join(' · '));
  }
  return out;
}

/**
 * Life-ledger section annotations (audit-2 A7/A26): a static legend explaining
 * the per-row labels (assembler-supplied row text) and a cadence line derived
 * ONLY from unit fields (sourceAt/sourceEndAt) relative to the model's own
 * capturedAt. `at-cap` is deliberately NOT derived: the per-life package size
 * is not a typed unit field, and parsing row bodies for a measurement would
 * duplicate the feeder's job (residual, not computed).
 */
function lifeLedgerHeaderLines(
  section: RebirthPackageV7LineageSection,
  capturedAt: string | null,
): string[] {
  const units = section.units.filter((unit) => unit.kind === 'life');
  if (units.length === 0) return [];
  const lines: string[] = [
    // Audit-3 A4 life-row/v3 + audit-4 S6: the legend enumerates EXACTLY the
    // keys the assembler emits per life row (span/by/runtime/boundary/
    // prior-status/package-chars/prompt-chars/build-ms/src) — legend and rows
    // share one grammar, and the key-parity test pins that both directions
    // hold. `src` is the builder source-tree SHA-256 prefix proving which code
    // built the life's package; `build-ms` is the request→capture wall the
    // artifact writer stamped (omitted when the row predates it).
    'legend: one line per life boundary · life <id> · span=<startISO>..<endISO|unknown> · by=<instanceId> · runtime=<engine>/<model|unknown> · boundary=<trigger> · prior-status=<predecessor status> · package-chars=<delivered chars> · prompt-chars=<prompt chars|unknown> · build-ms=<request→capture ms|omitted> · src=<builder sha256 first 12|unknown>',
  ];
  const refAt = knownSourceTime(capturedAt);
  const refMs = refAt ? Date.parse(refAt) : Number.NaN;
  const cadenceParts: string[] = [];
  if (Number.isFinite(refMs)) {
    const windowMs = 24 * 60 * 60 * 1000;
    const last24 = units.filter((unit) => {
      const start = knownSourceTime(unit.sourceAt);
      if (!start) return false;
      const startMs = Date.parse(start);
      return Number.isFinite(startMs) && startMs <= refMs && refMs - startMs <= windowMs;
    }).length;
    cadenceParts.push(`lives-24h=${last24}`);
  } else {
    cadenceParts.push('lives-24h=unknown (no captured-at reference)');
  }
  const durationsMs = units.flatMap((unit) => {
    const start = knownSourceTime(unit.sourceAt);
    const end = knownSourceTime(unit.sourceEndAt ?? null);
    if (!start || !end) return [];
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
      && (!Number.isFinite(refMs) || endMs <= refMs) ? [endMs - startMs] : [];
  });
  if (durationsMs.length > 0) {
    const sorted = [...durationsMs].sort((a, b) => a - b);
    const median = sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
    const minutes = Math.round(median / 60000);
    const suffix = ` (all captured lineage; ${durationsMs.length}/${units.length} valid spans; includes inactive time; reference=${refAt ?? 'unknown'})`;
    cadenceParts.push(`median-life=${minutes}m${suffix}`);
  } else {
    cadenceParts.push('median-life=unknown (no life spans with known start+end)');
  }
  lines.push(`cadence=${cadenceParts.join(' · ')}`);
  return lines;
}

function renderSectionBodies(
  model: RebirthPackageV6Model,
  limits: Record<RebirthPackageV6SectionId, number>,
  timing?: RebirthPackageV6SectionTimingAccumulator,
  sharedReferences?: MutableRecoveryReferenceCatalog,
  compact = false,
  compactTimeline = compact,
): Record<RebirthPackageV6SectionId, RenderedV6SectionBody> {
  // Audit-4 S7: ONE catalog per whole render pass — callers that re-render
  // sections (adaptive backfill, shrink probes) pass the same mutable catalog
  // so usage marking and legend numbering stay consistent across passes.
  const references = sharedReferences ?? buildRecoveryReferenceCatalog(model);
  const transcriptHandle = recoveryReference(
    references,
    model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle,
  );
  const recentConversation = measureSectionRender(timing, 'recentConversation', () => (
    renderConversation(model, limits.recentConversation, references, compactTimeline, limits.operatorVault === 0)
  ));
  const renderedConversationIds = new Set(
    (recentConversation.unitPlacements ?? [])
      .filter((placement) => placement.placement === 'rendered')
      .map((placement) => placement.id),
  );
  // The dialogue has rendered: cognition learns which of its artifacts the
  // dialogue owns (candidates) and what became of each (placements), so a
  // register glyph is budgeted, rendered and counted exactly once — as dialogue.
  const dialogueOwnership: CognitionDialogueOwnership = {
    candidates: dialogueCandidateKeys(model, limits.operatorVault === 0),
    placements: new Map((recentConversation.unitPlacements ?? [])
      .map((placement) => [dialogueUnitKey(placement.id), placement] as const)),
  };
  const renderedOperatorIds = new Set(
    model.recentConversation
      .filter((row) => row.role === 'user'
        && renderedConversationIds.has(conversationRowBaseId(row.provenanceId)))
      .map((row) => conversationRowBaseId(row.provenanceId)),
  );
  const operatorVault = operatorVaultWithConversationPointers(
    lineageSection(model, 'operatorVault'),
    renderedOperatorIds,
  );
  return {
    boundaryAndActiveTask: measureSectionRender(timing, 'boundaryAndActiveTask', () => (
      renderBoundary(model, limits.boundaryAndActiveTask, undefined, references, compact)
    )),
    brainMergeSynthesis: measureSectionRender(timing, 'brainMergeSynthesis', () => boundedText(
      model.brainMergeSynthesis ?? '',
      limits.brainMergeSynthesis,
      recoveryReference(references, model.recoveryIndex.find((entry) => entry.id === 'rebirth-package')?.handle),
    )),
    executionState: measureSectionRender(timing, 'executionState', () => (
      renderExecution(model, limits.executionState, references)
    )),
    activeEditDelta: measureSectionRender(timing, 'activeEditDelta', () => (
      renderActiveEdits(model, limits.activeEditDelta, references)
    )),
    cognitiveArtifacts: measureSectionRender(timing, 'cognitiveArtifacts', () => (
      renderCognition(model, limits.cognitiveArtifacts, references, compactTimeline, dialogueOwnership)
    )),
    recentConversation,
    operatorVault: measureSectionRender(timing, 'operatorVault', () => renderLineage(
      operatorVault,
      limits.operatorVault,
      transcriptHandle,
      // Audit-4 S7: pass RAW handles — resolving here would mark every ledger
      // omission handle "used" even when no row ever cites it; renderLineage
      // resolves at its emit points only.
      continuityLedgerOmissionHandle(model, 'operatorVault'),
      references,
      undefined,
      undefined,
      renderedOperatorIds.size > 0
        ? ['Relocation: bare operator IDs are rendered-in=recentConversation; exact request/answer endpoints live in Boundary and Active Task. Vault frontier describes retained vault units, separately from the active request.']
        : [],
    )),
    episodeChapterIndex: measureSectionRender(timing, 'episodeChapterIndex', () => renderLineage(
      lineageSection(model, 'episodeChapterIndex'),
      limits.episodeChapterIndex,
      model.recoveryIndex.find((entry) => entry.id === 'context-warp-stores')?.handle ?? null,
      continuityLedgerOmissionHandle(model, 'episodeChapterIndex'),
      references,
      EPISODE_CHAPTER_RECENCY_FLOOR_K,
      'episode',
    )),
    lifeLedger: measureSectionRender(timing, 'lifeLedger', () => {
      const led = renderLineage(
        lineageSection(model, 'lifeLedger'),
        limits.lifeLedger,
        model.recoveryIndex.find((entry) => entry.id === 'rebirth-package')?.handle ?? null,
        continuityLedgerOmissionHandle(model, 'lifeLedger'),
        references,
        LIFE_LEDGER_RECENCY_FLOOR_K,
        'life',
        lifeLedgerHeaderLines(lineageSection(model, 'lifeLedger'), model.boundaryAndActiveTask.capturedAt),
      );
      // Audit-3 B11: the un-contended Life Ledger ships dozens of consecutive
      // v3 rows differing only in life id/span/package size. Apply the display
      // RLE to the rendered text. The helper fuses only a maximal contiguous
      // run of FULL, parseable verbatim `life …` rows and bails (leaves the
      // text unchanged) the moment any line is a demoted digest/era/rollup it
      // cannot parse — so a contended (mixed-tier) render is never reshaped.
      // Ledger-safe: per-life unit verbatims and the collapse report/placements
      // are untouched; only the shipped section text is compacted.
      return { ...led, text: applyLifeLedgerVerbatinRle(led.text) };
    }),
    recoveryIndex: measureSectionRender(timing, 'recoveryIndex', () => (
      renderRecovery(model, limits.recoveryIndex, undefined, references, compact)
    )),
  };
}

export type RebirthPackageV6SectionTimings = Readonly<Partial<
  Record<RebirthPackageV6SectionId, number>
>>;

interface RebirthPackageV6SectionTimingAccumulator {
  readonly now: () => number;
  readonly durations: Partial<Record<RebirthPackageV6SectionId, number>>;
}

function createSectionTimingAccumulator(
  options: RenderRebirthPackageV6Options,
): RebirthPackageV6SectionTimingAccumulator | undefined {
  if (options.measureSectionTimings !== true) return undefined;
  return {
    now: options.sectionTimingClock ?? (() => performance.now()),
    durations: {},
  };
}

function measureSectionRender<T>(
  timing: RebirthPackageV6SectionTimingAccumulator | undefined,
  sectionId: RebirthPackageV6SectionId,
  render: () => T,
): T {
  if (!timing) return render();
  const startedAt = timing.now();
  try {
    return render();
  } finally {
    const duration = Math.max(0, timing.now() - startedAt);
    if (Number.isFinite(duration)) {
      timing.durations[sectionId] = (timing.durations[sectionId] ?? 0) + duration;
    }
  }
}

function admittedSectionIds(model: RebirthPackageV6Model): readonly RebirthPackageV6SectionId[] {
  return REBIRTH_PACKAGE_V6_SECTION_IDS.filter((id) => {
    if (id === 'brainMergeSynthesis') return Boolean(model.brainMergeSynthesis?.trim());
    if (id === 'recentConversation') {
      return conversationWithVault(model).length > 0 || conversationEndpointReceipt(model).length > 0;
    }
    if ((REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS as readonly string[]).includes(id)) {
      const section = lineageSection(model, id as RebirthPackageV7LineageSectionId);
      return section.units.length > 0 || Boolean(section.partialReason);
    }
    return true;
  });
}

export function defaultRebirthPackageBudgetChars(
  model: Pick<RebirthPackageV6Model, 'boundaryAndActiveTask'>,
): number {
  return model.boundaryAndActiveTask.lifecycle === 'brain_merge'
    ? DEFAULT_BRAIN_MERGE_REBIRTH_PACKAGE_BUDGET_CHARS
    : DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS;
}

function packageBudgetChars(
  model: Pick<RebirthPackageV6Model, 'boundaryAndActiveTask'>,
  options: RenderRebirthPackageV6Options,
): number {
  return options.packageBudget ?? defaultRebirthPackageBudgetChars(model);
}

function pushTargetChars(
  model: Pick<RebirthPackageV6Model, 'boundaryAndActiveTask'>,
  options: RenderRebirthPackageV6Options,
): number {
  const budget = packageBudgetChars(model, options);
  if (!Number.isFinite(budget) || budget <= 0) return budget;
  const configured = options.pushTargetChars;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) return budget;
  return Math.min(Math.floor(budget), Math.floor(configured));
}

/** Resolve bounded phase allocations, admitting whole dialogue exchanges first. */
export function resolveAdaptiveSectionCaps(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): Record<RebirthPackageV6SectionId, number> {
  return resolveAdaptiveSectionCapsInternal(model, options);
}

function resolveAdaptiveSectionCapsInternal(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options,
  timing?: RebirthPackageV6SectionTimingAccumulator,
): Record<RebirthPackageV6SectionId, number> {
  // Audit-3 C1: the section partition (and the adaptive-fill priority below)
  // is a function of the derived execution phase. rail-active keeps the
  // generic defaults; rail-complete / no-rail apply the ratified override
  // table on top of the defaults and before any caller-supplied sectionMaxChars
  // (an explicit caller cap still wins for the sections it names).
  const phase = deriveRebirthExecutionPhase(model);
  const phaseOverrides = sectionOverridesForPhase(phase);
  const limits = {
    ...DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS,
    ...phaseOverrides,
    ...options.sectionMaxChars,
  };
  // The newest exact exchange may grow beyond the old fixed boundary cap.
  // Fund it from the same envelope, before historical dialogue and cognition.
  if (options.sectionMaxChars?.boundaryAndActiveTask === undefined) {
    limits.boundaryAndActiveTask = Math.min(145_000, Math.max(limits.boundaryAndActiveTask,
      compactBoundary(model, model.boundaryAndActiveTask.lastMaterialAssistant?.text ?? null).length + 64));
  }
  // Reserve recovery's measured demand plus room for the final completeness
  // census. Unused directory space belongs to conversation, not blank padding.
  const recoveryReserve = options.sectionMaxChars?.recoveryIndex === undefined
    ? Math.min(limits.recoveryIndex, renderRecovery(model, limits.recoveryIndex).text.length + 1_024)
    : limits.recoveryIndex;
  const recoverySurplus = limits.recoveryIndex - recoveryReserve;
  limits.recoveryIndex = recoveryReserve;
  const references = buildRecoveryReferenceCatalog(model);
  let executionSurplus = 0;
  for (const id of ['executionState', 'activeEditDelta'] as const) {
    if (options.sectionMaxChars?.[id] !== undefined) continue;
    const body = id === 'executionState'
      ? renderExecution(model, limits[id], references)
      : renderActiveEdits(model, limits[id], references);
    // Retain room for final capture labels, then give unused capacity to prose.
    const reserved = Math.min(limits[id], Math.max(500, body.text.length + 256));
    executionSurplus += limits[id] - reserved;
    limits[id] = reserved;
  }
  const timelinePool = Math.max(0, (phase === 'rail-active' ? 115_000 : 129_000)
    + Math.max(0, Math.min(200_000, packageBudgetChars(model, options)) - 150_000)
    - (model.brainMergeSynthesis?.trim() ? 10_000 : 0)
    - Math.max(0, limits.boundaryAndActiveTask - 5_000) + recoverySurplus + executionSurplus);
  const explicitConversation = options.sectionMaxChars?.recentConversation;
  const explicitCognition = options.sectionMaxChars?.cognitiveArtifacts;
  const includeVault = limits.operatorVault === 0;
  // Every timeline citizen holds a budget. Distinct cognition — the units no
  // dialogue row owns — reserves up to the floor, but only as much of it as it
  // can actually fill at compact-row size: the reserve is measured demand, so
  // an idle lineage with nothing distinct taxes dialogue by zero characters,
  // and a busy one costs dialogue at most its oldest exchanges worth the floor.
  let cognitionReserve = 0;
  const owned = dialogueCandidateKeys(model, includeVault);
  if (explicitConversation === undefined && explicitCognition === undefined) {
    const hasDistinct = model.cognitiveArtifacts.some((row) => !owned.has(dialogueUnitKey(row.provenanceId)));
    if (hasDistinct) {
      const floor = Math.min(COGNITIVE_TIMELINE_FLOOR_CHARS, timelinePool);
      const probe = renderCognition(model, floor, buildRecoveryReferenceCatalog(model), !options.diagnostic, { candidates: owned });
      cognitionReserve = Math.min(floor, probe.text.length);
    }
  }
  limits.recentConversation = explicitConversation === undefined
    ? Math.max(0, timelinePool - cognitionReserve) : Math.min(limits.recentConversation, timelinePool);
  const dialogue = renderConversation(model, limits.recentConversation, buildRecoveryReferenceCatalog(model), !options.diagnostic, includeVault);
  const dialogueUsed = Math.min(limits.recentConversation, dialogue.text.length);
  if (explicitConversation === undefined) limits.recentConversation = dialogueUsed;
  if (explicitCognition === undefined) {
    // Whatever dialogue leaves flows to cognition; the reserve is a floor, not
    // a ceiling, and the two citizens always add up to the whole pool.
    limits.cognitiveArtifacts = Math.max(0, timelinePool - dialogueUsed);
  }
  // The conversation-first partition above reallocates WITHIN the ordinary
  // 145k content envelope. A lifecycle that declares a LARGER envelope
  // (brain_merge = 300k, or an explicit larger packageBudget) must not be
  // silently shrunk to the ordinary partition: its surplus, plus whatever the
  // timeline pool does not actually demand, funds the synthesis mandate the
  // larger budget exists for. Ordinary rebirths have no surplus, so this is
  // inert for them — including the extra demand probe, which only runs when
  // surplus capacity actually exists. The surplus follows the CONTENT, not the
  // envelope: with no donor synthesis to carry there is no mandate to fund, so
  // a larger budget alone can never inflate a section that renders nothing.
  const budget = packageBudgetChars(model, options);
  const envelopeSurplus = Number.isFinite(budget)
    ? Math.max(0, Math.floor(budget) - DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS)
    : 0;
  if (
    envelopeSurplus > 0
    && Boolean(model.brainMergeSynthesis?.trim())
    && limits.brainMergeSynthesis > 0
    && options.sectionMaxChars?.brainMergeSynthesis === undefined
  ) {
    const cognitionDemand = Math.min(
      limits.cognitiveArtifacts,
      renderCognition(model, limits.cognitiveArtifacts, buildRecoveryReferenceCatalog(model), false, { candidates: owned }).text.length,
    );
    const unusedTimelinePool = Math.max(0, limits.cognitiveArtifacts - cognitionDemand);
    limits.brainMergeSynthesis += envelopeSurplus + unusedTimelinePool;
  }

  return limits;
}

export function renderRebirthPackageV6Sections(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): readonly RenderedRebirthPackageV6Section[] {
  // Redaction lane: nothing republishes before it (pure, idempotent, cached).
  model = redactContinuityModel(model).model;
  // A section-only read does not deliver the raw appendix, so its rows must
  // remain self-contained instead of referring to an absent tail.
  if (model.rawHotTail) model = { ...model, rawHotTail: undefined };
  const limits = resolveAdaptiveSectionCaps(model, { ...options, diagnostic: true });
  // Standalone section readers retain their self-describing source envelopes;
  // the joined agent Timeline uses compact rows with its shared legend.
  return renderSectionsWithLimits(model, limits, undefined, undefined, !options.diagnostic, false);
}

function renderSectionsWithLimits(
  model: RebirthPackageV6Model,
  limits: Record<RebirthPackageV6SectionId, number>,
  timing?: RebirthPackageV6SectionTimingAccumulator,
  sharedReferences?: MutableRecoveryReferenceCatalog,
  compact = false,
  compactTimeline = compact,
): readonly RenderedRebirthPackageV6Section[] {
  const references = sharedReferences ?? buildRecoveryReferenceCatalog(model);
  const rendered = renderSectionBodies(model, limits, timing, references, compact, compactTimeline);
  // Audit-3 A8/S6: ONE completeness census derived from the actual rendered
  // bodies. The Boundary re-renders once WITH the census so its
  // capture-partial-lanes header, each section's partial= surface, the
  // RENDER-INCOMPLETE trailer, and the Recovery Index status= can never
  // disagree — one structure feeds all four.
  const completeness = computeSectionCompleteness(model, rendered, limits);
  rendered.boundaryAndActiveTask = measureSectionRender(timing, 'boundaryAndActiveTask', () => (
    renderBoundary(model, limits.boundaryAndActiveTask, completeness, references, compact)
  ));
  // Recovery section rows for rendered sections take the census status too
  // (fourth surface of the A8/S6 agreement), so it re-renders with the census.
  rendered.recoveryIndex = measureSectionRender(timing, 'recoveryIndex', () => (
    renderRecovery(model, limits.recoveryIndex, completeness, references, compact)
  ));
  const admitted = admittedSectionIds(model);
  // Render-loss sections in canonical order: the census's renderLoss flag is
  // the single basis for the trailer (was: admitted bodies with complete=false
  // — same outcome, now one structure with the header).
  // D2: a section the delivery deliberately does not render (limit 0 — life
  // ledger, episode chapter index, operator vault) is NOT an incomplete render.
  // Its units were relocated to the continuity ledger, and its own Recovery
  // Index row carries that status. Listing it here would report a truthful
  // relocation as a budget failure, and on a small package that false trailer
  // outweighed the section body it was appended to.
  const incomplete = REBIRTH_PACKAGE_V6_SECTION_IDS.filter((id) => {
    const entry = completeness.get(id);
    return entry?.renderLoss === true && entry.relocated === false;
  });
  if (incomplete.length > 0 && admitted.includes('recoveryIndex')) {
    const visibleSections = [...new Set(incomplete.map((id) => id === 'cognitiveArtifacts' ? 'recentConversation' : id))];
    const trailer = `\n[RENDER-INCOMPLETE sections: ${visibleSections.join(',')}]`;
    const recovery = rendered.recoveryIndex;
    if (recovery.text.length + trailer.length <= limits.recoveryIndex) {
      rendered.recoveryIndex = { ...recovery, text: `${recovery.text}${trailer}` };
    }
  }
  return admitted.map((id) => ({
    id,
    title: SECTION_TITLES[id],
    text: limits[id] <= 0 ? '' : measureSectionRender(timing, id, () => frameSection(id, rendered[id].text)),
    complete: rendered[id].complete,
    ...(rendered[id].collapse !== undefined ? { collapse: rendered[id].collapse } : {}),
    ...(rendered[id].unitPlacements !== undefined ? { unitPlacements: rendered[id].unitPlacements } : {}),
    ...(rendered[id].timelineRows !== undefined ? { timelineRows: rendered[id].timelineRows } : {}),
    ...(rendered[id].timelineSummary !== undefined ? { timelineSummary: rendered[id].timelineSummary } : {}),
    ...(rendered[id].timelineCensus !== undefined ? { timelineCensus: rendered[id].timelineCensus } : {}),
  }));
}

/**
 * Per-lineage-section collapse outcome of one actual render: the exact
 * placements behind the shipped text plus whether the normal section body was
 * replaced by a framed elision receipt at package compose. The section frame
 * itself is always retained. This is the record the continuity ledger persists
 * — computed once by the render, never re-derived.
 */
/** Sections owning collapse units: the v7 lineage trio plus the Active Edit Delta. */
export type RebirthPackageV7CollapseSectionId = RebirthPackageV7LineageSectionId | 'activeEditDelta';

export interface RebirthPackageV7SectionCollapseReport {
  readonly sectionId: RebirthPackageV7CollapseSectionId;
  readonly placements: readonly CollapseUnitPlacement[];
  readonly demotions: number;
  readonly droppedToFloorRollup: number;
  /** True when compose replaced the normal body with a framed elision receipt. */
  readonly sectionElided: boolean;
}

export interface RebirthPackageV7CollapseReport {
  readonly rawHotTailIds?: readonly string[];
  readonly sections: readonly RebirthPackageV7SectionCollapseReport[];
  /** Non-collapse sections whose exact source-unit omissions are ledgered. */
  readonly omissionSections: readonly RebirthPackageV6OmissionSectionReport[];
  /** Optional sections whose normal bodies yielded; their frames remain present. */
  readonly omittedSectionIds: readonly RebirthPackageV6SectionId[];
  /** Per-render counters from the graceful push-shrink and final compose. */
  readonly telemetry: RebirthPackageV7EvictionTelemetry;
}

export interface RebirthPackageV6OmissionSectionReport {
  readonly sectionId: 'cognitiveArtifacts';
  readonly placements: readonly RebirthPackageV6UnitPlacement[];
  readonly sectionElided: boolean;
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
  /**
   * Audit-3 A3: present when the post-admission cap enforcement trimmed
   * optional section bodies to keep delivered chars within the declared
   * budget. `capEnforcedChars` is the enforced budget value.
   */
  readonly capEnforcedChars?: number;
  readonly trimmedSectionIds?: readonly RebirthPackageV6SectionId[];
}

export interface RenderedRebirthPackageV6WithReport {
  readonly text: string;
  readonly collapse: RebirthPackageV7CollapseReport;
  /** Cumulative measured render cost across every pass; absent when not requested. */
  readonly sectionTimingsMs?: RebirthPackageV6SectionTimings;
}

function buildCollapseReport(
  sections: readonly RenderedRebirthPackageV6Section[],
  omittedSectionIds: readonly RebirthPackageV6SectionId[],
  telemetry: RebirthPackageV7EvictionTelemetry,
): RebirthPackageV7CollapseReport {
  const omitted = new Set<RebirthPackageV6SectionId>(omittedSectionIds);
  const dialogue = sections.find((section) => section.id === 'recentConversation');
  const deliveredDialogue = new Set(!omitted.has('recentConversation')
    ? (dialogue?.unitPlacements ?? []).filter((row) => row.placement === 'rendered' && !row.projected).map((row) => row.id)
    : []);
  const citizens = sections.filter((section): section is RenderedRebirthPackageV6Section & { collapse: CollapseResult } => (
    section.collapse != null
    && ((REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS as readonly string[]).includes(section.id)
      || section.id === 'activeEditDelta')
  ));
  return {
    sections: citizens.map((section) => ({
      sectionId: section.id as RebirthPackageV7CollapseSectionId,
      placements: section.collapse.placements.map((placement) => section.id === 'operatorVault'
        && deliveredDialogue.has(conversationRowBaseId(placement.id))
        ? { ...placement, tier: 't0' as const } : placement),
      demotions: section.collapse.demotions,
      droppedToFloorRollup: section.collapse.droppedToFloorRollup,
      sectionElided: omitted.has(section.id) && !(section.id === 'operatorVault'
        && section.collapse.placements.some((placement) => deliveredDialogue.has(conversationRowBaseId(placement.id)))),
    })),
    omissionSections: sections
      .filter((section): section is RenderedRebirthPackageV6Section & {
        id: 'cognitiveArtifacts';
        unitPlacements: readonly RebirthPackageV6UnitPlacement[];
      } => section.id === 'cognitiveArtifacts' && section.unitPlacements !== undefined)
      .map((section) => ({
        sectionId: 'cognitiveArtifacts',
        placements: section.unitPlacements,
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
 * Eviction body for a section whose normal body yielded at package compose:
 * unit count, source span, a skeletal era census, and the one continuity-ledger
 * handle where every evicted unit's placement row lives (spec: per-section
 * pointers to the ledger, not per-unit receipt spam). The caller wraps this in
 * the section's normal frame. A missing ledger handle renders the declared
 * degradation line — never a dead pointer.
 */
function buildSectionEvictionEnvelope(args: {
  sectionId: RebirthPackageV7CollapseSectionId;
  units: readonly CollapseUnit[];
  omissionHandle: string | null;
  includeCensus: boolean;
}): string {
  const times = args.units
    .map((unit) => unit.sourceAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const span = times.length > 0 ? `${times[0]}..${times.at(-1)}` : 'unknown..unknown';
  const header = args.omissionHandle
    ? `[EVICTED section=${args.sectionId} units=${args.units.length} span=${span} recover=${args.omissionHandle}]`
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

/**
 * ONE census line for the unified timeline.
 *
 * The diagnostic sub-counters the audited specimen shipped inline
 * (`relay-drops{…}`, `upstream-rejects{…}`, `dedupe{…}`, per-section
 * `recover=R<n>`) told the reader how the selector felt, not what it owed. What
 * survives here is the parity fact a successor can act on: how many captured
 * units did not render whole, and the single executable command that returns
 * them. Per-section detail stays in `timelineSummary` for diagnostic renders
 * and in the continuity ledger for exact recovery.
 */
function buildTimelineCensusLines(
  sections: readonly RenderedRebirthPackageV6Section[],
  dated: number,
  quarantined: number,
  partial: boolean,
): string[] {
  const censuses = sections
    .map((section) => section.timelineCensus)
    .filter((census): census is RebirthTimelineCensus => census !== undefined);
  const captured = censuses.reduce((sum, census) => sum + census.captured, 0);
  const incomplete = censuses.reduce((sum, census) => sum + census.incomplete, 0);
  const matched = censuses.reduce<number | null>(
    (sum, census) => (census.matched === null ? sum : (sum ?? 0) + census.matched),
    null,
  );
  const commands = [...new Set(
    censuses.map((census) => census.omissionCommand).filter((command): command is string => Boolean(command)),
  )];
  const accounting = censuses.length > 0
    ? `; ${incomplete} of ${captured} captured units not fully rendered${matched === null ? '' : ` (${matched} matched upstream)`}`
    : '';
  const head = `Timeline census: ${dated} dated, ${quarantined} quarantined${accounting}; `
    + `${partial ? 'partial' : 'captured rows complete'}.`;
  return commands.length > 0 ? [head, `Omitted units: ${commands.join(' · ')}`] : [head];
}

function joinRenderedSections(
  sections: readonly RenderedRebirthPackageV6Section[],
  declaration: string | null,
  model?: RebirthPackageV6Model,
): string {
  const timelineSections = sections.filter((section) => (
    section.id === 'recentConversation' || section.id === 'cognitiveArtifacts'
  ));
  // Dialogue owns a duplicated message body. Identity aliases are exact
  // message prefixes, never normalized prose or substring matches.
  const rows = new Map<string, RebirthTimelineRow>();
  for (const section of [...timelineSections].sort((a, b) => (
    Number(a.id === 'recentConversation') - Number(b.id === 'recentConversation')
  ))) {
    for (const row of section.timelineRows ?? []) rows.set(row.id, row);
  }
  const known = [...rows.values()].filter((row) => row.sourceAt && Number.isFinite(Date.parse(row.sourceAt)))
    .sort((a, b) => Date.parse(a.sourceAt!) - Date.parse(b.sourceAt!) || a.id.localeCompare(b.id));
  const unknown = [...rows.values()].filter((row) => !row.sourceAt || !Number.isFinite(Date.parse(row.sourceAt)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const partial = timelineSections.some((section) => !section.complete);
  const body = [
    ...(partial ? ['Timeline partial; omitted source units remain in the continuity ledger.'] : []),
    ...(model
      ? buildTimelineCensusLines(timelineSections, known.length, unknown.length, partial)
      : timelineSections.flatMap((section) => section.timelineSummary ? [section.timelineSummary] : [])),
    ...known.map((row) => model ? row.compactText ?? row.text : row.text),
    ...(unknown.length > 0 ? ['Unknown source time (quarantined; not part of the chronology):', ...unknown.map((row) => model ? row.compactText ?? row.text : row.text)] : []),
    // Preserve fallback receipt bodies inside the shared frame. These strings
    // are renderer-owned section frames; source content inside stays intact.
    ...timelineSections.filter((section) => section.timelineRows === undefined).map((section) => (
      section.text.startsWith(`── ${SECTION_TITLES[section.id]} ──\n${V6_SECTION_OPEN_PREFIX} id=${section.id} `)
        && section.text.endsWith(`\n${V6_SECTION_CLOSE}`)
        ? section.text.split('\n').slice(2, -1).join('\n')
        : section.text
    )),
  ].join('\n\n');
  const timeline = `── Timeline ──\n[REBIRTH-V6-SECTION id=recentConversation order=6 dir=asc chars=${body.length}]\n${body}\n${V6_SECTION_CLOSE}`;
  let emittedTimeline = false;
  const sectionsText = sections.map((section) => {
    if (section.id !== 'recentConversation' && section.id !== 'cognitiveArtifacts') return section.text;
    if (emittedTimeline) return '';
    emittedTimeline = true;
    return timeline;
  }).filter(Boolean).join('\n\n');
  return declaration ? `${declaration}\n\n${sectionsText}` : sectionsText;
}

interface RebirthPackageV7ShrinkOutcome {
  readonly sections: readonly RenderedRebirthPackageV6Section[];
  readonly text: string;
  readonly shrinkRenders: number;
  readonly sectionsShrunk: number;
  readonly capReductionChars: number;
  /** Section caps that produced `sections`, for downstream reduced-cap admission. */
  readonly limits: Record<RebirthPackageV6SectionId, number>;
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
  timing?: RebirthPackageV6SectionTimingAccumulator;
  diagnostic?: boolean;
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
    // Every probe gets a render-local recovery-reference ledger. A rejected
    // probe must not make later candidates pay for handles that will never
    // ship in their text.
    const candidateSections = renderSectionsWithLimits(args.model, candidateLimits, args.timing, undefined, !args.diagnostic);
    shrinkRenders += 1;
    return {
      limits: candidateLimits,
      sections: candidateSections,
      // Admission is based on the exact bytes the final funnel can deliver.
      // Unreferenced legend rows are removed there, so retaining them for size
      // comparisons would over-shrink real continuity content.
      text: pruneRecoveryLegendRows(joinRenderedSections(candidateSections, args.declaration, args.diagnostic ? undefined : args.model)),
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
    limits,
  };
}

/**
 * Audit-4 S7: prune Recovery-Index legend rows whose R<n> ref no section body
 * cites. Text-level and order-preserving: surviving rows keep their exact
 * numbers, and removing lines can only shrink the package. A ref counts as
 * cited when it appears on any NON-legend line (recovery rows' `recover=R<n>`,
 * eviction envelopes, partial-line citations, inline-evidence headers).
 */
function pruneRecoveryLegendRows(text: string): string {
  const legendRowRe = /^- (R\d+) = /u;
  const citeRe = /\b(R\d+)\b/gu;
  const lines = text.split('\n');
  const cited = new Set<string>();
  for (const line of lines) {
    if (legendRowRe.test(line)) continue;
    for (const match of line.matchAll(citeRe)) cited.add(match[1]!);
  }
  const hasLegend = lines.some((line) => legendRowRe.test(line));
  if (!hasLegend) return text;
  const kept = lines.filter((line) => {
    const ref = legendRowRe.exec(line)?.[1];
    return ref === undefined || cited.has(ref);
  });
  return kept.join('\n');
}

/**
 * ── Metadata density ────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS (rail-72adf723 S27). S19 asserted a "per-section metadata
 * <= 0.30" bar with no metric behind it, so the measurement used an ad-hoc
 * keyed-line heuristic that counted any `key=value` line as metadata. That
 * heuristic scored executionState 0.973, recoveryIndex 0.450 and
 * activeEditDelta 0.452 — not because those sections were diluted, but because
 * they are FACT TABLES whose keyed lines are the content. A metric that
 * penalises a fact table for being a fact table measures the wrong thing.
 *
 * THE DISTINCTION. The bar exists to stop provenance decoration from diluting
 * the prose an agent actually reads. So:
 *   - DECORATION is how to FIND or VERIFY a claim: the trailing `⟨source @time⟩`
 *     anchor, and addressing keys whose values are opaque identifiers a reader
 *     never interprets (call-id, result-source, sha256, capture-id, ...).
 *   - CONTENT is what the row SAYS — including truth labels like
 *     `outcome=unknown` or `current-source=unverified`, which change the
 *     meaning of the claim and are exactly what a successor must read.
 * A key is decoration because of what it addresses, not because it has an `=`.
 */
const REBIRTH_METADATA_ANCHOR_RE = /⟨[^⟩]*⟩/gu;

/**
 * Keys whose values are addressing/verification identifiers. Deliberately a
 * closed list: a key earns membership by being something a reader USES TO LOOK
 * SOMETHING UP rather than something they read. Truth/outcome labels are
 * excluded on purpose.
 */
const REBIRTH_METADATA_ADDRESSING_KEYS: readonly string[] = Object.freeze([
  'source', 'source-time', 'call-id', 'result-source', 'artifact-hashes',
  'provenance', 'capture-id', 'exposure-id', 'recover', 'projection',
  'authority', 'kept-by', 'frontier', 'sha256', 'atlas-file-row',
  'evidence-ids', 'observed-at',
]);

const REBIRTH_METADATA_ADDRESSING_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${REBIRTH_METADATA_ADDRESSING_KEYS.join('|')})=[^\\s·⟩]*`,
  'gu',
);

/**
 * Sections that carry prose a successor READS. The 0.30 bar is theirs: prose
 * diluted by decoration is the harm the bar was written for.
 */
export const REBIRTH_PACKAGE_PROSE_SECTION_IDS: ReadonlySet<string> = new Set([
  'boundaryAndActiveTask',
  'recentConversation',
]);

/**
 * Per-class bars. Structured sections get a higher bar because addressing is a
 * legitimately larger share of a terse fact row — but not an unlimited one: a
 * row that is more than half addressing is telling the agent where to look
 * instead of what happened.
 */
export const REBIRTH_PACKAGE_METADATA_RATIO_BARS = Object.freeze({
  prose: 0.30,
  structured: 0.50,
});

export interface RebirthPackageMetadataDensity {
  readonly sectionId: string;
  readonly sectionClass: 'prose' | 'structured';
  readonly totalChars: number;
  readonly decorationChars: number;
  /** decorationChars / totalChars; 0 for an empty section. */
  readonly ratio: number;
  readonly bar: number;
  readonly withinBar: boolean;
}

function measureMetadataSpan(text: string): { totalChars: number; decorationChars: number } {
  const totalChars = text.length;
  let decorationChars = 0;
  for (const match of text.matchAll(REBIRTH_METADATA_ANCHOR_RE)) decorationChars += match[0].length;
  // Addressing keys are counted on the ANCHOR-STRIPPED text so a key inside an
  // anchor is never double-counted.
  const withoutAnchors = text.replace(REBIRTH_METADATA_ANCHOR_RE, '');
  for (const match of withoutAnchors.matchAll(REBIRTH_METADATA_ADDRESSING_RE)) {
    decorationChars += match[0].length;
  }
  return { totalChars, decorationChars };
}

/**
 * Measure decoration density of a RENDERED package, overall and per section.
 * Pure and total: any string yields a result. Section bodies are taken between
 * a `[REBIRTH-V6-SECTION id=…]` header and its closing tag, so an unframed
 * string measures as one `package` span rather than throwing.
 */
export function measureRebirthPackageMetadataDensity(rendered: string): {
  readonly overall: RebirthPackageMetadataDensity;
  readonly sections: readonly RebirthPackageMetadataDensity[];
} {
  const classify = (sectionId: string): 'prose' | 'structured' => (
    REBIRTH_PACKAGE_PROSE_SECTION_IDS.has(sectionId) ? 'prose' : 'structured'
  );
  const describe = (sectionId: string, text: string): RebirthPackageMetadataDensity => {
    const { totalChars, decorationChars } = measureMetadataSpan(text);
    const sectionClass = classify(sectionId);
    const bar = REBIRTH_PACKAGE_METADATA_RATIO_BARS[sectionClass];
    const ratio = totalChars > 0 ? decorationChars / totalChars : 0;
    return { sectionId, sectionClass, totalChars, decorationChars, ratio, bar, withinBar: ratio <= bar };
  };

  const sections: RebirthPackageMetadataDensity[] = [];
  const headerRe = /\[REBIRTH-V6-SECTION id=([a-zA-Z0-9]+)[^\]]*\]/gu;
  for (const match of rendered.matchAll(headerRe)) {
    const sectionId = match[1];
    const bodyStart = (match.index ?? 0) + match[0].length;
    const closeAt = rendered.indexOf('[/REBIRTH-V6-SECTION]', bodyStart);
    sections.push(describe(sectionId, rendered.slice(bodyStart, closeAt < 0 ? rendered.length : closeAt)));
  }

  return { overall: describe('package', rendered), sections };
}

export function renderRebirthPackageV6WithReport(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): RenderedRebirthPackageV6WithReport {
  const redacted = redactContinuityModel(model);
  model = redacted.model;
  if (!model.rawHotTail?.length) return renderRebirthPackagePastWithReport(model, options);
  const budget = packageBudgetChars(model, options);
  // Appended rows share the effective delivery limit with the past and its
  // outer envelope. Reserve the past's existing allowance before selecting
  // whole rows, otherwise a small push target can be exceeded by the tail alone.
  const envelopeChars = Number.isFinite(options.envelopeChars)
    ? Math.max(0, Math.floor(options.envelopeChars ?? 0)) : 0;
  const tailLimit = Math.max(0, pushTargetChars(model, options) - envelopeChars - 10_000 - 2);
  const tail = selectRebirthHotTail(model.rawHotTail, Math.min(50_000, tailLimit));
  const tailChars = tail.text ? tail.text.length + 2 : 0;
  const past = renderRebirthPackagePastWithReport({ ...model, rawHotTail: tail.rows }, {
    ...options,
    packageBudget: Math.max(1, budget - tailChars),
    ...(options.pushTargetChars !== undefined
      ? { pushTargetChars: Math.max(1, options.pushTargetChars - tailChars) } : {}),
  }, redacted.declaration);
  return { ...past,
    text: tail.text ? `${past.text}\n\n${tail.text}` : past.text,
    collapse: { ...past.collapse, rawHotTailIds: tail.rows.map((row) => row.id), telemetry: { ...past.collapse.telemetry,
      budgetChars: budget,
      finalTotalChars: past.collapse.telemetry.finalTotalChars + tailChars,
      initialTotalChars: past.collapse.telemetry.initialTotalChars + tailChars,
    } },
  };
}

function renderRebirthPackagePastWithReport(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options,
  inheritedRedactionDeclaration?: string | null,
): RenderedRebirthPackageV6WithReport {
  // Redaction lane first: sections, eviction envelopes, and ledger capture
  // must all derive from the same redacted model, and the aggregate
  // declaration must ride INSIDE the budget math, never appended beyond it.
  const lane = redactContinuityModel(model);
  model = lane.model;
  // Reference numbers come from immutable model order. This catalog belongs to
  // the accepted composition only; speculative shrink probes build their own
  // usage ledgers so rejected candidates cannot contaminate later sizing.
  const references = buildRecoveryReferenceCatalog(model);
  // A tail-selection clone contains already-redacted bytes but has no cached
  // redaction receipt. Preserve the original declaration through that clone.
  const declaration = inheritedRedactionDeclaration ?? lane.declaration;
  const budget = packageBudgetChars(model, options);
  const pushTarget = pushTargetChars(model, options);
  const envelopeChars = Number.isFinite(options.envelopeChars)
    ? Math.max(0, Math.floor(options.envelopeChars ?? 0))
    : 0;
  const sectionTiming = createSectionTimingAccumulator(options);
  const initialLimits = resolveAdaptiveSectionCapsInternal(model, options, sectionTiming);
  const initialSections = renderSectionsWithLimits(model, initialLimits, sectionTiming, references, !options.diagnostic);
  // The final funnel always prunes unreferenced Recovery legend rows. Make
  // every earlier budget decision against that same deliverable byte shape.
  const initialRendered = pruneRecoveryLegendRows(joinRenderedSections(initialSections, declaration, options.diagnostic ? undefined : model));
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
      timing: sectionTiming,
      diagnostic: options.diagnostic,
    })
    : {
      sections: initialSections,
      text: initialRendered,
      shrinkRenders: 0,
      sectionsShrunk: 0,
      capReductionChars: 0,
      limits: initialLimits,
    };
  let sections = shrink.sections;
  let sectionLimits = shrink.limits;
  const rendered = shrink.text;
  const finish = (
    text: string,
    omittedSectionIds: readonly RebirthPackageV6SectionId[],
    // Audit-3 A3: section bodies trimmed by the post-admission cap enforcement
    // (lowest-priority optional sections demoted to framed elision receipts so
    // delivered chars never exceed the declared budget).
    trimmedSectionIds: readonly RebirthPackageV6SectionId[] = [],
  ): RenderedRebirthPackageV6WithReport => {
    // Audit-4 S7 legend prune: runs on the FINAL composed text at the single
    // funnel every render path (early fits, shrink, admission, eviction)
    // returns through. A legend row survives iff its R<n> ref is cited on a
    // NON-legend line somewhere in the package — the audited specimen carried
    // 8 never-cited legend rows that cost budget and reader attention. The
    // prune is text-level so it can never renumber refs (absent rows simply
    // disappear; remaining rows keep their numbers) and never regrows the
    // package (pruning only removes lines).
    const prunedLegendText = pruneRecoveryLegendRows(text);
    const citizens = sections.filter((section): section is RenderedRebirthPackageV6Section & { collapse: CollapseResult } => (
      section.collapse != null
    ));
    const omitted = new Set(omittedSectionIds);
    // Self-checks are admitted INSIDE budget: reserve only the chars remaining
    // before `text + envelope` reaches the declared budget so lint never pushes
    // the final package past its cap, and telemetry sees the true total.
    const budgetFloor = Number.isFinite(budget)
      ? Math.max(0, Math.floor(budget) - envelopeChars - prunedLegendText.length)
      : prunedLegendText.length * 2;
    const linted = withSelfLint(model, prunedLegendText, budgetFloor);
    const finalText = linted.text;
    const finalTotalChars = finalText.length + envelopeChars;
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
      ...(trimmedSectionIds.length > 0 && Number.isFinite(budget) && budget > 0
        ? {
          capEnforcedChars: Math.max(0, Math.floor(budget)),
          trimmedSectionIds,
        }
        : {}),
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
      text: finalText,
      collapse: buildCollapseReport(sections, omittedSectionIds, telemetry),
      ...(sectionTiming ? { sectionTimingsMs: { ...sectionTiming.durations } } : {}),
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

  // These bodies stay whole. Every admitted section FRAME is protected below;
  // optional means only that its normal body may yield to a framed elision
  // receipt. Never slice a framed section mid-line: that can hide an omitted-
  // file or truncation receipt and make partial evidence look complete.
  const protectedIds = new Set<RebirthPackageV6SectionId>([
    'boundaryAndActiveTask',
    'brainMergeSynthesis',
    'executionState',
    'activeEditDelta',
    'recoveryIndex',
  ]);
  const optional = sections.filter((section) => !protectedIds.has(section.id));
  const recover = recoveryReference(
    references,
    model.recoveryIndex.find((entry) => entry.id === 'rebirth-package')?.handle,
  ) || 'unavailable';
  const citizenUnits = (id: RebirthPackageV6SectionId): readonly CollapseUnit[] => {
    if (id === 'activeEditDelta') return buildActiveEditCollapseUnits(model);
    if ((REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS as readonly string[]).includes(id)) {
      return lineageSection(model, id as RebirthPackageV7LineageSectionId).units;
    }
    return [];
  };

  const framedElisionSection = (
    section: RenderedRebirthPackageV6Section,
    compactReceipt: boolean,
  ): string => {
    const units = citizenUnits(section.id);
    let body: string;
    if (units.length > 0) {
      body = buildSectionEvictionEnvelope({
        sectionId: section.id as RebirthPackageV7CollapseSectionId,
        units,
        omissionHandle: recoveryReference(
          references,
          continuityLedgerOmissionHandle(model, section.id),
        ),
        includeCensus: !compactReceipt,
      });
    } else if (section.id === 'cognitiveArtifacts' && model.cognitiveArtifacts.length > 0) {
      const omissionHandle = recoveryReference(
        references,
        continuityLedgerOmissionHandle(model, 'cognitiveArtifacts'),
      );
      body = `[EVICTED section=cognitiveArtifacts units=${model.cognitiveArtifacts.length}`
        + `${omissionHandle ? ` recover=${omissionHandle}` : ''}]`
        + (omissionHandle ? '' : '\nCognitive artifacts evicted; ledger unreachable');
    } else if (section.id === 'recentConversation'
      && (conversationWithVault(model).length > 0 || conversationEndpointReceipt(model).length > 0)) {
      const transcriptHandle = recoveryReference(
        references,
        model.recoveryIndex.find((entry) => entry.id === 'transcript')?.handle,
      );
      const endpointBodies = Number(Boolean(model.boundaryAndActiveTask.activeRequest))
        + Number(Boolean(model.boundaryAndActiveTask.lastMaterialAssistant));
      body = `[EVICTED section=recentConversation rows=${conversationWithVault(model).length}`
        + ` endpoint-bodies-relocated=${endpointBodies}`
        + `${transcriptHandle ? ` recover=${transcriptHandle}` : ''}]`
        + (transcriptHandle ? '' : '\nRecent conversation evicted; exact recovery unavailable');
    } else {
      // An admitted zero-unit section can still carry capture-degradation truth.
      // Preserve its structural slot even when that larger diagnostic body
      // cannot fit; Recovery Index remains the canonical expansion directory.
      body = `[EVICTED section=${section.id} units=0]`
        + '\nSection body yielded to package pressure; inspect Recovery Index.';
    }
    return frameSection(section.id, body);
  };

  const compose = (
    sectionsArg: readonly RenderedRebirthPackageV6Section[],
    includedOptional: ReadonlySet<RebirthPackageV6SectionId>,
    compactElisionReceipts = false,
    protectedOverrun = false,
    capNote = '',
  ): string => {
    const bodyElided = optional
      .filter((section) => !includedOptional.has(section.id))
      .map((section) => section.id);
    const composedSections: RenderedRebirthPackageV6Section[] = [];
    for (const section of sectionsArg) {
      if (section.id === 'recoveryIndex' && (bodyElided.length > 0 || protectedOverrun)) {
        const notice = `[REBIRTH-V6-PACKAGE-ELISION original-chars=${initialRendered.length} budget=${budget}`
          + ` envelope-chars=${envelopeChars}`
          + ` elided-section-bodies=${bodyElided.join(',') || 'none'}`
          + ` protected-overrun=${protectedOverrun || envelopeOverrun}`
          + capNote
          + ` recover=${recover}]`;
        composedSections.push({ ...section, text: `${notice}\n${section.text}` });
        continue;
      }
      if (protectedIds.has(section.id) || includedOptional.has(section.id)) {
        composedSections.push(section);
        continue;
      }
      // The normal body may yield, but the title/open/body/close frame is part
      // of the protected minimum package and can never disappear.
      composedSections.push({ ...section, text: framedElisionSection(section, compactElisionReceipts || protectedOverrun), timelineRows: undefined, timelineSummary: undefined });
    }
    // This is the exact pre-lint text finish() will deliver. Candidate
    // admission must not reject a section based on legend rows that the final
    // deterministic prune removes moments later.
    return pruneRecoveryLegendRows(joinRenderedSections(composedSections, declaration, options.diagnostic ? undefined : model));
  };

  const included = new Set<RebirthPackageV6SectionId>();
  const fullReceiptMinimum = compose(sections, included);
  const compactReceiptMinimum = compose(sections, included, true);
  if (compactReceiptMinimum.length > sectionBudget) {
    return finish(compose(sections, included, true, true), optional.map((section) => section.id));
  }
  // Era censuses are useful but not part of a section's protected minimum. If
  // they alone would force an overrun, retain every frame with compact receipts
  // and spend the remaining budget on actual section bodies.
  const compactElisionReceipts = fullReceiptMinimum.length > sectionBudget;

  // Reduced-cap admission (missing middle): a candidate that exceeds the
  // section budget at its current cap is retried at a bounded sequence of
  // reduced caps before it is elided wholesale. Cognition and conversation are
  // non-collapse sections, so the collapse-citizen shrink gear never relieves
  // them; the old all-or-nothing skip could amputate the only cognitive
  // carry-over while thousands of chars sat unused (specimen #38: cognition
  // elided with 36,209 chars of budget left). Every probe re-renders the FULL
  // section set at the candidate limits, so the compose that fits is the exact
  // render that ships — report, eviction envelopes, and ledger capture stay
  // congruent with the emitted bytes.
  const reducedCapAdmitsContent = (
    id: RebirthPackageV6SectionId,
    section: RenderedRebirthPackageV6Section | undefined,
  ): boolean => {
    if (!section) return false;
    if (id === 'cognitiveArtifacts') {
      return (section.unitPlacements ?? []).some(
        (placement) => placement.placement === 'rendered' && placement.projected !== true,
      );
    }
    if (id === 'recentConversation') {
      return (section.unitPlacements ?? []).some((placement) => placement.placement === 'rendered')
        || section.text.length > frameSection(id, '').length;
    }
    return false;
  };

  for (const section of optional) {
    // A vault pointer is valid only while the referenced Recent Conversation
    // body is admitted. Reverse-priority trimming drops operatorVault before
    // recentConversation below; this admission guard covers the other shape
    // (conversation could not fit, a compact pointer-only vault could).
    if (section.id === 'operatorVault' && !included.has('recentConversation')) continue;
    const candidate = new Set(included).add(section.id);
    if (compose(sections, candidate, compactElisionReceipts).length <= sectionBudget) {
      included.add(section.id);
      continue;
    }
    if (section.id !== 'cognitiveArtifacts' && section.id !== 'recentConversation') continue;
    const remaining = sectionBudget - compose(sections, included, compactElisionReceipts).length;
    if (remaining <= 0) continue;
    let probeCap = Math.min(sectionLimits[section.id], remaining);
    for (let attempt = 0; attempt < 4 && probeCap >= 1; attempt += 1) {
      const candidateLimits = { ...sectionLimits, [section.id]: probeCap };
      const candidateSections = renderSectionsWithLimits(model, candidateLimits, sectionTiming, undefined, !options.diagnostic);
      const candidateSection = candidateSections.find((probe) => probe.id === section.id);
      const fits = compose(candidateSections, candidate, compactElisionReceipts).length <= sectionBudget
        && reducedCapAdmitsContent(section.id, candidateSection);
      if (fits) {
        sections = candidateSections;
        sectionLimits = candidateLimits;
        included.add(section.id);
        break;
      }
      probeCap = Math.floor(probeCap / 2);
    }
  }
  // Audit-3 A3: the cap is on DELIVERED chars. Sections the admission loop
  // could not fit are NOT dropped silently — each optional body demoted to a
  // framed elision receipt is named on the receipt line itself via
  // `cap-enforced=<budget> trimmed=<ids>`, so a successor sees exactly what
  // budget pressure trimmed and why. Defense in depth: if the final compose
  // still exceeds the section budget (only possible through future admission
  // drift — every current path checks before including), drop included
  // optional bodies lowest-priority-first until it fits; the protected-minimum
  // overrun (envelope or frames alone exceed the budget) is the one case that
  // ships over, always recorded by hardOverrunChars, never silent.
  const budgetFloorNote = Number.isFinite(budget) ? String(Math.floor(budget)) : 'unbounded';
  const exclusionNote = (excluded: readonly RebirthPackageV6SectionId[]): string => (
    excluded.length > 0
      ? ` cap-enforced=${budgetFloorNote} trimmed=${excluded.join(',')}`
      : ''
  );
  const excludedIds = optional
    .filter((section) => !included.has(section.id))
    .map((section) => section.id);
  let finalIncluded = included;
  let finalExcluded = excludedIds;
  let finalText = compose(
    sections,
    finalIncluded,
    compactElisionReceipts,
    false,
    exclusionNote(finalExcluded),
  );
  if (finalText.length > sectionBudget) {
    const droppable = optional
      .filter((section) => finalIncluded.has(section.id))
      .reverse();
    for (const section of droppable) {
      finalIncluded = new Set(finalIncluded);
      finalIncluded.delete(section.id);
      finalExcluded = optional
        .filter((candidate) => !finalIncluded.has(candidate.id))
        .map((candidate) => candidate.id);
      finalText = compose(
        sections,
        finalIncluded,
        compactElisionReceipts,
        false,
        exclusionNote(finalExcluded),
      );
      if (finalText.length <= sectionBudget) break;
    }
  }
  // Audit-4 S7: the legend prune now lives inside finish() — the single funnel
  // every render path returns through (early fit, shrink, admission, and
  // eviction alike) — so the composed finalText ships directly here.
  return finish(finalText, finalExcluded, finalExcluded);
}

export function renderRebirthPackageV6(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): string {
  return renderRebirthPackageV6WithReport(model, options).text;
}

/**
 * Deterministic render-time self-lint (plan feature 11, W0 S2).
 *
 * Emits `⚠ self-check:` lines when the model+render would ship an internal
 * contradiction the package itself should surface rather than hide. Pure and
 * deterministic: same model + same render ⇒ same check lines. No behavior
 * change beyond the appended diagnostics. Each rule is a positive "flag if
 * broken" with a paired negative test.
 */
export function lintPackageSelfChecks(model: RebirthPackageV6Model, renderedText: string): string[] {
  const checks: string[] = [];

  // Rule 1 — families listed missing while matched>0. A canonical capture that
  // is complete but carries missingFamilies with matched roots means the
  // rendering is at risk of reporting "missing" for families that are present.
  const capture = model.cognitiveArtifactCapture;
  if (
    capture
    && capture.missingFamilies.length > 0
    && (capture.totalMatched ?? 0) > 0
    && (capture.status === 'complete' || capture.status === 'partial')
  ) {
    checks.push(
      `⚠ self-check: cognition lists missing families ${capture.missingFamilies.join(',')} while matched=${capture.totalMatched} — non-attestation, not absence; ensure the renderer frames it as watermarks-unattested, never data loss.`,
    );
  }

  // Rule 2 — an inline-body promise with no body. A recovery handle whose label
  // advertises an inline body but carries none is a dangling pointer. The
  // predicate matches the bounded phrase with or without its parentheses
  // (audit-2 A29-2: it previously required the literal `(inline body below)`).
  for (const entry of model.recoveryIndex) {
    if (/(?:inline\s*body\s+below|bounded\s+inline\s+evidence)/iu.test(entry.label.trim()) && !entry.inlineEvidence?.trim()) {
      checks.push(
        `⚠ self-check: recovery lane ${entry.id} labels "inline body below" but carries no inline evidence — dangling label.`,
      );
    }
  }

  // Rule 3 — a life rollup containing the head life. The newest known-time life
  // must render per-row (t0/t1); a [ROLLUP kind=life] whose span includes the
  // head life's sourceAt inverts recency protection (B7).
  const headLife = model.lifeLedger?.units
    ?.filter((u) => u.kind === 'life' && u.sourceAt)
    .sort((a, b) => (b.sourceAt as string).localeCompare(a.sourceAt as string))[0];
  if (headLife?.sourceAt) {
    const rollupRe = /\[ROLLUP kind=life[^\]]*\bspan=([^\] ]*?)\.\.([^\] ]*?)\]/g;
    let match: RegExpExecArray | null;
    while ((match = rollupRe.exec(renderedText)) !== null) {
      const [, start, end] = match;
      if (headLife.sourceAt >= start && headLife.sourceAt <= end) {
        checks.push(
          `⚠ self-check: life rollup [${start}..${end}] contains the head life (${headLife.sourceAt}) — newest life must stay per-row.`,
        );
        break;
      }
    }
  }

  // Rule 4 — a derived row whose source time is earlier than the source row it
  // derives from. Detectable case: a next_action/claim fact that mirrors the
  // active request verbatim but stamps an earlier sourceAt than the request
  // itself (B10: a derived row predating its source).
  if (model.boundaryAndActiveTask.activeRequest?.source?.sourceAt) {
    const requestAt = model.boundaryAndActiveTask.activeRequest.source.sourceAt;
    const requestText = model.boundaryAndActiveTask.activeRequest.text;
    for (const fact of model.executionState?.facts ?? []) {
      if (
        fact.kind === 'next_action'
        && fact.text.trim() === requestText.trim()
        && fact.sourceAt
        && fact.sourceAt < requestAt
      ) {
        checks.push(
          `⚠ self-check: next_action derives from the active request but is stamped ${fact.sourceAt}, before the request's own ${requestAt} — derived row predates its source.`,
        );
      }
    }
  }

  // Rule 5 — unknown-time rows presented as chronology. The risk this rule
  // exists to catch is a row with no source time sitting inside a rendered
  // chronological stream, where position alone implies an order the row cannot
  // support (God Rule 8). The check therefore scopes to what the delivered text
  // ACTUALLY renders as chronology, on both sides:
  //
  //  - The Timeline is the chronology now. Its conversation and cognition rows
  //    were invisible to this rule before the section unification, so the one
  //    section that can genuinely mis-order an undated row went unchecked.
  //  - A lineage section only carries chronology risk when its body renders.
  //    D2 relocates operatorVault/episodeChapterIndex/lifeLedger to the
  //    continuity ledger, so their undated units are addressed, not ordered —
  //    flagging them fired a permanent false positive on every package and
  //    taught successors to read a real banner as noise.
  const lineageSectionRendersBody = (id: RebirthPackageV6SectionId): boolean => (
    renderedText.includes(`[REBIRTH-V6-SECTION id=${id}`)
  );
  const unknownUnits = [
    ...(lineageSectionRendersBody('operatorVault') ? model.operatorVault?.units ?? [] : []),
    ...(lineageSectionRendersBody('episodeChapterIndex') ? model.episodeChapterIndex?.units ?? [] : []),
    ...(lineageSectionRendersBody('lifeLedger') ? model.lifeLedger?.units ?? [] : []),
  ].filter((u) => (u.sourceAt ?? null) === null);
  const unknownTimelineRows = lineageSectionRendersBody('recentConversation')
    ? [
      ...(model.recentConversation ?? []).filter((row) => (row.sourceAt ?? null) === null),
      ...(model.cognitiveArtifacts ?? []).filter((row) => (row.sourceAt ?? null) === null),
    ].length
    : 0;
  const unknownRendered = unknownUnits.length + unknownTimelineRows;
  if (unknownRendered > 0 && !renderedText.includes('Unknown source time (quarantined')) {
    checks.push(
      `⚠ self-check: ${unknownRendered} rendered unit(s) carry unknown source time but no quarantine banner rendered — unknown-time rows must not read as chronology.`,
    );
  }

  return checks;
}

/**
 * Append self-check diagnostics to a rendered package, BOUNDED inside budget.
 *
 * Self-check lines are honesty signals that must never silently push the final
 * package past its declared budget (the audit edge: appending after `finish`
 * bypassed telemetry and could exceed `budget`). `available` is how many chars
 * remain before `text + envelope` reaches the hard cap; we append as many whole
 * self-check lines as fit, then a bounded note naming how many were elided. The
 * telemetry in `finish` accounts for the returned length, so final + envelope
 * never exceeds the declared budget.
 */
function withSelfLint(
  model: RebirthPackageV6Model,
  text: string,
  availableForLint: number,
): { text: string; lintCount: number } {
  const checks = lintPackageSelfChecks(model, text);
  if (checks.length === 0) return { text, lintCount: 0 };
  const budget = Math.max(0, availableForLint);
  // Every appended byte is admission-checked against the remaining budget.
  // `header` is `\n\n<count> package self-check(s) surfaced:`. We accumulate an
  // output string and only ever append a fragment when it fits; if even the
  // header cannot fit, no diagnostic ships and the original text is returned
  // unchanged — a self-check must never push the package past its declared cap
  // (the audit edge). The elided suffix is likewise admission-checked, never
  // bolted on without re-probing room.
  const header = `\n\n${checks.length} package self-check(s) surfaced:`;
  let out = '';
  let budgetLeft = budget;
  if (header.length > budgetLeft) {
    // No diagnostic header fits: ship nothing (original text unchanged) rather
    // than exceeding the cap with a bare marker.
    return { text, lintCount: checks.length };
  }
  out += header;
  budgetLeft -= header.length;
  let admitted = 0;
  for (const check of checks) {
    // Audit-2 A29-3: the ternary was a no-op (`\n` both branches).
    const line = `\n${check}`;
    if (line.length > budgetLeft) break;
    out += line;
    budgetLeft -= line.length;
    admitted += 1;
  }
  if (admitted === 0) {
    // Header fit but no check line did. Prefer a bounded in-budget note over
    // silently dropping the header: only when a compact omission marker fits.
    const omission = ` (no room to print any; ${checks.length} self-check(s) elided for budget)`;
    if (omission.length <= budget - header.length) {
      return { text: `${text}${header}${omission}`, lintCount: checks.length };
    }
    return { text: `${text}${header}`, lintCount: checks.length };
  }
  if (admitted < checks.length) {
    const suffix = `\n(… +${checks.length - admitted} more self-check(s) elided for budget)`;
    if (suffix.length <= budgetLeft) out += suffix;
  }
  return { text: `${text}${out}`, lintCount: checks.length };
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
  | 'rawHotTail'
  | 'cognitiveArtifacts'
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
  /**
   * Projection declaration (mirrors CollapseUnit.projection). Present only when
   * `verbatim` is a stored prefix of a longer source `recover` resolves. Without
   * it a reader could treat the stored hash (which attests `verbatim`, not the
   * source) as full-artifact proof.
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

/** Source units behind the budgeted Cognitive Artifacts section. */
function buildCognitiveLedgerUnits(model: RebirthPackageV6Model): readonly CollapseUnit[] {
  const recover = model.recoveryIndex.find((entry) => entry.id === 'cognition')?.handle
    || 'unavailable (cognition store handle absent at capture)';
  const admittedIds = new Set(model.cognitiveArtifacts.map((row) => row.provenanceId));
  const sourceRows = [
    ...model.cognitiveArtifacts,
    ...(model.cognitiveArtifactCapture?.droppedByBudget ?? [])
      .filter((row) => !admittedIds.has(row.provenanceId)),
  ];
  return sourceRows.map((sourceRow) => {
    // Storage economy (dynamic fill, operator directive 2026-08-26): the model
    // carries FULL bodies so the render can ship them whole while the envelope
    // has room, but the ledger persists at most the declared per-entry
    // projection of each row. This is the second of exactly two call sites of
    // projectCognitiveRow (the other is the contended render fallback), so a
    // contended render and its capture produce identical bytes by
    // construction, while a full-fidelity render ships a body whose stored
    // ledger copy is a byte-exact declared PREFIX of it — sha256 attests the
    // stored projection or the entirety of real source bytes, never an
    // undeclared slice. Both call sites share the model's capturedAt as the
    // projection reference instant (audit-2 A22).
    const row = projectCognitiveRow(
      sourceRow,
      model.boundaryAndActiveTask.capturedAt,
      cognitiveLifeBoundaryStarts(model),
    );
    const verbatim = cognitionRowBody(row, model.boundaryAndActiveTask.capturedAt);
    const projection = row.projection === 'truncated'
      && row.storedChars !== undefined
      && row.storedBytes !== undefined
      && row.sourceChars !== undefined
      && row.sourceBytes !== undefined
      ? {
          mode: 'truncated' as const,
          algorithm: 'head-clamp' as const,
          version: 1,
          storedChars: row.storedChars,
          storedBytes: row.storedBytes,
          sourceChars: row.sourceChars,
          sourceBytes: row.sourceBytes,
        }
      : undefined;
    return {
      id: row.provenanceId,
      sourceAt: row.sourceAt,
      kind: 'cognitive',
      verbatim,
      digest: oneLineClaim(verbatim, 220),
      eraKey: row.sourceAt ? row.sourceAt.slice(0, 10) : null,
      claim: `${row.kind}: ${oneLineClaim(row.text, 180)}`,
      recover,
      ...(projection ? { projection } : {}),
    };
  });
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
  const rawIds = new Set(report.rawHotTailIds ?? []);
  for (const row of model.rawHotTail ?? []) {
    const rendered = rawIds.has(row.id);
    units.push({
      unitId: `raw-tail:${row.id}`, kind: `message:${row.kind}`, sectionId: 'rawHotTail',
      sourceProvenanceId: row.id, sourceIdentityAuthority: 'exact', sourceIndex: null,
      sourceInstanceId: row.sourceInstanceId, sourceTime: row.sourceAt, sourceEndTime: row.sourceAt,
      eraKey: row.sourceAt.slice(0, 10), tier: rendered ? 't0' : 't4',
      tierBasis: rendered ? 'rendered' : 'cap-overflow', placement: rendered ? 'rendered' : 'elided',
      claim: `${row.kind} source ${row.id}`, verbatim: row.text,
      sha256: sha256ContinuityLedgerVerbatim(row.text), origin: 'declared', recover: row.recover, workspace,
    });
  }
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
        ...(unit.projection ? { projection: unit.projection } : {}),
      });
    }
  }
  for (const sectionReport of report.omissionSections ?? []) {
    if (sectionReport.sectionId !== 'cognitiveArtifacts') continue;
    const sourceUnits = buildCognitiveLedgerUnits(model);
    const byId = new Map(sourceUnits.map((unit) => [unit.id, unit]));
    for (const outcome of sectionReport.placements) {
      const unit = byId.get(outcome.id);
      if (!unit) continue;
      const placement: ContinuityLedgerPlacement = sectionReport.sectionElided
        ? 'elided'
        : outcome.placement;
      const tierBasis: ContinuityLedgerTierBasis = sectionReport.sectionElided
        ? 'section-elision'
        : placement === 'rendered' && !outcome.projected
          ? 'rendered'
          : 'cap-overflow';
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
        tier: placement === 'rendered' ? 't0' : 't4',
        tierBasis,
        placement,
        claim: unit.claim,
        verbatim: unit.verbatim,
        sha256: sha256ContinuityLedgerVerbatim(unit.verbatim),
        origin: unit.origin ?? null,
        recover: unit.recover,
        workspace,
        ...(unit.projection ? { projection: unit.projection } : {}),
      });
    }
  }
  // Selector-level budget evictions never entered model.cognitiveArtifacts,
  // so the renderer cannot produce placements for them. Their capture lane is
  // nonetheless source-stamped and addressable: mint explicit T4 elisions
  // beside render-time truncations/drops without changing any header count.
  const existingCognitiveIds = new Set(units
    .filter((unit) => unit.sectionId === 'cognitiveArtifacts')
    .map((unit) => unit.unitId));
  const droppedIds = new Set(
    (model.cognitiveArtifactCapture?.droppedByBudget ?? [])
      .map((row) => row.provenanceId),
  );
  for (const unit of buildCognitiveLedgerUnits(model)) {
    if (!droppedIds.has(unit.id) || existingCognitiveIds.has(unit.id)) continue;
    existingCognitiveIds.add(unit.id);
    units.push({
      unitId: unit.id,
      kind: unit.kind,
      sectionId: 'cognitiveArtifacts',
      sourceProvenanceId: unit.id,
      sourceIdentityAuthority: 'exact',
      sourceIndex: null,
      sourceInstanceId: unit.sourceInstanceId ?? null,
      sourceTime: unit.sourceAt ?? null,
      sourceEndTime: unit.sourceEndAt ?? null,
      eraKey: unit.eraKey ?? null,
      tier: 't4',
      tierBasis: 'cap-overflow',
      placement: 'elided',
      claim: unit.claim,
      verbatim: unit.verbatim,
      sha256: sha256ContinuityLedgerVerbatim(unit.verbatim),
      origin: unit.origin ?? null,
      recover: unit.recover,
      workspace,
      ...(unit.projection ? { projection: unit.projection } : {}),
    });
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
        ?? `tap_instance_messages action="recent" target_instance_id=${JSON.stringify(ownerInstanceId)} (unit is canonical event ${sourceIndex} in that transcript)`,
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
