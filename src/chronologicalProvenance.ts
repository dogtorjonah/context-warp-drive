/**
 * Universal chronological provenance for model-visible continuity artifacts.
 *
 * The compact text grammar makes prompt topology explicit: where source
 * material lived, when it was transformed, where exact raw history resumes,
 * and whether newer raw state overrides the synthesis. Pure CPU, no clocks,
 * no I/O, and no token estimates. Hosts must pass every coordinate they know;
 * unavailable coordinates remain visibly unknown.
 */
import { CHRONOLOGICAL_PROVENANCE_PREFIX, type FoldMessage } from './rollingFold.ts';

export type ChronologicalContentClass =
  | 'raw'
  | 'exact-excerpt'
  | 'synthesized-history'
  | 'retrieved-history'
  | 'reconstructed-state'
  | 'live-state'
  | 'boundary';

export type ChronologicalCoordinateUnit = 'event' | 'message' | 'row' | 'turn' | 'exchange';

export type LiveObjectiveConfidence = 'high' | 'medium' | 'unknown';
export type LiveObjectiveSource = 'operator-message' | 'mixed-transport-envelope' | 'active-rail' | 'none';

export interface ClassifiedLiveObjective {
  readonly text: string | null;
  readonly confidence: LiveObjectiveConfidence;
  readonly source: LiveObjectiveSource;
}

