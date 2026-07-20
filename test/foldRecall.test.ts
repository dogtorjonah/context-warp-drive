import { describe, expect, test } from 'vitest';

import {
  buildFoldRecallContext,
  buildFoldIndex,
  blendScores,
  createFoldRecallState,
  distanceToBooster,
  deriveBoundaryRecallSignals,
  DEFAULT_FOLD_RECALL_CONFIG,
  excerptForRecall,
  extractActiveWindowText,
  extractPathsFromBashCommand,
  extractRecallSignals,
  findToolResultText,
  foldRecallProviderPovText,
  normalizeFoldRecallPovText,
  planRecall,
  repeatCardBudgetRatio,
  REPEAT_CARD_MIN_RATIO,
  REPEAT_CARD_SHRINK_RATIO,
  resolveFoldRecallConfig,
  stripRecallBlocks,
  type FoldRecallConfig,
  type FoldRecallIndex,
  type IntraTurnIndexEntry,
  type InterTurnIndexEntry,
} from '../src/foldRecall.ts';
import {
  ALWAYS_ON_FOLD_CONFIG,
  ALWAYS_ON_INTRA_FOLD_CONFIG,
  checkFoldTrigger,
  detectTurns,
  foldContext,
  intraTurnFold,
  planActiveTurnStepFold,
  RECALL_CARD_PREFIX,
  RECALL_HINT_PREFIX,
  type FoldMessage,
} from '../src/rollingFold.ts';

// ── Helpers ──

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

function anthropicToolUse(id: string, name: string, input: Record<string, unknown>): FoldMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function anthropicToolResult(toolUseId: string, content: string): FoldMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] };
}

function openaiToolCall(id: string, name: string, args: Record<string, unknown>): FoldMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function openaiToolResult(callId: string, content: string): FoldMessage {
  return { role: 'tool', content, tool_call_id: callId };
}

const ABS = (rel: string) => `/home/jonah/my-monorepo/${rel}`;
const BIGFILE = 'relay/src/bigfile.ts';
const BIGFILE_CONTENT = 'BIGFILE CONTENT START ' + 'x'.repeat(3_000) + ' BIGFILE CONTENT END';

/**
 * Two-turn Anthropic history shaped so the real pipeline folds both detected
 * turns under the continuous-fold contract. The intra-only view still pages out
 * helper0/helper1, which keeps intra-turn recall covered explicitly below.
 */
function buildAnthropicHistory(): FoldMessage[] {
  const msgs: FoldMessage[] = [];
  msgs.push(userMsg('Please investigate bigfile.ts'));
  msgs.push(anthropicToolUse('tu_big', 'Read', { file_path: ABS(BIGFILE) }));
  msgs.push(anthropicToolResult('tu_big', BIGFILE_CONTENT));
  msgs.push(assistantMsg('Found the bug in bigfile.ts — the handler ignores null inputs because of a legacy guard.'));
  msgs.push(userMsg('Now check all the helpers'));
  for (let i = 0; i < 7; i++) {
    msgs.push(anthropicToolUse(`tu_h${i}`, 'Read', { file_path: ABS(`relay/src/helper${i}.ts`) }));
    msgs.push(anthropicToolResult(`tu_h${i}`, `HELPER${i} BODY ` + 'y'.repeat(2_500)));
  }
  msgs.push(assistantMsg('Helpers reviewed.'));
  return msgs;
}

/** The real compaction pipeline as fcBaseSession runs it (fold mode 'on'). */
function runPipeline(raw: FoldMessage[]): FoldMessage[] {
  const intra = intraTurnFold(raw, ALWAYS_ON_INTRA_FOLD_CONFIG);
  const trigger = checkFoldTrigger(intra.messages, ALWAYS_ON_FOLD_CONFIG);
  if (!trigger.shouldFold) return intra.messages;
  return foldContext(intra.messages, trigger.turnsToFold, ALWAYS_ON_FOLD_CONFIG).messages;
}

function indexFor(raw: FoldMessage[]): FoldRecallIndex {
  return buildFoldIndex(raw, runPipeline(raw));
}

