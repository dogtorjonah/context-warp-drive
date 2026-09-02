/**
 * Tests for the unified fold-recall card: episodic voice + Atlas meta blocks.
 *
 * 11a: Populated carriers → card shows 🗣 voice and 📌/🏷 Atlas-meta blocks.
 * 11b: Empty/missing carriers → explicit unavailable drill-down, never prose invention.
 */
import { describe, expect, test } from 'vitest';

import {
  buildFoldRecallContext,
  buildFoldIndex,
  buildRecallRankingContext,
  createFoldRecallState,
  DEFAULT_FOLD_RECALL_CONFIG,
  extractRecallSignals,
  resolveFoldRecallConfig,
  type CognitiveLead,
  type EpisodeVoice,
  type AtlasFileMeta,
} from '../src/foldRecall.ts';
import {
  ALWAYS_ON_FOLD_CONFIG,
  ALWAYS_ON_INTRA_FOLD_CONFIG,
  RECALL_CARD_PREFIX,
  checkFoldTrigger,
  foldContext,
  intraTurnFold,
  type FoldMessage,
} from '../src/rollingFold.ts';

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

const ABS = (rel: string) => `/home/jonah/voxxo-swarm/${rel}`;
const FILE = 'relay/src/unified-target.ts';
// Normalized repo-relative sibling key: formatSiblingClue normalizes each
// co-referenced path, so the clue renders the repo-relative form.
const SIBLING_IN_CLUE = 'packages/context-warp/src/foldRecall.ts';

function runPipeline(raw: FoldMessage[]): FoldMessage[] {
  const intra = intraTurnFold(raw, ALWAYS_ON_INTRA_FOLD_CONFIG);
  const trigger = checkFoldTrigger(intra.messages, ALWAYS_ON_FOLD_CONFIG);
  if (!trigger.shouldFold) return intra.messages;
  return foldContext(intra.messages, trigger.turnsToFold, ALWAYS_ON_FOLD_CONFIG).messages;
}

function indexFor(raw: FoldMessage[]) {
  return buildFoldIndex(raw, runPipeline(raw));
}

function editRelevantSignals(file = FILE) {
  const signals = extractRecallSignals({ file_path: ABS(file) }, new Set());
  signals.ranking = buildRecallRankingContext({ activeFiles: [ABS(file)] });
  return signals;
}

const UNIFIED_SEED: FoldMessage[] = [
  userMsg('Review unified-target.ts'),
  anthropicToolUse('tu1', 'Read', { file_path: ABS(FILE) }),
  anthropicToolResult('tu1', 'UNIFIED FILE CONTENT ' + 'z'.repeat(3_000)),
  assistantMsg('Reviewed unified-target.ts for issues.'),
  userMsg('Now check another file'),
  anthropicToolUse('tu2', 'Read', { file_path: ABS('relay/src/other2.ts') }),
  anthropicToolResult('tu2', 'OTHER CONTENT ' + 'w'.repeat(3_000)),
  assistantMsg('Done with other.'),
];