// These envelopes are relay/provider context, even when a transport serializes
// them inside a user-role message. Strip only named product-owned wrappers; an
// arbitrary XML block may be genuine operator content and must remain intact.
const OPERATOR_TRANSPORT_ENVELOPE_RE = /<(environment_context|permissions instructions|skills_instructions|apps_instructions|recommended_plugins|multi_agent_mode|temporal_context)(?:\s[^>]*)?>[\s\S]*?<\/\1>/giu;
const OPERATOR_AGENTS_ENVELOPE_RE = /# AGENTS\.md instructions for [^\n]*\n<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/giu;
const OPERATOR_INCOMPLETE_TRANSPORT_ENVELOPE_RE = /<(?:environment_context|permissions instructions|skills_instructions|apps_instructions|recommended_plugins|multi_agent_mode|temporal_context)(?:\s[^>]*)?>[\s\S]*$/giu;
const SYNTHETIC_OBJECTIVE_ARTIFACT_RE = /(?:\[CONTEXT REBIRTH\]|\[Context band \d+\s+—\s+tail-epoch fold\]|\[Epoch Continuity Capsule\]|artifact=tail-epoch#|\[User Message Vault\]|\[System Note: Context pressure limits)/u;
// Interrupt seam artifacts occupy an entire user row: the CLI's own
// "[Request interrupted by user…]" texts and relay-authored bracketed
// "[Relay note: …]" replacements. A row that is nothing but one of these
// (before or after envelope stripping) is a fold/interrupt artifact, never
// live operator intent — callers wanting the real ask must walk further back.
const INTERRUPT_ARTIFACT_WHOLE_TEXT_RE = /^(?:\[Request interrupted by user(?: for tool use)?\]|\[Relay note:[\s\S]*\])$/u;

/**
 * Distinguish operator-authored objective text from user-role transport
 * envelopes. A mixed row is usable at medium confidence after its known
 * envelopes are removed; a plain row is high confidence; synthetic-only input
 * stays explicitly unknown instead of being promoted into live intent.
 */
export function classifyOperatorAuthoredObjective(value: string | null | undefined): ClassifiedLiveObjective {
  const raw = value?.trim() ?? '';
  if (!raw) return { text: null, confidence: 'unknown', source: 'none' };
  if (SYNTHETIC_OBJECTIVE_ARTIFACT_RE.test(raw)) {
    return { text: null, confidence: 'unknown', source: 'none' };
  }

  let removedEnvelope = false;
  const strip = (input: string, pattern: RegExp): string => input.replace(pattern, () => {
    removedEnvelope = true;
    return '';
  });
  let text = strip(raw, OPERATOR_AGENTS_ENVELOPE_RE);
  text = strip(text, OPERATOR_TRANSPORT_ENVELOPE_RE);
  text = strip(text, OPERATOR_INCOMPLETE_TRANSPORT_ENVELOPE_RE).trim();
  if (!text || /^(?:<[^>]+>\s*)+$/u.test(text) || INTERRUPT_ARTIFACT_WHOLE_TEXT_RE.test(text)) {
    return { text: null, confidence: 'unknown', source: 'none' };
  }
  return {
    text,
    confidence: removedEnvelope ? 'medium' : 'high',
    source: removedEnvelope ? 'mixed-transport-envelope' : 'operator-message',
  };
}

export interface ChronologicalPoint {
  readonly traceId?: string;
  readonly unit: ChronologicalCoordinateUnit;
  readonly index?: number;
  readonly id?: string;
  /** Measured source timestamp. Never inferred from another coordinate. */
  readonly timestamp?: string;
}

export interface ChronologicalSpan {
  readonly start: ChronologicalPoint;
  /** Exclusive when numeric; the renderer prints `[start..end)`. */
  readonly endExclusive?: ChronologicalPoint;
  readonly count?: number;
  readonly lastTimestamp?: string;
}

export interface ChronologicalTopology {
  readonly host: 'dedicated-synthetic-message' | 'dedicated-band-message' | 'continuity-package' | 'embedded-message-suffix';
  readonly previous: 'frozen-prefix' | 'rebirth-seed' | 'raw-history' | 'unknown';
  readonly next: 'raw-tail' | 'later-band' | 'none' | 'unknown';
  readonly representation: 'canonical' | 'alias';
  readonly rawTailCount: number;
}

export interface ChronologicalProvenanceEnvelope {
  readonly artifact: string;
  readonly contentClass: ChronologicalContentClass;
  readonly source: ChronologicalSpan;
  readonly transformedAt: ChronologicalPoint;
  readonly rawResumesAt?: ChronologicalPoint;
  readonly authority: 'historical-background' | 'current-as-of-frontier' | 'live';
  readonly supersession: 'later-raw-wins' | 'none-known' | 'explicit';
  readonly supersededAt?: ChronologicalPoint;
  readonly topology: ChronologicalTopology;
  readonly liveObjective?: string;
  readonly liveObjectiveConfidence?: LiveObjectiveConfidence;
  readonly liveObjectiveSource?: LiveObjectiveSource;
  /**
   * Interrupted work at the seam: the in-flight tool + a brief argument
   * preview sourced from the exact resume row, so post-fold resumption is
   * zero-inference. Free-form bounded text; absent when nothing was pending.
   */
  readonly pendingIntent?: string;
}

export interface ChronologicalValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function validTimestamp(value: string | undefined): boolean {
  return value === undefined || (value.trim().length > 0 && Number.isFinite(Date.parse(value)));
}

function validatePoint(point: ChronologicalPoint, label: string, errors: string[]): void {
  if (point.index !== undefined && (!Number.isInteger(point.index) || point.index < 0)) {
    errors.push(`${label}.index`);
  }
  if (point.id !== undefined && point.id.trim().length === 0) errors.push(`${label}.id`);
  if (point.traceId !== undefined && point.traceId.trim().length === 0) errors.push(`${label}.traceId`);
  if (!validTimestamp(point.timestamp)) errors.push(`${label}.timestamp`);
}

export function validateChronologicalProvenance(
  envelope: ChronologicalProvenanceEnvelope,
): ChronologicalValidationResult {
  const errors: string[] = [];
  if (!envelope.artifact.trim()) errors.push('artifact');
  validatePoint(envelope.source.start, 'source.start', errors);
  validatePoint(envelope.transformedAt, 'transformedAt', errors);
  if (envelope.source.endExclusive) {
    validatePoint(envelope.source.endExclusive, 'source.endExclusive', errors);
    if (envelope.source.start.unit !== envelope.source.endExclusive.unit) errors.push('source.unit-mismatch');
    if ((envelope.source.start.traceId ?? '') !== (envelope.source.endExclusive.traceId ?? '')) {
      errors.push('source.trace-mismatch');
    }
    const start = envelope.source.start.index;
    const end = envelope.source.endExclusive.index;
    if (start !== undefined && end !== undefined && end < start) errors.push('source.reverse-range');
    if (start !== undefined && end !== undefined && envelope.source.count !== undefined
      && end - start !== envelope.source.count) errors.push('source.count-mismatch');
  }
  if (envelope.source.count !== undefined
    && (!Number.isInteger(envelope.source.count) || envelope.source.count < 0)) errors.push('source.count');
  if (!validTimestamp(envelope.source.lastTimestamp)) errors.push('source.lastTimestamp');
  if (!Number.isInteger(envelope.topology.rawTailCount) || envelope.topology.rawTailCount < 0) {
    errors.push('topology.rawTailCount');
  }
  if (envelope.rawResumesAt) validatePoint(envelope.rawResumesAt, 'rawResumesAt', errors);
  if (envelope.topology.rawTailCount > 0 && !envelope.rawResumesAt) errors.push('rawResumesAt.missing');
  if (envelope.topology.rawTailCount === 0 && envelope.rawResumesAt) errors.push('rawResumesAt.without-tail');
  if (envelope.supersession === 'explicit' && !envelope.supersededAt) errors.push('supersededAt.missing');
  if (envelope.supersededAt) validatePoint(envelope.supersededAt, 'supersededAt', errors);
  if (envelope.liveObjectiveConfidence && envelope.liveObjectiveConfidence !== 'unknown' && !envelope.liveObjective?.trim()) {
    errors.push('liveObjective.missing');
  }
  if (envelope.liveObjectiveSource && envelope.liveObjectiveSource !== 'none' && !envelope.liveObjective?.trim()) {
    errors.push('liveObjective.source-without-objective');
  }
  const end = envelope.source.endExclusive;
  const resume = envelope.rawResumesAt;
  if (end?.index !== undefined && resume?.index !== undefined
    && end.unit === resume.unit && (end.traceId ?? '') === (resume.traceId ?? '')
    && resume.index < end.index) errors.push('rawResumesAt.before-source-end');
  return { valid: errors.length === 0, errors };
}

function pointCoordinate(point: ChronologicalPoint): string {
  const trace = point.traceId?.trim() || '?';
  const ordinal = point.index !== undefined ? String(point.index) : point.id?.trim() || '?';
  return `${trace}:${point.unit}#${ordinal}`;
}

function pointTimestamp(point: ChronologicalPoint): string {
  return point.timestamp ? ` @ ${point.timestamp}` : '';
}

function sourceText(span: ChronologicalSpan): string {
  const start = pointCoordinate(span.start);
  const end = span.endExclusive ? pointCoordinate(span.endExclusive) : '?';
  const count = span.count !== undefined ? ` n=${span.count}` : '';
  const firstTime = span.start.timestamp;
  const lastTime = span.lastTimestamp ?? span.endExclusive?.timestamp;
  const time = firstTime || lastTime ? ` @ ${firstTime ?? '?'}..${lastTime ?? '?'}` : '';
  return `${start}..${end}${count}${time}`;
}

function boundedObjective(value: string | undefined, capChars = 300): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const bounded = normalized.length > capChars ? `${normalized.slice(0, capChars)}…` : normalized;
  return JSON.stringify(bounded);
}

