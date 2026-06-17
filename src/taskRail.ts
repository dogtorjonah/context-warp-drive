/**
 * context-warp-drive/task-rail — portable long-horizon execution state.
 *
 * This is the dependency-free Task Rail state machine extracted from Voxxo's
 * relay task_rail tool. It deliberately contains NO persistence, NO MCP
 * transport, NO squad permissions, NO chat/Atlas/file-claim coupling, and NO
 * relay I/O. Consumers can wrap these pure lifecycle/execution helpers in their
 * own CLI, MCP tool, UI, local JSON file, SQLite store, or agent runtime.
 */


// ══════════════════════════════════════════════════════════════════════
//  Source: @voxxo/task-rail/src/types.ts
// ══════════════════════════════════════════════════════════════════════

/**
 * @voxxo/task-rail — Domain Types
 *
 * Pure domain types for task rails, steps, drafts, statuses, sprint
 * reservations, ACKs, and lifecycle operations. No persistence or
 * MCP transport dependencies — this package defines the shape of
 * the data, not how it's stored or served.
 *
 * The relay's task_rail MCP wrapper consumes these types and adds
 * persistence, serialization, and access control.
 */

// ══════════════════════════════════════════════════════════════════════
//  Mode & operation enums
// ══════════════════════════════════════════════════════════════════════

/** Top-level task_rail tool mode. */
export type TaskRailMode = 'load' | 'shoot' | 'sprint' | 'draft';

/** Valid operations for mode=load. */
export const TASK_RAIL_LOAD_OPERATIONS = [
  'start',
  'append',
  'insert',
  'update',
  'batch_update',
  'remove',
  'move',
  'lock',
  'unlock',
  'clear',
  'status',
  'detail',
  'read_step',
  'complete_review',
] as const;

export type TaskRailLoadOperation = (typeof TASK_RAIL_LOAD_OPERATIONS)[number];

/** Valid operations for mode=draft. */
export const TASK_RAIL_DRAFT_OPERATIONS = [
  'create',
  'append',
  'insert',
  'update',
  'batch_update',
  'remove',
  'move',
  'status',
  'detail',
  'read_step',
  'list',
  'merge',
  'abandon',
] as const;

export type TaskRailDraftOperation = (typeof TASK_RAIL_DRAFT_OPERATIONS)[number];

// ══════════════════════════════════════════════════════════════════════
//  Status enums
// ══════════════════════════════════════════════════════════════════════

/** Statuses used when acknowledging a step (shoot/sprint ACK). */
export const TASK_RAIL_ACK_STATUSES = [
  'done',
  'skipped',
  'blocked',
  'needs_review',
  'in_progress',
] as const;

export type TaskRailAckStatus = (typeof TASK_RAIL_ACK_STATUSES)[number];

/** All possible step lifecycle statuses. */
export const TASK_RAIL_STEP_STATUSES = [
  'pending',
  'active',
  ...TASK_RAIL_ACK_STATUSES,
] as const;

export type TaskRailStepStatus = (typeof TASK_RAIL_STEP_STATUSES)[number];

/** Rail lifecycle states. */
export type TaskRailState =
  | 'draft'
  | 'ready'
  | 'active'
  | 'blocked'
  | 'review'
  | 'complete'
  | 'abandoned';

/** Draft lifecycle states. */
export type TaskRailDraftState =
  | 'open'
  | 'merged'
  | 'conflicted'
  | 'abandoned';

// ══════════════════════════════════════════════════════════════════════
//  Core domain entities
// ══════════════════════════════════════════════════════════════════════

/** A single step within a task rail or draft. */
export interface TaskRailStep {
  id: string;
  title: string;
  instruction: string;
  acceptanceCriteria: string[];
  notes?: string;
  scope?: string;
  status: TaskRailStepStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastNote?: string;
  evidence?: string;
  attempts: number;
}

/** An entry in a rail or draft's operation history. */
export interface TaskRailHistoryEntry {
  ts: string;
  operation: string;
  stepId?: string;
  note?: string;
  actorId?: string;
  actorName?: string;
}

/** A complete task rail owned by a single instance. */
export interface TaskRailLifecycle {
  id: string;
  instanceId: string;
  title: string;
  objective: string;
  state: TaskRailState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lockedAt?: string;
  completedAt?: string;
  /** ID of the parent rail this one is linked to (e.g., review rail → implementation rail). */
  parentRailId?: string;
  steps: TaskRailStep[];
  history: TaskRailHistoryEntry[];
}

/** A conflict record when a draft merge fails. */
export interface TaskRailDraftConflict {
  ts: string;
  liveRevision: number;
  reason: string;
}

/** A ghost draft — an isolated proposal for a rail. */
export interface TaskRailDraft {
  id: string;
  ownerInstanceId: string;
  baseRailId?: string;
  baseRevision: number;
  authorId: string;
  authorName?: string;
  title: string;
  objective: string;
  state: TaskRailDraftState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  abandonedAt?: string;
  conflict?: TaskRailDraftConflict;
  steps: TaskRailStep[];
  history: TaskRailHistoryEntry[];
}

