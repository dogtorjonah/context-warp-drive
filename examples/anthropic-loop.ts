/**
 * Example — wiring context-warp-drive into an Anthropic function-calling loop.
 *
 * This is the FULL plug-and-play loop: FoldSession compacts history + freezes
 * the prefix, and the Anthropic provider adapter injects `cache_control`
 * breakpoints so the frozen prefix stays cached on Anthropic's side.
 *
 * Two function calls per turn — that's the whole integration:
 *
 *   1. session.prepare(history) → compacted messages + sealedBoundary
 *   2. applyCacheBreakpoints(messages, { sealedBoundary }) → cached messages
 *
 * In your project:
 *   import { FoldSession } from 'context-warp-drive';
 *   import { applyCacheBreakpoints } from 'context-warp-drive/providers/anthropic';
 */
import { FoldSession, ALWAYS_ON_FOLD_CONFIG, type FoldMessage } from '../src/index.ts';
import {
  applyCacheBreakpoints,
  buildCachedSystem,
  applyToolsCacheBreakpoint,
  EXTENDED_CACHE_TTL_BETA,
  type Message,
  type ToolSpec,
} from '../src/providers/anthropic.ts';

// --- Your provider call (stub). Replace with real @anthropic-ai/sdk. ---
interface AnthropicResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

async function callAnthropic(
  messages: Message[],
  system: string | object,
  tools: ToolSpec[],
): Promise<AnthropicResponse> {
  // const client = new Anthropic();
  // const res = await client.messages.create({
  //   model: 'claude-sonnet-4-20250514',
  //   max_tokens: 8192,
  //   system,
  //   tools,
  //   messages,
  //   betas: { headers: { 'anthropic-beta': EXTENDED_CACHE_TTL_BETA } },
  // });
  // console.log('cache stats:', res.usage.cache_read_input_tokens, res.usage.cache_creation_input_tokens);
  // return res;
  void messages; void system; void tools;
  return { content: [{ type: 'text', text: '(stub)' }] };
}

async function runAgent(task: string): Promise<void> {
  // One FoldSession per conversation. Use 1h TTL to match the cache breakpoints.
  const session = new FoldSession({
    foldConfig: ALWAYS_ON_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 },
  });

  const SYSTEM_PROMPT = 'You are a helpful assistant with file-editing tools.';
  const TOOLS: ToolSpec[] = [
    { name: 'edit_file', description: 'Edit a file', input_schema: { type: 'object', properties: {} } },
  ];

  const history: FoldMessage[] = [{ role: 'user', content: task }];

  for (let turn = 0; turn < 100; turn++) {
    // Step 1: Compact history. The frozen prefix is byte-identical when cacheHot.
    const { messages, cacheHot, sealedBoundary, stats } = session.prepare(history);

    console.log(
      `turn ${turn}: send=${messages.length} msgs cacheHot=${cacheHot} ` +
        `savings=${stats.savingsPercent ?? 0}% epochs=${stats.epochs} ` +
        `sealedBoundary=${sealedBoundary ?? 'none'}`,
    );

    // Step 2: Inject cache breakpoints. This is the only provider-specific call.
    //   - sealedBoundary breakpoint caches the frozen prefix band
    //   - rolling breakpoint on the last message caches the append-only tail
    const cachedMessages = applyCacheBreakpoints(messages as Message[], {
      sealedBoundary,
      ttl: '1h',
    });

    // Also cache the system prompt and tool definitions (stable per session).
    const cachedSystem = buildCachedSystem(SYSTEM_PROMPT, '1h');
    const cachedTools = applyToolsCacheBreakpoint(TOOLS, '1h');

    // Step 3: Send to Anthropic. The beta header is needed for 1h TTL.
    const response = await callAnthropic(cachedMessages, cachedSystem, cachedTools);

    // Step 4: Append to raw history (append-only — never mutate past messages).
    history.push({ role: 'assistant', content: response.content } as unknown as FoldMessage);

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) break;

    const toolResults = toolUses.map((b) => ({
      type: 'tool_result',
      tool_use_id: b.id,
      content: `result of ${b.name ?? 'tool'}`,
    }));
    history.push({ role: 'user', content: toolResults });
  }
}

runAgent('Investigate and fix the failing test in src/parser.ts').catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