function renderInvalidChronologicalProvenance(
  envelope: ChronologicalProvenanceEnvelope,
  errors: readonly string[],
): string {
  const artifact = envelope.artifact.replace(/\s+/g, '_').slice(0, 120) || 'unknown';
  return `${CHRONOLOGICAL_PROVENANCE_PREFIX} artifact=${artifact} class=${envelope.contentClass} provenance=invalid errors=${errors.join(',') || 'unknown'} authority=${envelope.authority} supersession=${envelope.supersession} topology=${envelope.topology.previous}>artifact>${envelope.topology.next} host=${envelope.topology.host} representation=${envelope.topology.representation} raw-resumes=unknown`;
}

/** Render the stable grammar; contradictory coordinates become an explicit invalid marker. */
export function renderChronologicalProvenance(
  envelope: ChronologicalProvenanceEnvelope,
): string | null {
  const validation = validateChronologicalProvenance(envelope);
  if (!validation.valid) return renderInvalidChronologicalProvenance(envelope, validation.errors);
  const objective = boundedObjective(envelope.liveObjective);
  const pendingIntent = boundedObjective(envelope.pendingIntent, 220);
  const objectiveAuthority = envelope.liveObjectiveConfidence
    ? `objective-confidence=${envelope.liveObjectiveConfidence} objective-source=${envelope.liveObjectiveSource ?? (objective ? 'operator-message' : 'none')}`
    : '';
  const rawFrontier = envelope.rawResumesAt
    ? `${pointCoordinate(envelope.rawResumesAt)}${pointTimestamp(envelope.rawResumesAt)} (${envelope.topology.rawTailCount} exact)`
    : `none (0 exact)`;
  const supersession = envelope.supersession === 'explicit' && envelope.supersededAt
    ? `explicit:${pointCoordinate(envelope.supersededAt)}`
    : envelope.supersession;
  return [
    CHRONOLOGICAL_PROVENANCE_PREFIX,
    `artifact=${envelope.artifact} class=${envelope.contentClass} authority=${envelope.authority} supersession=${supersession}`,
    `source=${sourceText(envelope.source)}`,
    `created=${pointCoordinate(envelope.transformedAt)}${pointTimestamp(envelope.transformedAt)}`,
    `topology=${envelope.topology.previous}>artifact>seam>${envelope.topology.next} host=${envelope.topology.host} representation=${envelope.topology.representation}`,
    `raw-resumes=${rawFrontier}`,
    objectiveAuthority,
    objective ? `live-objective=${objective}` : '',
    pendingIntent ? `pending-intent=${pendingIntent}` : '',
  ].filter(Boolean).join('\n');
}

