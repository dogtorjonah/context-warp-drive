/**
 * Continuity Receipt — the versioned, typed boundary-state snapshot that all
 * rebirth control surfaces render from.
 *
 * Before this module, the Rebirth Control block existed as two independent
 * renderers (the relay full-package path and the raw-seed/fold-freeze path),
 * each re-parsing overlapping prose sections (Task Rail Context, Resume Point,
 * Active Edit Delta) with its own regexes and its own drifted output format.
 * The receipt makes boundary state singular:
 *
 *   1. Assembly happens ONCE per boundary — either from typed process truth
 *      (the resolved TaskRailSnapshot, file-context sets, triggering message)
 *      via `buildContinuityReceipt`, or from legacy prose sections via
 *      `continuityReceiptFromProse` for hand-built/persisted packages that
 *      predate typed capture.
 *   2. Rendering happens through ONE pure renderer,
 *      `renderContinuityReceiptControl`, shared by the relay full-package
 *      path and the raw-seed path. Surface-specific concerns (the active
 *      request capsule budget) inject as a hook.
 *   3. Newer typed state mechanically outranks historical synthetic prose:
 *      when a valid receipt is present on a package/seed input, prose parsing
 *      is skipped entirely; when the receipt is absent or from an unknown
 *      future version, callers fall back to prose synthesis and still render
 *      the same canonical block.
 *
 * The receipt is JSON-safe (no functions, no class instances) so it can ride
 * the RebirthBuildSnapshot bag through the worker/sidecar envelope.
 *
 * Pure module: no I/O, no timers, no environment access. GOD RULE 2 safe.
 */

import {
  isPendingAssistantAction as isCanonicalPendingAssistantAction,
  type PendingAssistantAction,
} from './pendingAssistantAction.ts';

export const CONTINUITY_RECEIPT_VERSION = 1 as const;

export type ContinuityReceiptBoundary =
  | 'same_instance_hard_epoch'
  | 'continuation'
  | 'fresh_fork'
  | 'resurrection'
  | 'brain_merge';

/** Authoritative event that delivered this package into the receiving lifecycle. */
export type ContinuityDeliveryKind = 'session-rebirth' | 'fork-birth';

const CONTINUITY_RECEIPT_BOUNDARIES: readonly ContinuityReceiptBoundary[] = [
  'same_instance_hard_epoch',
  'continuation',
  'fresh_fork',
  'resurrection',
  'brain_merge',
];

/** One executable rail step as captured at the boundary. */
export interface ContinuityReceiptRailStep {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** Authoritative source time of this step's latest mutation, when known. */
  readonly updatedAt?: string;
  /** 1-based position within the rail's step list when known. */
  readonly position?: number;
  readonly totalSteps?: number;
  /** The step instruction — the authoritative immediate next action. */
  readonly instruction?: string;
}

/**
 * Typed rail facts. `rawLine`/`activeStepRawLine` exist only for the
 * prose-synthesis fallback: when a legacy package carries a pre-rendered rail
 * or active-step line that could not be decomposed, the line is preserved
 * verbatim and rendered as-is rather than being dropped or re-invented.
 */
export interface ContinuityReceiptRail {
  readonly railId: string;
  readonly title: string;
  readonly state: string;
  readonly revision?: number;
  readonly locked?: boolean;
  readonly doneSteps?: number;
  readonly totalSteps?: number;
  readonly percentComplete?: number;
  readonly activeStep?: ContinuityReceiptRailStep;
  /** Title of the first pending step queued after the active one. */
  readonly queuedStepTitle?: string;
  readonly updatedAt?: string;
  readonly rawLine?: string;
  readonly activeStepRawLine?: string;
}

/** Open file claims and recent edit evidence at the boundary. */
export interface ContinuityReceiptEditClaim {
  /** False when no Active Edit Delta section was bundled at all. */
  readonly supplied: boolean;
  readonly claims: readonly string[];
  readonly editEvidenceFiles: readonly string[];
}

/** Latest explicit validation/verification fact visible at the boundary. */
export interface ContinuityReceiptValidation {
  /** Stripped fact text (label removed); undefined when none was bundled. */
  readonly fact?: string;
}

export interface ContinuityReceiptValidationSource {
  readonly text: string;
  /** Authoritative source time of the text carrying the fact, when known. */
  readonly sourceTimestamp?: string;
  /**
   * True only for rail-execution ACK channels (cognitive artifacts of type
   * 'rail'): permits the scanner to admit an anchored outcome assertion
   * without the explicit Validation:/Verification: label. Never set for free
   * prose, conversation, chat, glyph, or star rows — those stay under the
   * strict label gate so a plan or mention can never impersonate an outcome.
   */
  readonly trustedOutcomeChannel?: boolean;
}

/** Canonical event range of the predecessor trace at package creation. */
export interface ContinuityReceiptCanonicalRange {
  readonly traceId: string;
  /** Number of events in the trace (range is event#0..event#eventCount). */
  readonly eventCount: number;
  /** Authoritative source time of event#0, when known. */
  readonly firstEventTimestamp?: string;
  /** Stable identity of the newest event included at capture, when known. */
  readonly lastEventId?: string;
  /** Authoritative source time of the newest included event, when known. */
  readonly lastEventTimestamp?: string;
}

export type ContinuityLiveFieldStatus =
  | 'current'
  | 'stale'
  | 'superseded'
  | 'unknown'
  | 'conflicting';

/** Source and capture coordinates are separate: capture time never substitutes for source time. */
export interface ContinuityLiveFieldSource {
  readonly kind: string;
  readonly id: string;
  readonly coordinate?: string;
  readonly sourceTimestamp?: string;
  readonly capturedAt: string;
}

export interface ContinuityLiveField<T> {
  readonly status: ContinuityLiveFieldStatus;
  readonly source: ContinuityLiveFieldSource;
  readonly value?: T;
  readonly note?: string;
}

export interface ContinuityLiveInstance {
  readonly instanceId: string;
  readonly instanceName: string;
  readonly runtimeStatus: string;
  readonly creationCause?: string;
  readonly parentInstanceId?: string | null;
  readonly replacesInstanceId?: string | null;
  readonly originEventId?: string;
  readonly originSourceTimestamp?: string;
}

export interface ContinuityLiveRawTailFrontier {
  readonly traceId: string;
  readonly unit: 'event' | 'message' | 'row';
  readonly index?: number;
  readonly id?: string;
  readonly exactCount: number;
  /** Source time at the frontier. Undefined is rendered as unknown, never inferred from capture time. */
  readonly sourceTimestamp?: string;
}

/** One reconciled active-state view; historical package sections stay immutable. */
export interface ContinuityReceiptLiveState {
  readonly capturedAt: string;
  readonly instance: ContinuityLiveField<ContinuityLiveInstance>;
  readonly request: ContinuityLiveField<{ readonly text: string; readonly totalChars: number }>;
  /** Newest assistant-created executable open loop, when one is still unresolved. */
  readonly assistantAction?: ContinuityLiveField<PendingAssistantAction>;
  readonly rail: ContinuityLiveField<ContinuityReceiptRail>;
  readonly step: ContinuityLiveField<ContinuityReceiptRailStep>;
  readonly claims: ContinuityLiveField<readonly string[]>;
  readonly edits: ContinuityLiveField<readonly string[]>;
  readonly validation: ContinuityLiveField<{ readonly fact: string }>;
  readonly review: ContinuityLiveField<{ readonly state: string }>;
  readonly blockers: ContinuityLiveField<readonly string[]>;
  /** Membership snapshot at capture time; not room activity history or squad membership. */
  readonly rooms: ContinuityLiveField<readonly string[]>;
  readonly subscriptions: ContinuityLiveField<readonly string[]>;
  readonly rawTailFrontier: ContinuityLiveField<ContinuityLiveRawTailFrontier>;
}

export interface ContinuityReceipt {
  readonly version: typeof CONTINUITY_RECEIPT_VERSION;
  readonly boundary: ContinuityReceiptBoundary;
  readonly predecessorName: string;
  /** ISO capture time for builder-assembled receipts; absent for prose synthesis. */
  readonly capturedAt?: string;
  /** Stable identity of the boundary capture. Optional only for persisted v1 receipts predating this field. */
  readonly captureSourceId?: string;
  readonly sourceStatus?: string;
  readonly rail?: ContinuityReceiptRail;
  /** Newer unresolved assistant commitment/progress that outranks a stale rail. */
  readonly pendingAssistantAction?: PendingAssistantAction;
  /**
   * Immediate next action as resolved at assembly: current operator request,
   * then pending assistant action, then explicit/rail fallback.
   */
  readonly nextAction?: string;
  readonly activeRequest?: { readonly text: string; readonly totalChars: number };
  readonly editClaim: ContinuityReceiptEditClaim;
  readonly validation: ContinuityReceiptValidation;
  /** Unresolved hazards the successor must not miss (bounded descriptors). */
  readonly hazards: readonly string[];
  readonly canonicalRange?: ContinuityReceiptCanonicalRange;
  /** Disagreements detected among bundled sources at assembly time. */
  readonly disagreements: readonly string[];
  /** Present on newly captured packages; absent on legacy persisted receipts. */
  readonly liveState?: ContinuityReceiptLiveState;
}

