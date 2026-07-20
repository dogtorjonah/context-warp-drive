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
  | 'frontier-index-mismatch'
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
  | 'completion-validation-missing'
  | 'takeover-lineage-invalid'
  | 'takeover-creator-mismatch'
  | 'takeover-rail-missing'
  | 'takeover-rail-identity-changed'
  | 'takeover-rail-owner-mismatch'
  | 'takeover-rail-creator-changed'
  | 'takeover-rail-content-changed'
  | 'takeover-record-missing'
  | 'takeover-record-added'
  | 'takeover-record-mutated'
  | 'takeover-claim-owner-mismatch';

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
          if (frontier.unit === 'event' && frontier.index !== canonical.eventCount) {
            issue(audit, 'error', 'frontier-index-mismatch', 'receipt.liveState.rawTailFrontier.value.index', 'frontier index must equal canonical event count');
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
    issue(audit, 'error', 'completion-validation-missing', 'validation', 'completion requires source-stamped verified evidence');
  }
  if ((input.signals?.length ?? 0) > 0 && !authoritativeComplete) {
    issue(audit, 'warning', 'completion-validation-missing', 'signals', `advisory signals observed: ${input.signals?.join(', ')}`);
  }

  return { ...result(audit), authoritativeComplete };
}

export type ContinuityActiveStatus = 'active' | 'pending' | 'blocked' | 'complete' | 'superseded';

export interface ContinuityDeltaItem {
  readonly provenanceId: string;
  readonly sourceSequence: number;
  readonly sourceTimestamp: string;
  readonly status: ContinuityActiveStatus;
}

/** Latest provenance row wins; terminal rows suppress elder active copies. */
export function selectActiveContinuityDelta<T extends ContinuityDeltaItem>(
  items: readonly T[],
): T[] {
  const latest = new Map<string, T>();
  for (const item of items) {
    if (!item.provenanceId.trim() || !Number.isInteger(item.sourceSequence)) continue;
    const previous = latest.get(item.provenanceId);
    if (!previous
      || item.sourceSequence > previous.sourceSequence
      || (item.sourceSequence === previous.sourceSequence && item.sourceTimestamp > previous.sourceTimestamp)) {
      latest.set(item.provenanceId, item);
    }
  }
  return [...latest.values()]
    .filter((item) => item.status === 'active' || item.status === 'pending' || item.status === 'blocked')
    .sort((left, right) => left.sourceSequence - right.sourceSequence
      || left.provenanceId.localeCompare(right.provenanceId));
}

export interface ContinuityTakeoverActor {
  readonly kind: 'operator' | 'agent' | 'system';
  readonly id?: string;
}

export interface ContinuityTakeoverRecord {
  readonly provenanceId: string;
  readonly sourceTimestamp: string;
  readonly digest: string;
}

export interface ContinuityTakeoverClaim extends ContinuityTakeoverRecord {
  readonly path: string;
  readonly ownerInstanceId: string;
}

export interface ContinuityTakeoverSnapshot {
  readonly instance: {
    readonly instanceId: string;
    readonly parentInstanceId?: string | null;
    readonly replacesInstanceId?: string | null;
    readonly originEventId: string;
    readonly originSourceTimestamp: string;
    readonly createdBy: ContinuityTakeoverActor;
  };
  readonly rail?: {
    readonly railId: string;
    readonly ownerInstanceId: string;
    readonly creatorInstanceId: string;
    /** Digest excludes mutable owner/revision/takeover-history fields. */
    readonly contentDigest: string;
  };
  readonly claims: readonly ContinuityTakeoverClaim[];
  readonly blockers: readonly ContinuityTakeoverRecord[];
  readonly validation: readonly ContinuityTakeoverRecord[];
  readonly provenance: readonly ContinuityTakeoverRecord[];
}

export interface CloneTakeoverAuditInput {
  readonly source: ContinuityTakeoverSnapshot;
  readonly replacement: ContinuityTakeoverSnapshot;
  readonly expectedCreator: ContinuityTakeoverActor;
}