/** Single-line form for repeated embedded artifacts such as recall cards. */
export function renderChronologicalProvenanceCompact(
  envelope: ChronologicalProvenanceEnvelope,
): string | null {
  const validation = validateChronologicalProvenance(envelope);
  if (!validation.valid) return renderInvalidChronologicalProvenance(envelope, validation.errors);
  const rawFrontier = envelope.rawResumesAt
    ? `${pointCoordinate(envelope.rawResumesAt)}(${envelope.topology.rawTailCount} exact)`
    : 'none';
  return `${CHRONOLOGICAL_PROVENANCE_PREFIX} artifact=${envelope.artifact} class=${envelope.contentClass} source=${sourceText(envelope.source)} created=${pointCoordinate(envelope.transformedAt)}${pointTimestamp(envelope.transformedAt)} authority=${envelope.authority} supersession=${envelope.supersession} topology=${envelope.topology.previous}>artifact>${envelope.topology.next} host=${envelope.topology.host} representation=${envelope.topology.representation} raw-resumes=${rawFrontier}`;
}

export interface TailEpochProvenanceInput {
  readonly traceId?: string;
  /**
   * Optional immutable coordinate frame for transports that rewrite/rebase
   * their provider transcript after every band. Numeric rows are comparable
   * only within this frame; canonical-history transports leave it unset.
   */
  readonly sourceFrameId?: string;
  readonly epoch: number;
  readonly unit: 'message' | 'row';
  readonly sourceStart: number;
  readonly sourceEndExclusive: number;
  readonly sourceFirstTimestamp?: string;
  readonly sourceLastTimestamp?: string;
  readonly committedAt: string;
  readonly rawTailCount: number;
  readonly rawResumeIndex?: number;
  readonly host: ChronologicalTopology['host'];
  readonly previous?: ChronologicalTopology['previous'];
  readonly liveObjective?: string;
  readonly liveObjectiveConfidence?: LiveObjectiveConfidence;
  readonly liveObjectiveSource?: LiveObjectiveSource;
  /** Interrupted tool + brief arg preview from the exact resume row (seam intent). */
  readonly pendingIntent?: string;
}

export interface TailEpochAliasProvenanceInput {
  readonly traceId?: string;
  readonly epoch: number;
  readonly rawTailCount: number;
}