/**
 * Executable truth order for continuity surfaces. Lower array position means
 * stronger authority. Keep the names stable: they are rendered into rebirth
 * control output and may be used as audit coordinates.
 */
export const CONTINUITY_AUTHORITY_ORDER = [
  'later-unanswered-operator-message',
  'pending-assistant-action',
  'live-task-rail',
  'newest-tail-band',
  'frozen-control-snapshot',
  'active-edit-delta',
  'rail-context',
  'recent-dialogue',
  'historical-evidence',
] as const;

export type ContinuityAuthorityRank = typeof CONTINUITY_AUTHORITY_ORDER[number];

export interface ContinuityAuthoritySource<T> {
  /** Stable provenance identity; the candidate value itself is never rendered. */
  readonly sourceId: string;
  readonly value: T;
}

/** Named fields prevent callers from inventing or silently reordering ranks. */
export interface ContinuityAuthorityLattice<T> {
  readonly laterUnansweredOperatorMessage?: ContinuityAuthoritySource<T>;
  readonly pendingAssistantAction?: ContinuityAuthoritySource<T>;
  readonly liveTaskRail?: ContinuityAuthoritySource<T>;
  readonly newestTailBand?: ContinuityAuthoritySource<T>;
  readonly frozenControlSnapshot?: ContinuityAuthoritySource<T>;
  readonly activeEditDelta?: ContinuityAuthoritySource<T>;
  readonly railContext?: ContinuityAuthoritySource<T>;
  readonly recentDialogue?: ContinuityAuthoritySource<T>;
  readonly historicalEvidence?: ContinuityAuthoritySource<T>;
}

export interface ContinuityAuthorityResolution<T> {
  readonly winner: ContinuityAuthoritySource<T> & { readonly rank: ContinuityAuthorityRank };
  readonly shadowedRanks: readonly ContinuityAuthorityRank[];
  readonly explanation: string;
}

const CONTINUITY_AUTHORITY_FIELDS = [
  ['later-unanswered-operator-message', 'laterUnansweredOperatorMessage'],
  ['pending-assistant-action', 'pendingAssistantAction'],
  ['live-task-rail', 'liveTaskRail'],
  ['newest-tail-band', 'newestTailBand'],
  ['frozen-control-snapshot', 'frozenControlSnapshot'],
  ['active-edit-delta', 'activeEditDelta'],
  ['rail-context', 'railContext'],
  ['recent-dialogue', 'recentDialogue'],
  ['historical-evidence', 'historicalEvidence'],
] as const satisfies readonly (readonly [ContinuityAuthorityRank, keyof ContinuityAuthorityLattice<unknown>])[];

/** Resolve the strongest present source and retain a deterministic audit explanation. */
export function resolveContinuityAuthority<T>(
  lattice: ContinuityAuthorityLattice<T>,
): ContinuityAuthorityResolution<T> | null {
  const present = CONTINUITY_AUTHORITY_FIELDS.flatMap(([rank, field]) => {
    const source = lattice[field] as ContinuityAuthoritySource<T> | undefined;
    return source ? [{ rank, source }] : [];
  });
  const selected = present[0];
  if (!selected) return null;
  const shadowedRanks = present.slice(1).map(({ rank }) => rank);
  const rankPosition = CONTINUITY_AUTHORITY_ORDER.indexOf(selected.rank) + 1;
  const explanation = `${selected.rank} (rank ${rankPosition}/${CONTINUITY_AUTHORITY_ORDER.length})`
    + ` from ${selected.source.sourceId}`
    + (shadowedRanks.length > 0 ? ` outranks ${shadowedRanks.join(' > ')}` : ' is the only present source');
  return {
    winner: { ...selected.source, rank: selected.rank },
    shadowedRanks,
    explanation,
  };
}

/** Render only provenance and rank, never candidate payload text. */
export function renderContinuityAuthorityResolution<T>(
  resolution: ContinuityAuthorityResolution<T>,
): string {
  const sourceId = JSON.stringify(resolution.winner.sourceId)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
  const shadowed = resolution.shadowedRanks.length > 0
    ? resolution.shadowedRanks.join(' > ')
    : 'none';
  return `authority resolution · winner=${resolution.winner.rank} · source=${sourceId} · outranks=${shadowed}`;
}

/** Resolve the authority sources materially present in one typed receipt. */
export function resolveContinuityReceiptAuthority(
  receipt: ContinuityReceipt,
): ContinuityAuthorityResolution<boolean> {
  const live = receipt.liveState;
  const currentRequest = live?.request.status === 'current' && live.request.value?.text.trim()
    ? live.request
    : undefined;
  const currentRail = live !== undefined
    && ((live.step.status === 'current' && live.step.value !== undefined)
      || (live.rail.status === 'current' && live.rail.value !== undefined));
  const livePendingAssistantAction = live?.assistantAction?.status === 'current'
    && live.assistantAction.value?.status === 'unresolved'
    ? live.assistantAction
    : undefined;
  const receiptPendingAssistantAction = receipt.pendingAssistantAction?.status === 'unresolved'
    ? receipt.pendingAssistantAction
    : undefined;
  const pendingAssistantActionPresent = Boolean(
    livePendingAssistantAction || receiptPendingAssistantAction,
  );
  const pendingAssistantActionSourceId = livePendingAssistantAction?.source.id
    ?? receiptPendingAssistantAction?.source.id
    ?? (receiptPendingAssistantAction
      ? `${receiptPendingAssistantAction.source.unit}#${receiptPendingAssistantAction.source.index ?? 'unknown'}`
      : undefined);
  const currentTail = live?.rawTailFrontier.status === 'current'
    && (live.rawTailFrontier.value?.exactCount ?? 0) > 0
    ? live.rawTailFrontier
    : undefined;
  const currentEdits = live !== undefined
    && ((live.claims.status === 'current' && (live.claims.value?.length ?? 0) > 0)
      || (live.edits.status === 'current' && (live.edits.value?.length ?? 0) > 0));
  return resolveContinuityAuthority<boolean>({
    laterUnansweredOperatorMessage: currentRequest
      ? { sourceId: currentRequest.source.id, value: true }
      : !live && receipt.activeRequest?.text.trim()
        ? { sourceId: 'continuity-receipt.active-request', value: true }
        : undefined,
    pendingAssistantAction: pendingAssistantActionPresent && pendingAssistantActionSourceId
      ? {
          sourceId: pendingAssistantActionSourceId,
          value: true,
        }
      : undefined,
    liveTaskRail: currentRail
      ? { sourceId: 'continuity-receipt.live-state', value: true }
      : undefined,
    newestTailBand: currentTail
      ? { sourceId: currentTail.source.id, value: true }
      : undefined,
    frozenControlSnapshot: {
      sourceId: `continuity-receipt/v${receipt.version}`,
      value: true,
    },
    activeEditDelta: currentEdits || (!live && receipt.editClaim.supplied)
      ? { sourceId: live ? 'continuity-receipt.live-edits' : 'continuity-receipt.edit-claim', value: true }
      : undefined,
    railContext: receipt.rail
      ? { sourceId: 'continuity-receipt.rail-context', value: true }
      : undefined,
    historicalEvidence: { sourceId: 'continuity-receipt.historical-evidence', value: true },
  })!;
}

// ── Boundary resolution ────────────────────────────────────────────────

/**
 * Single lifecycle-boundary resolver. Both control surfaces previously
 * duplicated this precedence; keep exactly one copy so a boundary can never
 * classify two ways in the same package.
 */
