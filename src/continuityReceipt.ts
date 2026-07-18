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
  REBIRTH_CONTROL_AUTHORITY_HORIZON,
  REBIRTH_CONTROL_DYNAMIC_TRUTH_ORDER,
} from './chronologicalProvenance.ts';

export const CONTINUITY_RECEIPT_VERSION = 1 as const;

export type ContinuityReceiptBoundary =
  | 'same_instance_hard_epoch'
  | 'continuation'
  | 'fresh_fork'
  | 'resurrection'
  | 'brain_merge';

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

/** Canonical event range of the predecessor trace at package creation. */
export interface ContinuityReceiptCanonicalRange {
  readonly traceId: string;
  /** Number of events in the trace (range is event#0..event#eventCount). */
  readonly eventCount: number;
}

export interface ContinuityReceipt {
  readonly version: typeof CONTINUITY_RECEIPT_VERSION;
  readonly boundary: ContinuityReceiptBoundary;
  readonly predecessorName: string;
  /** ISO capture time for builder-assembled receipts; absent for prose synthesis. */
  readonly capturedAt?: string;
  readonly sourceStatus?: string;
  readonly rail?: ContinuityReceiptRail;
  /**
   * Immediate next action as resolved at assembly. Defaults to the active
   * rail step's instruction when omitted here.
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
}

// ── Boundary resolution ────────────────────────────────────────────────

/**
 * Single lifecycle-boundary resolver. Both control surfaces previously
 * duplicated this precedence; keep exactly one copy so a boundary can never
 * classify two ways in the same package.
 */
export function resolveContinuityBoundary(input: {
  readonly lifecycleBoundary?: ContinuityReceiptBoundary;
  /** Pass undefined when no fork context exists (legacy callers/tests). */
  readonly isFreshFork?: boolean;
  readonly mergedLineageCount?: number;
}): ContinuityReceiptBoundary {
  if (input.lifecycleBoundary) return input.lifecycleBoundary;
  if (input.isFreshFork !== undefined && input.isFreshFork !== false) return 'fresh_fork';
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
  /** Defaults to rail.activeStep.instruction when omitted. */
  readonly nextAction?: string;
  readonly activeRequestText?: string;
  readonly claims?: readonly string[];
  readonly editEvidenceFiles?: readonly string[];
  /** Whether an Active Edit Delta section was bundled. Default: any claims/edits. */
  readonly hasActiveEditDelta?: boolean;
  /** Explicit validation fact (already scanned). Wins over validationSources. */
  readonly validationFact?: string;
  /** Prose blobs scanned for the latest explicit validation/verification line. */
  readonly validationSources?: readonly string[];
  /** Extra hazard descriptors beyond auto-detection. */
  readonly hazards?: readonly string[];
  /** Text blocks scanned for unresolved provider/runtime error markers. */
  readonly hazardSources?: readonly string[];
  readonly canonicalRange?: ContinuityReceiptCanonicalRange;
  /** Additional disagreements computed by the caller (typed world: rare). */
  readonly extraDisagreements?: readonly string[];
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

const VALIDATION_FACT_PATTERN = /^(?:validation|verification)(?:\s+(?:state|fact|facts))?\s*:/iu;

/**
 * Latest explicit validation/verification fact across prose blobs, latest line
 * wins. Returns the fact text with its label stripped (untruncated; the
 * renderer bounds display). This is THE scan — both the receipt assembler and
 * any legacy surface share it, so validation state cannot diverge.
 */
export function findLatestValidationFact(texts: readonly string[]): string | undefined {
  const explicitLines = texts
    .flatMap((text) => text.split('\n'))
    .map((line) => line.trim())
    .filter((line) => VALIDATION_FACT_PATTERN.test(line));
  const latest = explicitLines.at(-1);
  return latest ? latest.replace(/^[^:]+:\s*/u, '') : undefined;
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
  return {
    version: CONTINUITY_RECEIPT_VERSION,
    boundary: parts.boundary,
    predecessorName: parts.predecessorName,
    capturedAt: parts.capturedAt ?? new Date().toISOString(),
    sourceStatus: parts.sourceStatus?.trim() || undefined,
    rail: parts.rail,
    nextAction: parts.nextAction ?? parts.rail?.activeStep?.instruction,
    activeRequest: activeRequestText
      ? { text: activeRequestText, totalChars: activeRequestText.length }
      : undefined,
    editClaim: {
      supplied: parts.hasActiveEditDelta ?? (claims.length > 0 || editEvidenceFiles.length > 0),
      claims,
      editEvidenceFiles,
    },
    validation: {
      fact: parts.validationFact ?? findLatestValidationFact(parts.validationSources ?? []),
    },
    hazards: [...detectContinuityHazards(parts.hazardSources ?? []), ...(parts.hazards ?? [])],
    canonicalRange: parts.canonicalRange,
    disagreements,
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
   * Surface-specific active-request capsule renderer. Receives the full
   * request text and returns the complete `active request (...)` line(s).
   * Each surface injects its own budget policy so the capsule stays
   * byte-compatible with what it renders today.
   */
  readonly formatActiveRequest?: (text: string) => string;
}

const DEFAULT_ACTIVE_REQUEST_MAX_CHARS = 6_000;

/**
 * Default active-request capsule for hosts without a surface policy: verbatim
 * when it fits, honest middle elision with true size and a tap pointer
 * otherwise. Self-contained so the shared module has no rendering imports.
 */
function defaultFormatActiveRequest(activeRequest: string): string {
  if (activeRequest.length <= DEFAULT_ACTIVE_REQUEST_MAX_CHARS) {
    return `active request (verbatim; sole authoritative body):\n${activeRequest}`;
  }
  const headChars = Math.floor(DEFAULT_ACTIVE_REQUEST_MAX_CHARS * 0.6);
  const tailChars = DEFAULT_ACTIVE_REQUEST_MAX_CHARS - headChars;
  const rendered = `${activeRequest.slice(0, headChars)}\n[… ${activeRequest.length - headChars - tailChars} chars elided …]\n${activeRequest.slice(activeRequest.length - tailChars)}`;
  return `active request (EXCERPT — ${activeRequest.length} chars total, middle elided; full text via tap_instance_messages; sole authoritative body):\n${rendered}`;
}

function formatReceiptRailLine(rail: ContinuityReceiptRail | undefined): string {
  if (!rail) return 'unknown';
  if (!rail.railId) return rail.rawLine ?? 'unknown';
  const done = rail.doneSteps !== undefined ? String(rail.doneSteps) : '?';
  const total = rail.totalSteps !== undefined ? String(rail.totalSteps) : '?';
  const percent = rail.percentComplete !== undefined ? String(rail.percentComplete) : '?';
  return `📋 ${rail.title} (${rail.railId}) — ${rail.state} — ${done}/${total} (${percent}%)`;
}

function formatReceiptActiveStepLine(rail: ContinuityReceiptRail | undefined): string {
  const activeStep = rail?.activeStep;
  if (activeStep) return `▶ Active: ${activeStep.id} [${activeStep.status}] — ${activeStep.title}`;
  return rail?.activeStepRawLine ?? 'unknown';
}

function formatReceiptEditClaimLine(editClaim: ContinuityReceiptEditClaim): string {
  if (!editClaim.supplied) return 'edit/claim state: not supplied';
  const evidence = editClaim.editEvidenceFiles.length > 0
    ? `; recent edit evidence covers ${editClaim.editEvidenceFiles.length} file(s)`
    : '';
  if (editClaim.claims.length > 0) {
    return `edit/claim state: ${editClaim.claims.length} active claim(s): ${editClaim.claims.join(', ')}${evidence}; Active Edit Delta below governs ownership`;
  }
  return `edit/claim state: no active claims declared${evidence}; recent edits are evidence, not ownership`;
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
  const formatActiveRequest = options.formatActiveRequest ?? defaultFormatActiveRequest;
  return [
    '── Rebirth Control (AUTHORITATIVE) ──',
    `boundary: ${receipt.boundary}`,
    `identity: ${formatContinuityIdentity(receipt.boundary, receipt.predecessorName)}`,
    `source status: ${receipt.sourceStatus ?? 'unknown'}`,
    `rail: ${formatReceiptRailLine(receipt.rail)}`,
    `active rail step: ${formatReceiptActiveStepLine(receipt.rail)}`,
    `immediate next action: ${receipt.nextAction ?? 'unknown'}`,
    ...(receipt.rail?.queuedStepTitle ? [`queued after current: ${receipt.rail.queuedStepTitle}`] : []),
    formatReceiptEditClaimLine(receipt.editClaim),
    receipt.validation.fact !== undefined
      ? `validation state (explicit): ${truncateContinuity(receipt.validation.fact, 240)}`
      : 'validation state: no explicit validation fact bundled; step status alone is not proof',
    receipt.disagreements.length > 0
      ? `source disagreement: ${receipt.disagreements.join('; ')}`
      : 'source disagreement: none detected among bundled explicit sources',
    ...(receipt.hazards.length > 0 ? [`unresolved hazards: ${receipt.hazards.join('; ')}`] : []),
    REBIRTH_CONTROL_AUTHORITY_HORIZON,
    REBIRTH_CONTROL_DYNAMIC_TRUTH_ORDER,
    receipt.activeRequest
      ? formatActiveRequest(receipt.activeRequest.text)
      : 'active request: none bundled',
  ].join('\n');
}
