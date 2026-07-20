/**
 * Continuity Audit — pure, machine-readable invariants for hard-epoch and
 * replacement boundaries.
 *
 * This module does not build a second handoff artifact. It audits the same
 * typed receipt, band coordinates, digests, rail identities, and provenance
 * records that the runtime already emits. Callers decide whether an error
 * blocks delivery or is surfaced for operator inspection.
 *
 * Pure module: no I/O, timers, environment access, or inferred timestamps.
 */

import {
  LIVE_CONTINUITY_STATE_HEADER,
  isContinuityReceipt,
  type ContinuityLiveField,
  type ContinuityReceipt,
} from './continuityReceipt.ts';

export type ContinuityAuditSeverity = 'error' | 'warning';

export type ContinuityAuditCode =
  | 'receipt-invalid'
  | 'live-state-missing'
  | 'live-state-block-missing'
  | 'live-state-block-duplicate'
  | 'capture-time-invalid'
  | 'capture-time-mismatch'
  | 'source-id-missing'
  | 'source-time-missing'
  | 'source-time-invalid'
  | 'source-time-after-capture'
  | 'identity-missing'
  | 'frontier-missing'
  | 'frontier-trace-mismatch'
  | 'frontier-index-behind'
  | 'band-stack-empty'
  | 'band-range-invalid'
  | 'band-gap'
  | 'band-overlap'
  | 'band-epoch-order'
  | 'band-trace-mismatch'
  | 'band-time-order'
  | 'provenance-id-duplicate'
  | 'frozen-digest-missing'
  | 'frozen-artifact-mutated'
  | 'completed-step-replayed'
  | 'completion-rail-not-complete'
  | 'completion-validation-missing';

export interface ContinuityAuditIssue {
  readonly code: ContinuityAuditCode;
  readonly severity: ContinuityAuditSeverity;
  readonly path: string;
  readonly detail: string;
}

export interface ContinuityAuditResult {
  readonly valid: boolean;
  readonly errors: readonly ContinuityAuditIssue[];
  readonly warnings: readonly ContinuityAuditIssue[];
}

interface MutableAudit {
  readonly errors: ContinuityAuditIssue[];
  readonly warnings: ContinuityAuditIssue[];
}

function issue(
  audit: MutableAudit,
  severity: ContinuityAuditSeverity,
  code: ContinuityAuditCode,
  path: string,
  detail: string,
): void {
  audit[severity === 'error' ? 'errors' : 'warnings'].push({ code, severity, path, detail });
}

function result(audit: MutableAudit): ContinuityAuditResult {
  return {
    valid: audit.errors.length === 0,
    errors: audit.errors,
    warnings: audit.warnings,
  };
}

function parseSourceTime(
  audit: MutableAudit,
  value: string | undefined,
  path: string,
  required: boolean,
): number | null {
  if (!value) {
    if (required) issue(audit, 'error', 'source-time-missing', path, 'authoritative source time is required');
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    issue(audit, 'error', 'source-time-invalid', path, `invalid source timestamp: ${value}`);
    return null;
  }
  return parsed;
}

function requireIdentity(audit: MutableAudit, value: string | undefined, path: string): void {
  if (!value?.trim()) issue(audit, 'error', 'identity-missing', path, 'stable provenance identity is required');
}

export interface ContinuityAuditBand {
  readonly epoch: number;
  readonly traceId: string;
  readonly sourceStart: number;
  readonly sourceEndExclusive: number;
  readonly sourceFirstTimestamp: string;
  readonly sourceLastTimestamp: string;
  readonly createdAt: string;
  readonly provenanceId: string;
}