export function resolveContinuityBoundary(input: {
  readonly lifecycleBoundary?: ContinuityReceiptBoundary;
  /** Authoritative delivery event. Undefined is reserved for legacy packages/builders. */
  readonly deliveryKind?: ContinuityDeliveryKind;
  /** Pass undefined when no fork context exists (legacy callers/tests). */
  readonly isFreshFork?: boolean;
  readonly mergedLineageCount?: number;
}): ContinuityReceiptBoundary {
  if (input.lifecycleBoundary) return input.lifecycleBoundary;
  if (input.deliveryKind === 'fork-birth') return 'fresh_fork';
  if (input.deliveryKind === 'session-rebirth') {
    return (input.mergedLineageCount ?? 0) > 0 ? 'brain_merge' : 'continuation';
  }
  // Legacy-only fallback: missing/unknown fork evidence is never birth proof.
  if (input.isFreshFork === true) return 'fresh_fork';
  if ((input.mergedLineageCount ?? 0) > 0) return 'brain_merge';
  return 'continuation';
}

function formatContinuityIdentity(boundary: ContinuityReceiptBoundary, predecessorName: string): string {
  switch (boundary) {
    case 'same_instance_hard_epoch':
      return `same running instance "${predecessorName}"; provider context reseeded, not a handoff`;
    case 'fresh_fork':
      return `new independent fork; "${predecessorName}" is the source identity, not this instance`;
    case 'resurrection':
      return `resumed durable instance "${predecessorName}" from archived state`;
    case 'brain_merge':
      return `same receiving instance "${predecessorName}" with donor memories absorbed and attributed`;
    case 'continuation':
      return `same durable instance "${predecessorName}" across a session or model boundary`;
  }
}

// ── Typed assembly ─────────────────────────────────────────────────────

export interface ContinuityReceiptParts {
  readonly boundary: ContinuityReceiptBoundary;
  readonly predecessorName: string;
  readonly sourceStatus?: string;
  readonly capturedAt?: string;
  readonly rail?: ContinuityReceiptRail;
  readonly pendingAssistantAction?: PendingAssistantAction;
  /** Resolved after operator request and pending assistant action, before rail fallback. */
  readonly nextAction?: string;
  readonly activeRequestText?: string;
  readonly activeRequestSourceTimestamp?: string;
  readonly activeRequestSourceId?: string;
  readonly activeRequestSourceCoordinate?: string;
  readonly instance?: ContinuityLiveInstance;
  readonly claims?: readonly string[];
  readonly editEvidenceFiles?: readonly string[];
  /** False when claims/edits were recovered from a bundled delta rather than a live registry. */
  readonly claimsAreLive?: boolean;
  /** Whether an Active Edit Delta section was bundled. Default: any claims/edits. */
  readonly hasActiveEditDelta?: boolean;
  /** Explicit validation fact (already scanned). Wins over validationSources. */
  readonly validationFact?: string;
  /** Authoritative source time of validationFact, when the caller has it. */
  readonly validationFactSourceTimestamp?: string;
  /** Prose blobs scanned for the latest explicit validation/verification line. */
  readonly validationSources?: readonly (string | ContinuityReceiptValidationSource)[];
  /** Extra hazard descriptors beyond auto-detection. */
  readonly hazards?: readonly string[];
  /** Text blocks scanned for unresolved provider/runtime error markers. */
  readonly hazardSources?: readonly string[];
  readonly canonicalRange?: ContinuityReceiptCanonicalRange;
  readonly chatroomMembership?: string;
  /** Latest authoritative join time among the caller's current room memberships. */
  readonly chatroomMembershipSourceTimestamp?: string;
  /** Direct-mention or other notification subscriptions, when the relay contract exposes them. */
  readonly subscriptions?: readonly string[];
  readonly subscriptionsKnown?: boolean;
  readonly rawTailFrontier?: ContinuityLiveRawTailFrontier;
  /** Stable boundary request/build identity that provenance-stamps the capture. */
  readonly captureSourceId?: string;
  /** Additional disagreements computed by the caller (typed world: rare). */
  readonly extraDisagreements?: readonly string[];
}

function liveSource(
  capturedAt: string,
  kind: string,
  id: string,
  options: { coordinate?: string; sourceTimestamp?: string } = {},
): ContinuityLiveFieldSource {
  return {
    kind,
    id,
    capturedAt,
    ...(options.coordinate ? { coordinate: options.coordinate } : {}),
    ...(options.sourceTimestamp ? { sourceTimestamp: options.sourceTimestamp } : {}),
  };
}

function parseChatroomNames(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split('\n')
    .map((line) => line.trim())
    // Room rows are emitted as `name — members` by the digest's
    // buildChatroomMembershipSection; the [CHATROOM MEMBERSHIP] markers and
    // the scope/source-time footnote line carry no separator and are not
    // rooms. Requiring the separator keeps label/footnote lines out.
    .filter((line) => /\s+—\s+/u.test(line))
    .map((line) => line.split(/\s+—\s+/u)[0]?.trim() ?? '')
    .filter(Boolean);
}