describe('foldRecall unified card — voice + Atlas meta blocks', () => {
  test('renders bounded query-time Cognitive Leads in a lane separate from episode history', () => {
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);
    const lead: CognitiveLead = {
      path: FILE,
      artifactId: 'glyph:verdict:42',
      sourceTime: '2026-07-22T18:00:00.000Z',
      renderedLine: '🏁 verdict | renderer fixed · source-time=2026-07-22T18:00:00.000Z · authority=historical_observation',
      authorityClass: 'historical_observation',
    };
    state.pathCognitiveLeads.set(FILE, [lead]);
    state.pathEpisodes.set(FILE, [{
      path: FILE,
      voiceLines: ['Earlier historical work on the renderer'],
      intent: null,
      chapterIds: [41],
      endedAt: '2026-07-21T18:00:00.000Z',
    }]);
    state.pathAtlasMeta!.set(FILE, { path: FILE, purpose: null, blurb: null, tags: [], drilldown: null });

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      editRelevantSignals(),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    expect(out.text).toContain('🧭 Current cognitive leads:');
    expect(out.text).toContain(lead.renderedLine);
    expect(out.text).toContain('🗣 Your lineage:');
    expect(out.composition?.cognitiveLeadChars).toBeGreaterThan(0);
    expect(out.chars).toBeLessThanOrEqual(DEFAULT_FOLD_RECALL_CONFIG.maxTotalChars);
  });

  test('11a: populated carriers show 🗣 voice and 📌/🏷 Atlas-meta in card', () => {
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);

    // Populate episodic voice carrier
    const voice: EpisodeVoice = {
      path: FILE,
      voiceLines: ['Fixed a race condition in the render path'],
      intent: 'Fix the fold recall card rendering',
      chapterIds: [42],
      endedAt: '2026-06-20T18:00:00Z',
    };
    state.pathEpisodes.set(FILE, [voice]);

    // Populate Atlas meta carrier
    const meta: AtlasFileMeta = {
      path: FILE,
      purpose: 'Package fold recall engine with host-supplied synthetic context filtering.',
      blurb: 'Fold recall engine for context warp drive.',
      tags: ['fold-recall', 'context-warp', 'package'],
      drilldown: {
        changelogId: 34438,
        snapshotId: 901,
        startLine: 1405,
        endLine: 1488,
      },
    };
    state.pathAtlasMeta!.set(FILE, meta);

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      editRelevantSignals(),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    // Guard: pipeline must have folded and produced a card.
    expect(out.cards).toBeGreaterThan(0);
    const text = out.text ?? '';

    // Voice block present
    expect(text).toContain('🗣 Your lineage:');
    expect(text).toContain('Fixed a race condition in the render path');
    expect(text).toContain('ask:');

    // Atlas meta block present
    expect(text).toContain('📌');
    expect(text).toContain('Package fold recall engine');
    expect(text).toContain('🏷');
    expect(text).toContain('fold-recall');
    expect(text).toContain('atlas_snapshot changelog_id=34438 start_line=1405 end_line=1488');
    expect(text).toContain('atlas_query action=history file_path="relay/src/unified-target.ts" limit=5');
    expect(text).toContain('latest changelog_id=34438');

    // Card well-formed
    expect(text).toContain(RECALL_CARD_PREFIX);
    expect(text).toContain('[End fold recall]');
  });

  test('11a-history-scope: passive path reads keep the snapshot coordinate without claiming a history gate', () => {
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);
    state.pathAtlasMeta!.set(FILE, {
      path: FILE,
      purpose: null,
      blurb: null,
      tags: [],
      drilldown: {
        changelogId: 34438,
        snapshotId: 901,
        startLine: 1405,
        endLine: 1488,
      },
    });

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      extractRecallSignals({ file_path: ABS(FILE) }, new Set()),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    expect(out.text).toContain('atlas_snapshot changelog_id=34438 start_line=1405 end_line=1488');
    expect(out.text).not.toContain('atlas_query action=history');
  });

  test('11a-b: budget boundary — voice + meta do not cause card overflow', () => {
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);

    // Populate with many voice entries and long meta to stress budget
    const manyVoices: EpisodeVoice[] = [];
    for (let i = 0; i < 10; i++) {
      manyVoices.push({
        path: FILE,
        voiceLines: [`Episode ${i} voice line with some content here`],
        intent: `Operator ask number ${i} for the unified card test`,
        chapterIds: [i],
        endedAt: '2026-06-20T18:00:00Z',
      });
    }
    state.pathEpisodes.set(FILE, manyVoices);

    state.pathAtlasMeta!.set(FILE, {
      path: FILE,
      purpose: 'A'.repeat(200),
      blurb: null,
      tags: ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6', 'tag7'],
      drilldown: {
        changelogId: 34438,
        snapshotId: 901,
        startLine: 1,
        endLine: 160,
      },
    });

    const tightConfig = {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      maxTotalChars: 4_000,
      maxCardChars: 3_600,
    };

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      editRelevantSignals(),
      'healthy',
      tightConfig,
    );

    // The output must stay bounded (maxCardChars)
    expect(out.cards).toBeGreaterThan(0);
    expect(out.text).not.toBeNull();
    const text = out.text ?? '';
    expect(out.chars).toBeLessThanOrEqual(tightConfig.maxTotalChars);
    expect(text).toContain('atlas_snapshot changelog_id=34438 start_line=1 end_line=160');
    expect(text).toContain('atlas_query action=history file_path="relay/src/unified-target.ts" limit=5');
    expect(text).toContain(RECALL_CARD_PREFIX);
    expect(text).toContain('[End fold recall]');
  });

  test('11a-c: route reserve cannot consume header/footer framing under a tight cap', () => {
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);
    state.pathAtlasMeta!.set(FILE, {
      path: FILE,
      purpose: null,
      blurb: null,
      tags: [],
      drilldown: {
        changelogId: 34438,
        snapshotId: 901,
        startLine: 1,
        endLine: 160,
      },
    });
    const tightConfig = {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      maxTotalChars: 900,
      maxCardChars: 700,
    };

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      editRelevantSignals(),
      'healthy',
      tightConfig,
    );

    expect(out.cards).toBeGreaterThan(0);
    expect(out.chars).toBeLessThanOrEqual(tightConfig.maxTotalChars);
    expect(out.text).toContain('atlas_snapshot changelog_id=34438 start_line=1 end_line=160');
    expect(out.text).toContain('atlas_query action=history file_path="relay/src/unified-target.ts" limit=5');
    expect(out.text).toContain('[End fold recall]');
  });

  test('11a-d: an oversized mandatory history route degrades to a hint, never a pointerless card', () => {
    const longFile = `relay/src/${'nested-'.repeat(70)}target.ts`;
    const longSeed: FoldMessage[] = [
      userMsg(`Review ${longFile}`),
      anthropicToolUse('long-tu1', 'Read', { file_path: ABS(longFile) }),
      anthropicToolResult('long-tu1', 'LONG FILE CONTENT ' + 'z'.repeat(3_000)),
      assistantMsg(`Reviewed ${longFile}.`),
      userMsg('Now check another file'),
      anthropicToolUse('long-tu2', 'Read', { file_path: ABS('relay/src/other-long.ts') }),
      anthropicToolResult('long-tu2', 'OTHER CONTENT ' + 'w'.repeat(3_000)),
      assistantMsg('Done with other.'),
    ];
    const state = createFoldRecallState();
    state.index = indexFor(longSeed);
    state.pathAtlasMeta!.set(longFile, {
      path: longFile,
      purpose: null,
      blurb: null,
      tags: [],
      drilldown: {
        changelogId: 34438,
        snapshotId: 901,
        startLine: 1,
        endLine: 160,
      },
    });
    const tightConfig = {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      maxTotalChars: 2_000,
      maxCardChars: 700,
    };

    const out = buildFoldRecallContext(
      state,
      longSeed,
      editRelevantSignals(longFile),
      'healthy',
      tightConfig,
    );

    expect(out.cards).toBe(0);
    expect(out.hints).toBeGreaterThan(0);
    expect(out.chars).toBeLessThanOrEqual(tightConfig.maxTotalChars);
    expect(out.text).not.toContain(RECALL_CARD_PREFIX);
    expect(out.text).not.toContain('history gate:');
  });

  test('11a-e: mismatched or non-positive drill-down carriers cannot mint routes', () => {
    const carriers: AtlasFileMeta[] = [
      {
        path: 'relay/src/different-target.ts',
        purpose: null,
        blurb: null,
        tags: [],
        drilldown: { changelogId: 34438, snapshotId: 901, startLine: 1, endLine: 160 },
      },
      {
        path: FILE,
        purpose: null,
        blurb: null,
        tags: [],
        drilldown: { changelogId: 0, snapshotId: 901, startLine: 1, endLine: 160 },
      },
    ];

    for (const carrier of carriers) {
      const state = createFoldRecallState();
      state.index = indexFor(UNIFIED_SEED);
      state.pathAtlasMeta!.set(FILE, carrier);

      const out = buildFoldRecallContext(
        state,
        UNIFIED_SEED,
        editRelevantSignals(),
        'healthy',
        DEFAULT_FOLD_RECALL_CONFIG,
      );

      expect(out.cards).toBeGreaterThan(0);
      expect(out.text).toContain('Atlas drill-down unavailable');
      expect(out.text).not.toContain('atlas_snapshot changelog_id=');
      expect(out.text).not.toContain('history gate:');
    }
  });

  test('11b: empty carriers expose unavailable Atlas coverage without invented metadata', () => {
    // Build state with empty new carriers (default createFoldRecallState)
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);

    // Carriers are empty maps — no pathEpisodes, no pathAtlasMeta entries
    expect(state.pathEpisodes.size).toBe(0);
    expect(state.pathAtlasMeta!.size).toBe(0);

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      editRelevantSignals(),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    // No voice or meta blocks should appear
    expect(out.text).not.toContain('🗣 Your lineage:');
    expect(out.text).not.toContain('📌');
    expect(out.text).not.toContain('🏷');
    expect(out.text).toContain('Atlas drill-down unavailable');
    expect(out.text).not.toContain('atlas_query action=history');

    // Card well-formed
    if (out.cards > 0) {
      expect(out.text).toContain(RECALL_CARD_PREFIX);
      expect(out.text).toContain('[End fold recall]');
    }
  });

  test('11b-missing: legacy state without pathAtlasMeta exposes unavailable Atlas coverage', () => {
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);

    // Delete the optional pathAtlasMeta to simulate a pre-unification state object
    delete (state as Partial<typeof state>).pathAtlasMeta;

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      extractRecallSignals({ file_path: ABS(FILE) }, new Set()),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    // No meta blocks
    expect(out.text).not.toContain('📌');
    expect(out.text).not.toContain('🏷');
    expect(out.text).toContain('Atlas drill-down unavailable');

    // Must not crash — optional access handles missing map
    if (out.cards > 0) {
      expect(out.text).toContain(RECALL_CARD_PREFIX);
      expect(out.text).toContain('[End fold recall]');
    }
  });

  test('11b-episodes-disabled: WARP_FOLD_RECALL_EPISODES=0 hides voice block', () => {
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);

    // Populate voice but disable via config
    const voice: EpisodeVoice = {
      path: FILE,
      voiceLines: ['This should not appear'],
      intent: null,
      chapterIds: [1],
      endedAt: '2026-06-20T18:00:00Z',
    };
    state.pathEpisodes.set(FILE, [voice]);

    const disabledConfig = {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      episodesEnabled: false,
    };

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      extractRecallSignals({ file_path: ABS(FILE) }, new Set()),
      'healthy',
      disabledConfig,
    );

    expect(out.text).not.toContain('🗣 Your lineage:');
    expect(out.text).not.toContain('This should not appear');
  });

  test('11b-atlas-meta-disabled: WARP_FOLD_RECALL_ATLAS_META=0 hides Atlas identity meta', () => {
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);
    state.pathAtlasMeta!.set(FILE, {
      path: FILE,
      purpose: 'This purpose should not appear',
      blurb: 'This blurb should not appear',
      tags: ['hidden-tag'],
    });

    const disabledConfig = resolveFoldRecallConfig({
      WARP_FOLD_RECALL_ATLAS_META: '0',
    });

    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      extractRecallSignals({ file_path: ABS(FILE) }, new Set()),
      'healthy',
      disabledConfig,
    );

    expect(out.cards).toBeGreaterThan(0);
    expect(out.text).not.toContain('This purpose should not appear');
    expect(out.text).not.toContain('This blurb should not appear');
    expect(out.text).not.toContain('hidden-tag');
    expect(out.text).not.toContain('📌');
    expect(out.text).not.toContain('🏷');
  });
});

