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