// ══════════════════════════════════════════════════════════════════════
//  Progress & snapshot types
// ══════════════════════════════════════════════════════════════════════

/** Lightweight instance reference for contributor tracking. */
export interface TaskRailInstanceSummary {
  id: string;
  name?: string;
  status?: string;
  engine?: string;
  squadId?: string | null;
}

/** A contributor to a task rail (tracked via history). */
export interface TaskRailContributor {
  instanceId: string;
  instanceName?: string;
  activityCount: number;
  lastActivity: string;
  lastOperation: string;
}

/** Computed progress metrics for a rail. */
export interface TaskRailProgress {
  total: number;
  done: number;
  skipped: number;
  terminal: number;
  pending: number;
  active: number;
  blocked: number;
  needsReview: number;
  inProgress: number;
  percent: number;
}

/** A lightweight draft summary for listing. */
export interface TaskRailDraftSummary {
  id: string;
  title: string;
  objective: string;
  authorId: string;
  authorName?: string;
  state: TaskRailDraftState;
  baseRailId?: string;
  baseRevision: number;
  createdAt: string;
  updatedAt: string;
  steps: TaskRailStep[];
  stepCount: number;
}

/** A full snapshot of a rail, its owner, progress, and drafts. */
export interface TaskRailSnapshot {
  rail: TaskRailLifecycle;
  owner: TaskRailInstanceSummary | null;
  progress: TaskRailProgress;
  activeStep?: TaskRailStep;
  contributors: TaskRailContributor[];
  drafts: TaskRailDraftSummary[];
}

// ══════════════════════════════════════════════════════════════════════
//  Helper: isResolvedStep
// ══════════════════════════════════════════════════════════════════════

/** Steps with these statuses are considered resolved (not blocking). */
const RESOLVED_STATUSES: ReadonlySet<TaskRailStepStatus> = new Set([
  'done',
  'skipped',
]);

/** Returns true if the step is in a resolved (non-blocking) state. */
export function isResolvedStep(status: TaskRailStepStatus): boolean {
  return RESOLVED_STATUSES.has(status);
}

/** Returns true if the step is blocking (needs action). */
export function isBlockingStep(status: TaskRailStepStatus): boolean {
  return !isResolvedStep(status);
}

// ══════════════════════════════════════════════════════════════════════
//  Source: @voxxo/task-rail/src/lifecycle.ts
// ══════════════════════════════════════════════════════════════════════

/**
 * @voxxo/task-rail — Lifecycle State Transitions
 *
 * Pure state transition functions for the task rail lifecycle: start,
 * append, insert, update, batch_update, remove, move, lock, unlock,
 * clear, and shoot/sprint ACK.
 *
 * Every function mutates the provided rail object in place but performs
 * NO persistence, NO I/O, and NO MCP transport — these are pure
 * state machine transitions. The relay adapter handles loading,
 * saving, ID generation, and access control.
 */

// ══════════════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════════════

const HISTORY_LIMIT = 200;

// ══════════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════════

/** Returns the provided timestamp or the current ISO string. */
function ts(now?: string): string {
  return now ?? new Date().toISOString();
}

/** Returns true when the step status is terminal (done or skipped). */
function isResolved(status: TaskRailStepStatus): boolean {
  return status === 'done' || status === 'skipped';
}

// ══════════════════════════════════════════════════════════════════════
//  Step queries
// ══════════════════════════════════════════════════════════════════════

/** Find the first step that is actively blocking progress. */
export function findActiveOrBlockingStep(steps: TaskRailStep[]): TaskRailStep | undefined {
  return steps.find(
    (s) =>
      s.status === 'active' ||
      s.status === 'in_progress' ||
      s.status === 'blocked' ||
      s.status === 'needs_review',
  );
}

/** Find the first pending step. */
export function findFirstPendingStep(steps: TaskRailStep[]): TaskRailStep | undefined {
  return steps.find((s) => s.status === 'pending');
}

/** Find a step by id, returning index and step. */
export function findStep(
  steps: TaskRailStep[],
  stepId: string,
): { index: number; step: TaskRailStep } | undefined {
  const index = steps.findIndex((s) => s.id === stepId);
  if (index < 0) return undefined;
  return { index, step: steps[index] };
}

// ══════════════════════════════════════════════════════════════════════
//  Insert-index resolution
// ══════════════════════════════════════════════════════════════════════

export interface InsertPosition {
  /** Explicit 0-based index. */
  index?: number;
  /** Insert before this step id. */
  beforeStepId?: string;
  /** Insert after this step id. */
  afterStepId?: string;
}

/**
 * Resolve an insert position to a concrete 0-based index.
 * Defaults to end of the list when no position hints are given.
 */
