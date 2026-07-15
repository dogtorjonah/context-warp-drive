/**
 * Universal chronological provenance for model-visible continuity artifacts.
 *
 * The compact text grammar makes prompt topology explicit: where source
 * material lived, when it was transformed, where exact raw history resumes,
 * and whether newer raw state overrides the synthesis. Pure CPU, no clocks,
 * no I/O, and no token estimates. Hosts must pass every coordinate they know;
 * unavailable coordinates remain visibly unknown.
 */
import { CHRONOLOGICAL_PROVENANCE_PREFIX } from './rollingFold.ts';
function validTimestamp(value) {
    return value === undefined || (value.trim().length > 0 && Number.isFinite(Date.parse(value)));
}
function validatePoint(point, label, errors) {
    if (point.index !== undefined && (!Number.isInteger(point.index) || point.index < 0)) {
        errors.push(`${label}.index`);
    }
    if (point.id !== undefined && point.id.trim().length === 0)
        errors.push(`${label}.id`);
    if (point.traceId !== undefined && point.traceId.trim().length === 0)
        errors.push(`${label}.traceId`);
    if (!validTimestamp(point.timestamp))
        errors.push(`${label}.timestamp`);
}
export function validateChronologicalProvenance(envelope) {
    const errors = [];
    if (!envelope.artifact.trim())
        errors.push('artifact');
    validatePoint(envelope.source.start, 'source.start', errors);
    validatePoint(envelope.transformedAt, 'transformedAt', errors);
    if (envelope.source.endExclusive) {
        validatePoint(envelope.source.endExclusive, 'source.endExclusive', errors);
        if (envelope.source.start.unit !== envelope.source.endExclusive.unit)
            errors.push('source.unit-mismatch');
        if ((envelope.source.start.traceId ?? '') !== (envelope.source.endExclusive.traceId ?? '')) {
            errors.push('source.trace-mismatch');
        }
        const start = envelope.source.start.index;
        const end = envelope.source.endExclusive.index;
        if (start !== undefined && end !== undefined && end < start)
            errors.push('source.reverse-range');
        if (start !== undefined && end !== undefined && envelope.source.count !== undefined
            && end - start !== envelope.source.count)
            errors.push('source.count-mismatch');
    }
    if (envelope.source.count !== undefined
        && (!Number.isInteger(envelope.source.count) || envelope.source.count < 0))
        errors.push('source.count');
    if (!validTimestamp(envelope.source.lastTimestamp))
        errors.push('source.lastTimestamp');
    if (!Number.isInteger(envelope.topology.rawTailCount) || envelope.topology.rawTailCount < 0) {
        errors.push('topology.rawTailCount');
    }
    if (envelope.rawResumesAt)
        validatePoint(envelope.rawResumesAt, 'rawResumesAt', errors);
    if (envelope.topology.rawTailCount > 0 && !envelope.rawResumesAt)
        errors.push('rawResumesAt.missing');
    if (envelope.topology.rawTailCount === 0 && envelope.rawResumesAt)
        errors.push('rawResumesAt.without-tail');
    if (envelope.supersession === 'explicit' && !envelope.supersededAt)
        errors.push('supersededAt.missing');
    if (envelope.supersededAt)
        validatePoint(envelope.supersededAt, 'supersededAt', errors);
    const end = envelope.source.endExclusive;
    const resume = envelope.rawResumesAt;
    if (end?.index !== undefined && resume?.index !== undefined
        && end.unit === resume.unit && (end.traceId ?? '') === (resume.traceId ?? '')
        && resume.index < end.index)
        errors.push('rawResumesAt.before-source-end');
    return { valid: errors.length === 0, errors };
}
function pointCoordinate(point) {
    const trace = point.traceId?.trim() || '?';
    const ordinal = point.index !== undefined ? String(point.index) : point.id?.trim() || '?';
    return `${trace}:${point.unit}#${ordinal}`;
}
function pointTimestamp(point) {
    return point.timestamp ? ` @ ${point.timestamp}` : '';
}
function sourceText(span) {
    const start = pointCoordinate(span.start);
    const end = span.endExclusive ? pointCoordinate(span.endExclusive) : '?';
    const count = span.count !== undefined ? ` n=${span.count}` : '';
    const firstTime = span.start.timestamp;
    const lastTime = span.lastTimestamp ?? span.endExclusive?.timestamp;
    const time = firstTime || lastTime ? ` @ ${firstTime ?? '?'}..${lastTime ?? '?'}` : '';
    return `${start}..${end}${count}${time}`;
}
function boundedObjective(value) {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    if (!normalized)
        return undefined;
    const bounded = normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized;
    return JSON.stringify(bounded);
}
function renderInvalidChronologicalProvenance(envelope, errors) {
    const artifact = envelope.artifact.replace(/\s+/g, '_').slice(0, 120) || 'unknown';
    return `${CHRONOLOGICAL_PROVENANCE_PREFIX} artifact=${artifact} class=${envelope.contentClass} provenance=invalid errors=${errors.join(',') || 'unknown'} authority=${envelope.authority} supersession=${envelope.supersession} topology=${envelope.topology.previous}>artifact>${envelope.topology.next} host=${envelope.topology.host} representation=${envelope.topology.representation} raw-resumes=unknown`;
}
/** Render the stable grammar; contradictory coordinates become an explicit invalid marker. */
export function renderChronologicalProvenance(envelope) {
    const validation = validateChronologicalProvenance(envelope);
    if (!validation.valid)
        return renderInvalidChronologicalProvenance(envelope, validation.errors);
    const objective = boundedObjective(envelope.liveObjective);
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
        objective ? `live-objective=${objective}` : '',
    ].filter(Boolean).join('\n');
}
/** Single-line form for repeated embedded artifacts such as recall cards. */
export function renderChronologicalProvenanceCompact(envelope) {
    const validation = validateChronologicalProvenance(envelope);
    if (!validation.valid)
        return renderInvalidChronologicalProvenance(envelope, validation.errors);
    const rawFrontier = envelope.rawResumesAt
        ? `${pointCoordinate(envelope.rawResumesAt)}(${envelope.topology.rawTailCount} exact)`
        : 'none';
    return `${CHRONOLOGICAL_PROVENANCE_PREFIX} artifact=${envelope.artifact} class=${envelope.contentClass} source=${sourceText(envelope.source)} created=${pointCoordinate(envelope.transformedAt)}${pointTimestamp(envelope.transformedAt)} authority=${envelope.authority} supersession=${envelope.supersession} topology=${envelope.topology.previous}>artifact>${envelope.topology.next} host=${envelope.topology.host} representation=${envelope.topology.representation} raw-resumes=${rawFrontier}`;
}
/** Compact pointer used by transient boundary notices; the canonical row owns exact ranges. */
export function renderTailEpochAliasProvenance(input) {
    const point = (id) => ({ traceId: input.traceId, unit: 'event', id });
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
/**
 * Locate a compact excerpt/synthesis embedded inside another continuity
 * message. The enclosing epoch/package owns the global seam; this alias owns
 * its exact local source window so it cannot masquerade as a newer raw turn.
 */
export function renderEmbeddedContinuityArtifactProvenance(input) {
    const point = (index, timestamp) => ({
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
export function renderContinuityPackageProvenance(input) {
    const sourceEventCount = input.sourceEventCount !== undefined
        && Number.isInteger(input.sourceEventCount)
        && input.sourceEventCount >= 0
        ? input.sourceEventCount
        : undefined;
    const frontier = sourceEventCount !== undefined
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
function renderTailEpochStackOrientation(input) {
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
    return `stack=${input.previous ?? 'frozen-prefix'}>tail-epoch#${input.epoch}[${input.unit}:${input.sourceStart}..${input.sourceEndExclusive})>seam@${input.committedAt}>${raw}`;
}
export function renderTailEpochProvenance(input) {
    const point = (index, timestamp) => ({
        traceId: input.traceId,
        unit: input.unit,
        index,
        timestamp,
    });
    const envelope = {
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
    };
    const rendered = renderChronologicalProvenance(envelope);
    const stack = renderTailEpochStackOrientation(input);
    if (!rendered || !stack || !validateChronologicalProvenance(envelope).valid)
        return rendered;
    return `${rendered}\n${stack}`;
}
/** Measured message timestamp bounds; absent timestamps remain absent. */
export function foldMessageTimestampBounds(messages) {
    let first;
    let last;
    for (const message of messages) {
        if (typeof message.tsMs !== 'number' || !Number.isFinite(message.tsMs))
            continue;
        if (first === undefined)
            first = message.tsMs;
        last = message.tsMs;
    }
    return {
        ...(first !== undefined ? { firstTimestamp: new Date(first).toISOString() } : {}),
        ...(last !== undefined ? { lastTimestamp: new Date(last).toISOString() } : {}),
    };
}
/** Append a dedicated relay-internal user message; never mutates source arrays. */
export function appendDedicatedChronologicalMessage(view, provenance) {
    if (!provenance)
        return view.slice();
    return view.concat({ role: 'user', content: provenance });
}
function collectToolCoordinates(message) {
    const calls = [];
    const results = [];
    const text = (value) => (typeof value === 'string' && value.trim() ? value : undefined);
    const add = (target, id, name) => {
        const coordinate = { id: text(id), name: text(name) };
        if (coordinate.id || coordinate.name)
            target.push(coordinate);
    };
    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            const record = call;
            add(calls, record?.id, record?.function?.name);
        }
    }
    add(results, message.tool_call_id);
    const collectParts = (parts) => {
        if (!Array.isArray(parts))
            return;
        for (const part of parts) {
            if (!part || typeof part !== 'object')
                continue;
            const block = part;
            if (block.type === 'tool_use' || block.type === 'functionCall')
                add(calls, block.id, block.name);
            if (block.type === 'tool_result' || block.type === 'functionResponse') {
                add(results, block.tool_use_id ?? block.id, block.name);
            }
            const functionCall = block.functionCall;
            if (functionCall && typeof functionCall === 'object') {
                const call = functionCall;
                add(calls, call.id, call.name);
            }
            const functionResponse = block.functionResponse;
            if (functionResponse && typeof functionResponse === 'object') {
                const response = functionResponse;
                add(results, response.id, response.name);
            }
        }
    };
    collectParts(message.content);
    collectParts(message.parts);
    return { calls, results };
}
/**
 * Move a proposed raw-tail split left when it would sever a completed tool
 * call/result pair or fold away a call that still has no result. Repeats to
 * closure for parallel or nested calls.
 */
export function selectPairingSafeRawTailStart(messages, proposedStart) {
    let start = Math.max(0, Math.min(messages.length, Math.floor(proposedStart)));
    const indexedCalls = [];
    const pending = [];
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
            if (match < 0)
                continue;
            pending[match].resolvedAt = index;
            pending.splice(match, 1);
        }
    }
    for (;;) {
        let moved = start;
        for (const call of indexedCalls) {
            if (call.index >= start)
                continue;
            if (call.resolvedAt === undefined || call.resolvedAt >= start) {
                moved = Math.min(moved, call.index);
            }
        }
        if (moved === start)
            return start;
        start = moved;
    }
}
//# sourceMappingURL=chronologicalProvenance.js.map