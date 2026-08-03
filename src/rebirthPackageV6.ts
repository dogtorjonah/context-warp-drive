/**
 * Canonical Rebirth Package v6 model and renderer.
 *
 * This module is deliberately pure: callers freeze every external fact before
 * construction, then every delivery surface renders the same immutable model.
 * It performs no filesystem, Git, Atlas, transcript, or relay-state reads.
 */

import type { ContinuityLiveFieldSource, ContinuityReceipt } from './continuityReceipt.ts';

export const REBIRTH_PACKAGE_V6_VERSION = 'rebirth-package-v6/v1' as const;

export const REBIRTH_PACKAGE_V6_SECTION_IDS = [
  'boundaryAndActiveTask',
  'executionState',
  'activeEditDelta',
  'cognitiveArtifacts',
  'recentConversation',
  'recoveryIndex',
] as const;

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
    | 'next_action'
    | 'blocker'
    | 'claim'
    | 'validation'
    | 'review'
    | 'runtime'
    | 'coordination';
  readonly text: string;
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

export interface RebirthPackageV6Model {
  readonly version: typeof REBIRTH_PACKAGE_V6_VERSION;
  readonly boundaryAndActiveTask: RebirthPackageV6BoundaryAndActiveTask;
  readonly executionState: RebirthPackageV6ExecutionState;
  readonly activeEditDelta: RebirthPackageV6ActiveEditDelta;
  readonly cognitiveArtifacts: readonly RebirthPackageV6CognitiveArtifact[];
  readonly recentConversation: readonly RebirthPackageV6ConversationRow[];
  readonly recoveryIndex: readonly RebirthPackageV6RecoveryHandle[];
}

export interface BuildRebirthPackageV6ModelInput {
  readonly boundaryAndActiveTask: RebirthPackageV6BoundaryAndActiveTask;
  readonly executionState?: RebirthPackageV6ExecutionState;
  readonly activeEditDelta?: RebirthPackageV6ActiveEditDelta;
  readonly cognitiveArtifacts?: readonly RebirthPackageV6CognitiveArtifact[];
  readonly recentConversation?: readonly RebirthPackageV6ConversationRow[];
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
  readonly recoveryIndex?: readonly RebirthPackageV6RecoveryHandle[];
}

export interface RenderRebirthPackageV6Options {
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
}

export interface RenderedRebirthPackageV6Section {
  readonly id: RebirthPackageV6SectionId;
  readonly title: string;
  readonly text: string;
  readonly complete: boolean;
}

const SECTION_TITLES: Readonly<Record<RebirthPackageV6SectionId, string>> = Object.freeze({
  boundaryAndActiveTask: 'Boundary and Active Task',
  executionState: 'Execution State',
  activeEditDelta: 'Active Edit Delta',
  cognitiveArtifacts: 'Cognitive Artifacts',
  recentConversation: 'Recent Conversation',
  recoveryIndex: 'Recovery Index',
});

export const DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS: Readonly<
  Record<RebirthPackageV6SectionId, number>
> = Object.freeze({
  boundaryAndActiveTask: 58_000,
  executionState: 18_000,
  activeEditDelta: 70_000,
  cognitiveArtifacts: 28_000,
  recentConversation: 12_000,
  recoveryIndex: 9_000,
});

export const DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS = 200_000;

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

export function buildRebirthPackageV6Model(
  input: BuildRebirthPackageV6ModelInput,
): RebirthPackageV6Model {
  const activeRequest = nonEmpty(input.boundaryAndActiveTask.activeRequest?.text);
  const lastAssistant = nonEmpty(input.boundaryAndActiveTask.lastMaterialAssistant?.text);
  const model: RebirthPackageV6Model = {
    version: REBIRTH_PACKAGE_V6_VERSION,
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
    recentConversation: normalizeConversationRows(
      input.recentConversation ?? [],
      activeRequest,
      lastAssistant,
    ),
    recoveryIndex: [...(input.recoveryIndex ?? [])],
  };
  return deepFreeze(model) as RebirthPackageV6Model;
}

