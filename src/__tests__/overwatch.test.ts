import { describe, it, expect } from 'vitest';

import {
  governByTrace,
  breakevenAllowsShrink,
  classifyToolClass,
  glyphFromMessage,
  DEFAULT_OVERWATCH_CONFIG,
  type TraceToken,
  type OverwatchGlyph,
  type RailAck,
  type OverwatchToolClass,
} from '../overwatch.ts';

// ── tiny builders ─────────────────────────────────────────────────────────────

function msg(glyph: OverwatchGlyph): TraceToken {
  return { kind: 'msg', glyph };
}
function tool(toolClass: OverwatchToolClass, opts?: { paths?: string[]; ack?: RailAck }): TraceToken {
  return { kind: 'tool', toolClass, pathArgs: opts?.paths, railAck: opts?.ack };
}
function repeat(token: TraceToken, n: number): TraceToken[] {
  return Array.from({ length: n }, () => token);
}

const HEALTHY = { measuredTokens: 60_000, windowTokens: 200_000 }; // ~0.30 utilization
const CRITICAL = { measuredTokens: 170_000, windowTokens: 200_000 }; // 0.85 utilization

describe('classifyToolClass', () => {
  it('maps tool names to families and treats task_rail as ambient rail', () => {
    expect(classifyToolClass('read_file')).toBe('read');
    expect(classifyToolClass('atlas_query')).toBe('search');
    expect(classifyToolClass('edit_file')).toBe('edit');
    expect(classifyToolClass('write_file')).toBe('write');
    expect(classifyToolClass('run_bash')).toBe('bash');
    expect(classifyToolClass('git_diff')).toBe('git');
    expect(classifyToolClass('scoped-vitest')).toBe('test');
    expect(classifyToolClass('focused-typecheck')).toBe('test');
    expect(classifyToolClass('pm2_logs')).toBe('logs');
    expect(classifyToolClass('task_rail')).toBe('rail');
    expect(classifyToolClass('chatroom')).toBe('chat');
    expect(classifyToolClass('tap_instance_messages')).toBe('recall');
    expect(classifyToolClass(undefined)).toBe('other');
  });
});

describe('glyphFromMessage', () => {
  it('parses register glyphs via the shared glyphs.ts parser', () => {
    expect(glyphFromMessage('🔍 investigating')).toBe('working');
    expect(glyphFromMessage('▶ applying patch')).toBe('executing');
    expect(glyphFromMessage('▶️ running tests')).toBe('executing');
    expect(glyphFromMessage('🏁 Verdict: done')).toBe('verdict');
    expect(glyphFromMessage('⚠️ hazard ahead')).toBe('hazard');
    expect(glyphFromMessage('❓ blocked on input')).toBe('blocked');
  });
  it('returns undefined for non-compliant messages (fail-open)', () => {
    expect(glyphFromMessage('no glyph here')).toBeUndefined();
    expect(glyphFromMessage('')).toBeUndefined();
  });
});

describe('governByTrace — (a) task_rail interleaved in a review span', () => {
  it('does not flip the flavor off review when rail acks interleave', () => {
    // A reviewer: working span, reading + diffing + acking rail steps + testing.
    const window: TraceToken[] = [
      msg('working'),
      tool('read', { paths: ['src/a.ts'] }),
      tool('git', { paths: ['src/a.ts'] }),
      tool('rail', { ack: 'needs_review' }),
      tool('test'),
      tool('rail', { ack: 'done' }),
      tool('git'),
    ];
    const d = governByTrace(window, HEALTHY, 160_000);
    // Old engine: last tool git_diff is fine, but a task_rail ack would have
    // classified handoff. Here the histogram over the whole span wins.
    expect(d.flavor).toBe('review');
    expect(d.marathon).toBe(false);
    // review gets the wider recall aperture.
    expect(d.recall.maxCards).toBe(3);
    expect(d.recall.maxTotalChars).toBe(16_000);
  });

  it('a bare task_rail ack as the last tool still classifies review, not handoff', () => {
    const window: TraceToken[] = [
      msg('working'),
      tool('git'),
      tool('test'),
      tool('rail', { ack: 'needs_review' }), // last tool is the rail ack
    ];
    const d = governByTrace(window, HEALTHY, 160_000);
    expect(d.flavor).toBe('review');
  });
});