function buildReceiptLiveState(args: {
  capturedAt: string;
  captureSourceId: string;
  parts: ContinuityReceiptParts;
  activeRequest?: { readonly text: string; readonly totalChars: number };
  validationFact?: string;
  validationSourceTimestamp?: string;
  disagreements: readonly string[];
  claims: readonly string[];
  editEvidenceFiles: readonly string[];
}): ContinuityReceiptLiveState {
  const {
    capturedAt,
    captureSourceId,
    parts,
    activeRequest,
    validationFact,
    validationSourceTimestamp,
    disagreements,
    claims,
    editEvidenceFiles,
  } = args;
  const instanceId = parts.instance?.instanceId ?? parts.predecessorName;
  const captureId = captureSourceId;
  const captureSource = (kind: string, id = captureId, options: { coordinate?: string; sourceTimestamp?: string } = {}) => (
    liveSource(capturedAt, kind, id, options)
  );
  // A triggering operator message can arrive at the rebirth boundary before
  // its canonical event row is visible to the snapshot. Preserve a stable
  // boundary-scoped provenance identity instead of claiming the source is
  // "unknown"; source time remains explicitly unknown unless supplied.
  const activeRequestSourceId = activeRequest
    ? parts.activeRequestSourceId?.trim() || `${captureId}:embedded-active-request`
    : 'none';
  const rail = parts.rail;
  const pendingAssistantAction = parts.pendingAssistantAction;
  const railSource = rail
    ? captureSource('task-rail', rail.railId || 'legacy-rail', {
        ...(rail.revision !== undefined ? { coordinate: `revision:${rail.revision}` } : {}),
        ...(rail.updatedAt ? { sourceTimestamp: rail.updatedAt } : {}),
      })
    : captureSource('task-rail', 'none');
  const stepSource = rail?.activeStep
    ? captureSource('task-rail-step', `${rail.railId || 'legacy-rail'}:${rail.activeStep.id}`, {
        coordinate: `step:${rail.activeStep.id}`,
        ...(rail.activeStep.updatedAt ? { sourceTimestamp: rail.activeStep.updatedAt } : {}),
      })
    : captureSource('task-rail-step', 'none');
  const canonicalSource = parts.canonicalRange
    ? captureSource('canonical-events', parts.canonicalRange.traceId, {
        coordinate: `event#${parts.canonicalRange.eventCount}`,
        ...(parts.canonicalRange.lastEventTimestamp
          ? { sourceTimestamp: parts.canonicalRange.lastEventTimestamp }
          : {}),
      })
    : captureSource('canonical-events', instanceId);
  const claimsSource = parts.claimsAreLive === false
    ? captureSource('bundled-active-edit-delta', captureId)
    : captureSource('file-claim-registry', instanceId);
  const editsSource = parts.canonicalRange
    ? canonicalSource
    : captureSource('bundled-active-edit-delta', captureId);
  const rooms = parseChatroomNames(parts.chatroomMembership);
  const railConflictsWithRuntime = disagreements.some((item) => item.includes('runtime status=idle'));
  // task-rail lifecycle (refreshRailState): state 'review' ⟺ every step is
  // resolved and the rail is one refresh from 'complete' — a closeout
  // reminder, not an open review demand. A genuine open demand is a
  // needs_review STEP (which forces the rail into 'blocked', never 'review').
  const reviewState = rail?.activeStep?.status === 'needs_review'
    ? 'needs_review'
    : rail?.state === 'review'
      ? 'all-resolved-awaiting-closeout'
      : 'none';
  const blockers = rail?.activeStep?.status === 'blocked' ? [rail.activeStep.title] : [];
  const frontier = parts.rawTailFrontier ?? (parts.canonicalRange
    ? {
        traceId: parts.canonicalRange.traceId,
        unit: 'event' as const,
        index: parts.canonicalRange.eventCount,
        exactCount: 0,
        ...(parts.canonicalRange.lastEventTimestamp
          ? { sourceTimestamp: parts.canonicalRange.lastEventTimestamp }
          : {}),
      }
    : undefined);

  return {
    capturedAt,
    instance: {
      status: railConflictsWithRuntime ? 'conflicting' : parts.instance ? 'current' : 'unknown',
      source: captureSource('instance-registry', instanceId),
      ...(parts.instance ? { value: parts.instance } : {}),
      ...(!parts.instance ? { note: 'typed instance snapshot not supplied' } : {}),
    },
    request: {
      status: activeRequest ? 'current' : 'unknown',
      source: captureSource('operator-message', activeRequestSourceId, {
        ...(activeRequest
          ? { coordinate: parts.activeRequestSourceCoordinate ?? 'embedded-active-request' }
          : {}),
        ...(parts.activeRequestSourceTimestamp
          ? { sourceTimestamp: parts.activeRequestSourceTimestamp }
          : {}),
      }),
      ...(activeRequest ? { value: activeRequest } : {}),
      ...(!activeRequest ? { note: 'no unanswered operator request bundled' } : {}),
    },
    ...(pendingAssistantAction ? {
      assistantAction: {
        status: 'current' as const,
        source: captureSource(
          'assistant-message',
          pendingAssistantAction.source.id ?? `${captureId}:pending-assistant-action`,
          {
            ...(pendingAssistantAction.source.index !== null
              ? { coordinate: `${pendingAssistantAction.source.unit}#${pendingAssistantAction.source.index}` }
              : {}),
            ...(pendingAssistantAction.source.timestamp
              ? { sourceTimestamp: pendingAssistantAction.source.timestamp }
              : {}),
          },
        ),
        value: pendingAssistantAction,
        note: 'unresolved assistant commitment/progress outranks older task-rail work',
      },
    } : {}),
    rail: {
      status: rail ? 'current' : 'unknown',
      source: railSource,
      ...(rail ? { value: rail } : {}),
      ...(!rail ? { note: 'no live rail snapshot resolved' } : {}),
    },
    step: {
      status: rail?.activeStep ? 'current' : 'unknown',
      source: stepSource,
      ...(rail?.activeStep ? { value: rail.activeStep } : {}),
      ...(!rail?.activeStep ? { note: 'no active/blocking rail step resolved' } : {}),
    },
    claims: {
      status: 'current',
      source: claimsSource,
      value: claims,
    },
    edits: {
      status: parts.canonicalRange || parts.hasActiveEditDelta !== undefined ? 'current' : 'unknown',
      source: editsSource,
      value: editEvidenceFiles,
      ...(!parts.canonicalRange && parts.hasActiveEditDelta === undefined
        ? { note: 'edit-delta source unavailable' }
        : {}),
    },
    validation: {
      status: validationFact ? 'current' : 'unknown',
      source: captureSource('explicit-validation-scan', captureId, {
        coordinate: 'latest-explicit-fact',
        ...(validationSourceTimestamp ? { sourceTimestamp: validationSourceTimestamp } : {}),
      }),
      ...(validationFact ? { value: { fact: validationFact } } : {}),
      ...(!validationFact ? { note: 'step status alone is not validation evidence' } : {}),
    },
    review: {
      status: rail ? 'current' : 'unknown',
      source: railSource,
      ...(rail ? { value: { state: reviewState } } : {}),
      ...(!rail ? { note: 'review state unavailable without a rail snapshot' } : {}),
    },
    blockers: {
      status: rail ? 'current' : 'unknown',
      source: railSource,
      value: blockers,
      ...(!rail ? { note: 'blocker state unavailable without a rail snapshot' } : {}),
    },
    rooms: {
      status: parts.chatroomMembership !== undefined ? 'current' : 'unknown',
      source: captureSource('chatroom-membership-registry', instanceId, {
        ...(parts.chatroomMembershipSourceTimestamp
          ? { sourceTimestamp: parts.chatroomMembershipSourceTimestamp }
          : {}),
      }),
      value: rooms,
      ...(parts.chatroomMembership === undefined ? { note: 'room membership snapshot not supplied' } : {}),
    },
    subscriptions: {
      status: parts.subscriptionsKnown === true ? 'current' : 'unknown',
      source: captureSource('notification-subscription-registry', instanceId),
      value: [...(parts.subscriptions ?? [])],
      ...(parts.subscriptionsKnown !== true
        ? { note: 'direct-mention subscription state is not yet exposed separately from room membership' }
        : {}),
    },
    rawTailFrontier: {
      status: frontier ? 'current' : 'unknown',
      source: frontier
        ? captureSource('raw-tail-frontier', frontier.traceId, {
            coordinate: frontier.index !== undefined
              ? `${frontier.unit}#${frontier.index}`
              : frontier.id ?? 'unknown',
            ...(frontier.sourceTimestamp ? { sourceTimestamp: frontier.sourceTimestamp } : {}),
          })
        : captureSource('raw-tail-frontier', instanceId),
      ...(frontier ? { value: frontier } : {}),
      ...(!frontier ? { note: 'raw-tail coordinate unavailable' } : {}),
    },
  };
}

const TRUNCATION_SUFFIX = '... [truncated]';

function truncateContinuity(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_SUFFIX.length) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

const PROVIDER_RUNTIME_ERROR_MARKER = '⚠️ UNRESOLVED PROVIDER/RUNTIME ERROR';
const PROVIDER_RUNTIME_ERROR_HAZARD =
  'unresolved provider/runtime error captured after the last genuine assistant message (not assistant speech; verify provider/session state before acting)';

/** Detect unresolved provider/runtime error remainders in bundled text. */
export function detectContinuityHazards(sources: readonly string[]): string[] {
  return sources.some((source) => source.includes(PROVIDER_RUNTIME_ERROR_MARKER))
    ? [PROVIDER_RUNTIME_ERROR_HAZARD]
    : [];
}

const VALIDATION_FACT_PATTERN = /^(?:validation|verification)(?:\s+(?:passed|state|fact|facts))?\s*:/iu;

/**
 * Anchored outcome assertion, admitted ONLY on the trusted rail-execution
 * channel (trustedOutcomeChannel sources — rail ACK notes are self-reported
 * execution records, not prose). The assertion must OPEN the line so plans
 * and quotations cannot impersonate an outcome, and any modal/future marker
 * disqualifies the line. Everything without the trust bit stays under the
 * strict label gate above.
 */
const TRUSTED_VALIDATION_OUTCOME_PATTERN = /^(?:all\s+(?:(?:local|focused|scoped|full|relay|monorepo|standalone|both|the)\s+)*(?:validation|tests?|typechecks?|vitest|suites?|specs?)\b[^\n:]*\b(?:green|passed|pass|clean)\b|(?:[\w./-]+\s+)?\d+\s*\/\s*\d+\s*(?:tests?|specs?|suites?|assertions?)?\s*(?:passed|pass|green|clean)\b)/iu;
const MODAL_FUTURE_MARKER = /\b(?:should|will|would|could|once|until|if|plan(?:ned|ning)?|pending|waiting|todo|needs?\s+to|going\s+to)\b/iu;

/**
 * Latest explicit validation/verification fact across prose blobs. Structured
 * sources sort by authoritative source time; input order is only a deterministic
 * tie-break, and unknown-time prose cannot supersede a timestamped outcome.
 * Returns the fact text with its label stripped (untruncated; the renderer
 * bounds display). This is THE scan — both the receipt assembler and any legacy
 * surface share it, so validation state cannot diverge.
 */
export function findLatestValidationFact(texts: readonly string[]): string | undefined {
  return findLatestValidationFactWithSource(texts)?.fact;
}

interface ContinuityValidationFactMatch {
  readonly fact: string;
  readonly sourceTimestamp?: string;
}

