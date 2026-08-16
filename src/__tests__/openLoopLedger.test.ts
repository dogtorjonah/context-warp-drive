import { describe, expect, it } from 'vitest';

import {
  buildOpenLoopLedgerSection,
  classifyOpenLoopStates,
  OPEN_LOOP_LEDGER_ENTRY_MAX_CHARS,
  OPEN_LOOP_LEDGER_MAX_ENTRIES,
  renderOpenLoopLedger,
  type OpenLoopCandidate,
} from '../openLoopLedger.ts';

const blocked = (text: string): OpenLoopCandidate => ({ text, basis: 'blocked-register' });
const pending = (text: string, settled = false): OpenLoopCandidate => ({ text, basis: 'pending-action', settled });

describe('classifyOpenLoopStates', () => {
  it('keeps blocked-register items blocked and pending actions active by default', () => {
    const entries = classifyOpenLoopStates([blocked('a'), pending('b')], []);
    expect(entries.map((e) => e.state)).toEqual(['blocked', 'active']);
  });

  it('supersedes everything non-done when the latest directive is a redirect', () => {
    const entries = classifyOpenLoopStates(
      [blocked('a'), pending('b'), pending('c', true)],
      ['Never mind, do this instead'],
    );
    expect(entries.map((e) => e.state)).toEqual(['superseded', 'superseded', 'done']);
  });

  it('pauses active entries but leaves blocked ones blocked on a detour marker', () => {
    const entries = classifyOpenLoopStates([blocked('a'), pending('b')], ['Wait, before you continue…']);
    expect(entries.map((e) => e.state)).toEqual(['blocked', 'paused-by-user']);
  });

  it('latest directive wins: supersede beats pause when both appear', () => {
    const pauseThenRedirect = classifyOpenLoopStates(
      [pending('a')],
      ['Actually do the other thing instead', 'Wait a second'],
    );
    expect(pauseThenRedirect[0]?.state).toBe('superseded');
    const redirectThenPause = classifyOpenLoopStates([pending('a')], ['Wait a second', 'Actually do the other thing instead']);
    expect(redirectThenPause[0]?.state).toBe('paused-by-user');
  });
});

describe('renderOpenLoopLedger', () => {
  it('renders states, caps entries, and notes omissions', () => {
    const entries = Array.from({ length: OPEN_LOOP_LEDGER_MAX_ENTRIES + 3 }, (_, i) => ({
      text: `loop ${i}`,
      state: 'blocked' as const,
    }));
    const rendered = renderOpenLoopLedger(entries);
    expect(rendered).toContain('[Open Loop Ledger — heuristic states');
    expect(rendered?.split('\n').filter((l) => l.startsWith('- [blocked]'))).toHaveLength(OPEN_LOOP_LEDGER_MAX_ENTRIES);
    expect(rendered).toContain('(3 older omitted)');
    expect(renderOpenLoopLedger([], 10)).toBeNull();
    expect(renderOpenLoopLedger([{ text: 'x', state: 'active' }], 0)).toBeNull();
  });

  it('truncates long entries with an ellipsis', () => {
    const rendered = renderOpenLoopLedger([{ text: 'x'.repeat(500), state: 'active' }], 10, OPEN_LOOP_LEDGER_ENTRY_MAX_CHARS);
    expect(rendered?.split('\n')[1]?.endsWith('…')).toBe(true);
  });
});

describe('buildOpenLoopLedgerSection', () => {
  it('parses the blocked trail, skips headers, and classifies against operator texts', () => {
    const trail = [
      '## Open Questions — your own ❓ blocked-register trail',
      '[assistant msg 12] ❓ blocked on auth',
      '[assistant msg 40] ❓ blocked on deploy',
    ].join('\n');
    const section = buildOpenLoopLedgerSection({
      operatorTexts: ['Never mind, we changed plans'],
      blockedTrailText: trail,
    });
    expect(section).toContain('- [superseded] [assistant msg 12]');
    expect(section).toContain('- [superseded] [assistant msg 40]');
    expect(section).not.toContain('## Open Questions');
  });

  it('returns null when there is no blocked trail content', () => {
    expect(buildOpenLoopLedgerSection({ operatorTexts: [], blockedTrailText: '' })).toBeNull();
    expect(buildOpenLoopLedgerSection({ operatorTexts: [], blockedTrailText: '## only a header' })).toBeNull();
  });
});