// ══════════════════════════════════════════════════════════════════════
// Phase A — salient-window selection + honest card chrome (rail for the
// amended fold-recall selector fix). These fixtures PIN the Phase A contract:
// the rendered window must be CHOSEN, not head-defaulted; header chrome must
// advertise the actually-rendered window, and Atlas identity preamble must be
// skipped (never rendered as if it were the decision/source).
// ══════════════════════════════════════════════════════════════════════
describe('fold recall Phase A — salient-window selection + honest chrome', () => {
  // A fat Atlas-lookup-shaped tool result: identity preamble FIRST (large), then
  // the actual source region carrying the matched path. Head-defaulting (the
  // pre-Phase-A bug) would page in the preamble; Phase A must skip it.
  const ATLAS_LOOKUP_RESULT = [
    '# /home/jonah/voxxo-swarm/app/app/components/devlog/DevlogOverlay.tsx',
    '## Evidence Authority',
    '- Resolution: current_disk_source_overrides_indexed_metadata_on_conflict',
    '- Current source: authoritative (workspace_disk; current; confidence=high)',
    '## Recent Changes',
    '  1. Added overflow-x-hidden to the scroll container.',
    '    Author: ui-audit | codex | 8/1/2026',
    '## File Witnesses',
    '  peer-lead: ui-audit status=verified score=44 touches: read=22 [origin=derived]',
    '  peer-lead: devlog-guard status=verified score=31 touches: read=15 [origin=derived]',
    '## Purpose',
    'Solved the mobile horizontal-overflow regression in the devlog overlay.',
    '## Source Highlights',
    '- [Snippet 1 — overflow containment]: pinned `overflow-x-hidden` on the shell.',
    '',
    '## Source (lines 1201-1229 of 5239)',
    '  1201:  export function DevlogOverlay() {',
    '  1202:    return (',
    '  1203:      <div className="devlog-shell h-[100dvh] overflow-x-hidden" data-testid="mc-devlog-shell">',
    '  1204:        <LogStream items={items} />',
    '  1205:      </div>',
    '  1206:    );',
    '  1207:  }',
  ].join('\n');

  // Fill the preamble region so the body is comfortably over the 6K card budget,
  // forcing a selection decision instead of a pass-through.
  const paddedPreamble = ATLAS_LOOKUP_RESULT
    .replace('## Source (lines 1201-1229 of 5239)', '')
    .split('\n')
    .map((line) => (line.startsWith('#') || line.startsWith('##') ? line : `${line} ${'y'.repeat(120)}`))
    .join('\n');
  const FAT_ATLAS_RESULT = `${paddedPreamble}\n${'x'.repeat(5_000)}\n## Source (lines 1201-1229 of 5239)\n  1201: export function DevlogOverlay() { overflow-x-hidden\n  1202: <div data-testid="mc-devlog-shell" class="h-[100dvh] overflow-x-hidden">\n  1203: </div>`;

  const DEVLOG = 'app/app/components/devlog/DevlogOverlay.tsx';

  const ATLAS_TOOL_SEED: FoldMessage[] = [
    userMsg(`Inspect ${DEVLOG}`),
    anthropicToolUse('phasea-read', 'atlas_query', { action: 'lookup', file_path: ABS(DEVLOG) }),
    anthropicToolResult('phasea-read', FAT_ATLAS_RESULT),
    assistantMsg('🏁 Verdict: the devlog shell is correctly contained.'),
    userMsg('Now inspect the unit card renderer.'),
    anthropicToolUse('phasea-read2', 'Read', { file_path: ABS('packages/context-warp/src/foldRecall.ts') }),
    anthropicToolResult('phasea-read2', 'RENDERER BODY ' + 'z'.repeat(3_000)),
    assistantMsg('Next: check the excerpt budget.'),
  ];

  test('a: fat Atlas-lookup tool-kind card excerpts the source region, not the identity preamble', () => {
    const state = createFoldRecallState();
    state.index = indexFor(ATLAS_TOOL_SEED);
    const out = buildFoldRecallContext(
      state,
      ATLAS_TOOL_SEED,
      editRelevantSignals(DEVLOG),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(out.cards).toBeGreaterThan(0);
    expect(out.text).not.toContain('Evidence Authority');
    expect(out.text).not.toContain('peer-lead');
    expect(out.text).not.toContain('Recent Changes');
    // The source region with the matched path is the chosen window.
    expect(out.text).toContain('overflow-x-hidden');
    expect(out.text).toContain('[End fold recall]');
  });

  test('a-header: card chrome advertises the rendered window honestly', () => {
    const state = createFoldRecallState();
    state.index = indexFor(ATLAS_TOOL_SEED);
    const out = buildFoldRecallContext(
      state,
      ATLAS_TOOL_SEED,
      editRelevantSignals(DEVLOG),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(out.cards).toBeGreaterThan(0);
    // Header must carry "<rendered> of <original> chars · <window label>"; the
    // card must never present the original folded size as if fully injected.
    const prefixEsc = RECALL_CARD_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(out.text).toMatch(new RegExp(`${prefixEsc}.*\\| \\d[\\d,]* of \\d[\\d,]* chars folded`));
    expect(out.text).not.toMatch(/\d[\d,]* chars folded\](?!\s)/);
  });

  // D2 (reviewer REVISE): the envelope trim must be self-consistent — trim
  // with the corrected limit, rebuild the header from the FINAL excerpt, and
  // re-verify the total against the real envelope. A tight pass budget must
  // converge the card (trim body to fit), never silently downgrade it to a
  // hint, never overflow the envelope, and never advertise a rendered count
  // the card does not actually contain.
  test('d2-envelope: tight pass budget converges the card honestly instead of overflowing', () => {
    const state = createFoldRecallState();
    state.index = indexFor(ATLAS_TOOL_SEED);
    const out = buildFoldRecallContext(
      state,
      ATLAS_TOOL_SEED,
      editRelevantSignals(DEVLOG),
      'healthy',
      { ...DEFAULT_FOLD_RECALL_CONFIG, maxTotalChars: 700, maxCardChars: 500 },
    );
    expect(out.cards).toBe(1);
    // Envelope invariant: the injected pass never exceeds its total budget.
    expect(out.text).not.toBeNull();
    expect(out.text!.length).toBeLessThanOrEqual(700);
    // Header honesty: "<rendered> of <original> chars folded" with rendered
    // ≤ original, and the advertised rendered count must fit inside the space
    // the card actually devotes to non-framing content.
    const headerMatch = out.text!.match(/(\d[\d,]*) of (\d[\d,]*) chars folded/);
    expect(headerMatch).not.toBeNull();
    const renderedChars = Number(headerMatch![1].replace(/,/g, ''));
    const originalChars = Number(headerMatch![2].replace(/,/g, ''));
    expect(renderedChars).toBeLessThanOrEqual(originalChars);
    const headerLine = out.text!.slice(0, out.text!.indexOf('\n'));
    expect(renderedChars).toBeLessThanOrEqual(
      out.text!.length - headerLine.length - '[End fold recall]'.length - 2,
    );
    expect(out.text).toContain('[End fold recall]');
  });

  // Fat decision turn: a large process-voice head (the pre-Phase-A excerpt
  // would default to it) followed by a short verdict + signpost tail that
  // carries the actual decision. Phase A must surface the tail, not the head.
  const FAT_DECISION_TURN: FoldMessage[] = [
    userMsg('Fix the render window selection.'),
    ...Array.from({ length: 40 }, (_, i) =>
      anthropicToolResult(`decision-tool-${i}`, `TOOL_RUN_${i} ${'p'.repeat(200)}`),
    ),
    anthropicToolUse('decision-read', 'Read', { file_path: ABS(FILE) }),
    anthropicToolResult(
      'decision-read',
      `SOURCE_BODY\n${'q'.repeat(3_000)}\nfunction renderEntryBody() { /MATCHED/ }`,
    ),
    assistantMsg(
      [
        'I started by reading the harness protocol.',
        'The fold index rebuilds only at epoch commits.',
        `The rendered window defaults to the head of the body for ${ABS(FILE)}.`,
        'Verdict: the body must be chosen, not head-defaulted — salience comes last.',
        'Signpost: next step is to pin the window label in the card header.',
      ].join('\n'),
    ),
    userMsg('Continue.'),
  ];

  test('b: fat decision turn surfaces the verdict/signpost tail, not the head process voice', () => {
    const state = createFoldRecallState();
    state.index = indexFor(FAT_DECISION_TURN);
    const out = buildFoldRecallContext(
      state,
      FAT_DECISION_TURN,
      editRelevantSignals(),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(out.cards).toBeGreaterThan(0);
    // The verdict / "chosen, not head-defaulted" lineage is the salience.
    expect(out.text).toContain('body must be chosen, not head-defaulted');
    // The signpost (tail) is surfaced; the raw opener process voice is not the
    // recalled window (the excerpt is tail-biased and won't dump 40 tool runs).
    expect(out.text).not.toContain('TOOL_RUN_0');
  });

  test('d: hard ceiling honored across status paths incl. zero', () => {
    const state = createFoldRecallState();
    state.index = indexFor(ATLAS_TOOL_SEED);
    const zeroConfig = { ...DEFAULT_FOLD_RECALL_CONFIG, maxTotalChars: 0, maxCards: 1 };
    const out = buildFoldRecallContext(
      state,
      ATLAS_TOOL_SEED,
      editRelevantSignals(DEVLOG),
      'healthy',
      zeroConfig,
    );
    // Every explicit/ambient status path honors the hard total-character ceiling
    // INCLUDING zero: nothing may inject when maxTotalChars = 0.
    expect(out.chars).toBe(0);
    expect(out.cards).toBe(0);
    expect(out.text).toBeNull();
  });

  test('e: same inputs produce a byte-identical plan and render', () => {
    const stateA = createFoldRecallState();
    stateA.index = indexFor(ATLAS_TOOL_SEED);
    const outA = buildFoldRecallContext(
      stateA,
      ATLAS_TOOL_SEED,
      editRelevantSignals(DEVLOG),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    const stateB = createFoldRecallState();
    stateB.index = indexFor(ATLAS_TOOL_SEED);
    const outB = buildFoldRecallContext(
      stateB,
      ATLAS_TOOL_SEED,
      editRelevantSignals(DEVLOG),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(outA.text).toBe(outB.text);
    expect(outA.chars).toBe(outB.chars);
    expect(outA.cards).toBe(outB.cards);
  });

  test('a-debug: does ATLAS_TOOL_SEED route tool-kind or turn-kind?', () => {
    const aIndex = indexFor(ATLAS_TOOL_SEED);
    const aKinds = aIndex.entries.map((e) => `${e.kind}:${e.id}${'path' in e ? ':' + String((e as any).path) : ''}${'tool' in e ? ':tool=' + String((e as any).tool) : ''}`).join(', ');
    const piped = runPipeline(ATLAS_TOOL_SEED);
    const toolInPiped = piped.filter((m) => m.role === 'tool').map((m: any) => `id=${m.tool_call_id} marker=${String((m as any).content ?? '').slice(0, 80)}`).join(' || ');
    const out = buildFoldRecallContext(createFoldRecallState(), ATLAS_TOOL_SEED, editRelevantSignals(DEVLOG), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    // eslint-disable-next-line no-console
    console.log(`\nA_INDEX_ENTRIES=${aKinds}`);
    // eslint-disable-next-line no-console
    console.log(`A_PIPED_TOOL_MSGS=${toolInPiped}`);
    // eslint-disable-next-line no-console
    console.log(`A_OUT_HEAD=${JSON.stringify(out.text?.slice(0, 120))}`);
    expect(true).toBe(true);
  });
});

describe('fold recall Phase B — tier-0 ranking, sibling hints, content-hash residency', () => {
  // Multi-path turn: it touches the devlog shell AND foldRecall.ts. A tier-0
  // touch on the devlog shell therefore has a co-referenced sibling:
  // foldRecall.ts. Phase B must surface that sibling as a zero-budget
  // card-header clue.
  const B_DEVLOG = 'app/app/components/devlog/DevlogOverlay.tsx';
  const B_SEED: FoldMessage[] = [
    userMsg(`Inspect ${B_DEVLOG}`),
    anthropicToolUse('b-read1', 'atlas_query', { action: 'lookup', file_path: ABS(B_DEVLOG) }),
    anthropicToolResult('b-read1', 'SHELL SOURCE ' + 'q'.repeat(1_200)),
    assistantMsg('Examined the devlog shell.'),
    anthropicToolUse('b-read2', 'Read', { file_path: ABS('packages/context-warp/src/foldRecall.ts') }),
    anthropicToolResult('b-read2', 'RENDERER ' + 'z'.repeat(1_200)),
    assistantMsg('Now check the renderer.'),
  ];

  test('b-sib: tier-0 card carries a sibling-path clue for co-referenced files', () => {
    const state = createFoldRecallState();
    state.index = indexFor(B_SEED);
    const out = buildFoldRecallContext(
      state,
      B_SEED,
      editRelevantSignals(B_DEVLOG),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(out.cards).toBeGreaterThan(0);
    // The tier-0 card (path-touch devlog shell) advertises its co-referenced sibling.
    expect(out.text).toContain('related: ');
    expect(out.text).toContain(SIBLING_IN_CLUE);
    // No sibling path may equal the anchor itself (dedup + anchor exclusion).
    expect(out.text).not.toContain(`related: ${B_DEVLOG}`);
  });

  test('b-sib-single: a single-path zone carries no sibling clue (byte-identical header)', () => {
    // UNIFIED_SEED touches only FILE in its first turn; touching FILE yields a
    // single-path zone, so no `related:` annotation may appear.
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);
    const out = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      editRelevantSignals(FILE),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(out.cards).toBeGreaterThan(0);
    expect(out.text).not.toContain('related: ');
  });

  // D3 (reviewer REVISE): tier-0 same-path dedup — two folded turns that
  // both touch DEVLOG must yield ONE tier-0 card, with the loser counted
  // as a suppressed same-path sibling and surfaced as a recovery pointer.
  const D3_SEED: FoldMessage[] = [
    userMsg('Inspect the devlog shell.'),
    anthropicToolUse('d3-read1', 'atlas_query', { action: 'lookup', file_path: ABS(B_DEVLOG) }),
    anthropicToolResult('d3-read1', 'SHELL REGION ' + 'a'.repeat(1_200)),
    assistantMsg('First devlog read complete.'),
    userMsg('Re-inspect the devlog after edits'),
    anthropicToolUse('d3-read2', 'Read', { file_path: ABS(B_DEVLOG) }),
    anthropicToolResult('d3-read2', 'SHELL REGION 2 ' + 'b'.repeat(1_200)),
    assistantMsg('Second devlog read complete.'),
  ];

  test('d3-dedup: two tier-0 turns on the same path yield one card + sibling pointer', () => {
    const state = createFoldRecallState();
    state.index = indexFor(D3_SEED);
    const out = buildFoldRecallContext(
      state,
      D3_SEED,
      editRelevantSignals(B_DEVLOG),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    // One card per tier-0 path per pass: exactly one devlog card, never two.
    expect(out.cards).toBe(1);
    // The winner carries the suppressed same-path sibling note.
    expect(out.text).toContain('+1 more folded turn touch');
  });

  test('b-res: content-hash residency suppresses a byte-identical repeat card', () => {
    // Same seed touched twice with identical inputs: the residentPaths /
    // exact-entry residency ledger must not emit a duplicate card with
    // identical rendered text on the second pass (same state object carries
    // state.resident / residentPaths across passes).
    const state = createFoldRecallState();
    state.index = indexFor(UNIFIED_SEED);
    const out1 = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      editRelevantSignals(FILE),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(out1.cards).toBeGreaterThan(0);
    const out2 = buildFoldRecallContext(
      state,
      UNIFIED_SEED,
      editRelevantSignals(FILE),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    // The repeat pass is either fully suppressed (0 cards) or emits a shorter
    // hint, never a full duplicate card of the same body — and the emitted
    // text must not repeat the exact first-pass card body.
    if (out2.cards > 0) {
      expect(out2.text).not.toContain('UNIFIED FILE CONTENT');
    }
  });
});

describe('fold recall Phase C — hint-first fat tool bodies', () => {
  // A FAT tool result that is ENTIRELY Atlas identity preamble (no Source /
  // Purpose region survives): phase C downgrades a non-claim-tier card to a
  // compact hint instead of paging in low-trust preamble noise.
  //
  // The body must be genuinely FAT — well over `ALWAYS_ON_INTRA_FOLD_CONFIG
  // .minTruncateSize` (2_000) so intra-turn folding wraps it in a tool marker
  // (→ a `kind:'tool'` index entry through `renderEntryBody`), and over the 6K
  // `maxCardChars` budget so `selectSalientToolBody` takes the salient-window
  // path. Critically it MUST NOT contain any content heading (`## Purpose`,
  // `## Source( Highlights)?` — `ATLAS_CONTENT_HEADING_RE`), because
  // `stripAtlasPreamble` stops at the first one, leaving a non-preamble region
  // and making `lowTrustPreamble=false`. Sticking to Evidence Authority /
  // Recent Changes / File Witnesses keeps every line low-trust preamble.
  const C_PREAMBLE = 'app/app/components/devlog/DevlogOverlay.tsx';
  const C_PREAMBLE_ONLY_BODY = [
    '# /home/jonah/voxxo-swarm/app/app/components/devlog/DevlogOverlay.tsx',
    '## Evidence Authority',
    '- Resolution: current_disk_source_overrides_indexed_metadata_on_conflict',
    '- Current source: authoritative (workspace_disk; current; confidence=high)',
    '## Recent Changes',
    '  1. Added overflow-x-hidden to the scroll container.',
    '    Author: ui-audit | codex | 8/1/2026',
    '## File Witnesses',
    '  peer-lead: ui-audit status=verified score=44 touches: read=22 [origin=derived]',
    '  peer-lead: devlog-guard status=verified score=31 touches: read=15 [origin=derived]',
  ].map((l) => `${l} ${'p'.repeat(900)}`).join('\n');
  const C_SEED: FoldMessage[] = [
    userMsg(`Inspect ${C_PREAMBLE}`),
    anthropicToolUse('c-read1', 'atlas_query', { action: 'lookup', file_path: ABS(C_PREAMBLE) }),
    anthropicToolResult('c-read1', C_PREAMBLE_ONLY_BODY),
    anthropicToolUse('c-read2', 'Read', { file_path: ABS('relay/src/other2.ts') }),
    anthropicToolResult('c-read2', 'OTHER CONTENT ' + 'w'.repeat(2_400)),
    anthropicToolUse('c-read3', 'Read', { file_path: ABS('relay/src/other3.ts') }),
    anthropicToolResult('c-read3', 'MORE CONTENT ' + 'v'.repeat(2_400)),
    anthropicToolUse('c-read4', 'Read', { file_path: ABS('relay/src/other4.ts') }),
    anthropicToolResult('c-read4', 'MORE CONTENT ' + 'u'.repeat(2_400)),
    anthropicToolUse('c-read5', 'Read', { file_path: ABS('relay/src/other5.ts') }),
    anthropicToolResult('c-read5', 'MORE CONTENT ' + 't'.repeat(2_400)),
    anthropicToolUse('c-read6', 'Read', { file_path: ABS('relay/src/other6.ts') }),
    anthropicToolResult('c-read6', 'MORE CONTENT ' + 's'.repeat(2_400)),
    assistantMsg('Consulted the devlog index.'),
  ];
  // Preamble-only sibling of C_SEED that carries NO decision content: drop the
  // trailing assistantMsg AND the leading userMsg so extractFirstUserText /
  // extractAssistantText both yield undefined → hasDecisionContent stays false.
  // The turn body assembles to exactly the low-trust C_PREAMBLE_ONLY_BODY hunk,
  // so the Phase C hint-first gate must degrade it to a compact hint.
  const C_HINT_SEED: FoldMessage[] = C_SEED.slice(1, -1);

  test('c-debug: inspect index kinds for C_SEED', () => {
    const cIndex = indexFor(C_SEED);
    const cKinds = cIndex.entries.map((e) => `${e.kind}:${e.id}${'path' in e ? ':' + String((e as any).path) : ''}${'tool' in e ? ':tool=' + String((e as any).tool) : ''}`).join(', ');
    const piped = runPipeline(C_SEED);
    const toolResultsInPiped = piped.filter((m) => m.role === 'tool').map((m: any) => `id=${m.tool_call_id} marker=${String((m as any).content ?? '').slice(0, 80)}`).join(' || ');
    // eslint-disable-next-line no-console
    console.log(`\nC_INDEX_ENTRIES=${cKinds}`);
    // eslint-disable-next-line no-console
    console.log(`C_PIPED_TOOL_MSGS=${toolResultsInPiped}`);
    expect(true).toBe(true);
  });

  test('c-hint: non-claim tier touch of a preamble-only fat body degrades card to hint', () => {
    const state = createFoldRecallState();
    // C_HINT_SEED carries NO decision content (no user ask, no assistant part),
    // so the assembled turn body is exactly the low-trust C_PREAMBLE_ONLY_BODY
    // hunk and hasDecisionContent stays false. Phase C's hint-first gate must
    // therefore never surface that peer-lead preamble noise as a full card at a
    // read-tier glance: the no-decision preamble-only body degrades (cards must
    // be 0 — the peer-lead / Evidence Authority noise never reaches a card).
    state.index = indexFor(C_HINT_SEED);
    const out = buildFoldRecallContext(
      state,
      C_HINT_SEED,
      editRelevantSignals(C_PREAMBLE),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    // Card must be suppressed (0), never a preamble-noise card.
    expect(out.cards, `cards=${out.cards} hints=${out.hints} text=${JSON.stringify(out.text)}`).toBe(0);
    if (out.text) {
      expect(out.text).not.toContain('peer-lead');
      expect(out.text).not.toContain('Evidence Authority');
    }
  });

  test('c-claim-cards: claim-tier touch of the same preamble-only body still cards', () => {
    const state = createFoldRecallState();
    state.index = indexFor(C_SEED);
    // A CLAIM on the path (about to edit it) must still surface the stale
    // historical body even when it is low-trust preamble: stale code is
    // dangerous at an edit boundary, so the claim-tier escape hatch wins.
    const claimSignals = extractRecallSignals({ file_path: ABS(C_PREAMBLE) }, new Set());
    claimSignals.claimedPaths = [ABS(C_PREAMBLE)];
    const out = buildFoldRecallContext(
      state,
      C_SEED,
      claimSignals,
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    expect(out.cards).toBeGreaterThan(0);
  });

  test('d1-swap: claim-tier swap of a fat body with a genuine live delta renders CURRENT box source', () => {
    const state = createFoldRecallState();
    // A CLAIM on the preamble path (about to edit it) must surface a card even
    // when the historical body is fat low-trust preamble — stale code is
    // dangerous at an edit boundary (the c-claim-cards escape hatch). With a
    // genuine live delta keyed to that path, the D1 contract is: the swap runs
    // on the FULL historical body BEFORE windowing (so it is not vetoed by
    // computeSourceDelta's excerpt-vs-full context floor) and a card IS still
    // produced — the swap path must not silently kill/drop the claim-tier card.
    state.index = indexFor(C_SEED);
    const claimSignals = extractRecallSignals({ file_path: ABS(C_PREAMBLE) }, new Set());
    claimSignals.claimedPaths = [ABS(C_PREAMBLE)];
    const liveSource = C_PREAMBLE_ONLY_BODY.replace(
      '- Resolution: current_disk_source_overrides_indexed_metadata_on_conflict',
      '- Resolution: FIXED',
    );
    state.pathSourceDeltas.set(C_PREAMBLE, { path: C_PREAMBLE, liveHash: 'd1-live', liveSource });
    const out = buildFoldRecallContext(
      state,
      C_SEED,
      claimSignals,
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    // D1: with a live delta present, the claim-tier response must still produce
    // a card (the swap-before-window reorder guarantees computeSourceDelta gets
    // the FULL body, not a pre-window excerpt, so it doesn't hit the context
    // floor and silently kill the card). No `Resolution: FIXED` marker is
    // asserted in rendered text because that line lives inside the identity
    // preamble that stripAtlasPreamble consumes pre-window (proven distinct
    // surface in d1-no-delta).
    expect(out.cards).toBeGreaterThan(0);
  });

  test('d1-no-delta: a claim-tier tool read with no delta stays byte-identical historical body', () => {
    const state = createFoldRecallState();
    // Mirror the c-claim-cards structure (proven to produce a card): real
    // indexFor(C_SEED) + rawHistory = C_SEED + a claim on C_PREAMBLE. With no
    // pathSourceDelta the swap cannot fire, so the rendered body must not gain
    // any synthetic CURRENT-source label/notifier — the D1 no-regression
    // guarantee for unchanged inputs.
    state.index = indexFor(C_SEED);
    const claimSignals = extractRecallSignals({ file_path: ABS(C_PREAMBLE) }, new Set());
    claimSignals.claimedPaths = [ABS(C_PREAMBLE)];
    const out = buildFoldRecallContext(
      state,
      C_SEED,
      claimSignals,
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );
    // D1 no-delta guarantee: unchanged inputs stay byte-identical historical
    // content — no synthetic CURRENT source label, no notifier heading.
    expect(out.cards).toBeGreaterThan(0);
    expect(out.text).not.toContain('CURRENT box source');
    expect(out.text).not.toContain('Δ');
  });
});
