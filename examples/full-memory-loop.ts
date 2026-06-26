/**
 * Full Memory Loop Example — end-to-end demonstration of the complete
 * context-warp memory stack.
 *
 * This example proves the full stack works together:
 *   - FoldSession (rolling fold + freeze)
 *   - Fold recall (ambient page-in)
 *   - Episodic capture + persistence (SQLite store)
 *   - Episodic recall (durable cross-session memory)
 *   - Live-source delta tracking
 *   - Behavioral path affinity
 *   - File metadata provider (mock)
 *
 * Run: npx tsx examples/full-memory-loop.ts
 *
 * No external API calls — it uses a mock provider that simulates an agent
 * responding to messages.
 */
import { MemoryLoop } from '../src/host/MemoryLoop.ts';
import type { FileMetaProvider, FileMetaEntry } from '../src/host/fileMetaProvider.ts';
import { FoldSession } from '../src/session/FoldSession.ts';
import { resolveFoldConfigForBand, type FoldMessage } from '../src/rollingFold.ts';
import { createEpisodeStore, closeEpisodeStore } from '../src/episodes/sqliteStore.ts';
import { DEFAULT_FOLD_RECALL_CONFIG } from '../src/foldRecall.ts';

// ─── Mock file metadata provider ──────────────────────────────────────

class MockFileMetaProvider implements FileMetaProvider {
  private readonly registry = new Map<string, FileMetaEntry>([
    ['src/engine.ts', {
      path: 'src/engine.ts',
      purpose: 'Core engine logic — processes requests and manages state',
      blurb: 'Main request processing engine module',
      tags: ['core', 'engine', 'processing'],
      highlights: [
        { label: 'Main handler', startLine: 45, endLine: 78 },
        { label: 'State management', startLine: 120, endLine: 145 },
      ],
      hazards: [
        { text: 'Mutates shared state; thread-unsafe', startLine: 125, endLine: 130 },
      ],
    }],
    ['src/config.ts', {
      path: 'src/config.ts',
      purpose: 'Application configuration loader and validator',
      blurb: 'Configuration management module',
      tags: ['config', 'settings'],
    }],
  ]);

  async resolve(paths: readonly string[]): Promise<ReadonlyMap<string, FileMetaEntry>> {
    const result = new Map<string, FileMetaEntry>();
    for (const path of paths) {
      const entry = this.registry.get(path);
      if (entry) result.set(path, entry);
    }
    return result;
  }
}

// ─── Mock agent loop ──────────────────────────────────────────────────

/**
 * Generate a realistic assistant turn that includes an Anthropic-shaped
 * tool_use block. The recall engine indexes paths from these structured
 * tool calls, so we need them in the folded history for recall to fire.
 */
