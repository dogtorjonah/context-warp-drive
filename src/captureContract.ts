/**
 * capture-contract/v4 — authoritative capture boundary contract (relay-agnostic).
 *
 * This module is the canonical home for the intention/rail/step/status lifecycle
 * vocabulary that episode capture, canonical transport, and persistence joins
 * consume. It lives in the context-warp package so the portable engine and its
 * standalone mirror can own it without importing relay-local or shared/src
 * modules; relay and shared/src adapt DOWNWARD from here. Dependency direction
 * is one-way: this file imports nothing outside the package.
 *
 * Freeze seam: `capture-contract/v4`. Mutation path: version bump + squad
 * invalidation broadcast only. Consumers import or alias these exports; local
 * duplicates of the literals or predicates are freeze violations.
 *
 * Provenance law carried by every type below: source event time is authoritative
 * and separate from ingestion/write time; unknown source time stays unknown
 * rather than being inferred from row order, ids, or processing clocks.
 */

/** Durable identity of this freeze, for receipts and consumer gating. */
export const CAPTURE_CONTRACT_VERSION = 'capture-contract/v4' as const;

// ── Production seal-reason vocabulary ────────────────────────────────────────
//
// Owned by this contract. COMPLETELY SEPARATE from the portable glyph-burst
// episode store vocabulary (`episodes/episodeStore.ts`:
// 'verdict'|'hazard'|'blocked'|'window_end') — that store is a different
// subsystem with its own lifecycle; there is no unify and no mapping between
// the two. Before this contract, production capture declared the same union
// locally as `EpisodeClosedBy` in foldEpisodes.ts and only ever assigned
// 'epoch' (five session families) and 'rebirth' (rebirth package builder);
// 'idle' and 'release' had zero production writers. This contract makes 'idle'
// assignable — but only through isGenuineIdleTransition evidence.

export const CAPTURE_SEAL_REASONS = ['epoch', 'rebirth', 'release', 'idle', 'backfill'] as const;

export type CaptureSealReason = typeof CAPTURE_SEAL_REASONS[number];

export function isCaptureSealReason(value: unknown): value is CaptureSealReason {
  return typeof value === 'string' && (CAPTURE_SEAL_REASONS as readonly string[]).includes(value);
}

// ── Terminal episode outcome vocabulary ─────────────────────────────────────
//
// Capture owns the terminal state of an episode; retrieval may rank or render
// that outcome but must not invent its lifecycle vocabulary. Sidecar writers
// consume this validator at insertion time rather than duplicating literals.

export const CAPTURE_OUTCOME_STATUSES = [
  'done',
  'blocked',
  'needs_review',
  'skipped',
  'incomplete',
] as const;

export type CaptureOutcomeStatus = typeof CAPTURE_OUTCOME_STATUSES[number];

export function isCaptureOutcomeStatus(value: unknown): value is CaptureOutcomeStatus {
  return typeof value === 'string'
    && (CAPTURE_OUTCOME_STATUSES as readonly string[]).includes(value);
}

// ── Intention / rail / step attribution ──────────────────────────────────────
//
// Optional envelope-level attribution joining a canonical event to the
// intention spine that produced it. All three fields are optional so legacy
// producers remain valid; absence means unattributed, never inferred. Rail
// semantics on the stream were previously reconstructive-only (tool-name
// sniffing + free-text scope regexes); these fields are the first-class stamp.

export interface CaptureAttribution {
  /** Stable task-rail lifecycle id when the event executed inside a rail. */
  railId?: string;
  /** Rail step id when the event executed inside a reserved/sprinted step. */
  stepId?: string;
  /** Intention episode id grouping a user request through its agent sprint. */
  intentionId?: string;
}

// ── Episode transport DTOs ───────────────────────────────────────────────────
//
// A captured burst can cross several rail steps and can contain several
// terminal ACK facts (including one task_rail shoot call with a batched
// `acks[]`). These records are therefore plural on Episode. Each item retains
// its own source-event identity, authoritative source time, and within-event
// ordinal. Consumers persist every item append-only; they never derive current
// state from array position. `sourceAt: null` means the source event carried no
// authoritative clock and must remain quarantined rather than borrowing an
// ingestion/capture time.

export interface EpisodeCaptureAttribution extends CaptureAttribution {
  /** Stable provider/canonical identity of the task-rail tool event. */
  sourceEventId: string;
  /** Authoritative ISO source time, or null when the source carried no clock. */
  sourceAt: string | null;
  /** Zero-based position inside one source event (for batched lifecycle facts). */
  ordinal: number;
}

export interface EpisodeCaptureOutcome {
  /** Frozen terminal task outcome; non-terminal statuses are not outcomes. */
  status: CaptureOutcomeStatus;
  /** Stable provider/canonical identity of the event that sealed this outcome. */
  sealedBySourceEventId: string;
  /** Lifecycle reason carried by the sealing event. */
  sealedByReason: CaptureSealReason;
  /** Authoritative ISO source time, or null when the source carried no clock. */
  sourceAt: string | null;
  /** Zero-based position inside one source event (for batched ACK facts). */
  ordinal: number;
  /** Rail step terminalized by the event, when present. */
  stepId?: string;
  /** Review/audit verdict carried by the terminal event, when present. */
  verdict?: string;
  /** Stable evidence reference carried by the terminal event, when present. */
  evidenceRef?: string;
}