function actorEqual(left: ContinuityTakeoverActor, right: ContinuityTakeoverActor): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function auditTakeoverRecords(
  audit: MutableAudit,
  source: readonly ContinuityTakeoverRecord[],
  replacement: readonly ContinuityTakeoverRecord[],
  path: string,
): void {
  const sourceById = new Map(source.map((record) => [record.provenanceId, record]));
  const replacementById = new Map(replacement.map((record) => [record.provenanceId, record]));
  source.forEach((record, index) => {
    requireIdentity(audit, record.provenanceId, `${path}.source[${index}].provenanceId`);
    parseSourceTime(audit, record.sourceTimestamp, `${path}.source[${index}].sourceTimestamp`, true);
    const next = replacementById.get(record.provenanceId);
    if (!next) {
      issue(audit, 'error', 'takeover-record-missing', path, `replacement dropped ${record.provenanceId}`);
    } else if (record.digest !== next.digest || record.sourceTimestamp !== next.sourceTimestamp) {
      issue(audit, 'error', 'takeover-record-mutated', path, `replacement rewrote ${record.provenanceId}`);
    }
  });
  for (const record of replacement) {
    if (!sourceById.has(record.provenanceId)) {
      issue(audit, 'error', 'takeover-record-added', path, `replacement invented ${record.provenanceId} during takeover`);
    }
  }
}

/** Audit an exact clone-takeover boundary while allowing ownership to move. */
export function auditCloneTakeover(input: CloneTakeoverAuditInput): ContinuityAuditResult {
  const audit: MutableAudit = { errors: [], warnings: [] };
  const { source, replacement } = input;
  requireIdentity(audit, source.instance.instanceId, 'source.instance.instanceId');
  requireIdentity(audit, replacement.instance.instanceId, 'replacement.instance.instanceId');
  requireIdentity(audit, replacement.instance.originEventId, 'replacement.instance.originEventId');
  parseSourceTime(audit, replacement.instance.originSourceTimestamp, 'replacement.instance.originSourceTimestamp', true);

  if (source.instance.instanceId === replacement.instance.instanceId
    || replacement.instance.parentInstanceId !== source.instance.instanceId
    || replacement.instance.replacesInstanceId !== source.instance.instanceId) {
    issue(audit, 'error', 'takeover-lineage-invalid', 'replacement.instance', 'replacement must be a distinct child that explicitly replaces the source');
  }
  if (!actorEqual(replacement.instance.createdBy, input.expectedCreator)) {
    issue(audit, 'error', 'takeover-creator-mismatch', 'replacement.instance.createdBy', 'replacement creator role changed at takeover');
  }

  if (Boolean(source.rail) !== Boolean(replacement.rail)) {
    issue(audit, 'error', 'takeover-rail-missing', 'replacement.rail', 'replacement must preserve rail presence');
  } else if (source.rail && replacement.rail) {
    if (source.rail.railId !== replacement.rail.railId) {
      issue(audit, 'error', 'takeover-rail-identity-changed', 'replacement.rail.railId', 'rail stable identity changed');
    }
    if (source.rail.ownerInstanceId !== source.instance.instanceId
      || replacement.rail.ownerInstanceId !== replacement.instance.instanceId) {
      issue(audit, 'error', 'takeover-rail-owner-mismatch', 'replacement.rail.ownerInstanceId', 'rail ownership did not move from source to replacement');
    }
    if (source.rail.creatorInstanceId !== replacement.rail.creatorInstanceId) {
      issue(audit, 'error', 'takeover-rail-creator-changed', 'replacement.rail.creatorInstanceId', 'rail creator provenance must remain immutable');
    }
    if (source.rail.contentDigest !== replacement.rail.contentDigest) {
      issue(audit, 'error', 'takeover-rail-content-changed', 'replacement.rail.contentDigest', 'rail steps or state changed during takeover');
    }
  }

  auditTakeoverRecords(audit, source.blockers, replacement.blockers, 'blockers');
  auditTakeoverRecords(audit, source.validation, replacement.validation, 'validation');
  auditTakeoverRecords(audit, source.provenance, replacement.provenance, 'provenance');
  auditTakeoverRecords(audit, source.claims, replacement.claims, 'claims');

  const replacementClaims = new Map(replacement.claims.map((claim) => [claim.provenanceId, claim]));
  for (const claim of source.claims) {
    const next = replacementClaims.get(claim.provenanceId);
    if (next && (claim.path !== next.path || next.ownerInstanceId !== replacement.instance.instanceId)) {
      issue(audit, 'error', 'takeover-claim-owner-mismatch', 'replacement.claims', `claim ${claim.provenanceId} did not retain its path and move ownership`);
    }
  }

  return result(audit);
}