function findLatestValidationFactWithSource(
  sources: readonly (string | ContinuityReceiptValidationSource)[],
): ContinuityValidationFactMatch | undefined {
  let latest: (ContinuityValidationFactMatch & {
    readonly sourceTimeMs?: number;
    readonly sourceOrder: number;
    readonly lineOrder: number;
  }) | undefined;
  for (const [sourceOrder, source] of sources.entries()) {
    const text = typeof source === 'string' ? source : source.text;
    const sourceTimestamp = typeof source === 'string' ? undefined : source.sourceTimestamp;
    const trustedOutcomeChannel = typeof source !== 'string' && source.trustedOutcomeChannel === true;
    const parsedSourceTime = sourceTimestamp ? Date.parse(sourceTimestamp) : Number.NaN;
    for (const [lineOrder, line] of text.split('\n').entries()) {
      const trimmed = line.trim();
      const labeled = VALIDATION_FACT_PATTERN.test(trimmed);
      if (!labeled) {
        const trustedOutcome = trustedOutcomeChannel
          && TRUSTED_VALIDATION_OUTCOME_PATTERN.test(trimmed)
          && !MODAL_FUTURE_MARKER.test(trimmed);
        if (!trustedOutcome) continue;
      }
      const candidate = {
        fact: labeled ? trimmed.replace(/^[^:]+:\s*/u, '') : trimmed,
        ...(sourceTimestamp ? { sourceTimestamp } : {}),
        ...(Number.isFinite(parsedSourceTime) ? { sourceTimeMs: parsedSourceTime } : {}),
        sourceOrder,
        lineOrder,
      };
      if (!latest) {
        latest = candidate;
        continue;
      }
      const candidateKnown = candidate.sourceTimeMs !== undefined;
      const latestKnown = latest.sourceTimeMs !== undefined;
      if (candidateKnown !== latestKnown) {
        if (candidateKnown) latest = candidate;
        continue;
      }
      if (candidateKnown && latestKnown && candidate.sourceTimeMs !== latest.sourceTimeMs) {
        if (candidate.sourceTimeMs! > latest.sourceTimeMs!) latest = candidate;
        continue;
      }
      if (candidate.sourceOrder > latest.sourceOrder
        || (candidate.sourceOrder === latest.sourceOrder && candidate.lineOrder > latest.lineOrder)) {
        latest = candidate;
      }
    }
  }
  return latest
    ? {
        fact: latest.fact,
        ...(latest.sourceTimestamp ? { sourceTimestamp: latest.sourceTimestamp } : {}),
      }
    : undefined;
}

function railIsExecutable(rail: ContinuityReceiptRail | undefined): boolean {
  if (!rail) return false;
  if (rail.state === 'active') return true;
  const status = rail.activeStep?.status;
  return status === 'active' || status === 'in_progress' || status === 'blocked' || status === 'needs_review';
}

/**
 * Assemble a receipt from typed process truth. Pure; every disagreement is
 * computed from the same typed fields the renderer will display, so the
 * rendered block can never contradict its own evidence.
 */
export function buildContinuityReceipt(parts: ContinuityReceiptParts): ContinuityReceipt {
  const claims = (parts.claims ?? []).filter((claim) => claim.trim().length > 0);
  const editEvidenceFiles = (parts.editEvidenceFiles ?? []).filter((path) => path.trim().length > 0);
  const disagreements = [...(parts.extraDisagreements ?? [])];
  if (parts.sourceStatus === 'idle' && railIsExecutable(parts.rail)) {
    disagreements.push(
      `runtime status=idle conflicts with executable rail state=${parts.rail?.state ?? 'present'}; rail state wins for task continuity`,
    );
  }
  const activeRequestText = parts.activeRequestText?.trim() ? parts.activeRequestText : undefined;
  const capturedAt = parts.capturedAt ?? new Date().toISOString();
  const captureSourceId = parts.captureSourceId?.trim()
    || `rebirth-boundary:${parts.instance?.instanceId ?? parts.predecessorName}`;
  const activeRequest = activeRequestText
    ? { text: activeRequestText, totalChars: activeRequestText.length }
    : undefined;
  const validationMatch = parts.validationFact
    ? {
        fact: parts.validationFact,
        ...(parts.validationFactSourceTimestamp
          ? { sourceTimestamp: parts.validationFactSourceTimestamp }
          : {}),
      }
    : findLatestValidationFactWithSource(parts.validationSources ?? []);
  const validationFact = validationMatch?.fact;
  return {
    version: CONTINUITY_RECEIPT_VERSION,
    boundary: parts.boundary,
    predecessorName: parts.predecessorName,
    capturedAt,
    captureSourceId,
    sourceStatus: parts.sourceStatus?.trim() || undefined,
    rail: parts.rail,
    pendingAssistantAction: parts.pendingAssistantAction,
    nextAction: activeRequestText
      ?? parts.pendingAssistantAction?.text
      ?? parts.nextAction
      ?? parts.rail?.activeStep?.instruction,
    activeRequest,
    editClaim: {
      supplied: parts.hasActiveEditDelta ?? (claims.length > 0 || editEvidenceFiles.length > 0),
      claims,
      editEvidenceFiles,
    },
    validation: {
      fact: validationFact,
    },
    hazards: [...detectContinuityHazards(parts.hazardSources ?? []), ...(parts.hazards ?? [])],
    canonicalRange: parts.canonicalRange,
    disagreements,
    liveState: buildReceiptLiveState({
      capturedAt,
      captureSourceId,
      parts,
      activeRequest,
      validationFact,
      validationSourceTimestamp: validationMatch?.sourceTimestamp,
      disagreements,
      claims,
      editEvidenceFiles,
    }),
  };
}

// ── Prose synthesis (legacy fallback) ──────────────────────────────────

/**
 * Inputs for synthesizing a receipt from legacy prose sections. Used when a
 * package predates typed capture (hand-built fixtures, persisted artifacts
 * from older relays). The parse semantics below are the historical relay
 * control-block semantics, lifted unchanged so legacy packages render
 * byte-identical output through the canonical renderer.
 */
export interface ContinuityReceiptProseParts {
  readonly boundary: ContinuityReceiptBoundary;
  readonly predecessorName: string;
  readonly sourceStatus?: string;
  readonly resumePoint?: string;
  readonly taskRailContext?: string;
  readonly activeEditDelta?: string;
  readonly currentThread?: string;
  readonly lastUserAiMessages?: string;
  readonly activeRequestText?: string;
}

function findResumeLine(resumePoint: string | undefined, prefix: string): string {
  return resumePoint?.split('\n').find((line) => line.startsWith(prefix))?.trim() ?? 'unknown';
}

function taskRailLines(taskRailContext: string | undefined): string[] {
  return taskRailContext?.trim().split('\n') ?? [];
}

function parseProseRail(parts: ContinuityReceiptProseParts): ContinuityReceiptRail | undefined {
  const lines = taskRailLines(parts.taskRailContext);
  const header = lines[0] ?? '';
  const titleMatch = header.match(/^\[Task rail\]\s*(.+?)\s*\((rail-[a-f0-9]+)\)/u);
  if (!titleMatch) {
    const rawLine = findResumeLine(parts.resumePoint, '📋 ');
    if (rawLine === 'unknown') return undefined;
    const activeStepRawLine = findResumeLine(parts.resumePoint, '▶ Active:');
    return {
      railId: '',
      title: '',
      state: '',
      rawLine,
      activeStepRawLine: activeStepRawLine === 'unknown' ? undefined : activeStepRawLine,
    };
  }

  const state = parts.taskRailContext?.match(/\bstate=(\w+)/)?.[1] ?? 'unknown';
  const progress = lines.find((line) => line.startsWith('progress:')) ?? '';
  const done = progress.match(/\bdone=(\d+)/)?.[1];
  const total = progress.match(/\btotal=(\d+)/)?.[1];
  const percent = progress.match(/\bpercent=(\d+)%/)?.[1];

  const activeLine = lines.find((candidate) => candidate.startsWith('Active/blocking step:'));
  let activeStep: ContinuityReceiptRailStep | undefined;
  let activeStepRawLine: string | undefined;
  if (activeLine) {
    const match = activeLine.match(/Active\/blocking step:\s*(\d+)\/(\d+)\s+(\S+)\s+\[(\w+)\]\s*(.*)/u);
    if (match) {
      const activeIndex = lines.findIndex((candidate) => candidate.startsWith('Active/blocking step:'));
      const instruction = lines[activeIndex + 1]?.trim() ?? '';
      activeStep = {
        id: match[3],
        status: match[4],
        title: match[5].trim(),
        position: Number.parseInt(match[1], 10),
        totalSteps: Number.parseInt(match[2], 10),
        instruction: instruction
          && instruction !== 'Acceptance criteria:'
          && instruction !== 'Loaded steps:'
          && !instruction.startsWith('- ')
          && !/^\d+\.\s/u.test(instruction)
          ? instruction
          : undefined,
      };
    } else {
      activeStepRawLine = activeLine;
    }
  } else {
    const resumeActive = findResumeLine(parts.resumePoint, '▶ Active:');
    activeStepRawLine = resumeActive === 'unknown' ? undefined : resumeActive;
  }

  const loadedStepsIndex = lines.findIndex((line) => line === 'Loaded steps:');
  const candidates = loadedStepsIndex >= 0 ? lines.slice(loadedStepsIndex + 1) : lines;
  const pending = candidates.find((line) => /\[pending\]/u.test(line));
  const queuedStepTitle = pending?.match(/\[pending\]\s*(.*)/u)?.[1]?.trim() || undefined;

  const rail: ContinuityReceiptRail = {
    railId: titleMatch[2],
    title: titleMatch[1],
    state,
    doneSteps: done ? Number.parseInt(done, 10) : undefined,
    totalSteps: total ? Number.parseInt(total, 10) : undefined,
    percentComplete: percent ? Number.parseInt(percent, 10) : undefined,
    activeStep,
    activeStepRawLine,
    queuedStepTitle,
  };
  return rail;
}