/** Audit exact, end-exclusive tail-band geometry without inferring order from IDs. */
export function auditContinuityBandStack(
  bands: readonly ContinuityAuditBand[],
): ContinuityAuditResult {
  const audit: MutableAudit = { errors: [], warnings: [] };
  if (bands.length === 0) {
    issue(audit, 'error', 'band-stack-empty', 'bands', 'at least one source-stamped band is required');
    return result(audit);
  }

  let previous: ContinuityAuditBand | undefined;
  let previousLastTime: number | null = null;
  const provenanceIds = new Set<string>();

  bands.forEach((band, index) => {
    const path = `bands[${index}]`;
    requireIdentity(audit, band.traceId, `${path}.traceId`);
    requireIdentity(audit, band.provenanceId, `${path}.provenanceId`);
    if (provenanceIds.has(band.provenanceId)) {
      issue(audit, 'error', 'provenance-id-duplicate', `${path}.provenanceId`, `duplicate ${band.provenanceId}`);
    }
    provenanceIds.add(band.provenanceId);

    if (!Number.isInteger(band.sourceStart)
      || !Number.isInteger(band.sourceEndExclusive)
      || band.sourceStart < 0
      || band.sourceEndExclusive <= band.sourceStart) {
      issue(audit, 'error', 'band-range-invalid', path, 'band must have a non-empty non-negative end-exclusive range');
    }
    if (index === 0 && band.sourceStart !== 0) {
      issue(audit, 'error', 'band-gap', path, `stack omits source range 0..${band.sourceStart}`);
    }

    const firstTime = parseSourceTime(audit, band.sourceFirstTimestamp, `${path}.sourceFirstTimestamp`, true);
    const lastTime = parseSourceTime(audit, band.sourceLastTimestamp, `${path}.sourceLastTimestamp`, true);
    const createdTime = parseSourceTime(audit, band.createdAt, `${path}.createdAt`, true);
    if (firstTime !== null && lastTime !== null && firstTime > lastTime) {
      issue(audit, 'error', 'band-time-order', path, 'first source event occurs after the last source event');
    }
    if (lastTime !== null && createdTime !== null && lastTime > createdTime) {
      issue(audit, 'error', 'source-time-after-capture', path, 'band source event occurs after artifact creation');
    }
    if (previousLastTime !== null && firstTime !== null && firstTime < previousLastTime) {
      issue(audit, 'error', 'band-time-order', path, 'source time regresses across adjacent bands');
    }

    if (previous) {
      if (band.epoch <= previous.epoch) {
        issue(audit, 'error', 'band-epoch-order', `${path}.epoch`, 'epochs must increase strictly');
      }
      if (band.traceId !== previous.traceId) {
        issue(audit, 'error', 'band-trace-mismatch', `${path}.traceId`, 'adjacent bands must retain the same trace identity');
      }
      if (band.sourceStart > previous.sourceEndExclusive) {
        issue(audit, 'error', 'band-gap', path, `missing source range ${previous.sourceEndExclusive}..${band.sourceStart}`);
      } else if (band.sourceStart < previous.sourceEndExclusive) {
        issue(audit, 'error', 'band-overlap', path, `overlaps prior source range at ${band.sourceStart}..${previous.sourceEndExclusive}`);
      }
    }

    previous = band;
    previousLastTime = lastTime;
  });

  return result(audit);
}

export interface FrozenArtifactWitness {
  readonly artifactId: string;
  readonly sourceTimestamp: string;
  readonly frozenDigest: string;
  readonly currentDigest: string;
}

export interface ContinuityBoundaryAuditInput {
  readonly receipt: unknown;
  readonly renderedPrompt: string;
  readonly bands?: readonly ContinuityAuditBand[];
  readonly frozenArtifacts?: readonly FrozenArtifactWitness[];
  readonly completedStepIds?: readonly string[];
  readonly postBoundaryActivatedStepIds?: readonly string[];
}

function mergeAudit(target: MutableAudit, incoming: ContinuityAuditResult): void {
  target.errors.push(...incoming.errors);
  target.warnings.push(...incoming.warnings);
}

function exactLineCount(text: string, line: string): number {
  return text.split('\n').filter((candidate) => candidate.trim() === line).length;
}

function auditLiveFieldSource(
  audit: MutableAudit,
  field: ContinuityLiveField<unknown>,
  path: string,
  captureTime: number,
): void {
  requireIdentity(audit, field.source.id, `${path}.source.id`);
  const sourceCaptureTime = parseSourceTime(audit, field.source.capturedAt, `${path}.source.capturedAt`, true);
  if (sourceCaptureTime !== null && sourceCaptureTime !== captureTime) {
    issue(audit, 'error', 'capture-time-mismatch', `${path}.source.capturedAt`, 'field capture must match live-state capture');
  }
  const sourceTime = parseSourceTime(audit, field.source.sourceTimestamp, `${path}.source.sourceTimestamp`, false);
  if (sourceTime !== null && sourceTime > captureTime) {
    issue(audit, 'error', 'source-time-after-capture', `${path}.source.sourceTimestamp`, 'source event occurs after boundary capture');
  }
}

/**
 * Audit the rendered boundary plus its typed receipt and optional frozen/band
 * witnesses. This detects duplicate authority blocks without parsing prose to
 * reconstruct state.
 */
