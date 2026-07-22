import { describe, expect, it } from 'vitest';

import {
  renderContinuityPackageProvenance,
  renderChronologicalProvenance,
  renderChronologicalProvenanceCompact,
  renderTailEpochAliasProvenance,
  renderTailEpochProvenance,
  resolveChronologicalPointToSourceRow,
  selectPairingSafeRawTailStart,
} from '../chronologicalProvenance.ts';
import { isSyntheticContextText, type FoldMessage } from '../rollingFold.ts';

describe('chronological provenance', () => {
  it('resolves a coordinate only when source row identity and time agree', () => {
    const sourceRow = { role: 'assistant', content: 'source row' };
    const rows = [{
      row: sourceRow,
      sourceIdentity: 'instance-a:event#17',
      sourceTimestamp: '2026-07-21T22:00:00.000Z',
    }];
    const point = {
      unit: 'message' as const,
      index: 0,
      id: 'instance-a:event#17',
      timestamp: '2026-07-21T22:00:00.000Z',
    };

    expect(resolveChronologicalPointToSourceRow(point, rows)).toEqual({
      row: sourceRow,
      rowIndex: 0,
      sourceIdentity: 'instance-a:event#17',
      sourceTimestamp: '2026-07-21T22:00:00.000Z',
    });
    expect(resolveChronologicalPointToSourceRow(
      { ...point, id: 'instance-b:event#17' },
      rows,
    )).toBeNull();
    expect(resolveChronologicalPointToSourceRow(
      { ...point, timestamp: '2026-07-21T22:00:01.000Z' },
      rows,
    )).toBeNull();
    expect(resolveChronologicalPointToSourceRow(
      { ...point, index: 99 },
      rows,
    )).toBeNull();
    expect(resolveChronologicalPointToSourceRow(
      { ...point, timestamp: 'not-a-source-time' },
      rows,
    )).toBeNull();
    expect(resolveChronologicalPointToSourceRow(
      { unit: 'message', id: 'instance-a:event#17' },
      [...rows, rows[0]!],
    )).toBeNull();
  });

  it('renders every missing source time explicitly without borrowing another clock', () => {
    const envelope = {
      artifact: 'timeless-recall',
      contentClass: 'retrieved-history' as const,
      source: {
        start: { traceId: 'trace-time', unit: 'event' as const, index: 2 },
        endExclusive: { traceId: 'trace-time', unit: 'event' as const, index: 5 },
        count: 3,
      },
      transformedAt: { traceId: 'trace-time', unit: 'event' as const, index: 8 },
      rawResumesAt: { traceId: 'trace-time', unit: 'event' as const, index: 5 },
      authority: 'historical-background' as const,
      supersession: 'explicit' as const,
      supersededAt: { traceId: 'trace-time', unit: 'event' as const, index: 9 },
      topology: {
        host: 'dedicated-synthetic-message' as const,
        previous: 'raw-history' as const,
        next: 'raw-tail' as const,
        representation: 'canonical' as const,
        rawTailCount: 3,
      },
    };

    for (const rendered of [
      renderChronologicalProvenance(envelope),
      renderChronologicalProvenanceCompact(envelope),
    ]) {
      expect(rendered).toContain(
        'source=trace-time:event#2..trace-time:event#5 n=3 @ time unknown..time unknown',
      );
      expect(rendered).toContain('created=trace-time:event#8 @ time unknown');
      expect(rendered).toContain('supersession=explicit:trace-time:event#9 @ time unknown');
      expect(rendered).toContain('raw-resumes=trace-time:event#5 @ time unknown');
    }

    const partial = renderChronologicalProvenance({
      ...envelope,
      source: {
        ...envelope.source,
        start: { ...envelope.source.start, timestamp: '2026-07-20T08:00:00.000Z' },
      },
    });
    expect(partial).toContain(
      'source=trace-time:event#2..trace-time:event#5 n=3 @ 2026-07-20T08:00:00.000Z..time unknown',
    );
    expect(partial).not.toContain('2026-07-20T08:00:00.000Z..2026-07-20T08:00:00.000Z');
  });

  it('renders source, transformation, authority, topology, and exact raw resumption', () => {
    const rendered = renderTailEpochProvenance({
      traceId: 'instance-1',
      epoch: 3,
      unit: 'message',
      sourceStart: 12,
      sourceEndExclusive: 18,
      sourceFirstTimestamp: '2026-07-11T04:00:00.000Z',
      sourceLastTimestamp: '2026-07-11T04:05:00.000Z',
      committedAt: '2026-07-11T04:06:00.000Z',
      rawTailCount: 4,
      rawResumeIndex: 18,
      host: 'dedicated-synthetic-message',
      liveObjective: 'finish the chronology work',
    });

    expect(rendered).toContain('[Chronological Provenance v1]');
    expect(rendered).toContain('artifact=tail-epoch#3 class=synthesized-history authority=historical-background supersession=later-raw-wins');
    expect(rendered).toContain('source=instance-1:message#12..instance-1:message#18 n=6');
    expect(rendered).toContain('created=instance-1:message#? @ 2026-07-11T04:06:00.000Z');
    expect(rendered).toContain('topology=frozen-prefix>artifact>seam>raw-tail host=dedicated-synthetic-message representation=canonical');
    expect(rendered).toContain('raw-resumes=instance-1:message#18 @ time unknown (4 exact)');
    expect(rendered).toContain(
      'stack=frozen-prefix>tail-epoch#3[message:12..18)>seam@2026-07-11T04:06:00.000Z>raw-tail@message#18(+4)',
    );
    expect(isSyntheticContextText(rendered as string)).toBe(true);
  });

  it('fails visibly on contradictory ranges instead of fabricating coordinates', () => {
    const reverseRange = renderTailEpochProvenance({
      epoch: 1,
      unit: 'row',
      sourceStart: 9,
      sourceEndExclusive: 3,
      committedAt: '2026-07-11T04:06:00.000Z',
      rawTailCount: 0,
      host: 'dedicated-band-message',
    });
    expect(reverseRange).toContain('provenance=invalid errors=source.reverse-range,source.count');
    expect(reverseRange).toContain('raw-resumes=unknown');

    const contradictory = renderChronologicalProvenance({
      artifact: 'recall#1',
      contentClass: 'retrieved-history',
      source: {
        start: { traceId: 'a', unit: 'event', index: 1 },
        endExclusive: { traceId: 'b', unit: 'event', index: 2 },
      },
      transformedAt: { traceId: 'a', unit: 'event', timestamp: 'not-a-time' },
      authority: 'historical-background',
      supersession: 'later-raw-wins',
      topology: {
        host: 'dedicated-synthetic-message',
        previous: 'raw-history',
        next: 'raw-tail',
        representation: 'canonical',
        rawTailCount: 1,
      },
    });
    expect(contradictory).toContain('provenance=invalid');
    expect(contradictory).toContain('source.trace-mismatch');
    expect(contradictory).toContain('transformedAt.timestamp');
    expect(contradictory).toContain('rawResumesAt.missing');
  });

  it('locates a reconstructed continuity package before its exact live frontier', () => {
    const rendered = renderContinuityPackageProvenance({
      artifact: 'rebirth-package#same_instance_hard_epoch',
      traceId: 'instance-1',
      sourceEventCount: 42,
      rawTailCount: 1,
    });

    expect(rendered).toContain('artifact=rebirth-package#same_instance_hard_epoch class=reconstructed-state');
    expect(rendered).toContain('source=instance-1:event#0..instance-1:event#42 n=42');
    expect(rendered).toContain('created=instance-1:event#42');
    expect(rendered).toContain('topology=raw-history>artifact>seam>raw-tail host=continuity-package');
    expect(rendered).toContain('raw-resumes=instance-1:event#42 @ time unknown (1 exact)');
  });

  it('makes a transient boundary notice an explicit alias of the canonical epoch', () => {
    const rendered = renderTailEpochAliasProvenance({
      traceId: 'instance-1',
      epoch: 4,
      rawTailCount: 2,
    });

    expect(rendered).toContain('artifact=tail-epoch#4 class=boundary');
    expect(rendered).toContain('source=instance-1:event#canonical-source..instance-1:event#canonical-seam');
    expect(rendered).toContain('host=embedded-message-suffix representation=alias');
    expect(rendered).toContain('raw-resumes=instance-1:event#this-message @ time unknown(2 exact)');
  });

  it('moves a raw-tail boundary left rather than orphaning a tool result', () => {
    const messages: FoldMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function' }] },
      { role: 'tool', content: 'result', tool_call_id: 'call-1' },
      { role: 'assistant', content: 'continue' },
    ];
    expect(selectPairingSafeRawTailStart(messages, 1)).toBe(0);
    expect(selectPairingSafeRawTailStart(messages, 2)).toBe(2);
  });

  it('keeps unresolved and parallel tool calls raw until every result arrives', () => {
    const unresolved: FoldMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-open', type: 'function' }] },
      { role: 'assistant', content: 'waiting for the tool' },
    ];
    expect(selectPairingSafeRawTailStart(unresolved, 1)).toBe(0);

    const parallel: FoldMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-done', type: 'function' },
          { id: 'call-open', type: 'function' },
        ],
      },
      { role: 'tool', content: 'first result', tool_call_id: 'call-done' },
      { role: 'assistant', content: 'continue' },
    ];
    expect(selectPairingSafeRawTailStart(parallel, 2)).toBe(0);

    const complete = parallel.concat({ role: 'tool', content: 'second result', tool_call_id: 'call-open' });
    expect(selectPairingSafeRawTailStart(complete, 3)).toBe(0);
    expect(selectPairingSafeRawTailStart(complete, 4)).toBe(4);
  });

  it('recognizes native Gemini functionCall/functionResponse coordinates', () => {
    const call = {
      role: 'model',
      content: null,
      parts: [{ functionCall: { name: 'read_file', id: 'gemini-open', args: { path: '/tmp/a.ts' } } }],
    } as FoldMessage;
    const response = {
      role: 'user',
      content: null,
      parts: [{ functionResponse: { name: 'read_file', id: 'gemini-open', response: { result: 'ok' } } }],
    } as FoldMessage;

    expect(selectPairingSafeRawTailStart([call], 1)).toBe(0);
    expect(selectPairingSafeRawTailStart([call, response], 1)).toBe(0);
    expect(selectPairingSafeRawTailStart([call, response], 2)).toBe(2);
  });

  it('pairs Gemini responses by name when only the response carries an id', () => {
    const call = {
      role: 'model',
      content: null,
      parts: [{ functionCall: { name: 'read_file', args: { path: '/tmp/a.ts' } } }],
    } as FoldMessage;
    const response = {
      role: 'user',
      content: null,
      parts: [{ functionResponse: { id: 'gemini-generated-id', name: 'read_file', response: { result: 'ok' } } }],
    } as FoldMessage;

    expect(selectPairingSafeRawTailStart([call, response], 2)).toBe(2);
  });

  it('does not let one Gemini response resolve two same-name calls', () => {
    const call = (path: string): FoldMessage => ({
      role: 'model',
      content: null,
      parts: [{ functionCall: { name: 'read_file', args: { path } } }],
    }) as FoldMessage;
    const response = {
      role: 'user',
      content: null,
      parts: [{ functionResponse: { id: 'only-one-result', name: 'read_file', response: { result: 'ok' } } }],
    } as FoldMessage;
    const messages = [call('/tmp/a.ts'), call('/tmp/b.ts'), response];

    expect(selectPairingSafeRawTailStart(messages, messages.length)).toBe(0);
  });

  it('renders one bounded current-stack line without replaying earlier bands', () => {
    const first = renderTailEpochProvenance({
      epoch: 1,
      unit: 'row',
      sourceStart: 0,
      sourceEndExclusive: 10,
      committedAt: '2026-07-11T04:00:00.000Z',
      rawTailCount: 2,
      rawResumeIndex: 10,
      host: 'dedicated-band-message',
    }) as string;
    const later = renderTailEpochProvenance({
      epoch: 27,
      unit: 'row',
      sourceStart: 900,
      sourceEndExclusive: 940,
      committedAt: '2026-07-11T05:00:00.000Z',
      rawTailCount: 3,
      rawResumeIndex: 940,
      host: 'dedicated-band-message',
    }) as string;
    const stackLines = (value: string) => value.split('\n').filter((line) => line.startsWith('stack='));
    expect(stackLines(first)).toHaveLength(1);
    expect(stackLines(later)).toEqual([
      'stack=frozen-prefix>tail-epoch#27[row:900..940)>seam@2026-07-11T05:00:00.000Z>raw-tail@row#940(+3)',
    ]);
    expect(stackLines(later)[0]).not.toContain('tail-epoch#1');
  });
});