/** Compact pointer used by transient boundary notices; the canonical row owns exact ranges. */
export function renderTailEpochAliasProvenance(
  input: TailEpochAliasProvenanceInput,
): string | null {
  const point = (id: string): ChronologicalPoint => ({ traceId: input.traceId, unit: 'event', id });
  return renderChronologicalProvenanceCompact({
    artifact: `tail-epoch#${input.epoch}`,
    contentClass: 'boundary',
    source: {
      start: point('canonical-source'),
      endExclusive: point('canonical-seam'),
    },
    transformedAt: point('canonical-seam'),
    ...(input.rawTailCount > 0 ? { rawResumesAt: point('this-message') } : {}),
    authority: 'historical-background',
    supersession: input.rawTailCount > 0 ? 'later-raw-wins' : 'none-known',
    topology: {
      host: 'embedded-message-suffix',
      previous: 'frozen-prefix',
      next: input.rawTailCount > 0 ? 'raw-tail' : 'none',
      representation: 'alias',
      rawTailCount: input.rawTailCount,
    },
  });
}

export interface ContinuityPackageProvenanceInput {
  readonly artifact: string;
  readonly traceId?: string;
  readonly sourceEventCount?: number;
  /** Exact raw rows that follow the package in the model-visible prompt. */
  readonly rawTailCount: number;
}

export interface EmbeddedContinuityArtifactProvenanceInput {
  readonly artifact: string;
  readonly contentClass: 'exact-excerpt' | 'synthesized-history';
  readonly traceId: string;
  readonly unit: 'message' | 'row';
  readonly sourceStart: number;
  readonly sourceEndExclusive: number;
  readonly sourceFirstTimestamp?: string;
  readonly sourceLastTimestamp?: string;
  readonly authority: 'historical-background' | 'current-as-of-frontier' | 'live';
  readonly previous?: ChronologicalTopology['previous'];
}

/**
 * Locate a compact excerpt/synthesis embedded inside another continuity
 * message. The enclosing epoch/package owns the global seam; this alias owns
 * its exact local source window so it cannot masquerade as a newer raw turn.
 */
export function renderEmbeddedContinuityArtifactProvenance(
  input: EmbeddedContinuityArtifactProvenanceInput,
): string | null {
  const point = (index: number, timestamp?: string): ChronologicalPoint => ({
    traceId: input.traceId,
    unit: input.unit,
    index,
    timestamp,
  });
  return renderChronologicalProvenanceCompact({
    artifact: input.artifact,
    contentClass: input.contentClass,
    source: {
      start: point(input.sourceStart, input.sourceFirstTimestamp),
      endExclusive: point(input.sourceEndExclusive),
      count: input.sourceEndExclusive - input.sourceStart,
      lastTimestamp: input.sourceLastTimestamp,
    },
    transformedAt: point(input.sourceEndExclusive),
    authority: input.authority,
    supersession: 'later-raw-wins',
    topology: {
      host: 'embedded-message-suffix',
      previous: input.previous ?? 'raw-history',
      next: 'none',
      representation: 'alias',
      rawTailCount: 0,
    },
  });
}

/**
 * Locate a rebirth/resurrection package against its persisted predecessor
 * trace and the exact live frontier that follows it. Hosts pass measured event
 * counts only; an unavailable count stays visibly unknown.
 */