export function auditContinuityBoundary(
  input: ContinuityBoundaryAuditInput,
): ContinuityAuditResult {
  const audit: MutableAudit = { errors: [], warnings: [] };
  if (!isContinuityReceipt(input.receipt)) {
    issue(audit, 'error', 'receipt-invalid', 'receipt', 'typed continuity receipt is missing or malformed');
    return result(audit);
  }
  const receipt: ContinuityReceipt = input.receipt;
  const liveState = receipt.liveState;
  if (!liveState) {
    issue(audit, 'error', 'live-state-missing', 'receipt.liveState', 'new boundary audit requires typed live state');
  }

  const blockCount = exactLineCount(input.renderedPrompt, LIVE_CONTINUITY_STATE_HEADER);
  if (blockCount === 0) {
    issue(audit, 'error', 'live-state-block-missing', 'renderedPrompt', 'authoritative live-state block is absent');
  } else if (blockCount > 1) {
    issue(audit, 'error', 'live-state-block-duplicate', 'renderedPrompt', `found ${blockCount} authoritative live-state blocks`);
  }

  if (liveState) {
    const captureTime = Date.parse(liveState.capturedAt);
    if (!Number.isFinite(captureTime)) {
      issue(audit, 'error', 'capture-time-invalid', 'receipt.liveState.capturedAt', `invalid capture time: ${liveState.capturedAt}`);
    } else {
      if (receipt.capturedAt && receipt.capturedAt !== liveState.capturedAt) {
        issue(audit, 'error', 'capture-time-mismatch', 'receipt.capturedAt', 'receipt and live-state capture times differ');
      }
      const fields: ReadonlyArray<readonly [string, ContinuityLiveField<unknown>]> = [
        ['instance', liveState.instance],
        ['request', liveState.request],
        ['rail', liveState.rail],
        ['step', liveState.step],
        ['claims', liveState.claims],
        ['edits', liveState.edits],
        ['validation', liveState.validation],
        ['review', liveState.review],
        ['blockers', liveState.blockers],
        ['rooms', liveState.rooms],
        ['subscriptions', liveState.subscriptions],
        ['rawTailFrontier', liveState.rawTailFrontier],
      ];
      fields.forEach(([name, field]) => auditLiveFieldSource(audit, field, `receipt.liveState.${name}`, captureTime));

      if (liveState.request.value) {
        if (!liveState.request.source.sourceTimestamp) {
          issue(audit, 'warning', 'source-time-missing', 'receipt.liveState.request.source.sourceTimestamp', 'active-request source time is explicitly unknown');
        } else {
          parseSourceTime(audit, liveState.request.source.sourceTimestamp, 'receipt.liveState.request.source.sourceTimestamp', false);
        }
        if (liveState.request.source.id === 'unknown') {
          issue(audit, 'error', 'source-id-missing', 'receipt.liveState.request.source.id', 'active request needs a stable source identity');
        }
      }
      const instance = liveState.instance.value;
      if (instance) {
        requireIdentity(audit, instance.instanceId, 'receipt.liveState.instance.value.instanceId');
        if (instance.creationCause) {
          requireIdentity(audit, instance.originEventId, 'receipt.liveState.instance.value.originEventId');
          if (!instance.originSourceTimestamp) {
            issue(audit, 'warning', 'source-time-missing', 'receipt.liveState.instance.value.originSourceTimestamp', 'lineage source time is explicitly unknown');
          } else {
            parseSourceTime(audit, instance.originSourceTimestamp, 'receipt.liveState.instance.value.originSourceTimestamp', false);
          }
        }
      }

      const canonical = receipt.canonicalRange;
      const frontier = liveState.rawTailFrontier.value;
      if (!frontier) {
        issue(audit, 'error', 'frontier-missing', 'receipt.liveState.rawTailFrontier.value', 'raw-tail frontier is required');
      }
      if (canonical) {
        requireIdentity(audit, canonical.traceId, 'receipt.canonicalRange.traceId');
        if (canonical.eventCount > 0) {
          requireIdentity(audit, canonical.lastEventId, 'receipt.canonicalRange.lastEventId');
          if (!canonical.lastEventTimestamp) {
            issue(audit, 'warning', 'source-time-missing', 'receipt.canonicalRange.lastEventTimestamp', 'frontier source time is explicitly unknown');
          } else {
            parseSourceTime(audit, canonical.lastEventTimestamp, 'receipt.canonicalRange.lastEventTimestamp', false);
          }
        }
        if (frontier) {
          if (frontier.traceId !== canonical.traceId) {
            issue(audit, 'error', 'frontier-trace-mismatch', 'receipt.liveState.rawTailFrontier.value.traceId', 'frontier lost canonical trace identity');
          }
          // The frontier is captured at snapshot time while the canonical range
          // is counted at package assembly, so the frontier may legitimately
          // lead when the tail advances after capture or the package narrows.
          // Only a trailing frontier is incoherent: it would claim the package
          // covers events the raw tail never reached.
          if (frontier.unit === 'event') {
            if (typeof frontier.index !== 'number') {
              issue(audit, 'error', 'frontier-missing', 'receipt.liveState.rawTailFrontier.value.index', 'event-unit frontier requires a numeric index');
            } else if (frontier.index < canonical.eventCount) {
              issue(audit, 'error', 'frontier-index-behind', 'receipt.liveState.rawTailFrontier.value.index', 'frontier index must not trail the canonical event count');
            }
          }
        }
      }
    }
  }

  if (input.bands) mergeAudit(audit, auditContinuityBandStack(input.bands));

  const frozenIds = new Set<string>();
  (input.frozenArtifacts ?? []).forEach((artifact, index) => {
    const path = `frozenArtifacts[${index}]`;
    requireIdentity(audit, artifact.artifactId, `${path}.artifactId`);
    if (frozenIds.has(artifact.artifactId)) {
      issue(audit, 'error', 'provenance-id-duplicate', `${path}.artifactId`, `duplicate ${artifact.artifactId}`);
    }
    frozenIds.add(artifact.artifactId);
    parseSourceTime(audit, artifact.sourceTimestamp, `${path}.sourceTimestamp`, true);
    if (!artifact.frozenDigest || !artifact.currentDigest) {
      issue(audit, 'error', 'frozen-digest-missing', path, 'both frozen and current digests are required');
    } else if (artifact.frozenDigest !== artifact.currentDigest) {
      issue(audit, 'error', 'frozen-artifact-mutated', path, `${artifact.artifactId} changed after freeze`);
    }
  });

  const completed = new Set((input.completedStepIds ?? []).filter(Boolean));
  for (const stepId of input.postBoundaryActivatedStepIds ?? []) {
    if (completed.has(stepId)) {
      issue(audit, 'error', 'completed-step-replayed', 'postBoundaryActivatedStepIds', `completed step ${stepId} became executable again`);
    }
  }

  return result(audit);
}