// ── status_update payload contract ───────────────────────────────────────────
//
// Before this contract, `status_update` was a registered canonical event type
// with zero production writers: idle/working transitions existed only as
// in-memory side-effect gating, and the idle metadata computed at the
// transition ({inputQueueDepth, idleCleanupDeferred, workingStartedAt}) was
// dropped at the activity-bus wiring boundary. This payload makes the
// transition stream-visible with its eligibility evidence attached.
// `sourceTimestamp` is the authoritative transition time; ingestion/persist
// time is tracked separately by transport and never substitutes for it.

export interface CaptureStatusUpdatePayload {
  /** Status the instance transitioned from (e.g. 'working'). */
  fromStatus: string;
  /** Status the instance transitioned to (e.g. 'idle'). */
  toStatus: string;
  /** Queued user messages observed at the transition (0 for non-idle). */
  inputQueueDepth: number;
  /** True when idle cleanup was deferred because queued input remained. */
  idleCleanupDeferred: boolean;
  /** Authoritative start of the completed working window; 0 when unknown. */
  workingStartedAt: number;
  /** Result of isGenuineIdleTransition evaluated at the transition. */
  genuineIdle: boolean;
  /** Authoritative transition time (ms epoch); never ingestion time. */
  sourceTimestamp: number;
}

// ── Genuine-idle eligibility predicate ───────────────────────────────────────
//
// The single canonical export for deciding whether an idle transition is a
// GENUINE idle (agent finished and willingly went quiet) versus a deferred or
// lifecycle-generated idle. Empty input alone is not proof of completion:
// folds, rebirths, operator interrupts, and transient provider idles can all
// publish an empty-queue `idle` while the original turn remains alive. Relay
// status transitions compute the complete evidence exactly once; this pure
// predicate lets capture, transport, persistence, and idle-triggered mechanics
// consume one decision instead of hand-rolling weaker local guards.

export interface GenuineIdleTransitionInput {
  /** Status being exited; a voluntary completion must finish real work. */
  fromStatus: string;
  /** Status being entered. */
  toStatus: string;
  /** Queued user messages at the transition. */
  inputQueueDepth: number;
  /** Whether true-idle cleanup was deferred at the transition. */
  idleCleanupDeferred: boolean;
  /** True for relay-known interrupts, folds, rebirths, or abnormal termination. */
  lifecycleSuppressed: boolean;
  /** True while initial, rebirth, resume, or other continuation work is pending. */
  continuationPending: boolean;
  /** Provider/session authority says the original turn remains in flight. */
  turnStillInFlight: boolean;
}

export function isGenuineIdleTransition(input: GenuineIdleTransitionInput): boolean {
  return input.fromStatus === 'working'
    && input.toStatus === 'idle'
    && !input.idleCleanupDeferred
    && input.inputQueueDepth === 0
    && !input.lifecycleSuppressed
    && !input.continuationPending
    && !input.turnStillInFlight;
}

// ── Interrupt-artifact quarantine ────────────────────────────────────────────
//
// Relay-initiated interruptions (fold epochs, rebirths, provider-side aborts)
// inject synthetic transcript rows that impersonate user rejection — e.g. the
// CLI '[Request interrupted by user]' marker documented in claudeCliFold.ts.
// Capture must never treat those artifacts as user-terminal boundaries: they
// are non-user, non-terminal. The `initiator` tag is the host's authoritative
// knowledge; marker text is supporting evidence. When the initiator is unknown
// and a synthetic marker is present, fail closed: quarantine as an artifact
// rather than risk a false user-terminal boundary.

export type InterruptionInitiator = 'user' | 'fold' | 'rebirth' | 'provider' | 'unknown';

export interface InterruptionSignal {
  /** Host-authoritative initiator of the interruption. */
  initiator: InterruptionInitiator;
  /** Raw marker text when the interruption arrived as a transcript row. */
  markerText?: string;
}

/** Synthetic rows known to impersonate user rejection after relay interrupts. */
export const SYNTHETIC_USER_INTERRUPT_MARKERS = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
] as const;

export function isSyntheticInterruptMarker(text: string): boolean {
  const trimmed = text.trim();
  return (SYNTHETIC_USER_INTERRUPT_MARKERS as readonly string[]).some(
    (marker) => trimmed === marker || trimmed.startsWith(`${marker} `),
  );
}

/**
 * True when an interruption signal is a capture-boundary artifact that must be
 * quarantined (excluded from episode boundary and terminal-user semantics).
 * Genuine user interrupts (initiator 'user') are never artifacts, even when
 * they carry the same marker text a relay interrupt would synthesize.
 */
export function isCaptureBoundaryArtifact(signal: InterruptionSignal): boolean {
  if (signal.initiator === 'fold' || signal.initiator === 'rebirth' || signal.initiator === 'provider') {
    return true;
  }
  if (signal.initiator === 'unknown' && signal.markerText !== undefined) {
    return isSyntheticInterruptMarker(signal.markerText);
  }
  return false;
}