function intraOnlyIndexFor(raw: FoldMessage[]): FoldRecallIndex {
  return buildFoldIndex(raw, intraTurnFold(raw, ALWAYS_ON_INTRA_FOLD_CONFIG).messages);
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ══════════════════════════════════════════════════════════════════════
// Index construction (page table)
// ══════════════════════════════════════════════════════════════════════

describe('buildFoldIndex', () => {
  test('replays every marker-folded turn from the real continuous-fold pipeline', () => {
    const raw = buildAnthropicHistory();
    const index = indexFor(raw);

    const turnEntries = index.entries.filter((e): e is InterTurnIndexEntry => e.kind === 'turn');
    const toolEntries = index.entries.filter((e): e is IntraTurnIndexEntry => e.kind === 'tool');

    expect(turnEntries).toHaveLength(2);
    expect(turnEntries[0].rawStart).toBe(0);
    expect(turnEntries[0].rawEnd).toBe(4);
    expect(turnEntries[0].category).toBe('research');
    expect(turnEntries[0].paths).toEqual([BIGFILE]);
    expect(turnEntries[0].chars).toBeGreaterThan(3_000);
    expect(turnEntries[0].digest).toContain('bigfile');
    expect(turnEntries[1].paths).toEqual([
      'relay/src/helper0.ts',
      'relay/src/helper1.ts',
      'relay/src/helper2.ts',
      'relay/src/helper3.ts',
      'relay/src/helper4.ts',
      'relay/src/helper5.ts',
      'relay/src/helper6.ts',
    ]);
    expect(toolEntries).toHaveLength(0);

    expect(index.rawCount).toBe(raw.length);
  });

  test('scans intra-fold markers when no inter-turn fold block is present', () => {
    const raw = buildAnthropicHistory();
    const index = intraOnlyIndexFor(raw);

    const turnEntries = index.entries.filter((e): e is InterTurnIndexEntry => e.kind === 'turn');
    const toolEntries = index.entries.filter((e): e is IntraTurnIndexEntry => e.kind === 'tool');

    expect(turnEntries).toHaveLength(0);
    expect(toolEntries).toHaveLength(2);
    expect(toolEntries.map(e => e.toolId).sort()).toEqual(['tu_h0', 'tu_h1']);
    for (const e of toolEntries) {
      expect(e.tool).toBe('Read');
      expect(e.path).toMatch(/^relay\/src\/helper[01]\.ts$/);
      // Thousands separator round-trip: 2,5xx chars parsed back to a number.
      expect(e.chars).toBeGreaterThan(2_500);
    }

    expect(index.rawCount).toBe(raw.length);
  });

  test('parses OpenAI-shaped histories (tool_calls + role:tool, tool_call_id handles)', () => {
    const msgs: FoldMessage[] = [];
    msgs.push(userMsg('inspect the config'));
    msgs.push(openaiToolCall('call_cfg', 'Read', { file_path: ABS('relay/src/config.ts') }));
    msgs.push(openaiToolResult('call_cfg', 'CONFIG ' + 'z'.repeat(3_000)));
    msgs.push(assistantMsg('Config reviewed in depth.'));
    msgs.push(userMsg('now the runtime'));
    for (let i = 0; i < 7; i++) {
      msgs.push(openaiToolCall(`call_r${i}`, 'Read', { file_path: ABS(`relay/src/rt${i}.ts`) }));
      msgs.push(openaiToolResult(`call_r${i}`, `RT${i} ` + 'w'.repeat(2_400)));
    }
    msgs.push(assistantMsg('Runtime reviewed.'));

    const index = indexFor(msgs);
    const toolEntries = index.entries.filter((e): e is IntraTurnIndexEntry => e.kind === 'tool');
    expect(toolEntries).toHaveLength(0);
    const turnEntries = index.entries.filter((e): e is InterTurnIndexEntry => e.kind === 'turn');
    expect(turnEntries).toHaveLength(2);
    expect(turnEntries[0].paths).toEqual(['relay/src/config.ts']);
    expect(turnEntries[1].paths).toEqual([
      'relay/src/rt0.ts',
      'relay/src/rt1.ts',
      'relay/src/rt2.ts',
      'relay/src/rt3.ts',
      'relay/src/rt4.ts',
      'relay/src/rt5.ts',
      'relay/src/rt6.ts',
    ]);
  });

  test('a fold marker QUOTED inside live tool output does not index (anchored matching)', () => {
    const raw = buildAnthropicHistory();
    // A live (tail-buffer) result whose content merely QUOTES a fold marker.
    raw.push(anthropicToolUse('tu_quote', 'Read', { file_path: ABS('relay/src/transcript.txt') }));
    raw.push(anthropicToolResult('tu_quote', 'transcript says: [Folded: Read relay/src/old.ts — 1,234 chars | self-tap to recover] and more text'));
    const index = indexFor(raw);
    expect(index.entries.some(e => e.kind === 'tool' && e.toolId === 'tu_quote')).toBe(false);
    expect(index.entries.some(e => e.kind === 'tool' && e.path === 'relay/src/old.ts')).toBe(false);
  });

  test('no fold block in view → no inter-turn entries', () => {
    const raw: FoldMessage[] = [userMsg('hi'), assistantMsg('hello there, what can I do?')];
    const index = buildFoldIndex(raw, raw.slice());
    expect(index.entries.filter(e => e.kind === 'turn')).toHaveLength(0);
  });

  test('inline-coordinate fold block parses cleanly (count from header; suffix adds no entries)', () => {
    // A value-rich folded turn makes the view's fold block carry an inline
    // coordinate suffix. buildFoldIndex must read ONLY the "N turns folded"
    // header count and never derive entries/paths from suffix text.
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const raw: FoldMessage[] = [
      userMsg('look up the job id'),
      anthropicToolUse('tu_lit', 'Read', { file_path: ABS('relay/src/jobs.ts') }),
      anthropicToolResult('tu_lit', `job uuid ${uuid} registered`),
      assistantMsg('Found the job registration.'),
      userMsg('thanks, next task'),
      assistantMsg('Ready.'),
    ];
    const view = runPipeline(raw);

    const block = view.find(m => typeof m.content === 'string' && m.content.includes('[Conversation Context'));
    expect(block).toBeDefined();
    expect(block!.content as string).not.toContain('COORDINATE CLOSET');
    expect(block!.content as string).toContain(' ⌖ ');
    expect(block!.content as string).toContain(uuid);

    const index = buildFoldIndex(raw, view);
    const turnEntries = index.entries.filter((e): e is InterTurnIndexEntry => e.kind === 'turn');
    expect(turnEntries).toHaveLength(2);
    expect(turnEntries[0].paths).toEqual(['relay/src/jobs.ts']);
  });

  test('precomputedTurns makes a single-user-turn marathon fold recall-addressable (omitting it is unchanged)', () => {
    // The flattened/marathon shape: one user kickoff + many tool steps under a
    // single user boundary. detectTurns sees ONE turn, so the legacy 2-arg index
    // cannot address the folded steps — this is the Codex synthetic step-fold gap.
    const raw: FoldMessage[] = [userMsg('kick off one long autonomous task ' + 'scope '.repeat(20))];
    for (let i = 0; i < 30; i++) {
      raw.push(openaiToolCall(`call-${i}`, 'Bash', { command: `sed -n '${i}p' src/file${i}.ts` }));
      raw.push(openaiToolResult(`call-${i}`, `result ${i} ${'x'.repeat(200)}`));
    }
    const plan = planActiveTurnStepFold(raw, { activeTurnCharBudget: 1, keepLastSteps: 3 });
    expect(plan).not.toBeNull();
    const view = foldContext(raw, plan!.turnsToFold, ALWAYS_ON_FOLD_CONFIG, undefined, undefined, plan!.turns).messages;

    // Without the tiling, detectTurns collapses to one coarse folded turn.
    const collapsed = buildFoldIndex(raw, view);
    expect(collapsed.entries.length).toBe(1);

    // Passing detectTurns(raw) explicitly is byte-identical to omitting it (no FC/normal-path regression).
    expect(buildFoldIndex(raw, view, detectTurns(raw)).entries).toEqual(collapsed.entries);

    // With the step tiling, every folded step becomes a recall-addressable turn entry.
    const tiled = buildFoldIndex(raw, view, plan!.turns);
    expect(tiled.entries.length).toBe(plan!.turnsToFold);
    expect(tiled.entries.every(e => e.kind === 'turn')).toBe(true);
  });

  test('multi-band tail-epoch view: fold-block counts accumulate across ALL bands (first-block-wins regression)', () => {
    // FC append-only tail epochs seal one fold block per band, so the view can
    // carry several "[Conversation Context — N turns folded, …]" headers in
    // chronological band order. The page table must cover the SUM of the band
    // counts — reading only the FIRST block pinned the index to the oldest band
    // and left every later-folded turn unrecallable (measured as permanent
    // cards:0 recall on multi-band FC sessions).
    const raw: FoldMessage[] = [];
    for (let i = 0; i < 4; i++) {
      raw.push(userMsg(`work on task ${i}`));
      raw.push(anthropicToolUse(`tu_band_${i}`, 'Read', { file_path: ABS(`relay/src/band${i}.ts`) }));
      raw.push(anthropicToolResult(`tu_band_${i}`, `contents of band file ${i}`));
      raw.push(assistantMsg(`finished task ${i}`));
    }
    raw.push(userMsg('live tail turn'));
    raw.push(assistantMsg('working on it'));

    // Two sealed bands: band 1 folded turns 0-1, band 2 folded turns 2-3.
    const view: FoldMessage[] = [
      userMsg('[Conversation Context — 2 turns folded, 10K → 1K chars]\n(band 1 summary)'),
      userMsg('[Conversation Context — 2 turns folded, 8K → 1K chars]\n(band 2 summary)'),
      userMsg('live tail turn'),
      assistantMsg('working on it'),
    ];

    const index = buildFoldIndex(raw, view);
    const turnEntries = index.entries.filter((e): e is InterTurnIndexEntry => e.kind === 'turn');
    // All four folded turns are recall-addressable, not just the first band's two.
    expect(turnEntries).toHaveLength(4);
    const allPaths = turnEntries.flatMap(e => e.paths);
    expect(allPaths).toContain('relay/src/band0.ts');
    expect(allPaths).toContain('relay/src/band3.ts');

    // Single-block views keep byte-identical prior behavior: one marker, same count.
    const singleBlockView: FoldMessage[] = [
      userMsg('[Conversation Context — 2 turns folded, 10K → 1K chars]\n(band 1 summary)'),
      userMsg('live tail turn'),
      assistantMsg('working on it'),
    ];
    const singleIndex = buildFoldIndex(raw, singleBlockView);
    expect(singleIndex.entries.filter(e => e.kind === 'turn')).toHaveLength(2);
  });

  test('records exact visible recall card blocks from the built view', () => {
    const raw: FoldMessage[] = [userMsg('hi'), assistantMsg('hello')];
    const card = [
      `${RECALL_CARD_PREFIX} Read relay/src/visible.ts | trigger: claim relay/src/visible.ts | 5,000 chars folded]`,
      'visible recalled body',
      '[End fold recall]',
    ].join('\n');
    const view: FoldMessage[] = [
      userMsg(`before\n${card}\nafter`),
      anthropicToolResult('tu_visible', `fresh tool output\n\n${card}\n\ntrailing text`),
    ];

    const index = buildFoldIndex(raw, view);
    expect(index.visibleRecallCards).toEqual([card]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Signals
// ══════════════════════════════════════════════════════════════════════

describe('extractRecallSignals', () => {
  test('normalizes single and multi path args plus claims, sorted', () => {
    const signals = extractRecallSignals({ file_path: ABS('relay/src/zeta.ts'), paths: [ABS('relay/src/alpha.ts'), 'relay/src/beta.ts'] }, new Set([ABS('relay/src/claimed.ts')]));
    expect(signals.touchedPaths).toEqual(['relay/src/alpha.ts', 'relay/src/beta.ts', 'relay/src/zeta.ts']);
    expect(signals.claimedPaths).toEqual(['relay/src/claimed.ts']);
  });

  test('no tool input and no claims → empty signals', () => {
    const signals = extractRecallSignals(null, new Set());
    expect(signals.touchedPaths).toEqual([]);
    expect(signals.claimedPaths).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Planning: tiers, ordering, residency, pressure
// ══════════════════════════════════════════════════════════════════════

function makeIndex(entries: FoldRecallIndex['entries'], rawCount = 100): FoldRecallIndex {
  return { rawCount, entries };
}

function toolEntry(toolId: string, path: string, recency: number, chars = 5_000): IntraTurnIndexEntry {
  return { kind: 'tool', id: `tool:${toolId}`, toolId, tool: 'Read', path, recency, chars };
}

function turnEntry(id: string, digest: string, recency: number, paths: string[] = [], rawStart = 0, rawEnd = 2): InterTurnIndexEntry {
  return {
    kind: 'turn',
    id: `turn:${id}`,
    rawStart,
    rawEnd,
    recency,
    category: 'research',
    paths,
    digest,
    chars: 1_000,
  };
}

describe('extractActiveWindowText (tier-2 active-window query source)', () => {
  test('extracts user+assistant text of the unfolded tail, excluding pre-fold turns', () => {
    const raw: FoldMessage[] = [
      userMsg('investigate the cache layer'),
      assistantMsg('folded reasoning about cache invalidation'),
      userMsg('Does the pathless demand-paging reel still adapt?'),
      assistantMsg('the pathless demand-paging reel keeps adapting'),
    ];
    const text = extractActiveWindowText(raw, 2); // fold prefix = raw[0..2]
    expect(text).toContain('Does the pathless demand-paging reel still adapt?');
    expect(text).toContain('the pathless demand-paging reel keeps adapting');
    expect(text).not.toContain('folded reasoning about cache invalidation');
  });

  test('returns empty string when there is no unfolded tail', () => {
    const raw = [userMsg('a'), assistantMsg('b')];
    expect(extractActiveWindowText(raw, raw.length)).toBe('');
    expect(extractActiveWindowText(raw, raw.length + 10)).toBe('');
    expect(extractActiveWindowText([], 0)).toBe('');
  });

  test('excludes tool results and synthetic blocks from the query text', () => {
    const raw: FoldMessage[] = [
      userMsg('older folded turn'),
      anthropicToolUse('tu_x', 'Read', { file_path: ABS('relay/src/x.ts') }),
      anthropicToolResult('tu_x', 'SECRET TOOL OUTPUT should never seed the query'),
      assistantMsg('the demand-paging reel narrates its own pivot'),
    ];
    const text = extractActiveWindowText(raw, 1); // tail = toolUse + toolResult + assistant
    expect(text).toContain('the demand-paging reel narrates its own pivot');
    expect(text).not.toContain('SECRET TOOL OUTPUT');
  });

  test('strips host-supplied resumed-turn envelopes from active-window user text', () => {
    const hostSyntheticContext = {
      leadingBlocks: [
        { prefix: '[Host Time]', mode: 'line-or-paragraph' },
        { prefix: '[Host Memory]', end: '[END Host Memory]', mode: 'paired' },
        { prefix: '[Host Digest', end: '[END Host Digest]', mode: 'paired' },
        { prefix: '[Host Thread]', end: '[END Host Thread]', mode: 'paired' },
        { prefix: '[Host Signals]', end: '[END Host Signals]', mode: 'paired' },
        { prefix: '[Host Note:', mode: 'bracketed' },
      ],
    } as const;
    const wrappedAsk = `[Host Time] Session age: 4h 3m

[Host Memory]
Nearby codebase context from recent language:
- src/voiceRecording.ts - Voice recording capture pipeline (high; fts)
[END Host Memory]

[Host Digest seq 26-68]
  * peer-agent: touched src/foldSummary.ts
[END Host Digest]

[Host Thread]
  peer-agent in #fold-repair
[END Host Thread]

[Host Signals]
#result peer landed a related change
[END Host Signals]

[Host Note: Context pressure limits were reached during your execution.
Your context has been successfully folded for efficiency.
Please seamlessly continue your previous turn from where you were interrupted.
Do not repeat your prior output; simply resume your sentence, tool call, or task directly.]

Patch the fold recall query source`;
    const raw: FoldMessage[] = [userMsg('older folded turn'), userMsg(wrappedAsk), assistantMsg('fold recall query source is being patched')];

    const text = extractActiveWindowText(raw, 1, hostSyntheticContext);
    expect(text).toContain('Patch the fold recall query source');
    expect(text).toContain('fold recall query source is being patched');
    expect(text).not.toContain('[Host Digest');
    expect(text).not.toContain('Nearby codebase context');
    expect(text).not.toContain('[Host Note:');
  });

  test('drops a host continuity package from active-window user text when supplied', () => {
    const hostSyntheticContext = {
      leadingBlocks: [
        { prefix: '[Host Time]', mode: 'line-or-paragraph' },
        { prefix: '[Host Digest', end: '[END Host Digest]', mode: 'paired' },
      ],
      wholeTextMatchers: [(text: string) => text.startsWith('[Host Continuity]') || /^package_version:\s*\d+\n\[Host Continuity\]/.test(text)],
    } as const;
    const hostPkg = `[Host Time] Session age: 2h 6m

[Host Digest seq 514-529]
  * peer-agent: touched src/foldSummary.ts
[END Host Digest]

package_version: 5
[Host Continuity] You are the continuation of "agent". Read Last User + AI Messages first, then Current Thread.

── Current Thread ──
👤 USER (active request):
Make your fixes`;
    const raw: FoldMessage[] = [userMsg(hostPkg), userMsg('Now run the recall trace'), assistantMsg('running the recall trace now')];
    const text = extractActiveWindowText(raw, 0, hostSyntheticContext);
    expect(text).toContain('Now run the recall trace');
    expect(text).toContain('running the recall trace now');
    expect(text).not.toContain('[Host Continuity]');
    expect(text).not.toContain('You are the continuation');
    expect(text).not.toContain('Make your fixes');
  });

  test('recency-favored cap keeps the newest cognition when the tail exceeds the budget', () => {
    const oldChunk = 'startmarker-should-drop ' + 'alpha '.repeat(400); // > 1600 chars, oldest
    const raw: FoldMessage[] = [userMsg('folded'), assistantMsg(oldChunk), assistantMsg('omega-distinctive-marker zeta-distinctive-marker')];
    const text = extractActiveWindowText(raw, 1); // tail = oldChunk + fresh marker line
    expect(text.length).toBeLessThanOrEqual(1600);
    expect(text).toContain('omega-distinctive-marker'); // newest retained
    expect(text).toContain('zeta-distinctive-marker');
    expect(text).not.toContain('startmarker-should-drop'); // oldest dropped by the cap
  });
});

describe('deriveBoundaryRecallSignals (live fold-recall GET-path wiring seam)', () => {
  // Folded prefix raw[0..6] (target + two common fillers) then an unfolded active
  // tail raw[6..8] whose distinctive vocabulary overlaps the target turn.
  function wiringRaw(): FoldMessage[] {
    return [
      userMsg('investigate the cache'),
      assistantMsg('pathless demand-paging reel now follows live vocabulary'),
      userMsg('filler one'),
      assistantMsg('context fold system filler one'),
      userMsg('filler two'),
      assistantMsg('context fold system filler two'),
      userMsg('Does the pathless demand-paging reel still adapt?'),
      assistantMsg('the pathless demand-paging reel keeps adapting'),
    ];
  }
  function wiringIndex(): FoldRecallIndex {
    return makeIndex(
      [
        turnEntry('target', 'pathless demand-paging reel now follows live vocabulary', 30, [], 0, 2),
        turnEntry('common-a', 'context fold system filler one', 20, [], 2, 4),
        turnEntry('common-b', 'context fold system filler two', 10, [], 4, 6),
      ],
      6,
    ); // rawCount=6 → active tail = raw.slice(6)
  }

  test('default-on: pathless active window sharing >=2 distinctive terms proceeds and pages a tier-2 card', () => {
    const raw = wiringRaw();
    const { signals, proceed } = deriveBoundaryRecallSignals(null, new Set(), raw, 6, DEFAULT_FOLD_RECALL_CONFIG);
    expect(proceed).toBe(true);
    expect(signals.touchedPaths).toHaveLength(0);
    expect(signals.claimedPaths).toHaveLength(0);
    expect(signals.terms ?? []).toEqual(expect.arrayContaining(['pathless', 'demand-pag', 'reel']));

    const state = createFoldRecallState();
    state.index = wiringIndex();
    const out = buildFoldRecallContext(state, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.triggers[0]).toContain('term-overlap');
    expect(out.text).toContain('pathless demand-paging reel now follows');
  });

  test('explicit-off: a pathless boundary does not proceed and carries no term signals', () => {
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, termRecallEnabled: false };
    const { signals, proceed } = deriveBoundaryRecallSignals(null, new Set(), wiringRaw(), 6, config);
    expect(proceed).toBe(false);
    expect(signals.terms).toBeUndefined();
  });

  test('path-touch still proceeds with term recall OFF (tier-0 wiring unaffected by the seam)', () => {
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, termRecallEnabled: false };
    const { signals, proceed } = deriveBoundaryRecallSignals({ file_path: ABS('relay/src/x.ts') }, new Set(), wiringRaw(), 6, config);
    expect(proceed).toBe(true);
    expect(signals.touchedPaths).toEqual(['relay/src/x.ts']);
    expect(signals.terms).toBeUndefined();
  });
});

describe('planRecall', () => {
  const config = DEFAULT_FOLD_RECALL_CONFIG;

  test('tier 0 (path-touch) outranks tier 1 (claim); recency desc within a tier; id asc ties', () => {
    const index = makeIndex([
      toolEntry('a', 'relay/src/touched.ts', 10),
      toolEntry('b', 'relay/src/claimed.ts', 99), // most recent but only claim-matched
      toolEntry('c', 'relay/src/touched.ts', 50),
    ]);
    const plan = planRecall(index, new Map(), new Map(), 1, { touchedPaths: ['relay/src/touched.ts'], claimedPaths: ['relay/src/claimed.ts'] }, 'healthy', config);
    expect(plan.items.map(i => i.entry.id)).toEqual(['tool:c', 'tool:a', 'tool:b']);
    expect(plan.items.map(i => i.tier)).toEqual([0, 0, 1]);
    expect(plan.items[0].trigger).toBe('path-touch relay/src/touched.ts');
    expect(plan.items[2].trigger).toBe('claim relay/src/claimed.ts');
    // Default card budget (3) fits all three.
    expect(plan.items.map(i => i.render)).toEqual(['card', 'card', 'card']);
  });

  test('resident card suppresses; resident hint escalates on a fresh hard trigger', () => {
    const index = makeIndex([toolEntry('a', 'relay/src/a.ts', 10), toolEntry('b', 'relay/src/b.ts', 20)]);
    const resident = new Map([
      ['tool:a', { level: 'card' as const, expiresAtPass: 10 }],
      ['tool:b', { level: 'hint' as const, expiresAtPass: 10 }],
    ]);
    const plan = planRecall(index, resident, new Map(), 5, { touchedPaths: [], claimedPaths: ['relay/src/a.ts', 'relay/src/b.ts'] }, 'healthy', config);
    expect(plan.suppressed).toBe(1); // a (resident card)
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].entry.id).toBe('tool:b');
    expect(plan.items[0].escalatedFromHint).toBe(true);
    expect(plan.items[0].render).toBe('card');
  });

  test('expired residency is ignored', () => {
    const index = makeIndex([toolEntry('a', 'relay/src/a.ts', 10)]);
    const resident = new Map([['tool:a', { level: 'card' as const, expiresAtPass: 5 }]]);
    const plan = planRecall(index, resident, new Map(), 5, { touchedPaths: ['relay/src/a.ts'], claimedPaths: [] }, 'healthy', config);
    expect(plan.suppressed).toBe(0);
    expect(plan.items).toHaveLength(1);
  });

  test('pressure ladder: critical allows 1 card; auto_compact keeps a tier-0 floor', () => {
    const index = makeIndex([toolEntry('a', 'relay/src/a.ts', 10), toolEntry('b', 'relay/src/b.ts', 20)]);
    const signals = { touchedPaths: ['relay/src/a.ts', 'relay/src/b.ts'], claimedPaths: [] };

    const critical = planRecall(index, new Map(), new Map(), 1, signals, 'critical', config);
    expect(critical.items.map(i => i.render)).toEqual(['card', 'hint']);

    const autoCompact = planRecall(index, new Map(), new Map(), 1, signals, 'auto_compact', config);
    expect(autoCompact.items.map(i => i.render)).toEqual(['card', 'hint']);
  });

  test('pure: never mutates the residency map', () => {
    const index = makeIndex([toolEntry('a', 'relay/src/a.ts', 10)]);
    const resident = new Map<string, { level: 'card' | 'hint'; expiresAtPass: number }>();
    planRecall(index, resident, new Map(), 1, { touchedPaths: ['relay/src/a.ts'], claimedPaths: [] }, 'healthy', config);
    expect(resident.size).toBe(0);
  });

  test('tier 2 term matching is default-on, with explicit opt-out for legacy no-term behavior', () => {
    const index = makeIndex([
      turnEntry('target', 'pathless demand-paging reel adaptation solved the stale cache', 30),
      turnEntry('common-a', 'context fold system routing continued normally', 90),
      turnEntry('common-b', 'context fold system telemetry stayed quiet', 80),
    ]);
    const signals = extractRecallSignals(null, new Set(), 'pathless demand-paging reel should revive');

    const off = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', { ...config, termRecallEnabled: false });
    expect(off.items).toHaveLength(0);

    const on = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', config);
    expect(on.items).toHaveLength(1);
    expect(on.items[0].entry.id).toBe('turn:target');
    expect(on.items[0].tier).toBe(2);
    expect(on.items[0].trigger).toBe('term-overlap pathless, demand-pag, reel');
  });

  test('tier 2 anti-noise: common-word-only overlap does not fault', () => {
    const index = makeIndex([turnEntry('a', 'context fold system alpha', 30), turnEntry('b', 'context fold system beta', 20), turnEntry('c', 'context fold system gamma', 10)]);
    const signals = extractRecallSignals(null, new Set(), 'context fold system');
    const plan = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', { ...config, termRecallEnabled: true });
    expect(plan.items).toHaveLength(0);
  });

  test('tier 2 orders fuzzy term matches by relevance before recency', () => {
    const index = makeIndex([
      turnEntry('target', 'pathless demand-paging reel adaptation solved the stale cache', 10),
      turnEntry('recent-noisy', 'pathless demand-paging filler stayed recent', 99),
      turnEntry('filler-a', 'context fold system routing continued normally', 80),
      turnEntry('filler-b', 'context fold system telemetry stayed quiet', 70),
      turnEntry('filler-c', 'ordinary workspace note with no matching vocabulary', 60),
    ]);
    const signals = extractRecallSignals(null, new Set(), 'pathless demand-paging reel cache should revive');
    const plan = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', config);
    expect(plan.items.map(i => i.entry.id)).toEqual(['turn:target', 'turn:recent-noisy']);
  });

  test('path tiers still outrank term tier when both match', () => {
    const index = makeIndex([
      turnEntry('path', 'ordinary touched file work', 10, ['relay/src/hit.ts']),
      turnEntry('term', 'pathless demand-paging reel without a member path', 99),
      turnEntry('other', 'context fold system filler', 90),
    ]);
    const signals = extractRecallSignals({ file_path: 'relay/src/hit.ts' }, new Set(), 'pathless demand-paging reel');
    const plan = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', { ...config, termRecallEnabled: true });
    expect(plan.items.map(i => i.entry.id)).toEqual(['turn:path', 'turn:term']);
    expect(plan.items.map(i => i.tier)).toEqual([0, 2]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Tier-2 exact verbatim-token page-in (WARP_FOLD_RECALL_VERBATIM)
// ══════════════════════════════════════════════════════════════════════

describe('planRecall — exact verbatim-token tier', () => {
  const HASH = '7fd5835b00ab';
  const tokenTurn = (id: string, recency: number, tokens: string[], paths: string[] = []): InterTurnIndexEntry => ({
    ...turnEntry(id, `${id} digest text`, recency, paths),
    ...(tokens.length > 0 ? { verbatimTokens: tokens } : {}),
  });

  test('disabled (=0) suppresses; default config (ON) pages in the source turn', () => {
    const index = makeIndex([tokenTurn('target', 30, [HASH]), tokenTurn('other-a', 90, ['aaaaaaaaaaaa']), tokenTurn('other-b', 80, [])]);
    const signals = { touchedPaths: [], claimedPaths: [], verbatimTokens: [HASH] };

    const off = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      verbatimRecallEnabled: false,
    });
    expect(off.items).toHaveLength(0);

    // DEFAULT_FOLD_RECALL_CONFIG now has verbatimRecallEnabled: true.
    const on = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(on.items).toHaveLength(1);
    expect(on.items[0].entry.id).toBe('turn:target');
    expect(on.items[0].tier).toBe(2);
    expect(on.items[0].matchedPath).toBe(`verbatim:${HASH}`);
    expect(on.items[0].trigger).toBe(`verbatim-token ${HASH}`);
  });

  test('a SINGLE exact token suffices — no ≥2 distinctive-count gate', () => {
    const index = makeIndex([tokenTurn('solo', 30, [HASH])]);
    const signals = { touchedPaths: [], claimedPaths: [], verbatimTokens: [HASH] };
    const plan = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      verbatimRecallEnabled: true,
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].tier).toBe(2);
  });

  test('path-touch and claim tiers still outrank the verbatim-token tier', () => {
    const index = makeIndex([tokenTurn('touch', 10, [], ['relay/src/hit.ts']), tokenTurn('claimed', 20, [], ['relay/src/claimed.ts']), tokenTurn('tok', 99, [HASH])]);
    const signals = {
      touchedPaths: ['relay/src/hit.ts'],
      claimedPaths: ['relay/src/claimed.ts'],
      verbatimTokens: [HASH],
    };
    const plan = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      verbatimRecallEnabled: true,
    });
    expect(plan.items.map(i => i.entry.id)).toEqual(['turn:touch', 'turn:claimed', 'turn:tok']);
    expect(plan.items.map(i => i.tier)).toEqual([0, 1, 2]);
  });

  test('exact-token beats fuzzy term overlap within tier 2 (stronger trigger evaluated first)', () => {
    const index = makeIndex([{ ...turnEntry('both', 'pathless demand-paging reel adaptation', 30), verbatimTokens: [HASH] }]);
    const signals = {
      touchedPaths: [],
      claimedPaths: [],
      terms: ['pathless', 'demand-paging', 'reel'],
      verbatimTokens: [HASH],
    };
    const plan = planRecall(index, new Map(), new Map(), 1, signals, 'healthy', {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      termRecallEnabled: true,
      verbatimRecallEnabled: true,
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].tier).toBe(2);
    expect(plan.items[0].trigger).toBe(`verbatim-token ${HASH}`);
  });
});

describe('verbatim-token recall — buildFoldIndex + end-to-end (Tier-2 integration)', () => {
  const HASH = '7fd5835b00ab';
  // Folded turn 0 carries the hash in its tool result; the unfolded tail
  // (turn 1 assistant text) re-mentions it — the page-in trigger.
  function verbatimHistory(): FoldMessage[] {
    return [
      userMsg('investigate the changelog'),
      anthropicToolUse('tu_cl', 'Read', { file_path: ABS('relay/src/cl.ts') }),
      anthropicToolResult('tu_cl', `changelog_id: ${HASH} found in ` + 'x'.repeat(4_000)),
      assistantMsg('Noted the changelog entry for later.'),
      userMsg('what was that id again'),
      assistantMsg(`the id was ${HASH} from the earlier read`),
    ];
  }

  test('buildFoldIndex records the folded turn’s verbatim tokens', () => {
    const raw = verbatimHistory();
    const index = indexFor(raw);
    const turn = index.entries.find((e): e is InterTurnIndexEntry => e.kind === 'turn');
    expect(turn).toBeDefined();
    expect(turn!.verbatimTokens).toBeDefined();
    expect(turn!.verbatimTokens).toContain(HASH);
  });

  test('flag-on: a re-surfaced kept token pages in its source turn; flag-off: no recall', () => {
    const raw = verbatimHistory();
    const index = indexFor(raw);
    const foldedRawCount = 4; // turn 0 (raw[0..4)) folded; tail = raw[4..6)

    const onCfg: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, verbatimRecallEnabled: true };
    const onSig = deriveBoundaryRecallSignals(null, new Set(), raw, foldedRawCount, onCfg);
    expect(onSig.signals.verbatimTokens).toContain(HASH);
    expect(onSig.proceed).toBe(true);
    const onState = createFoldRecallState();
    onState.index = index;
    const on = buildFoldRecallContext(onState, raw, onSig.signals, 'healthy', onCfg);
    expect(on.text).not.toBeNull();
    expect(on.cards).toBeGreaterThanOrEqual(1);
    expect(on.triggers.some(t => t.includes(`verbatim-token ${HASH}`))).toBe(true);

    // Disabled (WARP_FOLD_RECALL_VERBATIM=0 plus term opt-out): no active-window
    // derivation, no token/term signal, no recall.
    const offCfg: FoldRecallConfig = {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      verbatimRecallEnabled: false,
      termRecallEnabled: false,
    };
    const offSig = deriveBoundaryRecallSignals(null, new Set(), raw, foldedRawCount, offCfg);
    expect(offSig.proceed).toBe(false);
    const offState = createFoldRecallState();
    offState.index = index;
    const off = buildFoldRecallContext(offState, raw, offSig.signals, 'healthy', offCfg);
    expect(off.text).toBeNull();
  });

  test('residency: a second identical pass suppresses the just-shown verbatim card', () => {
    const raw = verbatimHistory();
    const index = indexFor(raw);
    const cfg: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, verbatimRecallEnabled: true, ttlPasses: 3 };
    const state = createFoldRecallState();
    state.index = index;
    const sig = deriveBoundaryRecallSignals(null, new Set(), raw, 4, cfg).signals;

    const first = buildFoldRecallContext(state, raw, sig, 'healthy', cfg);
    expect(first.cards).toBeGreaterThanOrEqual(1);
    const second = buildFoldRecallContext(state, raw, sig, 'healthy', cfg);
    expect(second.cards).toBe(0);
    expect(second.suppressed).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// End-to-end recall pass (state + rendering + residency + budget)
// ══════════════════════════════════════════════════════════════════════

describe('buildFoldRecallContext', () => {
  function freshState(raw: FoldMessage[]) {
    const state = createFoldRecallState();
    state.index = indexFor(raw);
    return state;
  }

  function freshIntraState(raw: FoldMessage[]) {
    const state = createFoldRecallState();
    state.index = intraOnlyIndexFor(raw);
    return state;
  }

  const touchBigfile = () => extractRecallSignals({ file_path: ABS(BIGFILE) }, new Set());
  const claimBigfile = () => extractRecallSignals(null, new Set([ABS(BIGFILE)]));

  test('tier-0 path re-touch pages folded turn content back in as a card', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const out = buildFoldRecallContext(state, raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.text).not.toBeNull();
    expect(out.cards).toBe(1);
    expect(out.text!).toContain(RECALL_CARD_PREFIX);
    expect(out.text!).toContain('trigger: path-touch relay/src/bigfile.ts');
    // Body sliced from in-memory raw history: the folded turn's tool result + assistant text.
    expect(out.text!).toContain('BIGFILE CONTENT START');
    expect(out.text!).toContain('Found the bug in bigfile.ts');
    expect(out.text!).toContain('↞ source episode: Read · relay/src/bigfile.ts');
    expect(out.text!).toContain('[End fold recall]');
    expect(out.triggers).toEqual(['path-touch relay/src/bigfile.ts']);
    expect(state.cardsInjected).toBe(1);
    expect(state.recallChars).toBe(out.chars);
  });

  test('labels a multi-file recalled episode with counted tools and a bounded path cluster', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const signals = extractRecallSignals({ file_path: ABS('relay/src/helper0.ts') }, new Set());

    const out = buildFoldRecallContext(state, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    expect(out.text).toContain(
      '↞ source episode: Read ×7 · relay/src/helper0.ts, relay/src/helper1.ts, relay/src/helper2.ts',
    );
    expect(out.text).not.toContain('relay/src/helper3.ts, relay/src/helper4.ts');
  });

  test('tier-0 path re-touch suppresses the identical entry on consecutive passes', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 3 };
    const signals = touchBigfile();

    const first = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(first.cards).toBe(1);
    expect(first.text!).toContain('BIGFILE CONTENT START');

    const second = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(second.text).toContain('[Fold recall suppressed manifest — 1 matching body withheld as already resident]');
    expect(second.suppressedManifest).toBe(second.text);
    expect(second.text).toContain('relay/src/bigfile.ts @ raw messages 1–4');
    expect(second.text).not.toContain('BIGFILE CONTENT START');
    expect(second.text!.length).toBeLessThanOrEqual(480);
    expect(second.cards).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(state.cardsInjected).toBe(1);
  });

  test('suppresses a folded body already resident elsewhere in provider POV', () => {
    const raw = buildAnthropicHistory();
    const firstState = freshState(raw);
    const first = buildFoldRecallContext(firstState, raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(first.cards).toBe(1);
    const bodyOnly = first.text!
      .split('\n')
      .filter((line) => !line.startsWith(RECALL_CARD_PREFIX) && line !== '[End fold recall]')
      .join('\n');

    const secondState = freshState(raw);
    secondState.index = {
      ...secondState.index!,
      visibleRecallCards: [],
      visiblePovText: normalizeFoldRecallPovText(bodyOnly),
    };
    const second = buildFoldRecallContext(secondState, raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(second.text).toContain('[Fold recall suppressed manifest');
    expect(second.cards).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(secondState.cardsInjected).toBe(0);
  });

  test('prunes body paragraphs already visible in the unfolded raw tail while keeping novel recovery', () => {
    const historical = buildAnthropicHistory();
    const state = freshState(historical);
    const repeatedConclusion = 'Found the bug in bigfile.ts — the handler ignores null inputs because of a legacy guard.';
    const raw = [...historical, assistantMsg(repeatedConclusion)];

    const out = buildFoldRecallContext(state, raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    expect(out.text).toContain('BIGFILE CONTENT START');
    expect(out.text).not.toContain(repeatedConclusion);
    expect(out.text).toContain('↞ source episode: Read · relay/src/bigfile.ts');
  });

  test('cadence-gates an unchanged suppressed manifest and periodically reminds', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 20 };
    const signals = touchBigfile();

    expect(buildFoldRecallContext(state, raw, signals, 'healthy', config).cards).toBe(1);
    const firstSuppression = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(firstSuppression.suppressedManifest).toContain('[Fold recall suppressed manifest');

    for (let pass = 0; pass < 5; pass += 1) {
      const quiet = buildFoldRecallContext(state, raw, signals, 'healthy', config);
      expect(quiet.text).toBeNull();
      expect(quiet.suppressed).toBe(1);
    }

    const reminder = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(reminder.suppressedManifest).toContain('[Fold recall suppressed manifest');
    expect(reminder.cards).toBe(0);
  });

  test('uses raw provider POV before the first fold index exists', () => {
    const raw: FoldMessage[] = [
      userMsg('Keep this pre-fold provider-visible instruction resident.'),
      assistantMsg('The circular episode must not replay while this exact narration remains visible.'),
    ];

    const pov = foldRecallProviderPovText(null, raw);

    expect(pov).toContain(normalizeFoldRecallPovText('The circular episode must not replay while this exact narration remains visible.'));
  });

  test('deduplicates identical recovered content across two entries in one recall pass', () => {
    const alpha = 'relay/src/alpha.ts';
    const beta = 'relay/src/beta.ts';
    const raw: FoldMessage[] = [
      userMsg('Investigate the duplicated recovery seam across both aliases in this folded turn.'),
      assistantMsg('The same historical finding is indexed under two paths but should only be shown once to the provider.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([
      turnEntry('alpha-alias', 'duplicated recovery seam', 2, [alpha], 0, 2),
      turnEntry('beta-alias', 'duplicated recovery seam', 2, [beta], 0, 2),
    ], raw.length);
    const signals = extractRecallSignals({ paths: [ABS(alpha), ABS(beta)] }, new Set());
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, maxCards: 3 };

    const out = buildFoldRecallContext(state, raw, signals, 'healthy', config);

    expect(out.cards).toBe(1);
    expect(out.suppressed).toBe(1);
    expect(out.text!.match(new RegExp(RECALL_CARD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  test('missing index signature is treated as first pass for legacy recall state objects', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 3 };
    const signals = touchBigfile();

    const first = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(first.cards).toBe(1);
    delete state.lastIndexSignature;

    const second = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(second.text).toContain('[Fold recall suppressed manifest');
    expect(second.cards).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(state.cardsInjected).toBe(1);
  });

  test('live source delta: claim-tier recall on a genuinely edited path swaps the body to CURRENT box source + delta notifier', () => {
    const edited = 'relay/src/edited.ts';
    const staleBody = ['function handler(input) {', '  if (input === null) {', '    return legacyGuard(input);', '  }', '  return process(input);', '}'].join('\n');
    const currentSource = ['function handler(input) {', '  if (input === null) {', '    return modernGuard(input);', '  }', '  return process(input);', '}'].join('\n');
    const raw: FoldMessage[] = [
      userMsg('Investigate edited.ts'),
      anthropicToolUse('tu_ed', 'Read', { file_path: ABS(edited) }),
      anthropicToolResult('tu_ed', staleBody),
      assistantMsg('Reviewed the handler in edited.ts.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([toolEntry('tu_ed', edited, 10)], raw.length);
    state.pathSourceDeltas.set(edited, { path: edited, liveHash: 'ed-new', liveSource: currentSource });

    // A file CLAIM (tier 1 — about to edit) is where stale code is actively
    // dangerous: the body swaps to CURRENT box source, heading says so.
    const out = buildFoldRecallContext(state, raw, extractRecallSignals(null, new Set([ABS(edited)])), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    expect(out.text!).toContain('trigger: claim relay/src/edited.ts');
    expect(out.text!).toContain('Δ Source changed since fold — body below is CURRENT box source; what changed:');
    expect(out.text!).toContain('relay/src/edited.ts (liveHash=ed-new)');
    expect(out.text!).toContain('↻ CURRENT box source — relay/src/edited.ts:');
    expect(out.text!).toContain('modernGuard');
    // Stale guard only survives as a `−` deletion line in the hunk.
    expect(out.text!).toMatch(/−\s*return legacyGuard\(input\);/);
    // Composition telemetry: the swap and the notifier are visible in the stats.
    expect(out.composition).toBeDefined();
    expect(out.composition!.swappedPaths).toBe(1);
    expect(out.composition!.bodyChars).toBeGreaterThan(0);
    expect(out.composition!.notifierChars).toBeGreaterThan(0);
  });

  test('live source delta: live source matching historical ⇒ no notifier, byte-identical legacy body', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    // Live snapshot equals the historical body ⇒ no genuine change.
    state.pathSourceDeltas.set(BIGFILE, {
      path: BIGFILE,
      liveHash: 'abcd1234',
      liveSource: BIGFILE_CONTENT,
    });
    const out = buildFoldRecallContext(state, raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    expect(out.text!).not.toContain('Δ Source changed since fold');
    expect(out.text!).not.toContain('Δ Fold-recall live-source check');
    expect(out.text!).not.toContain('↻ CURRENT box source');
    expect(out.text!).toContain('BIGFILE CONTENT START');
  });

  test('source delta: truncated snapshot with no in-window change keeps historical body + warns fresh-read (beyond-window)', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    // A truncated single-line snapshot: its only line is a partial of the
    // historical, so nothing is comparable in-window — flag, don't fabricate.
    state.pathSourceDeltas.set(BIGFILE, {
      path: BIGFILE,
      liveHash: 'ghi789',
      liveSource: BIGFILE_CONTENT.slice(0, 500),
      truncated: true,
    });
    const out = buildFoldRecallContext(state, raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.text!).toContain('Δ Fold-recall live-source check:');
    expect(out.text!).toContain('snapshot truncated');
    expect(out.text!).toContain('fresh-read to verify current code');
    // Historical body retained — no current content for the region beyond the window.
    expect(out.text!).toContain('BIGFILE CONTENT END');
    expect(out.text!).not.toContain('↻ CURRENT box source');
  });

  test('source delta: a truncated snapshot whose hash is stable since the prior epoch suppresses the repeat beyond-window nudge', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    // Same truncated snapshot as the beyond-window case, but flagged stable (the
    // file's full liveHash is unchanged since the prior epoch) ⇒ no fresh-read nag.
    state.pathSourceDeltas.set(BIGFILE, {
      path: BIGFILE,
      liveHash: 'ghi789',
      liveSource: BIGFILE_CONTENT.slice(0, 500),
      truncated: true,
      stableSincePrior: true,
    });
    const out = buildFoldRecallContext(state, raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    // Suppressed: no fresh-read warning, historical body retained byte-identical.
    expect(out.text!).not.toContain('Δ Fold-recall live-source check:');
    expect(out.text!).not.toContain('snapshot truncated');
    expect(out.text!).not.toContain('↻ CURRENT box source');
    expect(out.text!).toContain('BIGFILE CONTENT END');
  });

  test('context floor: an Atlas-lookup-shaped folded body vs raw source is a shape mismatch — no delta, even for a claim', () => {
    const target = 'relay/src/looked-up.ts';
    // What an Atlas lookup result looks like folded: metadata + prose, NOT source.
    const lookupBody = [
      '# relay/src/looked-up.ts',
      '## Recent Changes',
      '1. Added the widget factory registry.',
      '2. Hardened null handling in the parser.',
      '📌 Purpose: widget factory registry for the relay.',
      '🏷 Tags: registry, widgets',
      '⌖ Key region: createWidget (L10-40)',
      'Hazards: mutates shared registry map in place.',
    ].join('\n');
    const rawSource = [
      'import { z } from "zod";',
      '',
      'export function createWidget(kind) {',
      '  return registry.get(kind)?.build();',
      '}',
      '',
      'export const registry = new Map();',
      'registry.set("gauge", { build: () => new Gauge() });',
    ].join('\n');
    const raw: FoldMessage[] = [
      userMsg('Look up looked-up.ts in Atlas'),
      anthropicToolUse('tu_lk', 'Read', { file_path: ABS(target) }),
      anthropicToolResult('tu_lk', lookupBody),
      assistantMsg('Reviewed the Atlas record.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([toolEntry('tu_lk', target, 10)], raw.length);
    state.pathSourceDeltas.set(target, { path: target, liveHash: 'lk-live', liveSource: rawSource });

    // Even a claim (strongest swap intent) must not treat a document-shape
    // mismatch as an edit: near-zero shared context ⇒ no delta at all.
    const out = buildFoldRecallContext(state, raw, extractRecallSignals(null, new Set([ABS(target)])), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    expect(out.text!).not.toContain('Δ Source changed since fold');
    expect(out.text!).not.toContain('Δ Fold-recall live-source check');
    expect(out.text!).not.toContain('↻ CURRENT box source');
    // Historical lookup body retained untouched.
    expect(out.text!).toContain('## Recent Changes');
  });

  test('context floor: a windowed mid-file Read body vs full source is a shape mismatch — no delta', () => {
    const target = 'relay/src/windowed.ts';
    const fullLines = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`);
    // A mid-file Read window: real source lines, but positionally disjoint from
    // the full file's prefix/suffix — zero shared context at the boundaries.
    const windowBody = fullLines.slice(30, 38).join('\n');
    const raw: FoldMessage[] = [
      userMsg('Read the middle of windowed.ts'),
      anthropicToolUse('tu_win', 'Read', { file_path: ABS(target) }),
      anthropicToolResult('tu_win', windowBody),
      assistantMsg('Reviewed the mid-file window.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([toolEntry('tu_win', target, 10)], raw.length);
    state.pathSourceDeltas.set(target, { path: target, liveHash: 'win-live', liveSource: fullLines.join('\n') });

    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ file_path: ABS(target) }, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    expect(out.text!).not.toContain('Δ Source changed since fold');
    expect(out.text!).not.toContain('Δ Fold-recall live-source check');
    expect(out.text!).not.toContain('↻ CURRENT box source');
    // Historical windowed body retained untouched.
    expect(out.text!).toContain('const line30 = 30;');
  });

  test('touching one folded read-burst member flags the CHANGED sibling with a drift notifier (historical body kept)', () => {
    const alpha = 'relay/src/alpha.ts';
    const beta = 'relay/src/beta.ts';
    const betaOld = ['BETA HEAD', 'BETA OLD CONTENT', 'BETA TAIL'].join('\n');
    const raw: FoldMessage[] = [
      userMsg('Read alpha and beta together'),
      anthropicToolUse('tu_alpha', 'Read', { file_path: ABS(alpha) }),
      anthropicToolResult('tu_alpha', 'ALPHA OLD CONTENT'),
      anthropicToolUse('tu_beta', 'Read', { file_path: ABS(beta) }),
      anthropicToolResult('tu_beta', betaOld),
      assistantMsg('Alpha and beta were reviewed in one temporal burst.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([turnEntry('burst', 'alpha beta reviewed together', 30, [alpha, beta], 0, raw.length)], raw.length);
    // beta was genuinely partially edited on disk since the fold; alpha was not.
    state.pathSourceDeltas.set(beta, {
      path: beta,
      liveHash: 'beta-new',
      liveSource: ['BETA HEAD', 'BETA NEW CONTENT', 'BETA TAIL'].join('\n'),
    });

    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ file_path: ABS(alpha) }, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    expect(out.text!).toContain('trigger: path-touch relay/src/alpha.ts');
    // alpha has no delta ⇒ its body stays the historical (legacy) content, not swapped.
    expect(out.text!).toContain('ALPHA OLD CONTENT');
    // A path-touch is a passive glance (tier 0): beta's HISTORICAL body is kept
    // and the notifier flags the drift with the hunk + fresh-read pointer.
    expect(out.text!).toContain('Δ Source changed since fold');
    expect(out.text!).toContain('HISTORICAL folded copy');
    expect(out.text!).toContain('relay/src/beta.ts (liveHash=beta-new)');
    expect(out.text!).not.toContain('↻ CURRENT box source');
    expect(out.text!).toContain('BETA OLD CONTENT');
    expect(out.text!).toMatch(/\+\s*BETA NEW CONTENT/);
    expect(out.text!).toMatch(/−\s*BETA OLD CONTENT/);
    // Composition telemetry: drift notifier rendered, but nothing was swapped.
    expect(out.composition).toBeDefined();
    expect(out.composition!.swappedPaths).toBe(0);
    expect(out.composition!.notifierChars).toBeGreaterThan(0);
  });

  test('source delta: reviewing a peer-edited file keeps the HISTORICAL body but flags the drift with hunk + fresh-read (processChat trap)', () => {
    const reviewed = 'src/lib/chatJob/processChat.ts';
    const staleBody = [
      'export function resolveClinicId(evidenceClinicId, practiceToolClinicId) {',
      '  if (evidenceClinicId) {',
      '    return evidenceClinicId;',
      '  }',
      '  return null;',
      '}',
    ].join('\n');
    const currentSource = ['export function resolveClinicId(evidenceClinicId, practiceToolClinicId) {', '  return evidenceClinicId ?? practiceToolClinicId;', '}'].join('\n');
    const raw: FoldMessage[] = [
      userMsg('Review the G2 fix in processChat.ts'),
      anthropicToolUse('tu_pc', 'Read', { file_path: ABS(reviewed) }),
      anthropicToolResult('tu_pc', staleBody),
      assistantMsg('Reviewing the clinic id resolution.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([toolEntry('tu_pc', reviewed, 10)], raw.length);
    // The reviewer's read folded the PRE-edit gate; the file on disk now has the fix.
    state.pathSourceDeltas.set(reviewed, {
      path: reviewed,
      liveHash: '2ffe6f651e65e8a7',
      liveSource: currentSource,
    });

    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ file_path: ABS(reviewed) }, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    // A review read is a passive glance (tier 0): the HISTORICAL folded body is
    // kept — the reviewer sees what they folded — while the notifier carries the
    // trap disarm: an explicit drift warning, the landed fix as a `+` hunk line,
    // and a fresh-read pointer before relying on the stale gate.
    expect(out.text!).not.toContain('↻ CURRENT box source');
    expect(out.text!).toContain('Δ Source changed since fold');
    expect(out.text!).toContain('HISTORICAL folded copy');
    expect(out.text!).toContain('fresh-read');
    expect(out.text!).toContain('liveHash=2ffe6f651e65e8a7');
    expect(out.text!).toMatch(/−\s*if \(evidenceClinicId\) \{/);
    expect(out.text!).toMatch(/\+\s*return evidenceClinicId \?\? practiceToolClinicId;/);
  });

  test('zone fan-out residency stays exact-path: later sibling touch is not suppressed', () => {
    const alpha = 'relay/src/alpha.ts';
    const beta = 'relay/src/beta.ts';
    const raw: FoldMessage[] = [
      userMsg('Read alpha and beta together'),
      anthropicToolUse('tu_alpha', 'Read', { file_path: ABS(alpha) }),
      anthropicToolResult('tu_alpha', 'ALPHA OLD CONTENT'),
      anthropicToolUse('tu_beta', 'Read', { file_path: ABS(beta) }),
      anthropicToolResult('tu_beta', 'BETA OLD CONTENT'),
      assistantMsg('Alpha and beta were reviewed in one temporal burst.'),
      userMsg('Later, check beta again'),
      anthropicToolUse('tu_beta2', 'Read', { file_path: ABS(beta) }),
      anthropicToolResult('tu_beta2', 'BETA LATER CONTENT'),
      assistantMsg('Beta revisited in a separate turn.'),
    ];
    const state = createFoldRecallState();
    // Two separate entries: a shared burst (alpha+beta) and a later beta-only turn.
    state.index = makeIndex(
      [turnEntry('burst', 'alpha beta reviewed together', 30, [alpha, beta], 0, 6), turnEntry('later-beta', 'beta revisited separately', 20, [beta], 6, raw.length)],
      raw.length,
    );

    // Pass 1: claim alpha → matches the burst entry. Card injected; residency
    // keys on matchedPath (alpha), NOT the zone.
    const out1 = buildFoldRecallContext(state, raw, extractRecallSignals(null, new Set([ABS(alpha)])), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out1.cards).toBe(1);
    expect(out1.text!).toContain('trigger: claim relay/src/alpha.ts');

    // Pass 2: claim beta → the burst entry is entry-resident (suppressed), but
    // the later-beta entry is a different entry and must still produce a card.
    // If residency incorrectly used the zone, beta would be path-resident from
    // pass 1 and the later-beta entry would be suppressed too.
    const out2 = buildFoldRecallContext(state, raw, extractRecallSignals(null, new Set([ABS(beta)])), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out2.cards).toBe(1);
    expect(out2.text!).toContain('trigger: claim relay/src/beta.ts');
  });

  test('wide burst: enrichment is proximity-ordered and top-K capped, body is not', () => {
    const core = 'relay/src/core.ts';
    const helper = 'relay/src/helper.ts';
    const extra = 'relay/src/utils/extra.ts';
    const pkg = 'package.json';
    const raw: FoldMessage[] = [
      userMsg('Read core, helper, utils, and package.json together'),
      anthropicToolUse('tu_core', 'Read', { file_path: ABS(core) }),
      anthropicToolResult('tu_core', 'CORE OLD CONTENT'),
      anthropicToolUse('tu_helper', 'Read', { file_path: ABS(helper) }),
      anthropicToolResult('tu_helper', 'HELPER OLD CONTENT'),
      anthropicToolUse('tu_extra', 'Read', { file_path: ABS(extra) }),
      anthropicToolResult('tu_extra', 'EXTRA OLD CONTENT'),
      anthropicToolUse('tu_pkg', 'Read', { file_path: ABS(pkg) }),
      anthropicToolResult('tu_pkg', 'PACKAGE CONFIG'),
      assistantMsg('Core, helper, extra, and package config reviewed together.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([turnEntry('burst', 'core helper extra pkg reviewed', 30, [core, helper, extra, pkg], 0, raw.length)], raw.length);
    // Highlights for all 4 paths so enrichment (radar) is observable.
    state.pathHighlights.set(core, [{ label: 'CORE-ANCHOR', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(helper, [{ label: 'HELPER-SIBLING', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(extra, [{ label: 'EXTRA-NESTED', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(pkg, [{ label: 'PKG-INCIDENTAL', startLine: 10, endLine: 20 }]);

    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ file_path: ABS(core) }, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    // Body is uncapped: all 4 tool-result bodies are present.
    expect(out.text!).toContain('CORE OLD CONTENT');
    expect(out.text!).toContain('HELPER OLD CONTENT');
    expect(out.text!).toContain('EXTRA OLD CONTENT');
    expect(out.text!).toContain('PACKAGE CONFIG');
    // Enrichment is proximity-ordered + top-K capped (K=3).
    // Anchor (core) and same-dir siblings (helper, extra) rank in top-3.
    expect(out.text!).toContain('CORE-ANCHOR');
    expect(out.text!).toContain('HELPER-SIBLING');
    expect(out.text!).toContain('EXTRA-NESTED');
    // Cross-cluster incidental (package.json, sharedPrefix=0) is sorted last
    // and excluded from the top-K enrichment cap.
    expect(out.text!).not.toContain('PKG-INCIDENTAL');
  });

  test('tier-1: affinity carrier overrides proximity ordering for enrichment', () => {
    const core = 'relay/src/core.ts';
    const helper = 'relay/src/helper.ts'; // same-dir sibling (proximity=2)
    const shared = 'shared/types.ts'; // cross-cluster (proximity=0)
    const raw: FoldMessage[] = [
      userMsg('Read core, helper, and shared types together'),
      anthropicToolUse('tu_core', 'Read', { file_path: ABS(core) }),
      anthropicToolResult('tu_core', 'CORE OLD CONTENT'),
      anthropicToolUse('tu_helper', 'Read', { file_path: ABS(helper) }),
      anthropicToolResult('tu_helper', 'HELPER OLD CONTENT'),
      anthropicToolUse('tu_shared', 'Read', { file_path: ABS(shared) }),
      anthropicToolResult('tu_shared', 'SHARED OLD CONTENT'),
      assistantMsg('Core, helper, and shared types reviewed together.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([turnEntry('burst', 'core helper shared reviewed', 30, [core, helper, shared], 0, raw.length)], raw.length);
    // Highlights for all 3 paths.
    state.pathHighlights.set(core, [{ label: 'CORE-ANCHOR', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(helper, [{ label: 'HELPER-SIBLING', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(shared, [{ label: 'SHARED-TYPE', startLine: 10, endLine: 20 }]);
    // Affinity carrier: shared has HIGH affinity to core (0.9), helper LOW (0.1).
    // Proximity alone would rank helper above shared, but affinity overrides.
    state.pathAffinity.set(`${core}\x00${shared}`, 0.9);
    state.pathAffinity.set(`${core}\x00${helper}`, 0.1);

    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ file_path: ABS(core) }, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    // All bodies present (uncapped).
    expect(out.text!).toContain('CORE OLD CONTENT');
    expect(out.text!).toContain('HELPER OLD CONTENT');
    expect(out.text!).toContain('SHARED OLD CONTENT');
    // Enrichment is affinity-ordered: anchor (core) + shared (0.9) make top-2,
    // helper (0.1) is third. With K=3 all three fit, but the key assertion is
    // that SHARED-TYPE radar appears (it would be excluded under tier-0 proximity
    // if K<3, since shared is cross-cluster). More importantly, the ranking is
    // by affinity not proximity: shared ranks above helper.
    expect(out.text!).toContain('CORE-ANCHOR');
    expect(out.text!).toContain('SHARED-TYPE');
    expect(out.text!).toContain('HELPER-SIBLING');
    // Verify affinity ordering: SHARED-TYPE should appear before HELPER-SIBLING
    // in the radar output (higher affinity ranks first).
    const sharedIdx = out.text!.indexOf('SHARED-TYPE');
    const helperIdx = out.text!.indexOf('HELPER-SIBLING');
    expect(sharedIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(sharedIdx).toBeLessThan(helperIdx);
  });

  test('tier-1: empty affinity carrier falls back to proximity ordering', () => {
    const core = 'relay/src/core.ts';
    const helper = 'relay/src/helper.ts';
    const extra = 'relay/src/utils/extra.ts';
    const pkg = 'package.json';
    const raw: FoldMessage[] = [
      userMsg('Read core, helper, extra, and package.json together'),
      anthropicToolUse('tu_core', 'Read', { file_path: ABS(core) }),
      anthropicToolResult('tu_core', 'CORE OLD CONTENT'),
      anthropicToolUse('tu_helper', 'Read', { file_path: ABS(helper) }),
      anthropicToolResult('tu_helper', 'HELPER OLD CONTENT'),
      anthropicToolUse('tu_extra', 'Read', { file_path: ABS(extra) }),
      anthropicToolResult('tu_extra', 'EXTRA OLD CONTENT'),
      anthropicToolUse('tu_pkg', 'Read', { file_path: ABS(pkg) }),
      anthropicToolResult('tu_pkg', 'PACKAGE CONFIG'),
      assistantMsg('Core, helper, extra, and package config reviewed together.'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex([turnEntry('burst', 'core helper extra pkg reviewed', 30, [core, helper, extra, pkg], 0, raw.length)], raw.length);
    // pathAffinity is empty (default) → tier-0 proximity fallback.
    state.pathHighlights.set(core, [{ label: 'CORE-ANCHOR', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(helper, [{ label: 'HELPER-SIBLING', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(extra, [{ label: 'EXTRA-NESTED', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(pkg, [{ label: 'PKG-INCIDENTAL', startLine: 10, endLine: 20 }]);

    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ file_path: ABS(core) }, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    // Proximity fallback: same-dir siblings in top-K=3, cross-cluster excluded.
    expect(out.text!).toContain('CORE-ANCHOR');
    expect(out.text!).toContain('HELPER-SIBLING');
    expect(out.text!).toContain('EXTRA-NESTED');
    expect(out.text!).not.toContain('PKG-INCIDENTAL');
  });

  test('tier-1: behaviorally-cold zone keeps tier-0 proximity even when carrier is non-empty (F7 regression)', () => {
    const core = 'relay/src/core.ts';
    const helper = 'relay/src/helper.ts';
    const extra = 'relay/src/utils/extra.ts';
    const pkg = 'package.json';
    const raw: FoldMessage[] = [
      userMsg('Read core, package.json, helper, and extra together'),
      anthropicToolUse('tu_core', 'Read', { file_path: ABS(core) }),
      anthropicToolResult('tu_core', 'CORE OLD CONTENT'),
      anthropicToolUse('tu_pkg', 'Read', { file_path: ABS(pkg) }),
      anthropicToolResult('tu_pkg', 'PACKAGE CONFIG'),
      anthropicToolUse('tu_helper', 'Read', { file_path: ABS(helper) }),
      anthropicToolResult('tu_helper', 'HELPER OLD CONTENT'),
      anthropicToolUse('tu_extra', 'Read', { file_path: ABS(extra) }),
      anthropicToolResult('tu_extra', 'EXTRA OLD CONTENT'),
      assistantMsg('Core, package, helper, and extra reviewed together.'),
    ];
    const state = createFoldRecallState();
    // Insertion order deliberately puts cross-cluster pkg SECOND, so the old
    // insertion-order tie-break would rank pkg into top-K and drop extra.
    state.index = makeIndex([turnEntry('burst', 'core pkg helper extra reviewed', 30, [core, pkg, helper, extra], 0, raw.length)], raw.length);
    state.pathHighlights.set(core, [{ label: 'CORE-ANCHOR', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(helper, [{ label: 'HELPER-SIBLING', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(extra, [{ label: 'EXTRA-NESTED', startLine: 10, endLine: 20 }]);
    state.pathHighlights.set(pkg, [{ label: 'PKG-INCIDENTAL', startLine: 10, endLine: 20 }]);
    // Carrier is NON-EMPTY, but only for an UNRELATED anchor — core's zone has no
    // affinity entries. Pre-F7 this forced insertion-order ranking (losing tier-0
    // proximity); post-F7 it falls back to proximity per-anchor.
    state.pathAffinity.set('unrelated/anchor.ts\x00unrelated/zone.ts', 0.9);

    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ file_path: ABS(core) }, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(1);
    // Proximity preserved: anchor + same-dir siblings make top-K=3; cross-cluster
    // pkg is excluded, NOT crowded in by insertion order.
    expect(out.text!).toContain('CORE-ANCHOR');
    expect(out.text!).toContain('HELPER-SIBLING');
    expect(out.text!).toContain('EXTRA-NESTED');
    expect(out.text!).not.toContain('PKG-INCIDENTAL');
  });

  test('tier-1 claim on a folded path pages content in', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const signals = extractRecallSignals(null, new Set([ABS(BIGFILE)]));
    const out = buildFoldRecallContext(state, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.text!).toContain('trigger: claim relay/src/bigfile.ts');
  });

  test('tier-2 term overlap can render a card without any path signal when flag-enabled', () => {
    const raw: FoldMessage[] = [
      userMsg('Can the rebirth reel adapt after a pivot?'),
      assistantMsg('The pathless demand-paging reel now follows the live vocabulary.'),
      userMsg('Filler turn one'),
      assistantMsg('context fold system filler'),
      userMsg('Filler turn two'),
      assistantMsg('context fold system filler'),
    ];
    const state = createFoldRecallState();
    state.index = makeIndex(
      [
        turnEntry('target', 'pathless demand-paging reel now follows live vocabulary', 30, [], 0, 2),
        turnEntry('common-a', 'context fold system filler', 20, [], 2, 4),
        turnEntry('common-b', 'context fold system filler', 10, [], 4, 6),
      ],
      raw.length,
    );
    const out = buildFoldRecallContext(state, raw, extractRecallSignals(null, new Set(), 'pathless demand-paging reel'), 'healthy', {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      termRecallEnabled: true,
    });
    expect(out.cards).toBe(1);
    expect(out.triggers).toEqual(['term-overlap pathless, demand-pag, reel']);
    expect(out.text).toContain('pathless demand-paging reel now follows');
  });

  test('claim residency suppresses while the exact prior card is visible; view absence re-enables', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 3 };

    const first = buildFoldRecallContext(state, raw, claimBigfile(), 'healthy', config);
    expect(first.cards).toBe(1);

    raw.push(anthropicToolUse('tu_visible_bigfile', 'Read', { file_path: ABS(BIGFILE) }));
    raw.push(anthropicToolResult('tu_visible_bigfile', `fresh read output\n\n${first.text}`));
    state.index = { ...indexFor(raw), visibleRecallCards: [first.text!] };

    const visible = buildFoldRecallContext(state, raw, claimBigfile(), 'healthy', config);
    expect(visible.text).toContain('[Fold recall suppressed manifest');
    expect(visible.suppressed).toBeGreaterThan(0);

    // Burn passes with non-matching (but non-empty) signals past the old TTL.
    const unrelated = extractRecallSignals({ file_path: ABS('relay/src/unrelated.ts') }, new Set());
    for (let i = 0; i < config.ttlPasses + 1; i++) {
      buildFoldRecallContext(state, raw, unrelated, 'healthy', config);
    }

    const stillVisible = buildFoldRecallContext(state, raw, claimBigfile(), 'healthy', config);
    expect(stillVisible.text).toContain('[Fold recall suppressed manifest');
    expect(stillVisible.suppressed).toBeGreaterThan(0);

    state.index = { ...indexFor(raw), visibleRecallCards: [] };
    const absent = buildFoldRecallContext(state, raw, claimBigfile(), 'healthy', config);
    expect(absent.cards).toBeGreaterThan(0);
  });

  test('sliding claim residency keeps repeated matching signals suppressed', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 3 };
    const signals = claimBigfile();

    let cards = 0;
    let suppressed = 0;
    for (let i = 0; i < 30; i++) {
      const out = buildFoldRecallContext(state, raw, signals, 'healthy', config);
      cards += out.cards;
      suppressed += out.suppressed;
    }

    expect(cards).toBe(1);
    expect(suppressed).toBe(29);
    expect(state.cardsInjected).toBe(1);
  });

  test('idle residency expiry still re-enables recall', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 3 };
    const signals = claimBigfile();
    const unrelated = extractRecallSignals({ file_path: ABS('relay/src/unrelated.ts') }, new Set());

    expect(buildFoldRecallContext(state, raw, signals, 'healthy', config).cards).toBe(1);
    for (let i = 0; i < config.ttlPasses + 1; i++) {
      buildFoldRecallContext(state, raw, unrelated, 'healthy', config);
    }

    expect(buildFoldRecallContext(state, raw, signals, 'healthy', config).cards).toBe(1);
  });

  test('sliding claim-path residency survives rebuild only while the exact card remains visible', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 3 };
    const signals = claimBigfile();

    const first = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(first.cards).toBe(1);

    raw.push(anthropicToolUse('tu_touch_path', 'Read', { file_path: ABS(BIGFILE) }));
    raw.push(anthropicToolResult('tu_touch_path', `fresh read output\n\n${first.text}`));
    raw.push(userMsg('continue'));
    raw.push(assistantMsg('Continuing.'));
    state.index = { ...indexFor(raw), visibleRecallCards: [first.text!] };

    let cardsAfterRebuild = 0;
    let suppressedAfterRebuild = 0;
    for (let i = 0; i < 30; i++) {
      const out = buildFoldRecallContext(state, raw, signals, 'healthy', config);
      cardsAfterRebuild += out.cards;
      suppressedAfterRebuild += out.suppressed;
    }

    expect(cardsAfterRebuild).toBe(0);
    expect(suppressedAfterRebuild).toBeGreaterThanOrEqual(30);
    expect(state.cardsInjected).toBe(1);

    state.index = { ...indexFor(raw), visibleRecallCards: [] };
    const absent = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(absent.cards).toBeGreaterThan(0);
  });

  test('claim auto_compact injects a hint; the next hard trigger at healthy escalates it to a card', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);

    const hinted = buildFoldRecallContext(state, raw, claimBigfile(), 'auto_compact', DEFAULT_FOLD_RECALL_CONFIG);
    expect(hinted.cards).toBe(0);
    expect(hinted.hints).toBe(1);
    expect(hinted.text!).toContain(RECALL_HINT_PREFIX);
    expect(hinted.text!).not.toContain('BIGFILE CONTENT START');

    const escalated = buildFoldRecallContext(state, raw, claimBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(escalated.cards).toBe(1);
    expect(escalated.hints).toBe(0);
    expect(escalated.text!).toContain('BIGFILE CONTENT START');
  });

  test('does not replay an exact hint that survived an index rebuild in provider POV', () => {
    const raw = buildAnthropicHistory();
    const firstState = freshState(raw);
    const first = buildFoldRecallContext(firstState, raw, claimBigfile(), 'auto_compact', DEFAULT_FOLD_RECALL_CONFIG);
    expect(first.hints).toBe(1);

    const rebuilt = freshState(raw);
    rebuilt.index = {
      ...rebuilt.index!,
      visiblePovText: normalizeFoldRecallPovText(first.text!),
    };
    const repeated = buildFoldRecallContext(rebuilt, raw, claimBigfile(), 'auto_compact', DEFAULT_FOLD_RECALL_CONFIG);

    expect(repeated.text).toContain('[Fold recall suppressed manifest');
    expect(repeated.hints).toBe(0);
    expect(repeated.suppressed).toBe(1);
  });

  test('resident hints slide under critical pressure instead of storming duplicates', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, maxTotalChars: 1_200, ttlPasses: 3 };
    const signals = touchBigfile();

    let hints = 0;
    let suppressed = 0;
    for (let i = 0; i < 10; i++) {
      const out = buildFoldRecallContext(state, raw, signals, 'critical', config);
      hints += out.hints;
      suppressed += out.suppressed;
    }

    expect(hints).toBe(1);
    expect(suppressed).toBe(9);
    expect(state.hintsInjected).toBe(1);
  });

  test('measured char budget downgrades overflowing cards to hints', () => {
    const raw = buildAnthropicHistory();

    // Measure the natural card size for this trigger, then craft a budget
    // that fits one card plus a hint but not two cards.
    const probeState = freshIntraState(raw);
    const probe = buildFoldRecallContext(
      probeState,
      raw,
      extractRecallSignals({ paths: [ABS('relay/src/helper0.ts'), ABS('relay/src/helper1.ts')] }, new Set()),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(probe.cards).toBe(2);

    const oneCardChars = Math.ceil(probe.chars / 2);
    const state = freshIntraState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, maxTotalChars: oneCardChars + 300 };
    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ paths: [ABS('relay/src/helper0.ts'), ABS('relay/src/helper1.ts')] }, new Set()), 'healthy', config);
    expect(out.cards).toBe(1);
    expect(out.hints).toBe(1);
    expect(out.text!).toContain(RECALL_CARD_PREFIX);
    expect(out.text!).toContain(RECALL_HINT_PREFIX);
  });

  test('intra-turn entry recalls the ORIGINAL pre-fold tool result body by tool id', () => {
    const raw = buildAnthropicHistory();
    const state = freshIntraState(raw);
    const out = buildFoldRecallContext(state, raw, extractRecallSignals({ file_path: ABS('relay/src/helper0.ts') }, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.text!).toContain('Read relay/src/helper0.ts');
    expect(out.text!).toContain('HELPER0 BODY');
  });

  test('empty signals, stale (rewound) raw, and disabled config are all no-ops', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);

    const empty = buildFoldRecallContext(state, raw, extractRecallSignals(null, new Set()), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(empty.text).toBeNull();

    const rewound = buildFoldRecallContext(state, raw.slice(0, 2), touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(rewound.text).toBeNull();

    const disabled = buildFoldRecallContext(state, raw, touchBigfile(), 'healthy', {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      enabled: false,
    });
    expect(disabled.text).toBeNull();
    expect(state.passSeq).toBe(0); // all three calls are guard no-ops — no pass consumed
  });

  test('byte-identical determinism: identical fresh states and inputs render identical bytes', () => {
    const raw = buildAnthropicHistory();
    const a = buildFoldRecallContext(freshState(raw), raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    const b = buildFoldRecallContext(freshState(raw), raw, touchBigfile(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(a.text).toBe(b.text);
    expect(a.chars).toBe(b.chars);
  });

  // ── Repeat-recall card shrink (rail-c63e326e s6) ──

  test('repeat-recall shrink: unchanged content shrinks card body chars on each same-session repeat', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    // Force truncation to become visible: BIGFILE_CONTENT is ~3,044 chars, so a
    // maxCardChars small enough to truncate on pass 1 makes each shrink step
    // observable in out.chars instead of hiding under an already-full budget.
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 1, maxCardChars: 3_000 };
    const signals = touchBigfile();

    const first = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(first.cards).toBe(1);
    expect(state.pathCardShowCounts.get(BIGFILE)).toBe(1);

    // ttlPasses: 1 expires residency every pass, so the same path re-cards.
    const second = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(second.cards).toBe(1);
    expect(state.pathCardShowCounts.get(BIGFILE)).toBe(2);
    expect(second.chars).toBeLessThan(first.chars);

    const third = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(third.cards).toBe(1);
    expect(state.pathCardShowCounts.get(BIGFILE)).toBe(3);
    expect(third.chars).toBeLessThan(second.chars);
  });

  test('repeat-recall shrink: ratio floors at REPEAT_CARD_MIN_RATIO instead of vanishing', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 1, maxCardChars: 3_000 };
    const signals = touchBigfile();

    let last = Infinity;
    for (let i = 0; i < 8; i++) {
      const out = buildFoldRecallContext(state, raw, signals, 'healthy', config);
      // Every repeat either downgrades to hint (still non-empty) or shrinks a
      // strictly smaller-or-equal card once the floor ratio is reached — it
      // never grows back and never disappears while still matched.
      expect(out.text).not.toBeNull();
      expect(out.chars).toBeLessThanOrEqual(last);
      last = out.chars;
    }
    // Never shrinks a card below the floor: maxCardChars * REPEAT_CARD_MIN_RATIO.
    expect(repeatCardBudgetRatio(50)).toBe(REPEAT_CARD_MIN_RATIO);
  });

  test('repeat-recall shrink: no loss of correctness — a genuine live-source change resets to full body budget', () => {
    const raw = buildAnthropicHistory();
    const state = freshState(raw);
    const config: FoldRecallConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, ttlPasses: 1, maxCardChars: 3_000 };
    const signals = touchBigfile();

    // Warm up two unchanged repeats so the shrink has visibly taken hold.
    const first = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    const second = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(second.chars).toBeLessThan(first.chars);
    expect(state.pathCardShowCounts.get(BIGFILE)).toBe(2);

    // Relay signals a genuine live-source change since the prior pass — this
    // is the correctness guard: shrink must NOT apply to genuinely changed
    // content, even though priorShowCount is already 2. The change is a
    // genuine append (shared prefix) so it clears the context floor.
    state.pathSourceDeltas.set(BIGFILE, {
      path: BIGFILE,
      liveHash: 'changed-hash',
      liveSource: `${BIGFILE_CONTENT}\nNEW TRAILING LINE ON DISK\nANOTHER NEW LINE ADDED SINCE THE FOLD`,
      stableSincePrior: false,
    });
    const third = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(third.cards).toBe(1);
    expect(state.pathCardShowCounts.get(BIGFILE)).toBe(3);
    expect(third.text!).toContain('Δ Source changed since fold');
    // Full (unshrunk) body budget used again despite priorShowCount=2.
    expect(third.chars).toBeGreaterThan(second.chars);
  });

  test('repeatCardBudgetRatio: pure arithmetic matches the documented shrink/floor contract', () => {
    expect(repeatCardBudgetRatio(0)).toBe(1);
    expect(repeatCardBudgetRatio(-1)).toBe(1);
    expect(repeatCardBudgetRatio(1)).toBe(REPEAT_CARD_SHRINK_RATIO);
    expect(repeatCardBudgetRatio(2)).toBeCloseTo(REPEAT_CARD_SHRINK_RATIO ** 2, 10);
    expect(repeatCardBudgetRatio(10)).toBe(REPEAT_CARD_MIN_RATIO);
    // Monotonically non-increasing as priorShowCount grows.
    let prev = repeatCardBudgetRatio(0);
    for (let n = 1; n <= 12; n++) {
      const cur = repeatCardBudgetRatio(n);
      expect(cur).toBeLessThanOrEqual(prev);
      prev = cur;
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// Excerpting + recovery helpers
// ══════════════════════════════════════════════════════════════════════

describe('excerptForRecall', () => {
  test('returns short text unchanged', () => {
    expect(excerptForRecall('short', 100)).toBe('short');
  });

  test('head+tail excerpt carries an omission note', () => {
    const text = 'H'.repeat(5_000) + 'MIDDLE' + 'T'.repeat(5_000);
    const out = excerptForRecall(text, 1_000);
    expect(out.length).toBeLessThan(1_200);
    expect(out).toContain('chars omitted — self-tap for full content');
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
  });

  test('never splits surrogate pairs on multibyte content', () => {
    const text = '🦀'.repeat(2_000); // 4,000 UTF-16 units
    for (const max of [999, 1000, 1001, 333]) {
      const out = excerptForRecall(text, max);
      expect(LONE_SURROGATE_RE.test(out)).toBe(false);
    }
  });
});

describe('findToolResultText', () => {
  test('recovers Anthropic block content and OpenAI tool message content by id', () => {
    const msgs: FoldMessage[] = [anthropicToolResult('tu_x', 'ANTHROPIC BODY'), openaiToolResult('call_y', 'OPENAI BODY')];
    expect(findToolResultText(msgs, 'tu_x')).toBe('ANTHROPIC BODY');
    expect(findToolResultText(msgs, 'call_y')).toBe('OPENAI BODY');
    expect(findToolResultText(msgs, 'missing')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// Config resolution
// ══════════════════════════════════════════════════════════════════════

describe('resolveFoldRecallConfig', () => {
  test('default ON with documented defaults', () => {
    const config = resolveFoldRecallConfig({});
    expect(config).toEqual(DEFAULT_FOLD_RECALL_CONFIG);
  });

  test('kill switch and numeric overrides', () => {
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL: '0' }).enabled).toBe(false);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL: 'off' }).enabled).toBe(false);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL: 'false' }).enabled).toBe(false);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL: '1' }).enabled).toBe(true);
    const tuned = resolveFoldRecallConfig({
      WARP_FOLD_RECALL_MAX_CARDS: '5',
      WARP_FOLD_RECALL_MAX_TOTAL_CHARS: '20000',
      WARP_FOLD_RECALL_MAX_CARD_CHARS: '9000',
      WARP_FOLD_RECALL_TTL_PASSES: '12',
    });
    expect(tuned.maxCards).toBe(5);
    expect(tuned.maxTotalChars).toBe(20_000);
    expect(tuned.maxCardChars).toBe(9_000);
    expect(tuned.ttlPasses).toBe(12);
    expect(tuned.termRecallEnabled).toBe(true);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_TERMS: '0' }).termRecallEnabled).toBe(false);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_TERMS: 'off' }).termRecallEnabled).toBe(false);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_TERMS: '1' }).termRecallEnabled).toBe(true);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_TERMS: 'on' }).termRecallEnabled).toBe(true);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_MAX_CARDS: 'junk' }).maxCards).toBe(3);
    // Verbatim tier is default ON; only explicit disable values turn it off.
    expect(tuned.verbatimRecallEnabled).toBe(true);
    expect(resolveFoldRecallConfig({}).verbatimRecallEnabled).toBe(true);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_VERBATIM: '0' }).verbatimRecallEnabled).toBe(false);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_VERBATIM: 'off' }).verbatimRecallEnabled).toBe(false);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_VERBATIM: 'false' }).verbatimRecallEnabled).toBe(false);
    expect(resolveFoldRecallConfig({ WARP_FOLD_RECALL_VERBATIM: '1' }).verbatimRecallEnabled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Feedback-loop + rebuild-survival guards (regressions caught by integration)
// ══════════════════════════════════════════════════════════════════════

describe('stripRecallBlocks', () => {
  test('removes embedded cards and hints, keeps surrounding content', () => {
    const text = [
      'fresh read output',
      '',
      `${RECALL_CARD_PREFIX} Read relay/src/x.ts | trigger: path-touch relay/src/x.ts | 5,000 chars folded]`,
      'stale recalled body',
      '[End fold recall]',
      'trailing real content',
      `${RECALL_HINT_PREFIX} Read relay/src/y.ts folded earlier (1,000 chars) | trigger: claim relay/src/y.ts | self-tap to recover]`,
    ].join('\n');
    const out = stripRecallBlocks(text);
    expect(out).toContain('fresh read output');
    expect(out).toContain('trailing real content');
    expect(out).not.toContain('stale recalled body');
    expect(out).not.toContain(RECALL_CARD_PREFIX);
    expect(out).not.toContain(RECALL_HINT_PREFIX);
  });

  test('text without recall blocks passes through unchanged', () => {
    const text = 'plain content\nwith lines';
    expect(stripRecallBlocks(text)).toBe(text);
  });
});

describe('recall feedback-loop + rebuild-survival', () => {
  test('path residency survives an index rebuild (same content, new entry id) and recalled bodies never nest cards', () => {
    const raw = buildAnthropicHistory();
    const state = createFoldRecallState();
    state.index = indexFor(raw);
    const config = DEFAULT_FOLD_RECALL_CONFIG;
    const signals = extractRecallSignals(null, new Set([ABS(BIGFILE)]));

    // First recall card for the bigfile turn.
    const first = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(first.cards).toBe(1);

    // The dispatcher appends the card to a fresh tool result; a new turn
    // follows; the fold re-runs (epoch) and the index is rebuilt — the
    // touch-turn now ALSO carries the bigfile path under a NEW entry id.
    raw.push(anthropicToolUse('tu_touch', 'Read', { file_path: ABS(BIGFILE) }));
    raw.push(anthropicToolResult('tu_touch', `fresh read output\n\n${first.text}`));
    raw.push(userMsg('next item of work please'));
    raw.push(assistantMsg('Working the next item now.'));
    state.index = { ...indexFor(raw), visibleRecallCards: [first.text!] };

    // Immediate re-claim: suppressed by PATH residency despite the new entry ids.
    const second = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(second.text).toContain('[Fold recall suppressed manifest');
    expect(second.suppressed).toBeGreaterThan(0);

    // After the TTL lapses, the still-visible prior card continues suppressing.
    const unrelated = extractRecallSignals({ file_path: ABS('relay/src/other.ts') }, new Set());
    for (let i = 0; i < config.ttlPasses; i++) {
      buildFoldRecallContext(state, raw, unrelated, 'healthy', config);
    }
    const stillVisible = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(stillVisible.text).toContain('[Fold recall suppressed manifest');
    expect(stillVisible.suppressed).toBeGreaterThan(0);

    // Once the rebuilt view no longer contains the exact card, recall returns —
    // and the re-recalled body must contain the original payload but never a nested card.
    state.index = { ...indexFor(raw), visibleRecallCards: [] };
    const third = buildFoldRecallContext(state, raw, signals, 'healthy', config);
    expect(third.cards).toBeGreaterThan(0);
    const occurrences = third.text!.split(RECALL_CARD_PREFIX).length - 1;
    expect(occurrences).toBe(third.cards); // headers only — no nested stale cards
    expect(third.text!).not.toContain('[End fold recall]\n[End fold recall]');
  });
});

// ══════════════════════════════════════════════════════════════════════
// Bash path extraction — extractPathsFromBashCommand
// ══════════════════════════════════════════════════════════════════════

describe('extractPathsFromBashCommand', () => {
  test('absolute my-monorepo path is normalized to repo-relative', () => {
    expect(extractPathsFromBashCommand(`cat ${ABS(BIGFILE)}`)).toEqual([BIGFILE]);
  });

  test('repo-relative path (no home prefix) passes through unchanged', () => {
    expect(extractPathsFromBashCommand('cat relay/src/foldRecall.ts')).toEqual(['relay/src/foldRecall.ts']);
  });

  test('single-quoted path containing spaces is treated as one token', () => {
    const abs = ABS('relay/src/my file.ts');
    const result = extractPathsFromBashCommand(`cat '${abs}'`);
    expect(result).toEqual(['relay/src/my file.ts']);
  });

  test('flag tokens starting with - are ignored', () => {
    expect(extractPathsFromBashCommand(`grep -rn pattern ${ABS(BIGFILE)}`)).toEqual([BIGFILE]);
  });

  test('URL tokens containing :// are rejected', () => {
    expect(extractPathsFromBashCommand('curl https://example.com/api/path')).toEqual([]);
  });

  test('redirect and /dev tokens are rejected while real paths survive', () => {
    expect(extractPathsFromBashCommand('grep -n foo relay/src/x.ts 2>/dev/null')).toEqual(['relay/src/x.ts']);
    expect(extractPathsFromBashCommand('cmd >/dev/null 2>&1')).toEqual([]);
    expect(extractPathsFromBashCommand('cat /dev/null')).toEqual([]);
    expect(extractPathsFromBashCommand('echo hi >> logs/out.txt')).toEqual(['logs/out.txt']);
    expect(extractPathsFromBashCommand('echo hi >>logs/out.txt')).toEqual([]);
    expect(extractPathsFromBashCommand('ls a/b.ts c/d.ts')).toEqual(['a/b.ts', 'c/d.ts']);
  });

  test('redirect target after > is captured as a separate token', () => {
    const result = extractPathsFromBashCommand(`cat ${ABS(BIGFILE)} > /tmp/out.txt`);
    expect(result).toContain(BIGFILE);
    expect(result).toContain('/tmp/out.txt');
  });

  test('duplicate paths are deduped; first-occurrence order preserved', () => {
    const cmd = `diff ${ABS(BIGFILE)} ${ABS(BIGFILE)}`;
    expect(extractPathsFromBashCommand(cmd)).toEqual([BIGFILE]);
  });

  test('cap at 4 paths per command; first four win', () => {
    const paths = Array.from({ length: 5 }, (_, i) => ABS(`relay/src/file${i}.ts`));
    const result = extractPathsFromBashCommand(paths.join(' '));
    expect(result).toHaveLength(4);
    expect(result[0]).toBe('relay/src/file0.ts');
    expect(result[3]).toBe('relay/src/file3.ts');
  });

  test('multibyte command produces no lone surrogates in extracted paths', () => {
    const cmd = `cat '${ABS('relay/src/🦀emoji.ts')}'`;
    const result = extractPathsFromBashCommand(cmd);
    for (const p of result) {
      expect(LONE_SURROGATE_RE.test(p)).toBe(false);
    }
  });

  test('empty command returns empty array', () => {
    expect(extractPathsFromBashCommand('')).toEqual([]);
  });

  test('token without / is ignored', () => {
    expect(extractPathsFromBashCommand('echo hello world')).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Bash path participation — seam tests
// ══════════════════════════════════════════════════════════════════════

/**
 * Mirror of buildAnthropicHistory() using Bash with command instead of
 * Read with file_path — same turn structure, content sizes, fold trigger.
 */
function buildBashHistory(): FoldMessage[] {
  const msgs: FoldMessage[] = [];
  msgs.push(userMsg('Read the source file'));
  msgs.push(anthropicToolUse('tu_bash', 'Bash', { command: `cat ${ABS(BIGFILE)}` }));
  msgs.push(anthropicToolResult('tu_bash', BIGFILE_CONTENT));
  msgs.push(assistantMsg('Found the bug in bigfile.ts via bash read.'));
  msgs.push(userMsg('Now check the helpers'));
  for (let i = 0; i < 7; i++) {
    msgs.push(anthropicToolUse(`tu_bh${i}`, 'Bash', { command: `cat ${ABS(`relay/src/helper${i}.ts`)}` }));
    msgs.push(anthropicToolResult(`tu_bh${i}`, `HELPER${i} BODY ` + 'y'.repeat(2_500)));
  }
  msgs.push(assistantMsg('All helpers checked via bash.'));
  return msgs;
}

/** OAI run_bash variant (function-calling format). */
function buildOpenAIRunBashHistory(): FoldMessage[] {
  const msgs: FoldMessage[] = [];
  msgs.push(userMsg('Read the source file'));
  msgs.push(openaiToolCall('call_bash', 'run_bash', { command: `cat ${ABS(BIGFILE)}` }));
  msgs.push(openaiToolResult('call_bash', BIGFILE_CONTENT));
  msgs.push(assistantMsg('Found the bug via run_bash.'));
  msgs.push(userMsg('Now check the helpers'));
  for (let i = 0; i < 7; i++) {
    msgs.push(openaiToolCall(`call_bh${i}`, 'run_bash', { command: `cat ${ABS(`relay/src/helper${i}.ts`)}` }));
    msgs.push(openaiToolResult(`call_bh${i}`, `HELPER${i} BODY ` + 'y'.repeat(2_500)));
  }
  msgs.push(assistantMsg('All helpers checked via run_bash.'));
  return msgs;
}

describe('extractRecallSignals — bash arm', () => {
  test('bash command yields touched paths', () => {
    const signals = extractRecallSignals({ command: `cat ${ABS(BIGFILE)}` }, new Set());
    expect(signals.touchedPaths).toEqual([BIGFILE]);
  });

  test('bash command and file_path contribute additively to touchedPaths, sorted', () => {
    const signals = extractRecallSignals({ file_path: ABS('relay/src/zeta.ts'), command: `cat ${ABS('relay/src/alpha.ts')}` }, new Set());
    expect(signals.touchedPaths).toEqual(['relay/src/alpha.ts', 'relay/src/zeta.ts']);
  });

  test('duplicate path from both file_path and command is deduped', () => {
    const signals = extractRecallSignals({ file_path: ABS(BIGFILE), command: `cat ${ABS(BIGFILE)}` }, new Set());
    expect(signals.touchedPaths).toEqual([BIGFILE]);
  });
});

describe('buildFoldIndex — bash-path participation', () => {
  test('Bash tool_use in an inter-folded turn contributes to entry paths', () => {
    const raw = buildBashHistory();
    const index = indexFor(raw);
    const turnEntries = index.entries.filter((e): e is InterTurnIndexEntry => e.kind === 'turn');
    expect(turnEntries).toHaveLength(2);
    expect(turnEntries.some(e => e.paths.includes(BIGFILE))).toBe(true);
  });

  test('run_bash (OpenAI format) in an inter-folded turn contributes to entry paths', () => {
    const raw = buildOpenAIRunBashHistory();
    const index = indexFor(raw);
    const turnEntries = index.entries.filter((e): e is InterTurnIndexEntry => e.kind === 'turn');
    expect(turnEntries).toHaveLength(2);
    expect(turnEntries.some(e => e.paths.includes(BIGFILE))).toBe(true);
  });
});

describe('buildFoldRecallContext — bash-path participation', () => {
  test('tier-0 path re-touch via bash command fires recall card', () => {
    const raw = buildBashHistory();
    const state = createFoldRecallState();
    state.index = indexFor(raw);
    const signals = extractRecallSignals({ command: `cat ${ABS(BIGFILE)}` }, new Set());
    expect(signals.touchedPaths).toContain(BIGFILE);
    const out = buildFoldRecallContext(state, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.text!).toContain(RECALL_CARD_PREFIX);
    expect(out.text!).toContain('trigger: path-touch ' + BIGFILE);
    expect(out.text!).toContain('BIGFILE CONTENT START');
    expect(out.text!).toContain('[End fold recall]');
  });

  test('cross-modality A: structured read indexed → bash touch recalls', () => {
    const raw = buildAnthropicHistory();
    const state = createFoldRecallState();
    state.index = indexFor(raw);
    // Trigger via bash command instead of file_path
    const signals = extractRecallSignals({ command: `cat ${ABS(BIGFILE)}` }, new Set());
    const out = buildFoldRecallContext(state, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.text!).toContain('trigger: path-touch ' + BIGFILE);
    expect(out.text!).toContain('Found the bug in bigfile.ts');
  });

  test('cross-modality B: bash read indexed → structured touch recalls', () => {
    const raw = buildBashHistory();
    const state = createFoldRecallState();
    state.index = indexFor(raw);
    // Trigger via structured file_path even though history used bash
    const signals = extractRecallSignals({ file_path: ABS(BIGFILE) }, new Set());
    const out = buildFoldRecallContext(state, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.text!).toContain('trigger: path-touch ' + BIGFILE);
    expect(out.text!).toContain('BIGFILE CONTENT START');
  });

  test('byte-identical determinism on bash-flavored history', () => {
    const raw = buildBashHistory();
    const makeState = () => {
      const s = createFoldRecallState();
      s.index = indexFor(raw);
      return s;
    };
    const sig = extractRecallSignals({ command: `cat ${ABS(BIGFILE)}` }, new Set());
    const a = buildFoldRecallContext(makeState(), raw, sig, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    const b = buildFoldRecallContext(makeState(), raw, sig, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(a.text).toBe(b.text);
    expect(a.chars).toBe(b.chars);
  });
});

describe('tier-1b (BENCHED): import-graph distance booster pure helpers', () => {
  // These helpers are benched — nothing in the live pipeline calls them. The tests
  // guard the retained ranking math so it stays correct if tier-1b is ever revived.
  test('distanceToBooster: distance 0 → 1.0, ∞ → 0, linear between', () => {
    expect(distanceToBooster(0)).toBe(1.0);
    expect(distanceToBooster(Number.POSITIVE_INFINITY)).toBe(0);
    expect(distanceToBooster(6)).toBe(0);
    expect(distanceToBooster(3)).toBeCloseTo(0.5, 5);
    expect(distanceToBooster(1)).toBeCloseTo(1 - 1 / 6, 5);
  });

  test('distanceToBooster: cross-cluster (∞) is zero boost, NOT negative', () => {
    expect(distanceToBooster(Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(0);
  });

  test('blendScores: booster-only invariant — never below behavioral baseline', () => {
    expect(blendScores(0.8, 0)).toBeGreaterThanOrEqual(0.8);
    expect(blendScores(0.9, 0.1)).toBeGreaterThanOrEqual(0.9);
    expect(blendScores(0.5, 1.0)).toBeCloseTo(0.65, 5);
  });

  test('blendScores: cold-start (behavioral=0) uses import booster as fallback', () => {
    const score = blendScores(0, 1.0);
    expect(score).toBeCloseTo(0.3, 5);
    expect(score).toBeGreaterThan(0);
  });

  test('blendScores: all scores clamped to [0, 1]', () => {
    expect(blendScores(1, 1)).toBeLessThanOrEqual(1);
    expect(blendScores(1, 1)).toBeGreaterThanOrEqual(0);
    expect(blendScores(0, 0)).toBeGreaterThanOrEqual(0);
  });

  test('blendScores: cross-cluster paths (∞ distance) get zero boost but no penalty', () => {
    expect(blendScores(0.6, 0)).toBeCloseTo(0.6, 5);
  });

  test('booster raises score above behavioral-only baseline', () => {
    const noBoost = blendScores(0.5, 0);
    const withBoost = blendScores(0.5, 1.0);
    expect(withBoost).toBeGreaterThan(noBoost);
  });
});
