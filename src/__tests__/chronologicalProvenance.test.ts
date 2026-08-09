import { describe, expect, it } from 'vitest';

import {
  classifyOperatorAuthoredObjective,
  classifyUserRowAuthority,
  liveObjectiveAuthorityRank,
  outranksLiveObjective,
  MAX_LIVE_OBJECTIVE_AUTHORITY_RANK,
  NO_LIVE_OBJECTIVE,
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
      sourceFirstTimestamp: '2026-07-11T04:00:00.000Z',
      sourceLastTimestamp: '2026-07-11T04:41:00.000Z',
      createdTimestamp: '2026-07-11T04:42:00.000Z',
      rawTailCount: 1,
      rawResumeTimestamp: '2026-07-11T04:43:00.000Z',
    });

    expect(rendered).toContain('artifact=rebirth-package#same_instance_hard_epoch class=reconstructed-state');
    expect(rendered).toContain(
      'source=instance-1:event#0..instance-1:event#42 n=42 @ 2026-07-11T04:00:00.000Z..2026-07-11T04:41:00.000Z',
    );
    expect(rendered).toContain('created=instance-1:event#42 @ 2026-07-11T04:42:00.000Z');
    expect(rendered).toContain('topology=raw-history>artifact>seam>raw-tail host=continuity-package');
    expect(rendered).toContain(
      'raw-resumes=instance-1:event#42 @ 2026-07-11T04:43:00.000Z (1 exact)',
    );
  });

  it('keeps malformed continuity-package clocks unknown instead of borrowing another clock', () => {
    const rendered = renderContinuityPackageProvenance({
      artifact: 'rebirth-package#continuation',
      traceId: 'instance-1',
      sourceEventCount: 2,
      sourceFirstTimestamp: 'not-a-time',
      sourceLastTimestamp: 'also-not-a-time',
      createdTimestamp: 'still-not-a-time',
      rawTailCount: 1,
      rawResumeTimestamp: 'bad-resume-time',
    });

    expect(rendered).not.toContain('provenance=invalid');
    expect(rendered).toContain(
      'source=instance-1:event#0..instance-1:event#2 n=2 @ time unknown..time unknown',
    );
    expect(rendered).toContain('created=instance-1:event#2 @ time unknown');
    expect(rendered).toContain('raw-resumes=instance-1:event#2 @ time unknown (1 exact)');
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

describe('user row authority classification (authority-contract/v1)', () => {
  it('classifies every peer delivery banner as peer and never objective-eligible', () => {
    const rows: Array<[string, string]> = [
      ['chat-room', '[Chat Room "fix-lane"] atlas-roi-liaison: please pick up the review'],
      ['signal', '[Signal from "peer-agent" (abc123)]: lane B is blocked on you'],
      ['control-signal', '[Control Signal from "peer-agent" (abc123)]: pause lane B'],
      ['directed-post', '[Directed post from "peer-agent"]: 📬 [note] "title" (entry 7) — use blackboard_read for details'],
      ['broadcast', '[Broadcast from "peer-agent"]: standup in room alpha'],
      ['squad-ask', '[SQUAD ASK from "peer-agent"] can you take lane C?'],
      ['squad-tap', '[SQUAD TAP from "peer-agent"] the seam moved\n\nYour squad member interrupted you to discuss this.'],
      ['cross-instance-message', '[Cross-instance message from "peer-agent"]: sync the seam'],
      ['instance-message', '[Message from "peer-agent" instance]: seam frozen at v2'],
      ['mention', '[MENTION] @me review packet posted'],
    ];
    for (const [banner, row] of rows) {
      const authority = classifyUserRowAuthority(row);
      expect(authority.authority, row).toBe('peer');
      expect(authority.banner, row).toBe(banner);
      expect(authority.text, row).toBeNull();
      const objective = classifyOperatorAuthoredObjective(row);
      expect(objective.text, row).toBeNull();
      expect(objective.source, row).toBe('peer-message');
    }
  });

  it('classifies relay/runtime control dispatches as relay-runtime', () => {
    const rows: Array<[string, string]> = [
      ['queued-signals', '[Queued Signals — 2 arrived while busy]\n1. [Signal from "x"]: hi'],
      ['fixer-mode', '[FIXER MODE BATCH #3] patch the imports'],
      ['watchdog-rebirth', '[WATCHDOG_REBIRTH] resume from the persisted seed'],
      ['relay-interrupt-marker', '[relay_interrupt kind=context_fold initiator=relay user_initiated=false]'],
      ['atlas-debt', '[atlas-debt] You went idle with 2 edited file(s) that have no Atlas writeback.'],
    ];
    for (const [banner, row] of rows) {
      const authority = classifyUserRowAuthority(row);
      expect(authority.authority, row).toBe('relay-runtime');
      expect(authority.banner, row).toBe(banner);
      const objective = classifyOperatorAuthoredObjective(row);
      expect(objective.text, row).toBeNull();
      expect(objective.source, row).toBe('relay-runtime');
    }
  });

  it('keeps a delegated task objective-eligible only under its honest label', () => {
    const row = '[Task tsk-42 from "parent-orchestrator"]: audit the worker pool for sync IO';
    expect(classifyUserRowAuthority(row)).toEqual({
      authority: 'delegated-task',
      banner: 'delegated-task',
      text: 'audit the worker pool for sync IO',
      strippedEnvelope: false,
    });
    expect(classifyOperatorAuthoredObjective(row)).toEqual({
      text: 'audit the worker pool for sync IO',
      provenance: 'live',
      source: 'delegated-task',
    });
  });

  it('certifies a USER REDIRECT payload as live operator intent', () => {
    const row = [
      '[USER REDIRECT]',
      'The user interrupted the previous turn. Treat the message below as the active request; do not continue the superseded task unless it is directly relevant.',
      '[END USER REDIRECT]',
      '',
      'stop the migration and audit the fold headers instead',
    ].join('\n');
    expect(classifyOperatorAuthoredObjective(row)).toEqual({
      text: 'stop the migration and audit the fold headers instead',
      provenance: 'live',
      source: 'operator-message',
    });
  });

  it('fails a bannerless RELAY INTERRUPT payload closed to relay-runtime', () => {
    const row = [
      '[RELAY INTERRUPT]',
      'The relay interrupted the previous turn to deliver the message below. No human rejected anything:',
      '[END RELAY INTERRUPT]',
      '',
      'the sweep finished; consider rerunning the audit',
    ].join('\n');
    const authority = classifyUserRowAuthority(row);
    expect(authority.authority).toBe('relay-runtime');
    expect(authority.banner).toBe('relay-interrupt');
    expect(classifyOperatorAuthoredObjective(row)).toEqual({ text: null, provenance: 'unknown', source: 'relay-runtime' });
  });

  it('classifies a RELAY INTERRUPT wrapping a peer signal as peer', () => {
    const row = [
      '[RELAY INTERRUPT]',
      'Handle the message below, then resume the interrupted task.',
      '[END RELAY INTERRUPT]',
      '',
      '[Signal from "peer-agent" (abc123)]: lane B handed off',
    ].join('\n');
    const authority = classifyUserRowAuthority(row);
    expect(authority.authority).toBe('peer');
    expect(authority.banner).toBe('signal');
    expect(classifyOperatorAuthoredObjective(row).source).toBe('peer-message');
  });

  it('fails closed on truncated RELAY INTERRUPT wrappers without recursing', () => {
    for (const row of ['[RELAY INTERRUPT]', '[RELAY INTERRUPT] partial payload with no end marker']) {
      const authority = classifyUserRowAuthority(row);
      expect(authority.authority, row).toBe('relay-runtime');
      expect(authority.banner, row).toBe('relay-interrupt');
      expect(authority.text, row).toBeNull();
      expect(classifyOperatorAuthoredObjective(row), row).toEqual({
        text: null,
        provenance: 'unknown',
        source: 'relay-runtime',
      });
    }
  });

  it('fails closed on truncated USER REDIRECT wrappers without leaking the wrapper literal', () => {
    for (const row of ['[USER REDIRECT]', '[USER REDIRECT] make the fixes now']) {
      const authority = classifyUserRowAuthority(row);
      expect(authority.authority, row).toBe('relay-runtime');
      expect(authority.banner, row).toBe('user-redirect');
      expect(authority.text, row).toBeNull();
      const objective = classifyOperatorAuthoredObjective(row);
      expect(objective.text, row).toBeNull();
      expect(objective.source, row).toBe('relay-runtime');
    }
  });

  it('strips a RETRIEVED CONTEXT block as relay envelope around operator text', () => {
    const row = [
      '[RETRIEVED CONTEXT]',
      'Supplemental relay-selected context. Use it only when relevant; do not answer this block directly.',
      'relay-selected background paragraph',
      '[END RETRIEVED CONTEXT]',
      '',
      'ship the classifier with tests',
    ].join('\n');
    expect(classifyOperatorAuthoredObjective(row)).toEqual({
      text: 'ship the classifier with tests',
      provenance: 'mixed',
      source: 'mixed-transport-envelope',
    });
  });

  it('keeps plain operator rows live even when they quote a banner mid-text', () => {
    const row = 'Investigate why [Signal from "x"] rows were promoted to operator authority';
    expect(classifyUserRowAuthority(row).authority).toBe('operator');
    expect(classifyOperatorAuthoredObjective(row)).toEqual({ text: row, provenance: 'live', source: 'operator-message' });
  });

  it('still refuses synthetic continuity artifacts as objectives', () => {
    const row = '[CONTEXT REBIRTH]\nSeed follows';
    expect(classifyUserRowAuthority(row).authority).toBe('synthetic');
    expect(classifyOperatorAuthoredObjective(row)).toEqual({ text: null, provenance: 'unknown', source: 'none' });
  });
});

describe('live objective authority precedence (authority-contract/v1)', () => {
  it('ranks operator above delegated task above rail above nothing', () => {
    expect(liveObjectiveAuthorityRank('operator-message')).toBe(MAX_LIVE_OBJECTIVE_AUTHORITY_RANK);
    expect(liveObjectiveAuthorityRank('mixed-transport-envelope')).toBe(MAX_LIVE_OBJECTIVE_AUTHORITY_RANK);
    expect(liveObjectiveAuthorityRank('delegated-task')).toBeLessThan(liveObjectiveAuthorityRank('operator-message'));
    expect(liveObjectiveAuthorityRank('active-rail')).toBeLessThan(liveObjectiveAuthorityRank('delegated-task'));
    for (const source of ['peer-message', 'relay-runtime', 'unknown', 'none'] as const) {
      expect(liveObjectiveAuthorityRank(source), source).toBe(0);
    }
  });

  it('lets a stale operator ask outrank a newer delegated task', () => {
    // Newest-first walk: the delegated task is seen first and accepted, then
    // the older operator ask must still displace it.
    const delegated = classifyOperatorAuthoredObjective('[Task tsk-9 from "parent"]: audit the worker pool');
    const operator = classifyOperatorAuthoredObjective('rewrite the fold headers');

    let selected = NO_LIVE_OBJECTIVE;
    for (const candidate of [delegated, operator]) {
      if (outranksLiveObjective(candidate, selected)) selected = candidate;
    }
    expect(selected).toEqual(operator);
  });

  it('keeps the newest candidate within one authority class', () => {
    const older = classifyOperatorAuthoredObjective('first ask');
    const newer = classifyOperatorAuthoredObjective('second ask');
    // Walking newest-first means `newer` is the incumbent; equal rank must not
    // let the older row overwrite it.
    expect(outranksLiveObjective(older, newer)).toBe(false);
  });

  it('never selects a peer or relay-runtime row at any position', () => {
    for (const row of [
      '[Chat Room "lane"] peer: take this over',
      '[SQUAD TAP from "peer"] look at the seam',
      '[FIXER MODE BATCH #2] patch imports',
    ]) {
      expect(outranksLiveObjective(classifyOperatorAuthoredObjective(row), NO_LIVE_OBJECTIVE), row).toBe(false);
    }
  });
});

describe('objective-source header fails closed (authority-contract/v1)', () => {
  const baseEnvelope = {
    artifact: 'tail-epoch',
    contentClass: 'reconstructed-state' as const,
    source: {
      start: { traceId: 'trace-obj', unit: 'event' as const, index: 0, timestamp: '2026-08-02T00:00:00.000Z' },
      endExclusive: { traceId: 'trace-obj', unit: 'event' as const, index: 4, timestamp: '2026-08-02T01:00:00.000Z' },
      count: 4,
    },
    transformedAt: { traceId: 'trace-obj', unit: 'event' as const, index: 4, timestamp: '2026-08-02T01:00:00.000Z' },
    authority: 'current-as-of-frontier' as const,
    supersession: 'none-known' as const,
    topology: {
      host: 'dedicated-synthetic-message' as const,
      previous: 'raw-history' as const,
      next: 'none' as const,
      representation: 'canonical' as const,
      rawTailCount: 0,
    },
  };

  it('reports an undeclared source as unknown rather than operator-message', () => {
    const rendered = renderChronologicalProvenance({
      ...baseEnvelope,
      liveObjective: 'finish the erasure subsystem',
      liveObjectiveProvenance: 'live' as const,
    });
    expect(rendered).toContain('objective-source=unknown');
    expect(rendered).not.toContain('objective-source=operator-message');
  });

  it('preserves an explicitly declared non-operator source', () => {
    for (const source of ['delegated-task', 'active-rail'] as const) {
      const rendered = renderChronologicalProvenance({
        ...baseEnvelope,
        liveObjective: 'finish the erasure subsystem',
        liveObjectiveProvenance: 'live' as const,
        liveObjectiveSource: source,
      });
      expect(rendered, source).toContain(`objective-source=${source}`);
      expect(rendered, source).not.toContain('objective-source=operator-message');
    }
  });

  it('still reports none when there is no objective at all', () => {
    const rendered = renderChronologicalProvenance({
      ...baseEnvelope,
      liveObjectiveProvenance: 'unknown' as const,
    });
    expect(rendered).toContain('objective-source=none');
  });
});