export function renderContinuityPackageProvenance(
  input: ContinuityPackageProvenanceInput,
): string | null {
  const sourceEventCount = input.sourceEventCount !== undefined
    && Number.isInteger(input.sourceEventCount)
    && input.sourceEventCount >= 0
    ? input.sourceEventCount
    : undefined;
  const frontier: ChronologicalPoint = sourceEventCount !== undefined
    ? { traceId: input.traceId, unit: 'event', index: sourceEventCount }
    : { traceId: input.traceId, unit: 'event', id: 'live-frontier' };
  return renderChronologicalProvenance({
    artifact: input.artifact,
    contentClass: 'reconstructed-state',
    source: {
      start: { traceId: input.traceId, unit: 'event', index: sourceEventCount !== undefined ? 0 : undefined },
      endExclusive: frontier,
      ...(sourceEventCount !== undefined ? { count: sourceEventCount } : {}),
    },
    transformedAt: frontier,
    ...(input.rawTailCount > 0 ? { rawResumesAt: frontier } : {}),
    authority: 'current-as-of-frontier',
    supersession: input.rawTailCount > 0 ? 'later-raw-wins' : 'none-known',
    topology: {
      host: 'continuity-package',
      previous: 'raw-history',
      next: input.rawTailCount > 0 ? 'raw-tail' : 'none',
      representation: 'canonical',
      rawTailCount: input.rawTailCount,
    },
  });
}

function renderTailEpochStackOrientation(input: TailEpochProvenanceInput): string | null {
  if (!Number.isInteger(input.epoch) || input.epoch < 0
    || !Number.isInteger(input.sourceStart) || input.sourceStart < 0
    || !Number.isInteger(input.sourceEndExclusive) || input.sourceEndExclusive < input.sourceStart
    || !Number.isInteger(input.rawTailCount) || input.rawTailCount < 0
    || !validTimestamp(input.committedAt)
    || (input.rawTailCount > 0
      && (input.rawResumeIndex === undefined
        || !Number.isInteger(input.rawResumeIndex)
        || input.rawResumeIndex < input.sourceEndExclusive))) {
    return null;
  }
  const raw = input.rawTailCount > 0
    ? `raw-tail@${input.unit}#${input.rawResumeIndex}(+${input.rawTailCount})`
    : 'raw-tail:none';
  const frame = input.sourceFrameId ? ` frame=${input.sourceFrameId}` : '';
  return `stack=${input.previous ?? 'frozen-prefix'}>tail-epoch#${input.epoch}[${input.unit}:${input.sourceStart}..${input.sourceEndExclusive})>seam@${input.committedAt}>${raw}${frame}`;
}

export function renderTailEpochProvenance(input: TailEpochProvenanceInput): string | null {
  const sourceTraceId = input.sourceFrameId ?? input.traceId;
  const point = (index: number, timestamp?: string): ChronologicalPoint => ({
    traceId: sourceTraceId,
    unit: input.unit,
    index,
    timestamp,
  });
  const envelope: ChronologicalProvenanceEnvelope = {
    artifact: `tail-epoch#${input.epoch}`,
    contentClass: 'synthesized-history',
    source: {
      start: point(input.sourceStart, input.sourceFirstTimestamp),
      endExclusive: point(input.sourceEndExclusive),
      count: input.sourceEndExclusive - input.sourceStart,
      lastTimestamp: input.sourceLastTimestamp,
    },
    transformedAt: { traceId: input.traceId, unit: input.unit, timestamp: input.committedAt },
    ...(input.rawTailCount > 0 && input.rawResumeIndex !== undefined
      ? { rawResumesAt: point(input.rawResumeIndex) }
      : {}),
    authority: 'historical-background',
    supersession: input.rawTailCount > 0 ? 'later-raw-wins' : 'none-known',
    topology: {
      host: input.host,
      previous: input.previous ?? 'frozen-prefix',
      next: input.rawTailCount > 0 ? 'raw-tail' : 'none',
      representation: 'canonical',
      rawTailCount: input.rawTailCount,
    },
    liveObjective: input.liveObjective,
    liveObjectiveConfidence: input.liveObjectiveConfidence,
    liveObjectiveSource: input.liveObjectiveSource,
    pendingIntent: input.pendingIntent,
  };
  const rendered = renderChronologicalProvenance(envelope);
  const stack = renderTailEpochStackOrientation(input);
  if (!rendered || !stack || !validateChronologicalProvenance(envelope).valid) return rendered;
  const frame = input.sourceFrameId
    ? `coordinate-frame=${input.sourceFrameId} scope=pre-fold-snapshot comparable-within-frame-only`
    : '';
  return [rendered, frame, stack].filter(Boolean).join('\n');
}