describe('governByTrace — (b) marathon decays the stale front glyph', () => {
  it('lets the histogram own the decision and holds the band', () => {
    const window: TraceToken[] = [
      msg('verdict'),
      ...repeat(tool('edit', { paths: ['src/impl.ts'] }), 20),
    ];
    const d = governByTrace(window, HEALTHY, 170_000);
    expect(d.marathon).toBe(true);
    expect(d.flavor).toBe('marathon');
    // front verdict is 20 tool ticks stale → impulse decayed to ~0.
    expect(d.impulses.tighten).toBeLessThan(0.001);
    // a near-zero tighten cannot clear breakeven → band held.
    expect(d.bandTokens).toBe(170_000);
    // marathon → epoch freeze (hot tail filling).
    expect(d.freeze.action).toBe('epoch');
  });
});

describe('governByTrace — (c) verdict tighten gated by breakeven', () => {
  it('breakevenAllowsShrink matches the 170k→80k ~9-hit derivation', () => {
    // writePremium = 1.25*80k - 0.1*170k = 100k - 17k = 83k; savings/hit = 9k.
    expect(breakevenAllowsShrink(170_000, 80_000, 10)).toBe(true); // 90k ≥ 83k
    expect(breakevenAllowsShrink(170_000, 80_000, 9)).toBe(false); // 81k < 83k
  });

  it('vetoes a timid shrink (ΔN too small) at realistic hit counts', () => {
    expect(breakevenAllowsShrink(170_000, 168_000, 9)).toBe(false);
  });

  it('a cosmetic re-fold with no shrink is always vetoed (ΔN→0 ⇒ ∞ breakeven)', () => {
    expect(breakevenAllowsShrink(170_000, 170_000, 1_000_000)).toBe(false);
  });

  it('commits a band shrink when a fresh verdict closes a long implementation span', () => {
    // 90 edits, then a verdict, then one edit → recent strong verdict + long tail.
    const window: TraceToken[] = [
      ...repeat(tool('edit', { paths: ['src/impl.ts'] }), 90),
      msg('verdict'),
      tool('edit', { paths: ['src/impl.ts'] }),
    ];
    const d = governByTrace(window, HEALTHY, 170_000);
    expect(d.marathon).toBe(false); // only 1 tool tick since the verdict
    expect(d.impulses.tighten).toBeGreaterThan(0.1);
    expect(d.bandTokens).not.toBeNull();
    expect(d.bandTokens!).toBeLessThan(170_000); // breakeven cleared by the long tail
    expect(d.freeze.action).toBe('epoch');
  });

  it('prefers measured hot-reuse evidence over the trace-length proxy when present', () => {
    const window: TraceToken[] = [
      ...repeat(tool('edit', { paths: ['src/impl.ts'] }), 90),
      msg('verdict'),
      tool('edit', { paths: ['src/impl.ts'] }),
    ];

    const quiet = governByTrace(window, { ...HEALTHY, cache: { hotReuses: 0, epochs: 7 } }, 170_000);
    expect(quiet.bandTokens).toBe(170_000);
    expect(quiet.derivation.some((line) => line.includes('measured hotReuses=0 epochs=7'))).toBe(true);

    const hot = governByTrace(window, { ...HEALTHY, cache: { hotReuses: 100, epochs: 7 } }, 170_000);
    expect(hot.bandTokens).not.toBeNull();
    expect(hot.bandTokens!).toBeLessThan(170_000);
    expect(hot.derivation.some((line) => line.includes('measured hotReuses=100 epochs=7'))).toBe(true);
  });
});

describe('governByTrace — (d) blocked glyph widens recall', () => {
  it('opens the recall aperture when the agent declares it is blocked', () => {
    const window: TraceToken[] = [msg('blocked'), tool('read', { paths: ['src/x.ts'] })];
    const d = governByTrace(window, HEALTHY, 160_000);
    expect(d.impulses.widenRecall).toBeGreaterThan(0);
    expect(d.recall.maxCards).toBe(4);
    expect(d.recall.maxTotalChars).toBe(24_000);
  });

  it('also widens recall on observed thrash even without a blocked glyph', () => {
    // read a path, leave the window for >=3 ticks, re-read it → thrash.
    const window: TraceToken[] = [
      tool('read', { paths: ['src/lost.ts'] }),
      tool('search'),
      tool('search'),
      tool('search'),
      tool('read', { paths: ['src/lost.ts'] }),
    ];
    const d = governByTrace(window, HEALTHY, 160_000);
    expect(d.signals.thrash).toBeGreaterThan(0);
    expect(d.recall.maxCards).toBe(4);
  });
});