function parseProseNextAction(parts: ContinuityReceiptProseParts, rail: ContinuityReceiptRail | undefined): string | undefined {
  if (rail?.activeStep?.instruction) return rail.activeStep.instruction;
  // Historical byte-compat: the resume line renders WITH its ⏭ marker — the
  // legacy control block printed the raw line, and old packages must not
  // shift a byte when re-rendered through the canonical renderer.
  const explicit = findResumeLine(parts.resumePoint, '⏭ Next action:');
  if (explicit !== 'unknown') return explicit;
  const legacy = findResumeLine(parts.resumePoint, '⏭ Next:');
  return legacy === 'unknown' ? undefined : legacy;
}

function parseProseEditClaim(activeEditDelta: string | undefined): ContinuityReceiptEditClaim {
  const delta = activeEditDelta?.trim();
  if (!delta) return { supplied: false, claims: [], editEvidenceFiles: [] };
  const claimLine = delta.split('\n').find((line) => line.startsWith('Files claimed for editing:'));
  const claims = claimLine
    ?.slice('Files claimed for editing:'.length)
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean) ?? [];
  const editEvidenceFiles = [...new Set(
    [...delta.matchAll(/^\[[^\]]+\]\s+.+?\s→\s(.+)$/gmu)]
      .map((match) => match[1]?.trim())
      .filter((path): path is string => Boolean(path)),
  )];
  return { supplied: true, claims, editEvidenceFiles };
}

/**
 * Synthesize a receipt from legacy prose sections. Preserves the historical
 * relay parse semantics exactly — including the resumePoint-vs-context
 * disagreement detection, which can only exist in the prose world (typed
 * assembly draws every field from one TaskRailSnapshot, so the class of
 * disagreement where two prose renderings of the same rail conflict
 * disappears by construction).
 */
export function continuityReceiptFromProse(parts: ContinuityReceiptProseParts): ContinuityReceipt {
  const rail = parseProseRail(parts);
  const disagreements: string[] = [];
  // The disagreement check uses the raw `state=` token (undefined when the
  // context omits it), never the display fallback 'unknown' — a missing token
  // must not fabricate a disagreement against the Resume Point line.
  const railStateToken = parts.taskRailContext?.match(/\bstate=(\w+)/)?.[1];
  const resumeRailLine = findResumeLine(parts.resumePoint, '📋 ');
  const resumeState = resumeRailLine === 'unknown'
    ? undefined
    : resumeRailLine.match(/\s—\s([a-z_]+)\s—\s/iu)?.[1];
  if (railStateToken && resumeState && railStateToken !== resumeState) {
    disagreements.push(
      `Resume Point rail state=${resumeState} conflicts with Task Rail Context state=${railStateToken}; Task Rail Context wins`,
    );
  }
  // Executable detection mirrors the historical prose scan: structured fields
  // when the Active/blocking line parsed, the raw-line status pattern when it
  // did not (a malformed line with an [active] tag still counts as executable).
  const rawExecutable = rail?.activeStepRawLine !== undefined
    && /\[(?:active|in_progress|blocked|needs_review)\]/u.test(rail.activeStepRawLine);
  if (parts.sourceStatus === 'idle' && (railIsExecutable(rail) || rawExecutable)) {
    disagreements.push(
      `runtime status=idle conflicts with executable rail state=${railStateToken ?? 'present'}; rail state wins for task continuity`,
    );
  }
  const activeRequestText = parts.activeRequestText?.trim() ? parts.activeRequestText : undefined;
  return {
    version: CONTINUITY_RECEIPT_VERSION,
    boundary: parts.boundary,
    predecessorName: parts.predecessorName,
    sourceStatus: parts.sourceStatus?.trim() || undefined,
    rail,
    nextAction: parseProseNextAction(parts, rail),
    activeRequest: activeRequestText
      ? { text: activeRequestText, totalChars: activeRequestText.length }
      : undefined,
    editClaim: parseProseEditClaim(parts.activeEditDelta),
    validation: {
      fact: findLatestValidationFact([parts.taskRailContext ?? '', parts.currentThread ?? '']),
    },
    hazards: detectContinuityHazards([parts.lastUserAiMessages ?? '']),
    disagreements,
  };
}

// ── Transport validation ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPendingAssistantAction(value: unknown): value is PendingAssistantAction {
  return isCanonicalPendingAssistantAction(value);
}

const CONTINUITY_LIVE_FIELD_STATUSES: readonly ContinuityLiveFieldStatus[] = [
  'current',
  'stale',
  'superseded',
  'unknown',
  'conflicting',
];

function isContinuityLiveField(value: unknown): value is ContinuityLiveField<unknown> {
  if (!isRecord(value) || typeof value.status !== 'string'
    || !CONTINUITY_LIVE_FIELD_STATUSES.includes(value.status as ContinuityLiveFieldStatus)) return false;
  if (!isRecord(value.source)) return false;
  return typeof value.source.kind === 'string'
    && typeof value.source.id === 'string'
    && typeof value.source.capturedAt === 'string';
}

function isContinuityReceiptLiveState(value: unknown): value is ContinuityReceiptLiveState {
  if (!isRecord(value) || typeof value.capturedAt !== 'string') return false;
  const requiredFieldsValid = [
    'instance',
    'request',
    'rail',
    'step',
    'claims',
    'edits',
    'validation',
    'review',
    'blockers',
    'rooms',
    'subscriptions',
    'rawTailFrontier',
  ].every((key) => isContinuityLiveField(value[key]));
  return requiredFieldsValid
    && (value.assistantAction === undefined
      || (isContinuityLiveField(value.assistantAction)
        && (value.assistantAction.value === undefined
          || isPendingAssistantAction(value.assistantAction.value))));
}

/** Structural check for the typed render path. Unknown/newer versions fail so older runtimes degrade to prose synthesis instead of misrendering. */
export function isContinuityReceipt(value: unknown): value is ContinuityReceipt {
  if (!isRecord(value)) return false;
  if (value.version !== CONTINUITY_RECEIPT_VERSION) return false;
  if (typeof value.predecessorName !== 'string' || value.predecessorName.length === 0) return false;
  if (typeof value.boundary !== 'string'
    || !CONTINUITY_RECEIPT_BOUNDARIES.includes(value.boundary as ContinuityReceiptBoundary)) return false;
  if (!isRecord(value.editClaim) || !isStringArray(value.editClaim.claims) || !isStringArray(value.editClaim.editEvidenceFiles)) return false;
  if (!isRecord(value.validation)) return false;
  if (!isStringArray(value.hazards) || !isStringArray(value.disagreements)) return false;
  if (value.pendingAssistantAction !== undefined
    && !isPendingAssistantAction(value.pendingAssistantAction)) return false;
  if (value.liveState !== undefined && !isContinuityReceiptLiveState(value.liveState)) return false;
  return true;
}

/**
 * Tolerant normalizer for rail facts crossing the worker/sidecar envelope.
 * Returns undefined for malformed input — a missing rail must never crash a
 * rebirth package build.
 */
export function normalizeContinuityReceiptRail(value: unknown): ContinuityReceiptRail | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.railId !== 'string' || typeof value.title !== 'string' || typeof value.state !== 'string') {
    return undefined;
  }
  const activeStepValue = isRecord(value.activeStep) ? value.activeStep : undefined;
  const activeStep: ContinuityReceiptRailStep | undefined = activeStepValue
    && typeof activeStepValue.id === 'string'
    && typeof activeStepValue.title === 'string'
    && typeof activeStepValue.status === 'string'
    ? {
        id: activeStepValue.id,
        title: activeStepValue.title,
        status: activeStepValue.status,
        ...(typeof activeStepValue.updatedAt === 'string' ? { updatedAt: activeStepValue.updatedAt } : {}),
        ...(typeof activeStepValue.position === 'number' ? { position: activeStepValue.position } : {}),
        ...(typeof activeStepValue.totalSteps === 'number' ? { totalSteps: activeStepValue.totalSteps } : {}),
        ...(typeof activeStepValue.instruction === 'string' ? { instruction: activeStepValue.instruction } : {}),
      }
    : undefined;
  return {
    railId: value.railId,
    title: value.title,
    state: value.state,
    ...(typeof value.revision === 'number' ? { revision: value.revision } : {}),
    ...(typeof value.locked === 'boolean' ? { locked: value.locked } : {}),
    ...(typeof value.doneSteps === 'number' ? { doneSteps: value.doneSteps } : {}),
    ...(typeof value.totalSteps === 'number' ? { totalSteps: value.totalSteps } : {}),
    ...(typeof value.percentComplete === 'number' ? { percentComplete: value.percentComplete } : {}),
    ...(activeStep ? { activeStep } : {}),
    ...(typeof value.queuedStepTitle === 'string' ? { queuedStepTitle: value.queuedStepTitle } : {}),
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.rawLine === 'string' ? { rawLine: value.rawLine } : {}),
    ...(typeof value.activeStepRawLine === 'string' ? { activeStepRawLine: value.activeStepRawLine } : {}),
  };
}