function mockAssistantTurn(history: FoldMessage[], turnNum: number): FoldMessage[] {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const touched = userText.match(/src\/[\w.]+/g) ?? [];
  const path = touched[0] ?? 'src/engine.ts';

  const filler = `Analyzed the request and reviewed the relevant code. `.repeat(8);

  // Assistant message with a structured tool_use block (Anthropic format).
  const assistant: FoldMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: `${filler}Working on: ${path} (turn ${turnNum}).` },
      {
        type: 'tool_use',
        id: `toolu_${turnNum}`,
        name: 'Read',
        input: { file_path: path },
      },
    ],
  };

  // Tool result message (user role with tool_result block).
  const result: FoldMessage = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `toolu_${turnNum}`,
        content: `Read 200 lines from ${path}. Found the implementation and related types.`,
      },
    ],
  };

  return [assistant, result];
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Full Memory Loop — End-to-End Demonstration');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Setup ──
  // better-sqlite3 is an optional peer dependency. If it isn't installed,
  // we skip episodic persistence and still demonstrate the full fold+recall loop.
  let episodeStore = null;
  try {
    episodeStore = await createEpisodeStore({ path: ':memory:' });
  } catch {
    console.log('  (better-sqlite3 not installed — running without episodic persistence)\n');
  }

  // Demo-scaled config: a small band (2K tokens ≈ 8K chars) so folding
  // triggers within the example's short message sequence. Real apps use
  // the default 40K-token band (resolveFoldConfigForBand() with no args).
  const demoFoldConfig = resolveFoldConfigForBand(2_000);
  const session = new FoldSession({
    foldConfig: demoFoldConfig,
    // Disable the provider-cache freeze layer for the demo. With freeze on,
    // the frozen prefix is reused (cacheHot=true) for 5 minutes — too long
    // for a sub-second demo. freeze:false forces a fresh fold every call,
    // so the recall index rebuilds and recall actually fires.
    // Real apps leave freeze:true to benefit from provider prompt caching.
    freeze: false,
    eviction: true,
    pressureCeiling: 150_000,
  });

  const loop = new MemoryLoop({
    session,
    recallConfig: DEFAULT_FOLD_RECALL_CONFIG,
    episodeStore: episodeStore ?? undefined,
    sessionId: 'demo-session',
    enableLiveSource: false, // off for demo (no real files)
    enableAffinity: true,
    fileMetaProvider: new MockFileMetaProvider(),
  });

  // ── Simulate turns ──
  let history: FoldMessage[] = [
    { role: 'user', content: 'I need to work on src/engine.ts and src/config.ts' },
  ];

  console.log('Turn 1: Initial request mentioning two files\n');

  const turn1 = await loop.prepare(history, {
    toolInput: { path: 'src/engine.ts' },
    claimedPaths: new Set(['src/engine.ts', 'src/config.ts']),
    contextWindow: 200_000,
  });

  console.log(`  Epoch triggered: ${turn1.epochTriggered}`);
  console.log(`  Messages in view: ${turn1.messages.length}`);
  console.log(`  Fold recall context: ${turn1.recallContext ? `${turn1.recallContext.length} chars` : 'none'}`);
  console.log(`  Episode cards: ${turn1.episodeCards.length}`);
  console.log(`  Recall stats: ${turn1.recallStats.cardsInjected} cards, ${turn1.recallStats.hintsInjected} hints\n`);

  // Simulate assistant response with tool calls
  history = [...history, ...mockAssistantTurn(history, 1)];

  // ── Generate enough turns to trigger a fold ──
  console.log('Simulating 30 more turns to trigger folding...\n');

  for (let i = 0; i < 30; i++) {
    history = [
      ...history,
      { role: 'user', content: `Turn ${i + 2}: Please review src/engine.ts again for issue #${i + 1}` },
    ];
    history = [...history, ...mockAssistantTurn(history, i + 2)];
  }

  // ── Turn after folding: recall should fire ──
  console.log('Turn 32: Post-fold recall test\n');

  const turn32 = await loop.prepare(history, {
    toolInput: { path: 'src/engine.ts' },
    claimedPaths: new Set(['src/engine.ts']),
    contextWindow: 200_000,
  });

  console.log(`  Epoch triggered: ${turn32.epochTriggered}`);
  console.log(`  Messages in view: ${turn32.messages.length}`);
  console.log(`  Fold recall context: ${turn32.recallContext ? `${turn32.recallContext.length} chars` : 'none'}`);
  console.log(`  Episode cards: ${turn32.episodeCards.length}`);
  console.log(`  Recall stats: ${turn32.recallStats.cardsInjected} cards injected total, ${turn32.recallStats.suppressed} suppressed\n`);

  if (turn32.recallContext) {
    console.log('  Recall context preview:');
    const preview = turn32.recallContext.slice(0, 200);
    console.log(`  "${preview}${turn32.recallContext.length > 200 ? '...' : '"'}\n`);
  }

  if (turn32.episodeCards.length > 0) {
    console.log('  Episode cards:');
    for (const card of turn32.episodeCards) {
      console.log(`    [${card.episodeId}] paths: ${card.matchedPaths.join(', ')}`);
      console.log(`    ${card.text.slice(0, 100)}...\n`);
    }
  }

  // ── Show episode persistence ──
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Episodic Memory Persistence');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const runtime = loop.getEpisodeRuntime();
  if (runtime) {
    const recallResult = runtime.recallCards(['src/engine.ts'], { limit: 10 });
    console.log(`  Episodes recalled for src/engine.ts: ${recallResult.cards.length}`);
    console.log(`  Served episode IDs (deduped): ${recallResult.state.servedEpisodeIds.length}\n`);
  }

  // ── Cleanup ──
  if (episodeStore) closeEpisodeStore(episodeStore);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ✓ Full memory loop demonstration complete');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('Demonstration failed:', err);
  process.exit(1);
});