/** Measured message timestamp bounds; absent timestamps remain absent. */
export function foldMessageTimestampBounds(messages: readonly FoldMessage[]): {
  firstTimestamp?: string;
  lastTimestamp?: string;
} {
  let first: number | undefined;
  let last: number | undefined;
  for (const message of messages) {
    if (typeof message.tsMs !== 'number' || !Number.isFinite(message.tsMs)) continue;
    if (first === undefined) first = message.tsMs;
    last = message.tsMs;
  }
  return {
    ...(first !== undefined ? { firstTimestamp: new Date(first).toISOString() } : {}),
    ...(last !== undefined ? { lastTimestamp: new Date(last).toISOString() } : {}),
  };
}

/** Append a dedicated relay-internal user message; never mutates source arrays. */
export function appendDedicatedChronologicalMessage<T extends FoldMessage>(
  view: readonly T[],
  provenance: string | null,
): T[] {
  if (!provenance) return view.slice();
  return view.concat({ role: 'user', content: provenance } as T);
}

interface ToolCoordinate {
  readonly id?: string;
  readonly name?: string;
}

function collectToolCoordinates(message: FoldMessage): {
  calls: ToolCoordinate[];
  results: ToolCoordinate[];
} {
  const calls: ToolCoordinate[] = [];
  const results: ToolCoordinate[] = [];
  const text = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim() ? value : undefined
  );
  const add = (target: ToolCoordinate[], id: unknown, name?: unknown): void => {
    const coordinate = { id: text(id), name: text(name) };
    if (coordinate.id || coordinate.name) target.push(coordinate);
  };
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const record = call as { id?: unknown; function?: { name?: unknown } } | null;
      add(calls, record?.id, record?.function?.name);
    }
  }
  add(results, message.tool_call_id);
  const collectParts = (parts: unknown): void => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const block = part as Record<string, unknown>;
      if (block.type === 'tool_use' || block.type === 'functionCall') add(calls, block.id, block.name);
      if (block.type === 'tool_result' || block.type === 'functionResponse') {
        add(results, block.tool_use_id ?? block.id, block.name);
      }
      const functionCall = block.functionCall;
      if (functionCall && typeof functionCall === 'object') {
        const call = functionCall as Record<string, unknown>;
        add(calls, call.id, call.name);
      }
      const functionResponse = block.functionResponse;
      if (functionResponse && typeof functionResponse === 'object') {
        const response = functionResponse as Record<string, unknown>;
        add(results, response.id, response.name);
      }
    }
  };
  collectParts(message.content);
  collectParts((message as FoldMessage & { parts?: unknown }).parts);
  return { calls, results };
}

/**
 * Move a proposed raw-tail split left when it would sever a completed tool
 * call/result pair or fold away a call that still has no result. Repeats to
 * closure for parallel or nested calls.
 */
export function selectPairingSafeRawTailStart(
  messages: readonly FoldMessage[],
  proposedStart: number,
): number {
  let start = Math.max(0, Math.min(messages.length, Math.floor(proposedStart)));
  const indexedCalls: Array<{ index: number; coordinate: ToolCoordinate; resolvedAt?: number }> = [];
  const pending: typeof indexedCalls = [];
  for (let index = 0; index < messages.length; index += 1) {
    const coordinates = collectToolCoordinates(messages[index]);
    for (const coordinate of coordinates.calls) {
      const call = { index, coordinate };
      indexedCalls.push(call);
      pending.push(call);
    }
    for (const result of coordinates.results) {
      let match = result.id
        ? pending.findIndex((call) => call.coordinate.id === result.id)
        : -1;
      if (match < 0 && result.name) {
        match = pending.findIndex((call) => call.coordinate.name === result.name);
      }
      if (match < 0) continue;
      pending[match].resolvedAt = index;
      pending.splice(match, 1);
    }
  }
  for (;;) {
    let moved = start;
    for (const call of indexedCalls) {
      if (call.index >= start) continue;
      if (call.resolvedAt === undefined || call.resolvedAt >= start) {
        moved = Math.min(moved, call.index);
      }
    }
    if (moved === start) return start;
    start = moved;
  }
}