// ── Canonical renderer ─────────────────────────────────────────────────

export interface RenderContinuityReceiptControlOptions {
  /**
   * Deprecated compatibility hook. Active request text has one readable home,
   * so the continuity boundary deliberately never invokes this renderer.
   */
  readonly formatActiveRequest?: (text: string) => string;
  /**
   * Renderer-owned location of the exact request text. This is metadata, not a
   * second copy of the request. Persisted-package readers use the character
   * count to recover the request from its canonical section without searching
   * arbitrary prose for user-controlled marker strings.
   */
  readonly activeRequestLocation?: 'last-user-ai-messages';
}

export const LIVE_CONTINUITY_STATE_HEADER = '── Continuity Boundary (RECOVERY COORDINATES) ──';

/**
 * The spelling this capsule carried before it became the continuity boundary.
 * Packages written under it are still on disk and still resumable, so readers
 * must keep recognising it; only the renderer above is current.
 */
export const HISTORICAL_CONTINUITY_CONTROL_HEADER = '── Rebirth Control (AUTHORITATIVE) ──';

/**
 * Every spelling of the control-capsule header, newest first.
 *
 * Readers that scan a persisted package for the capsule MUST match this set
 * rather than one literal. Seed pinning, active-request recovery, and the
 * post-rebirth bundle split all key off finding the capsule, and each one
 * fails OPEN when it misses: no error, no assertion — the caller simply
 * behaves as if the package had no capsule at all. That is how a header
 * rename silently disables consumers one at a time. Append new spellings
 * here; never inline the literal at a call site.
 */
export const CONTINUITY_CONTROL_HEADERS: readonly string[] = [
  LIVE_CONTINUITY_STATE_HEADER,
  HISTORICAL_CONTINUITY_CONTROL_HEADER,
];

export interface ContinuityControlSectionMatch {
  readonly index: number;
  readonly endIndex: number;
  readonly header: string;
  readonly text: string;
}

function findSectionEnd(text: string, contentStart: number): number {
  const match = /\n── [^\n]+ ──[ \t]*(?=\r?\n|$)/gu.exec(text.slice(contentStart));
  return match ? contentStart + match.index : text.length;
}

function isStructurallyValidControlSection(
  header: string,
  sectionText: string,
): boolean {
  if (!/^boundary(?:=|:)\S*/mu.test(sectionText)) return false;
  if (header === LIVE_CONTINUITY_STATE_HEADER) {
    return /^authority resolution · winner=/mu.test(sectionText);
  }
  return /^active request(?:(?: \((?:verbatim;|EXCERPT\b)[^\n]*\):)|: none bundled)/mu.test(sectionText)
    || /^truth order:/mu.test(sectionText);
}

/**
 * Resolve a renderer-owned control section rather than an arbitrary matching
 * substring. Current packages place this typed section immediately before the
 * Orientation footer; that tail position wins over matching literals quoted
 * in Current Thread, edit deltas, or source snippets. Historical packages
 * retain a validated line-level fallback.
 */
export function findContinuityControlSection(text: string): ContinuityControlSectionMatch | null {
  const candidates: ContinuityControlSectionMatch[] = [];
  for (const header of CONTINUITY_CONTROL_HEADERS) {
    let fromIndex = 0;
    while (fromIndex <= text.length) {
      const index = text.indexOf(header, fromIndex);
      if (index < 0) break;
      fromIndex = index + header.length;
      const startsLine = index === 0 || text[index - 1] === '\n';
      const afterHeader = index + header.length;
      const endsLine = afterHeader === text.length
        || text[afterHeader] === '\n'
        || (text[afterHeader] === '\r' && text[afterHeader + 1] === '\n');
      if (!startsLine || !endsLine) continue;
      const endIndex = findSectionEnd(text, afterHeader);
      const sectionText = text.slice(index, endIndex);
      if (isStructurallyValidControlSection(header, sectionText)) {
        candidates.push({ index, endIndex, header, text: sectionText });
      }
    }
  }
  if (candidates.length === 0) return null;
  const orientationIndex = text.lastIndexOf('\n── Orientation ──');
  if (orientationIndex >= 0) {
    const tailCandidate = candidates
      .filter((candidate) => candidate.endIndex === orientationIndex)
      .sort((left, right) => right.index - left.index)[0];
    if (tailCandidate) return tailCandidate;
  }
  return candidates.sort((left, right) => left.index - right.index)[0] ?? null;
}

/** Structurally identified control-capsule header, with its offset, or null. */
export function findContinuityControlHeader(
  text: string,
): { readonly index: number; readonly header: string } | null {
  const section = findContinuityControlSection(text);
  return section ? { index: section.index, header: section.header } : null;
}

/** True when `text` carries a structurally identified control capsule. */
export function hasContinuityControlHeader(text: string): boolean {
  return findContinuityControlSection(text) !== null;
}

export const ACTIVE_REQUEST_REFERENCE_PREFIX = 'active request ref';
export const TRIGGERING_USER_MESSAGE_HEADER = '[TRIGGERING USER MESSAGE]';
export const TRIGGERING_USER_MESSAGE_FRAME_SCHEMA = 'triggering-user-message/v1';

export interface ContinuityActiveRequestReference {
  readonly section: 'last-user-ai-messages';
  readonly chars: number;
}

/** Parse the typed request-location record from a validated control section. */
export function parseContinuityActiveRequestReference(
  sectionText: string,
): ContinuityActiveRequestReference | null {
  const match = sectionText.match(
    /^active request ref · section=(last-user-ai-messages) · chars=(\d+)$/mu,
  );
  if (!match) return null;
  const chars = Number(match[2]);
  return Number.isSafeInteger(chars) && chars > 0
    ? { section: match[1] as 'last-user-ai-messages', chars }
    : null;
}

export interface TriggeringUserMessageTrailerMatch {
  readonly index: number;
  readonly bodyStart: number;
  readonly body: string;
  readonly framed: boolean;
}

/**
 * Frame a delivery-only operator trailer with its exact body length. The
 * explanation remains human-readable, while parsers key off the versioned
 * frame and end-of-message length rather than marker-shaped user prose.
 */
export function renderTriggeringUserMessageTrailer(
  body: string,
  explanation: string,
): string {
  return `\n\n${TRIGGERING_USER_MESSAGE_HEADER}\n`
    + `schema=${TRIGGERING_USER_MESSAGE_FRAME_SCHEMA} · chars=${body.length}\n`
    + `${explanation}\n\n${body}`;
}