export function resolveInsertIndex(
  steps: TaskRailStep[],
  pos?: InsertPosition,
): number {
  if (pos?.index !== undefined) {
    return Math.max(0, Math.min(steps.length, Math.floor(pos.index)));
  }
  if (pos?.beforeStepId) {
    const idx = steps.findIndex((s) => s.id === pos.beforeStepId);
    if (idx >= 0) return idx;
  }
  if (pos?.afterStepId) {
    const idx = steps.findIndex((s) => s.id === pos.afterStepId);
    if (idx >= 0) return idx + 1;
  }
  return steps.length;
}

// ══════════════════════════════════════════════════════════════════════
//  Progress computation
// ══════════════════════════════════════════════════════════════════════

/** Compute progress metrics from a step array. Pure function. */
export function computeProgress(steps: TaskRailStep[]): TaskRailProgress {
  const counts: Partial<Record<TaskRailStepStatus, number>> = {};
  for (const s of steps) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  const total = steps.length;
  const done = counts['done'] ?? 0;
  const skipped = counts['skipped'] ?? 0;
  const terminal = done + skipped;
  return {
    total,
    done,
    skipped,
    terminal,
    pending: counts['pending'] ?? 0,
    active: counts['active'] ?? 0,
    blocked: counts['blocked'] ?? 0,
    needsReview: counts['needs_review'] ?? 0,
    inProgress: counts['in_progress'] ?? 0,
    percent: total > 0 ? Math.round((terminal / total) * 100) : 0,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  State refresh
// ══════════════════════════════════════════════════════════════════════

/**
 * Recompute the rail's `state` field from its current steps.
 *
 * Rules (first match wins):
 *  1. Abandoned rails stay abandoned.
 *  2. All steps resolved → review (if currently active/ready/blocked/review)
 *     or complete (if already in review state from a prior refresh).
 *     completedAt is set on first entry to review and again on complete.
 *  3. Active step is blocked/needs_review → blocked.
 *  4. Active step is active/in_progress → active.
 *  5. Rail is locked → ready.
 *  6. Otherwise → draft.
 */
export function refreshRailState(rail: TaskRailLifecycle, now?: string): void {
  if (rail.state === 'abandoned') return;

  if (rail.steps.length > 0 && rail.steps.every((s) => isResolved(s.status))) {
    if (rail.state === 'review') {
      rail.state = 'complete';
      rail.completedAt ??= ts(now);
    } else {
      rail.state = 'review';
      rail.completedAt ??= ts(now);
    }
    return;
  }

  rail.completedAt = undefined;
  const active = findActiveOrBlockingStep(rail.steps);

  if (active?.status === 'blocked' || active?.status === 'needs_review') {
    rail.state = 'blocked';
    return;
  }

  if (active?.status === 'active' || active?.status === 'in_progress') {
    rail.state = 'active';
    return;
  }

  rail.state = rail.lockedAt ? 'ready' : 'draft';
}

// ══════════════════════════════════════════════════════════════════════
//  History / revision
// ══════════════════════════════════════════════════════════════════════

function appendHistory(
  target: { history: TaskRailHistoryEntry[] },
  operation: string,
  stepId?: string,
  note?: string,
  actorId?: string,
  actorName?: string,
  now?: string,
): void {
  target.history.push({
    ts: ts(now),
    operation,
    ...(stepId ? { stepId } : {}),
    ...(note ? { note } : {}),
    ...(actorId ? { actorId } : {}),
    ...(actorName ? { actorName } : {}),
  });
  target.history = target.history.slice(-HISTORY_LIMIT);
}

export interface LifecycleContext {
  note?: string;
  actorId?: string;
  actorName?: string;
  now?: string;
}

/** Bump revision, updatedAt, and append a history entry. */
function bump(
  rail: TaskRailLifecycle,
  operation: string,
  stepId?: string,
  ctx?: LifecycleContext,
): void {
  rail.revision += 1;
  rail.updatedAt = ts(ctx?.now);
  appendHistory(
    rail,
    operation,
    stepId,
    ctx?.note,
    ctx?.actorId,
    ctx?.actorName,
    ctx?.now,
  );
}

/** Record an operation that mutates rail execution state outside a single step helper. */
export function recordRailOperation(
  rail: TaskRailLifecycle,
  operation: string,
  stepId?: string,
  ctx?: LifecycleContext,
): void {
  bump(rail, operation, stepId, ctx);
}

// ══════════════════════════════════════════════════════════════════════
//  start — create a new rail
// ══════════════════════════════════════════════════════════════════════

export interface CreateRailArgs {
  id: string;
  instanceId: string;
  title?: string;
  objective?: string;
  locked?: boolean;
  /** Optional initial state override (e.g., 'active' for a pre-locked review rail). */
  state?: TaskRailLifecycle['state'];
  /** Link this rail to a parent rail (e.g., review rail → implementation rail). */
  parentRailId?: string;
  steps?: TaskRailStep[];
  note?: string;
  actorId?: string;
  actorName?: string;
}

/**
 * Create a brand-new task rail. Returns the rail object; does not
 * persist it. The caller handles saving.
 *
 * If locked=true, the rail starts in `ready` state. Otherwise `draft`.
 * Pass `state` to override the initial state explicitly.
 */
export function createRail(args: CreateRailArgs, now?: string): TaskRailLifecycle {
  const createdAt = ts(now);
  const rail: TaskRailLifecycle = {
    id: args.id,
    instanceId: args.instanceId,
    title: args.title ?? 'Task rail',
    objective: args.objective ?? '',
    state: args.state ?? (args.locked ? 'ready' : 'draft'),
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    lockedAt: args.locked ? createdAt : undefined,
    parentRailId: args.parentRailId,
    steps: args.steps ?? [],
    history: [
      {
        ts: createdAt,
        operation: 'start',
        ...(args.note ? { note: args.note } : {}),
        ...(args.actorId ? { actorId: args.actorId } : {}),
        ...(args.actorName ? { actorName: args.actorName } : {}),
      },
    ],
  };
  refreshRailState(rail, now);
  return rail;
}

// ══════════════════════════════════════════════════════════════════════
//  append — add steps at the end
// ══════════════════════════════════════════════════════════════════════

/**
 * Append one or more steps to the end of the rail.
 * Clears completedAt if the rail was complete or in review.
 */
export function appendSteps(
  rail: TaskRailLifecycle,
  steps: TaskRailStep[],
  ctx?: LifecycleContext,
): void {
  if (steps.length === 0) return;
  if (rail.state === 'complete' || rail.state === 'review') rail.completedAt = undefined;
  rail.steps.push(...steps);
  refreshRailState(rail, ctx?.now);
  bump(rail, 'append', steps[0].id, ctx);
}

// ══════════════════════════════════════════════════════════════════════
//  insert — add steps at a specific position
// ══════════════════════════════════════════════════════════════════════

/**
 * Insert one or more steps at a specific index.
 * Clears completedAt if the rail was complete or in review.
 */
export function insertSteps(
  rail: TaskRailLifecycle,
  steps: TaskRailStep[],
  index: number,
  ctx?: LifecycleContext,
): void {
  if (steps.length === 0) return;
  if (rail.state === 'complete' || rail.state === 'review') rail.completedAt = undefined;
  const clamped = Math.max(0, Math.min(rail.steps.length, Math.floor(index)));
  rail.steps.splice(clamped, 0, ...steps);
  refreshRailState(rail, ctx?.now);
  bump(rail, 'insert', steps[0].id, ctx);
}

// ══════════════════════════════════════════════════════════════════════
//  update — change one step's fields
// ══════════════════════════════════════════════════════════════════════

export interface StepUpdateFields {
  title?: string;
  instruction?: string;
  acceptanceCriteria?: string[];
  notes?: string | null;
  scope?: string | null;
  status?: TaskRailStepStatus;
}

/**
 * Update a single step's mutable fields. If status is set to 'pending',
 * startedAt and completedAt are cleared.
 */
export function updateStepFields(
  rail: TaskRailLifecycle,
  stepId: string,
  changes: StepUpdateFields,
  ctx?: LifecycleContext,
): TaskRailStep {
  const found = findStep(rail.steps, stepId);
  if (!found) throw new Error(`Step not found: ${stepId}`);
  const step = found.step;
  const timestamp = ts(ctx?.now);

  if (changes.title !== undefined) step.title = changes.title;
  if (changes.instruction !== undefined) step.instruction = changes.instruction;
  if (changes.acceptanceCriteria !== undefined) step.acceptanceCriteria = changes.acceptanceCriteria;
  if (changes.notes !== undefined) step.notes = changes.notes ?? undefined;
  if (changes.scope !== undefined) step.scope = changes.scope ?? undefined;
  if (changes.status !== undefined) {
    step.status = changes.status;
    if (changes.status === 'pending') {
      step.startedAt = undefined;
      step.completedAt = undefined;
    }
  }
  step.updatedAt = timestamp;

  refreshRailState(rail, ctx?.now);
  bump(rail, 'update', stepId, ctx);
  return step;
}

// ══════════════════════════════════════════════════════════════════════
//  batch_update — update multiple steps in one call
// ══════════════════════════════════════════════════════════════════════

export interface BatchUpdateEntry {
  stepId: string;
  changes: StepUpdateFields;
}

/**
 * Update multiple steps atomically. Throws if any stepId is not found.
 * All updates are applied before refreshing state once.
 */
export function batchUpdateStepFields(
  rail: TaskRailLifecycle,
  updates: BatchUpdateEntry[],
  ctx?: LifecycleContext,
): string[] {
  if (updates.length === 0) return [];

  const timestamp = ts(ctx?.now);
  const updatedIds: string[] = [];

  for (const { stepId, changes } of updates) {
    const found = findStep(rail.steps, stepId);
    if (!found) throw new Error(`Step not found: ${stepId}`);
    const step = found.step;
    if (changes.title !== undefined) step.title = changes.title;
    if (changes.instruction !== undefined) step.instruction = changes.instruction;
    if (changes.acceptanceCriteria !== undefined) step.acceptanceCriteria = changes.acceptanceCriteria;
    if (changes.notes !== undefined) step.notes = changes.notes ?? undefined;
    if (changes.scope !== undefined) step.scope = changes.scope ?? undefined;
    if (changes.status !== undefined) {
      step.status = changes.status;
      if (changes.status === 'pending') {
        step.startedAt = undefined;
        step.completedAt = undefined;
      }
    }
    step.updatedAt = timestamp;
    updatedIds.push(stepId);
  }

  refreshRailState(rail, ctx?.now);
  bump(rail, 'batch_update', updatedIds.join(','), ctx);
  return updatedIds;
}

// ══════════════════════════════════════════════════════════════════════
//  remove — delete a step
// ══════════════════════════════════════════════════════════════════════

/**
 * Remove a step by id. Returns the removed step.
 * Throws if the step is not found.
 */
export function removeStep(
  rail: TaskRailLifecycle,
  stepId: string,
  ctx?: LifecycleContext,
): TaskRailStep {
  const found = findStep(rail.steps, stepId);
  if (!found) throw new Error(`Step not found: ${stepId}`);
  const [removed] = rail.steps.splice(found.index, 1);
  refreshRailState(rail, ctx?.now);
  bump(rail, 'remove', removed.id, ctx);
  return removed;
}

// ══════════════════════════════════════════════════════════════════════
//  move — reposition a step
// ══════════════════════════════════════════════════════════════════════

/**
 * Move a step from its current position to a new index.
 * Throws if the step is not found.
 */
export function moveStep(
  rail: TaskRailLifecycle,
  stepId: string,
  targetIndex: number,
  ctx?: LifecycleContext,
): TaskRailStep {
  const found = findStep(rail.steps, stepId);
  if (!found) throw new Error(`Step not found: ${stepId}`);
  const [step] = rail.steps.splice(found.index, 1);
  const clamped = Math.max(0, Math.min(rail.steps.length, Math.floor(targetIndex)));
  rail.steps.splice(clamped, 0, step);
  refreshRailState(rail, ctx?.now);
  bump(rail, 'move', stepId, ctx);
  return step;
}

// ══════════════════════════════════════════════════════════════════════
//  lock / unlock
// ══════════════════════════════════════════════════════════════════════

/**
 * Lock the rail, marking it ready for shoot/sprint execution.
 * Throws if the rail has no steps.
 */
export function lockRail(
  rail: TaskRailLifecycle,
  ctx?: LifecycleContext,
): void {
  if (rail.steps.length === 0) {
    throw new Error('Cannot lock an empty task rail. Add steps first.');
  }
  rail.lockedAt = ts(ctx?.now);
  refreshRailState(rail, ctx?.now);
  bump(rail, 'lock', undefined, ctx);
}

/**
 * Unlock the rail, returning it to draft state for further editing.
 */
export function unlockRail(
  rail: TaskRailLifecycle,
  ctx?: LifecycleContext,
): void {
  rail.lockedAt = undefined;
  refreshRailState(rail, ctx?.now);
  bump(rail, 'unlock', undefined, ctx);
}

// ══════════════════════════════════════════════════════════════════════
//  clear — abandon the rail
// ══════════════════════════════════════════════════════════════════════

/**
 * Abandon the rail. Its state is set to 'abandoned' and it cannot
 * be shot or edited further (except by creating a new rail).
 */
export function clearRail(
  rail: TaskRailLifecycle,
  ctx?: LifecycleContext,
): void {
  rail.state = 'abandoned';
  bump(rail, 'clear', undefined, ctx);
}

// ══════════════════════════════════════════════════════════════════════
//  ack — acknowledge a step (shoot/sprint ACK)
// ══════════════════════════════════════════════════════════════════════

/**
 * Acknowledge a step with a new status. Used by shoot and sprint modes.
 *
 * Sets completedAt when status is 'done' or 'skipped'.
 * Does NOT auto-activate the next step — the caller handles that.
 *
 * Returns the updated step.
 * Throws if the step is not found or the ack status is invalid.
 */
export function ackStep(
  rail: TaskRailLifecycle,
  stepId: string,
  ackStatus: TaskRailStepStatus,
  ctx?: LifecycleContext & { evidence?: string },
): TaskRailStep {
  const found = findStep(rail.steps, stepId);
  if (!found) throw new Error(`Step not found: ${stepId}`);
  const step = found.step;
  const timestamp = ts(ctx?.now);

  step.status = ackStatus;
  step.updatedAt = timestamp;
  if (ctx?.note) step.lastNote = ctx.note;
  if (ctx?.evidence) step.evidence = ctx.evidence;
  if (ackStatus === 'done' || ackStatus === 'skipped') {
    step.completedAt = timestamp;
  }

  refreshRailState(rail, ctx?.now);
  bump(rail, `ack:${ackStatus}`, stepId, ctx);
  return step;
}

// ══════════════════════════════════════════════════════════════════════
//  activateNext — promote the first pending step to active
// ══════════════════════════════════════════════════════════════════════

/**
 * Find the first pending step and activate it (status → 'active',
 * startedAt set, attempts incremented). Used by shoot mode after
 * an ACK when there is no active/blocking step remaining.
 *
 * Returns the activated step, or undefined if no pending steps exist.
 */
export function activateNextStep(
  rail: TaskRailLifecycle,
  ctx?: LifecycleContext,
): TaskRailStep | undefined {
  const pending = findFirstPendingStep(rail.steps);
  if (!pending) return undefined;

  const timestamp = ts(ctx?.now);
  pending.status = 'active';
  pending.startedAt = timestamp;
  pending.updatedAt = timestamp;
  pending.attempts += 1;

  refreshRailState(rail, ctx?.now);
  bump(rail, 'shoot', pending.id, ctx);
  return pending;
}

// ══════════════════════════════════════════════════════════════════════
//  reset — reset a blocking step back to pending
// ══════════════════════════════════════════════════════════════════════

/**
 * Reset a step's status to 'pending', clearing its startedAt/completedAt.
 * Useful for unblocking a rail without removing the step.
 */
export function resetStepToPending(
  rail: TaskRailLifecycle,
  stepId: string,
  ctx?: LifecycleContext,
): TaskRailStep {
  return updateStepFields(rail, stepId, {
    status: 'pending',
  }, ctx);
}

// ══════════════════════════════════════════════════════════════════════
//  Source: @voxxo/task-rail/src/execution.ts
// ══════════════════════════════════════════════════════════════════════

/**
 * @voxxo/task-rail — Execution Semantics
 *
 * Pure functions for shoot (single-step) and sprint (batch) execution
 * cursors. These compose the lower-level lifecycle primitives (ackStep,
 * activateNextStep, refreshRailState) into the full shoot/sprint flows
 * that the relay's task_rail MCP tool consumes.
 *
 * Every function mutates the provided rail object in place but performs
 * NO persistence, NO I/O, and NO MCP transport. The relay adapter
 * handles loading, saving, and transport formatting.
 */

// ══════════════════════════════════════════════════════════════════════
//  Guards
// ══════════════════════════════════════════════════════════════════════

/** Type-narrow: is this a valid ACK status? */
export function isAckStatus(value: string): value is TaskRailAckStatus {
  return (TASK_RAIL_ACK_STATUSES as readonly string[]).includes(value);
}

// ══════════════════════════════════════════════════════════════════════
//  Result types
// ══════════════════════════════════════════════════════════════════════

export interface ShootArgs {
  /** ACK the current step before shooting the next. */
  ackStatus?: TaskRailAckStatus;
  /** Explicit step id to ACK (defaults to active/blocking step). */
  ackStepId?: string;
  note?: string;
  evidence?: string;
}

export interface ShootResult {
  /** The current step, if one exists. */
  step?: TaskRailStep;
  /** True when the step is blocking progress (blocked/needs_review). */
  paused?: boolean;
  /** True when the rail is complete (all steps resolved). */
  complete?: boolean;
}

export interface SprintArgs {
  /** Number of pending steps to reserve. Default: 6. Max: 20. */
  sprintCount?: number;
  note?: string;
}

export interface SprintResult {
  /** Reserved steps in order. First is 'active' only when no active step
   *  already exists; otherwise all reserved steps are 'in_progress'. */
  steps?: TaskRailStep[];
  /** True when the rail is complete (all steps resolved). */
  complete?: boolean;
}

// ══════════════════════════════════════════════════════════════════════
//  Error constructors (pure — no persistence)
// ══════════════════════════════════════════════════════════════════════

/** Error thrown when the rail is abandoned and cannot be executed. */
export class AbandonedRailError extends Error {
  constructor() {
    super('This task rail was abandoned. Start a new rail with mode="load" operation="start".');
    this.name = 'AbandonedRailError';
  }
}

/** Error thrown when the rail has no steps. */
export class EmptyRailError extends Error {
  constructor() {
    super('Task rail has no loaded steps. Load the complete plan before using shoot/sprint mode.');
    this.name = 'EmptyRailError';
  }
}

/** Error thrown when the rail is still in draft state (not locked). */
export class DraftRailError extends Error {
  constructor() {
    super('Task rail is still draft. In the relay task_rail tool, sprint/shoot execution is implicit approval and may lock non-empty draft rails; pure callers should lock only after approval.');
    this.name = 'DraftRailError';
  }
}

/** Error thrown when ACK status is invalid. */
export class InvalidAckStatusError extends Error {
  constructor(value: string) {
    super(`ack_status must be one of: ${TASK_RAIL_ACK_STATUSES.join(', ')}. Got: ${value}`);
    this.name = 'InvalidAckStatusError';
  }
}

/** Error thrown when sprint is called while a blocking step exists. */
export class BlockedSprintError extends Error {
  constructor(stepId: string, status: string) {
    super(
      `Rail is paused on step "${stepId}" (${status}). Sprint mode will not reserve more steps while the rail is blocked.`,
    );
    this.name = 'BlockedSprintError';
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Validation
// ══════════════════════════════════════════════════════════════════════

function validateRailForExecution(rail: TaskRailLifecycle): void {
  if (rail.state === 'abandoned') throw new AbandonedRailError();
  if (rail.steps.length === 0) throw new EmptyRailError();
  // refreshRailState may transition draft→ready, so we refresh first
  refreshRailState(rail);
  if (rail.state === 'draft') throw new DraftRailError();
  // 'review' is a valid execution state — the reviewer executes review steps
}

// ══════════════════════════════════════════════════════════════════════
//  shoot
// ══════════════════════════════════════════════════════════════════════

/**
 * Execute a single shoot operation on the rail.
 *
 * Flow:
 *  1. Validate rail (not abandoned, has steps, not draft).
 *  2. Capture `wasCompleteOnLoad`.
 *  3. If ACK status provided → ack the step.
 *  4. Refresh rail state.
 *  5. If active/blocking step exists → return it (paused if blocked/needs_review).
 *  6. If pending step exists → activate it and return.
 *  7. Otherwise → mark complete (if not already) and return complete signal.
 *
 * Mutates the rail in place. Returns a structured result.
 */
export function shoot(
  rail: TaskRailLifecycle,
  args: ShootArgs = {},
  ctx?: LifecycleContext,
): ShootResult {
  validateRailForExecution(rail);

  const wasTerminalOnLoad = rail.state === 'complete' || rail.state === 'review';

  // ── ACK phase ──
  if (args.ackStatus !== undefined) {
    if (!isAckStatus(args.ackStatus)) {
      throw new InvalidAckStatusError(args.ackStatus);
    }

    // Resolve the step to ACK: explicit id or active/blocking
    let ackStepId = args.ackStepId;
    if (!ackStepId) {
      const active = findActiveOrBlockingStep(rail.steps);
      if (!active) {
        throw new Error('No active task rail step to acknowledge.');
      }
      ackStepId = active.id;
    }

    ackStep(rail, ackStepId, args.ackStatus, {
      ...ctx,
      note: args.note ?? ctx?.note,
      evidence: args.evidence,
    });
  }

  // ── Step resolution phase ──
  refreshRailState(rail);

  const active = findActiveOrBlockingStep(rail.steps);
  if (active) {
    if (active.status === 'blocked' || active.status === 'needs_review') {
      return { step: active, paused: true };
    }
    return { step: active };
  }

  // No active/blocking step — try to activate the next pending
  const next = activateNextStep(rail, ctx);
  if (next) {
    return { step: next };
  }

  // Nothing left — refresh state (review → complete or stays terminal)
  refreshRailState(rail);
  if (!wasTerminalOnLoad && rail.state !== 'complete' && rail.state !== 'review') {
    // Force-complete: all steps are resolved but state didn't flip (edge case)
    rail.state = 'complete';
    rail.completedAt ??= new Date().toISOString();
  }
  return { complete: true };
}

// ══════════════════════════════════════════════════════════════════════
//  sprint
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_SPRINT_COUNT = 6;
const MAX_SPRINT_COUNT = 20;

function resolveSprintCount(args: SprintArgs): number {
  const raw = args.sprintCount ?? DEFAULT_SPRINT_COUNT;
  return Math.max(1, Math.min(MAX_SPRINT_COUNT, Math.floor(raw)));
}

/**
 * Execute a sprint operation: reserve a bounded batch of upcoming
 * pending steps.
 *
 * Flow:
 *  1. Validate rail (not abandoned, has steps, not draft).
 *  2. Capture `wasCompleteOnLoad`.
 *  3. If a blocking step exists → throw BlockedSprintError.
 *  4. Check for an existing active step to avoid dual-active state.
 *  5. Iterate steps in order, reserving only `pending` steps up to limit.
 *     First reserved → 'active' (only if no active step already exists);
 *     rest → 'in_progress'.
 *  6. Refresh rail state.
 *  7. If any steps reserved → return them.
 *  8. Otherwise → mark complete and return complete signal.
 *
 * Only reserves pending steps — skips active/in_progress (already claimed
 * by another executor). This enables concurrent squad sprints where each
 * caller gets a different batch.
 *
 * Mutates the rail in place. Returns a structured result.
 */
export function sprint(
  rail: TaskRailLifecycle,
  args: SprintArgs = {},
  ctx?: LifecycleContext,
): SprintResult {
  validateRailForExecution(rail);

  const wasTerminalOnLoad = rail.state === 'complete' || rail.state === 'review';

  // ── Blocking guard ──
  const blocking = findActiveOrBlockingStep(rail.steps);
  if (blocking?.status === 'blocked' || blocking?.status === 'needs_review') {
    throw new BlockedSprintError(blocking.id, blocking.status);
  }

  // ── Reserve phase ──
  const limit = resolveSprintCount(args);
  const selected: TaskRailStep[] = [];
  const now = new Date().toISOString();

  // Guard: if a step is already active, do not promote any newly-reserved
  // step to active — that would create two active steps and cause the
  // prior active step to be auto-ACK'd on the next shoot call.
  const hasActiveStep = rail.steps.some(s => s.status === 'active');

  for (const step of rail.steps) {
    if (selected.length >= limit) break;
    if (step.status !== 'pending') continue;

    step.status = (selected.length === 0 && !hasActiveStep) ? 'active' : 'in_progress';
    step.startedAt ??= now;
    step.updatedAt = now;
    step.attempts += 1;
    selected.push(step);
  }

  refreshRailState(rail);

  if (selected.length > 0) {
    recordRailOperation(
      rail,
      'sprint',
      selected.map((step) => step.id).join(','),
      {
        ...ctx,
        note: args.note ?? ctx?.note,
      },
    );
    return { steps: selected };
  }

  // Nothing left — refresh state (review → complete or stays terminal)
  refreshRailState(rail);
  if (!wasTerminalOnLoad && rail.state !== 'complete' && rail.state !== 'review') {
    rail.state = 'complete';
    rail.completedAt ??= new Date().toISOString();
  }
  return { complete: true };
}


// ══════════════════════════════════════════════════════════════════════
//  Standalone convenience helpers
// ══════════════════════════════════════════════════════════════════════

/** Minimal seed accepted by createTaskRailStep for portable callers. */
export interface TaskRailStepSeed {
  id?: string;
  title?: string;
  instruction: string;
  acceptanceCriteria?: string[];
  notes?: string;
  scope?: string;
  status?: TaskRailStepStatus;
}

/** JSON-serializable rail payload for storage in any caller-owned backend. */
export interface SerializedTaskRail {
  schema: 'context-warp-drive/task-rail@1';
  rail: TaskRailLifecycle;
}

/** Default deterministic-ish id factory; callers may supply their own stable IDs. */
function defaultTaskRailId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** Create a single portable rail step with timestamps and defaults filled. */
export function createTaskRailStep(seed: TaskRailStepSeed, now?: string): TaskRailStep {
  const timestamp = ts(now);
  return {
    id: seed.id ?? defaultTaskRailId('step'),
    title: seed.title ?? (seed.instruction.slice(0, 80) || 'Task rail step'),
    instruction: seed.instruction,
    acceptanceCriteria: seed.acceptanceCriteria ?? [],
    ...(seed.notes ? { notes: seed.notes } : {}),
    ...(seed.scope ? { scope: seed.scope } : {}),
    status: seed.status ?? 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    attempts: 0,
  };
}

export interface StartTaskRailArgs {
  id?: string;
  ownerId?: string;
  title?: string;
  objective?: string;
  locked?: boolean;
  steps?: TaskRailStepSeed[];
  note?: string;
  actorId?: string;
  actorName?: string;
  now?: string;
}

/** Start a portable task rail without depending on the Voxxo relay adapter. */
export function startTaskRail(args: StartTaskRailArgs = {}): TaskRailLifecycle {
  const timestamp = ts(args.now);
  return createRail({
    id: args.id ?? defaultTaskRailId('rail'),
    instanceId: args.ownerId ?? 'standalone',
    title: args.title,
    objective: args.objective,
    locked: args.locked,
    steps: (args.steps ?? []).map((step) => createTaskRailStep(step, timestamp)),
    note: args.note,
    actorId: args.actorId,
    actorName: args.actorName,
  }, timestamp);
}

/** Serialize a rail for caller-owned JSON, file, database, browser, or MCP storage. */
export function serializeTaskRail(rail: TaskRailLifecycle): SerializedTaskRail {
  return {
    schema: 'context-warp-drive/task-rail@1',
    rail,
  };
}

/** Restore a serialized rail, validating only the portable schema envelope. */
export function restoreTaskRail(serialized: SerializedTaskRail): TaskRailLifecycle {
  if (serialized.schema !== 'context-warp-drive/task-rail@1') {
    throw new Error(`Unsupported task rail schema: ${String((serialized as { schema?: unknown }).schema)}`);
  }
  return serialized.rail;
}