describe('governByTrace — executing glyph holds the burst runway', () => {
  it('treats executing as implementation runway: hold band and modestly widen recall', () => {
    const window: TraceToken[] = [
      msg('executing'),
      tool('edit', { paths: ['src/impl.ts'] }),
      tool('test'),
    ];
    const d = governByTrace(window, HEALTHY, 160_000);
    expect(d.glyphsPresent).toBe(true);
    expect(d.impulses.hold).toBeGreaterThan(0);
    expect(d.bandTokens).toBe(160_000);
    expect(d.recall.maxCards).toBe(3);
    expect(d.recall.maxTotalChars).toBe(16_000);
    expect(d.derivation).toContain('recall: executing → 3 cards / 16k');
    expect(d.derivation.some((line) => line.startsWith('band: executing hold'))).toBe(true);
  });

  it('uses executing to veto an otherwise fresh verdict shrink, but critical pressure still wins', () => {
    const window: TraceToken[] = [
      ...repeat(tool('edit', { paths: ['src/impl.ts'] }), 90),
      msg('verdict'),
      msg('executing'),
      tool('edit', { paths: ['src/impl.ts'] }),
    ];

    const healthy = governByTrace(window, HEALTHY, 170_000);
    expect(healthy.impulses.tighten).toBeGreaterThan(0);
    expect(healthy.impulses.hold).toBeGreaterThan(0);
    expect(healthy.bandTokens).toBe(170_000);
    expect(healthy.freeze.action).toBe('defer');

    const critical = governByTrace(window, CRITICAL, 170_000);
    expect(critical.bandTokens).toBe(DEFAULT_OVERWATCH_CONFIG.defaults.pressureBandTokens);
    expect(critical.recall.maxCards).toBe(1);
    expect(critical.freeze.action).toBe('epoch');
  });

  it('lets a fresh verdict shrink after a stale executing glyph decays below the hold threshold', () => {
    const window: TraceToken[] = [
      msg('executing'),
      ...repeat(tool('edit', { paths: ['src/impl.ts'] }), 90),
      msg('verdict'),
      tool('edit', { paths: ['src/impl.ts'] }),
    ];

    const d = governByTrace(window, HEALTHY, 170_000);
    expect(d.impulses.tighten).toBeGreaterThan(0.1);
    expect(d.impulses.hold).toBe(0);
    expect(d.bandTokens).not.toBeNull();
    expect(d.bandTokens!).toBeLessThan(170_000);
    expect(d.freeze.action).toBe('epoch');
    expect(d.derivation.some((line) => line.includes('below 0.1 threshold'))).toBe(true);
  });
});

describe('governByTrace — (e) fail-open with zero glyphs', () => {
  it('falls back to the histogram floor and holds the prior band', () => {
    const window: TraceToken[] = [
      tool('read', { paths: ['src/a.ts'] }),
      tool('search'),
    ];
    const d = governByTrace(window, HEALTHY, 150_000);
    expect(d.glyphsPresent).toBe(false);
    expect(d.flavor).toBe('investigation');
    expect(d.impulses.tighten).toBe(0);
    expect(d.recall.maxCards).toBe(DEFAULT_OVERWATCH_CONFIG.defaults.recallCards);
    expect(d.bandTokens).toBe(150_000); // held, not clamped to a starvation default
  });

  it('an empty window is a generous planning default, never a clamp', () => {
    const d = governByTrace([], HEALTHY, 150_000);
    expect(d.flavor).toBe('planning');
    expect(d.bandTokens).toBe(150_000);
  });
});

describe('governByTrace — (f) cadence damping under a verdict streak', () => {
  it('a lone fresh verdict produces more tighten than a verdict streak', () => {
    const lone = governByTrace([msg('working'), msg('working'), msg('verdict')], HEALTHY, 160_000);
    const streak = governByTrace([msg('verdict'), msg('verdict'), msg('verdict')], HEALTHY, 160_000);
    expect(lone.impulses.tighten).toBeGreaterThan(streak.impulses.tighten);
  });
});

describe('governByTrace — hard pressure overrides everything', () => {
  it('shrinks toward the pressure floor and narrows recall under critical pressure', () => {
    const window: TraceToken[] = [msg('working'), tool('read')];
    const d = governByTrace(window, CRITICAL, 170_000);
    expect(d.pressure.level).toBe('critical');
    expect(d.bandTokens).toBe(DEFAULT_OVERWATCH_CONFIG.defaults.pressureBandTokens);
    expect(d.recall.maxCards).toBe(1);
    expect(d.freeze.action).toBe('epoch');
  });
});

describe('governByTrace — derivation is always populated', () => {
  it('emits a readable derivation trail for trust/audit', () => {
    const d = governByTrace([msg('verdict'), tool('edit', { paths: ['x.ts'] })], HEALTHY, 160_000);
    expect(Array.isArray(d.derivation)).toBe(true);
    expect(d.derivation.length).toBeGreaterThan(0);
    expect(d.derivation.some((line) => line.startsWith('pressure='))).toBe(true);
    expect(d.derivation.some((line) => line.startsWith('flavor='))).toBe(true);
  });
});