/** Resolve a framed trailer, with a positional fallback for persisted legacy packages. */
export function findTriggeringUserMessageTrailer(
  text: string,
): TriggeringUserMessageTrailerMatch | null {
  const marker = `\n${TRIGGERING_USER_MESSAGE_HEADER}\n`;
  let fromIndex = 0;
  while (fromIndex < text.length) {
    const markerIndex = text.indexOf(marker, fromIndex);
    if (markerIndex < 0) break;
    const index = markerIndex + 1;
    fromIndex = index + TRIGGERING_USER_MESSAGE_HEADER.length;
    const frameStart = index + TRIGGERING_USER_MESSAGE_HEADER.length + 1;
    const frameEnd = text.indexOf('\n', frameStart);
    if (frameEnd < 0) continue;
    const frame = text.slice(frameStart, frameEnd);
    const match = frame.match(/^schema=triggering-user-message\/v1 · chars=(\d+)$/u);
    if (!match) continue;
    const chars = Number(match[1]);
    if (!Number.isSafeInteger(chars) || chars < 0) continue;
    const bodyStart = text.indexOf('\n\n', frameEnd + 1);
    if (bodyStart < 0) continue;
    const contentStart = bodyStart + 2;
    if (text.length - contentStart !== chars) continue;
    return {
      index,
      bodyStart: contentStart,
      body: text.slice(contentStart),
      framed: true,
    };
  }

  const orientationIndex = text.lastIndexOf('\n── Orientation ──');
  const legacySearchStart = orientationIndex >= 0 ? orientationIndex : 0;
  const legacyIndex = text.indexOf(marker, legacySearchStart);
  if (legacyIndex < 0) return null;
  const index = legacyIndex + 1;
  const afterHeader = index + TRIGGERING_USER_MESSAGE_HEADER.length + 1;
  if (text.slice(afterHeader).startsWith('schema=triggering-user-message/')) return null;
  const bodySeparator = text.indexOf('\n\n', afterHeader);
  const bodyStart = bodySeparator >= 0 ? bodySeparator + 2 : afterHeader;
  const body = text.slice(bodyStart).trim();
  return body
    ? { index, bodyStart, body, framed: false }
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function renderLiveList(value: unknown, empty = 'none'): string {
  const list = stringList(value);
  return list.length > 0 ? list.join(', ') : empty;
}

function renderLiveFrontier(value: unknown): string {
  if (!isRecord(value)) return 'unknown';
  const traceId = typeof value.traceId === 'string' ? value.traceId : 'unknown';
  const unit = value.unit === 'event' || value.unit === 'message' || value.unit === 'row' ? value.unit : 'row';
  const coordinate = typeof value.index === 'number'
    ? `${unit}#${value.index}`
    : typeof value.id === 'string' ? `${unit}:${value.id}` : `${unit}:unknown`;
  const exactCount = typeof value.exactCount === 'number' ? value.exactCount : 0;
  return `${traceId}@${coordinate} (${exactCount} exact row${exactCount === 1 ? '' : 's'} after frontier)`;
}

function renderCurrentTaskRailStep(
  value: unknown,
  updatedAt?: string,
  rawLine?: string,
): string[] {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || typeof value.status !== 'string') {
    const fallback = rawLine?.trim();
    return fallback ? [`current task-rail step · ${truncateContinuity(fallback, 320)}`] : [];
  }
  const position = typeof value.position === 'number'
    ? `${value.position}${typeof value.totalSteps === 'number' ? `/${value.totalSteps}` : ''} · `
    : '';
  const timestamp = updatedAt?.trim() ? ` · updated=${updatedAt.trim()}` : '';
  const lines = [
    `current task-rail step · ${position}${truncateContinuity(value.id, 80)} [${truncateContinuity(value.status, 40)}] · ${truncateContinuity(value.title, 200)}${timestamp}`,
  ];
  if (typeof value.instruction === 'string' && value.instruction.trim()) {
    lines.push(`step instruction=${truncateContinuity(value.instruction.trim(), 360)}`);
  }
  return lines;
}

/**
 * recent-edits boundary field. "none" from the live capture means "none in
 * this boundary window", not "no edit evidence exists": when an Active Edit
 * Delta section rode along in the same package, say so explicitly so the two
 * surfaces can never silently contradict each other (a successor otherwise
 * burns a tool call resolving which section is right).
 */
function renderRecentEditsField(edits: string, activeEditDeltaSupplied: boolean): string {
  return edits === 'none' && activeEditDeltaSupplied
    ? 'none this boundary window (older edits: see Active Edit Delta)'
    : edits;
}

function renderContinuityLiveState(
  receipt: ContinuityReceipt,
  liveState: ContinuityReceiptLiveState,
): string {
  const validation = isRecord(liveState.validation.value) && typeof liveState.validation.value.fact === 'string'
    ? truncateContinuity(liveState.validation.value.fact, 240)
    : '';
  const instance = isRecord(liveState.instance.value) ? liveState.instance.value : undefined;
  const runtimeStatus = typeof instance?.runtimeStatus === 'string'
    ? instance.runtimeStatus
    : receipt.sourceStatus ?? 'unknown';
  const activeStepLines = renderCurrentTaskRailStep(
    liveState.step.value,
    liveState.step.source.sourceTimestamp,
  );
  const pendingAssistantAction = liveState.assistantAction?.status === 'current'
    ? liveState.assistantAction.value
    : receipt.pendingAssistantAction;
  const pendingAssistantActionLines = pendingAssistantAction?.status === 'unresolved'
    ? [
        `pending assistant action · ${truncateContinuity(pendingAssistantAction.text, 360)}`,
        `pending action source · id=${pendingAssistantAction.source.id ?? 'unknown'} · coordinate=${pendingAssistantAction.source.unit}#${pendingAssistantAction.source.index ?? 'unknown'} · source-time=${pendingAssistantAction.source.timestamp ?? 'unknown'} · status=unresolved · outranks=live-task-rail`,
      ]
    : [];

  return [
    LIVE_CONTINUITY_STATE_HEADER,
    `boundary=${receipt.boundary} · identity=${formatContinuityIdentity(receipt.boundary, receipt.predecessorName)} · runtime=${runtimeStatus}`,
    `captured=${liveState.capturedAt} · frontier=${renderLiveFrontier(liveState.rawTailFrontier.value)}`,
    ...pendingAssistantActionLines,
    ...activeStepLines,
    `active files · claims=${renderLiveList(liveState.claims.value)} · recent edits=${renderRecentEditsField(renderLiveList(liveState.edits.value), receipt.editClaim.supplied || receipt.editClaim.editEvidenceFiles.length > 0)}`,
    ...(validation ? [`validation=${validation}`] : []),
    ...(receipt.hazards.length > 0 ? [`unresolved hazards: ${receipt.hazards.join('; ')}`] : []),
  ].join('\n');
}

/**
 * THE Rebirth Control block renderer. Every control surface (relay full
 * package, raw seed / fold-freeze hard epoch) renders through this function
 * from a receipt, so the authoritative boundary state is singular by
 * construction rather than by convention.
 */
export function renderContinuityReceiptControl(
  receipt: ContinuityReceipt,
  options: RenderContinuityReceiptControlOptions = {},
): string {
  const authorityLine = renderContinuityAuthorityResolution(
    resolveContinuityReceiptAuthority(receipt),
  );
  const activeRequest = receipt.liveState?.request.status === 'current'
    ? receipt.liveState.request.value
    : receipt.activeRequest;
  const activeRequestReference = options.activeRequestLocation && activeRequest?.text
    ? `${ACTIVE_REQUEST_REFERENCE_PREFIX} · section=${options.activeRequestLocation} · chars=${activeRequest.text.length}`
    : '';
  if (receipt.liveState) {
    return [
      renderContinuityLiveState(receipt, receipt.liveState),
      activeRequestReference,
      authorityLine,
    ].filter(Boolean).join('\n');
  }
  const canonical = receipt.canonicalRange
    ? `${receipt.canonicalRange.traceId}@event#${receipt.canonicalRange.eventCount}`
    : 'unknown';
  const activeStepLines = renderCurrentTaskRailStep(
    receipt.rail?.activeStep,
    receipt.rail?.activeStep?.updatedAt,
    receipt.rail?.activeStepRawLine,
  );
  const pendingAssistantActionLines = receipt.pendingAssistantAction?.status === 'unresolved'
    ? [
        `pending assistant action · ${truncateContinuity(receipt.pendingAssistantAction.text, 360)}`,
        `pending action source · id=${receipt.pendingAssistantAction.source.id ?? 'unknown'} · coordinate=${receipt.pendingAssistantAction.source.unit}#${receipt.pendingAssistantAction.source.index ?? 'unknown'} · source-time=${receipt.pendingAssistantAction.source.timestamp ?? 'unknown'} · status=unresolved · outranks=live-task-rail`,
      ]
    : [];
  return [
    LIVE_CONTINUITY_STATE_HEADER,
    `boundary=${receipt.boundary} · identity=${formatContinuityIdentity(receipt.boundary, receipt.predecessorName)} · runtime=${receipt.sourceStatus ?? 'unknown'}`,
    `frontier=${canonical}`,
    ...pendingAssistantActionLines,
    ...activeStepLines,
    `active files · claims=${receipt.editClaim.claims.join(', ') || 'none'} · recent edits=${renderRecentEditsField(receipt.editClaim.editEvidenceFiles.join(', ') || 'none', receipt.editClaim.supplied)}`,
    receipt.validation.fact !== undefined
      ? `validation=${truncateContinuity(receipt.validation.fact, 240)}`
      : '',
    ...(receipt.hazards.length > 0 ? [`unresolved hazards: ${receipt.hazards.join('; ')}`] : []),
    activeRequestReference,
    authorityLine,
  ].filter(Boolean).join('\n');
}