export function isRebirthPackageV6Model(value: unknown): value is RebirthPackageV6Model {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<RebirthPackageV6Model>;
  return candidate.version === REBIRTH_PACKAGE_V6_VERSION
    && Boolean(candidate.boundaryAndActiveTask)
    && Boolean(candidate.executionState)
    && Boolean(candidate.activeEditDelta)
    && Array.isArray(candidate.cognitiveArtifacts)
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
  const assistantText = extractLegacyAssistant(legacy.lastUserAiMessages);
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
    });
    const nextAction = nonEmpty(receipt.nextAction ?? receipt.rail.queuedStepTitle);
    if (nextAction) {
      executionFacts.push({
        kind: 'next_action',
        text: nextAction,
        ...receiptFactSource('next_action', nextAction, receipt.liveState?.step.source ?? railSource),
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
          provenanceId: stableTextIdentity('last-assistant', assistantText),
          sourceAt: null,
          status: 'partial',
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
    `- ${fact.kind} · ${fact.text} · source=${fact.provenanceId} · source-time=${fact.sourceAt} · status=${fact.status}`
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

function renderActiveEdits(model: RebirthPackageV6Model, maxChars: number): { text: string; complete: boolean } {
  const delta = model.activeEditDelta;
  const lines = [
    `state=${delta.state} · capture=${delta.captureId ?? 'unknown'} · source-time=${delta.capturedSourceAt ?? 'unknown'} · observed-at=${delta.completedObservedAt ?? 'unknown'}`,
  ];
  if (delta.state === 'none' && delta.files.length === 0) {
    lines.push('Exact immutable capture proved zero open attributable diffs.');
  } else if (delta.state === 'unknown' && delta.files.length === 0) {
    lines.push('Active edit state is unknown; absence of evidence is not rendered as none.');
  }
  for (const file of delta.files) {
    const stats = file.insertions === null || file.deletions === null
      ? '+?/−?'
      : `+${file.insertions}/−${file.deletions}`;
    lines.push('', `${file.changeKind.toUpperCase()} ${file.filePath} · ${file.ownership} · baseline=${file.baselineQuality} · ${stats} · validation=${file.validationState} · closure=${file.closureState}`);
    if (file.state === 'withheld_sensitive' || file.baselineQuality === 'withheld_sensitive') {
      lines.push('  sensitive content withheld');
      continue;
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
  }
  if (delta.inheritedCaptureIds.length > 0) lines.push(`inherited-captures=${delta.inheritedCaptureIds.join(',')}`);
  if (delta.truncated || delta.omittedFiles > 0) {
    const recovery = model.recoveryIndex.find((entry) => entry.id === 'atlas-edit-capture')?.handle || 'unavailable';
    lines.push(`capture partial: omitted-files=${delta.omittedFiles} recover=${recovery}`);
  }
  for (const reason of delta.reasons) lines.push(`reason=${reason}`);
  const recovery = model.recoveryIndex.find((entry) => entry.id === 'atlas-edit-capture')?.handle ?? null;
  return boundedText(lines.join('\n'), maxChars, recovery);
}

function renderCognition(model: RebirthPackageV6Model, maxChars: number): { text: string; complete: boolean } {
  const known = model.cognitiveArtifacts.filter((row) => row.sourceAt);
  const unknown = model.cognitiveArtifacts.filter((row) => !row.sourceAt);
  const lines = known.map((row) => `${row.sourceAt} · ${row.kind} · ${row.text} · source=${row.provenanceId} · authority=${row.authority}`);
  if (unknown.length > 0) {
    lines.push('', 'Unknown source time (quarantined; not part of the chronology):');
    for (const row of unknown) lines.push(`- ${row.kind} · ${row.text} · source=${row.provenanceId} · authority=${row.authority}`);
  }
  if (lines.length === 0) lines.push('No relevant current cognitive artifacts captured.');
  return boundedText(lines.join('\n'), maxChars, model.recoveryIndex.find((entry) => entry.id === 'cognition')?.handle ?? null);
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

function frameSection(id: RebirthPackageV6SectionId, body: string): string {
  return [
    `── ${SECTION_TITLES[id]} ──`,
    `${V6_SECTION_OPEN_PREFIX} id=${id} chars=${body.length}]`,
    body,
    V6_SECTION_CLOSE,
  ].join('\n');
}

export function renderRebirthPackageV6Sections(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): readonly RenderedRebirthPackageV6Section[] {
  const limits = { ...DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS, ...options.sectionMaxChars };
  const rendered: Record<RebirthPackageV6SectionId, { text: string; complete: boolean }> = {
    boundaryAndActiveTask: renderBoundary(model, limits.boundaryAndActiveTask),
    executionState: renderExecution(model, limits.executionState),
    activeEditDelta: renderActiveEdits(model, limits.activeEditDelta),
    cognitiveArtifacts: renderCognition(model, limits.cognitiveArtifacts),
    recentConversation: renderConversation(model, limits.recentConversation),
    recoveryIndex: renderRecovery(model, limits.recoveryIndex),
  };
  return REBIRTH_PACKAGE_V6_SECTION_IDS
    .filter((id) => id !== 'recentConversation' || model.recentConversation.length > 0)
    .map((id) => ({
      id,
      title: SECTION_TITLES[id],
      text: frameSection(id, rendered[id].text),
      complete: rendered[id].complete,
    }));
}

export function renderRebirthPackageV6(
  model: RebirthPackageV6Model,
  options: RenderRebirthPackageV6Options = {},
): string {
  const sections = renderRebirthPackageV6Sections(model, options);
  const rendered = sections.map((section) => section.text).join('\n\n');
  const budget = options.packageBudget ?? DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS;
  if (!Number.isFinite(budget) || budget <= 0) return rendered;

  // The protected lifecycle envelope (emitted by the relay above these sections)
  // is reserved from the section budget so the produced total never silently
  // exceeds the declared packageBudget. When the envelope alone consumes the
  // entire budget, record a protected-overrun and admit no optional sections —
  // the envelope is protected, so the overrun must be visible, never hidden.
  const envelopeChars = Number.isFinite(options.envelopeChars)
    ? Math.max(0, Math.floor(options.envelopeChars ?? 0))
    : 0;
  const envelopeOverrun = envelopeChars > budget;
  const sectionBudget = envelopeOverrun ? 0 : Math.max(0, budget - envelopeChars);
  if (!envelopeOverrun && rendered.length <= sectionBudget) return rendered;

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

  const compose = (
    includedOptional: ReadonlySet<RebirthPackageV6SectionId>,
    protectedOverrun = false,
  ): string => {
    const omitted = optional
      .filter((section) => !includedOptional.has(section.id))
      .map((section) => section.id);
    const blocks: string[] = [];
    for (const section of sections) {
      if (section.id === 'recoveryIndex' && (omitted.length > 0 || protectedOverrun)) {
        blocks.push(
          `[REBIRTH-V6-PACKAGE-ELISION original-chars=${rendered.length} budget=${budget}`
          + ` envelope-chars=${envelopeChars} omitted-sections=${omitted.join(',') || 'none'}`
          + ` protected-overrun=${protectedOverrun || envelopeOverrun}`
          + ` recover=${recover}]`,
        );
      }
      if (protectedIds.has(section.id) || includedOptional.has(section.id)) {
        blocks.push(section.text);
      }
    }
    return blocks.join('\n\n');
  };

  const included = new Set<RebirthPackageV6SectionId>();
  const protectedOnly = compose(included);
  if (protectedOnly.length > sectionBudget) return compose(included, true);

  for (const section of optional) {
    const candidate = new Set(included).add(section.id);
    if (compose(candidate).length > sectionBudget) break;
    included.add(section.id);
  }
  return compose(included);
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