export type ContinuityCompletionSignal = 'glyph' | 'star' | 'atlas_commit' | 'step_ack';

export interface ContinuityCompletionAuditInput {
  readonly claimedComplete: boolean;
  readonly railState?: string;
  readonly validation?: {
    readonly status: 'verified' | 'failed' | 'unknown';
    readonly sourceId?: string;
    readonly sourceTimestamp?: string;
  };
  readonly signals?: readonly ContinuityCompletionSignal[];
}

export interface ContinuityCompletionAuditResult extends ContinuityAuditResult {
  readonly authoritativeComplete: boolean;
}

/** Completion requires terminal rail state plus source-stamped verification. */
export function auditContinuityCompletion(
  input: ContinuityCompletionAuditInput,
): ContinuityCompletionAuditResult {
  const audit: MutableAudit = { errors: [], warnings: [] };
  const railComplete = input.railState === 'complete';
  const validationVerified = input.validation?.status === 'verified'
    && Boolean(input.validation.sourceId?.trim())
    && Number.isFinite(Date.parse(input.validation.sourceTimestamp ?? ''));
  const authoritativeComplete = railComplete && validationVerified;

  if (input.claimedComplete && !railComplete) {
    issue(audit, 'error', 'completion-rail-not-complete', 'railState', 'glyphs, stars, Atlas commits, and step ACKs cannot replace terminal rail state');
  }
  if (input.claimedComplete && !validationVerified) {
    // Only a supplied-but-inadequate validation object is an error. When no
    // structured validation exists at all the boundary cannot confirm
    // completion either way, and erroring there would fire on every delivery
    // until callers carry source-stamped validation.
    if (input.validation) {
      issue(audit, 'error', 'completion-validation-missing', 'validation', 'completion requires source-stamped verified evidence');
    } else {
      issue(audit, 'warning', 'completion-validation-missing', 'validation', 'no structured validation supplied; completion cannot be independently confirmed');
    }
  }
  if ((input.signals?.length ?? 0) > 0 && !authoritativeComplete) {
    issue(audit, 'warning', 'completion-validation-missing', 'signals', `advisory signals observed: ${input.signals?.join(', ')}`);
  }

  return { ...result(audit), authoritativeComplete };
}
