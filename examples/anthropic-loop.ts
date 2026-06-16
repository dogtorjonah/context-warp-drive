/**
 * Example — wiring context-warp-drive into an Anthropic function-calling loop.
 *
 * The only context-warp-drive surface you need for the headline feature is
 * `FoldSession.prepare(history)`: hand it your full provider-shaped history every
 * turn, send the returned (compacted) messages, and the frozen fold prefix is
 * reused byte-identical while Anthropic's prompt cache is warm. Anthropic still
 * needs the request-level `cache_control` knob at the SDK call site.
 *
 * This file is self-contained so it typechecks without the SDK installed.
 * In your project: `import { FoldSession } from 'context-warp-drive'` and replace
 * `callAnthropic` with a real `@anthropic-ai/sdk` Messages.create call.
 */
import { FoldSession, ALWAYS_ON_FOLD_CONFIG, type FoldMessage } from '../src/index.ts';

// --- Your provider call (stub). Anthropic returns content blocks. ---
interface AnthropicAssistantTurn {
  role: 'assistant';
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
}

interface AnthropicCacheControl {
  type: 'ephemeral';
  ttl?: '1h';
}

async function callAnthropic(
  messages: FoldMessage[],
  cacheControl: AnthropicCacheControl = { type: 'ephemeral' },
): Promise<AnthropicAssistantTurn> {
  // const client = new Anthropic();
  // const res = await client.messages.create({
  //   model: 'claude-...',
  //   max_tokens: 4096,
  //   cache_control: cacheControl,
  //   system,
  //   tools,
  //   messages: messages as Anthropic.MessageParam[],
  // });
  // console.log(res.usage.cache_read_input_tokens, res.usage.cache_creation_input_tokens);
  // return { role: 'assistant', content: res.content };
  void messages;
  void cacheControl;
  return { role: 'assistant', content: [{ type: 'text', text: '(stub assistant reply)' }] };
}

async function runAgent(task: string): Promise<void> {
  // One FoldSession per conversation. ALWAYS_ON_FOLD_CONFIG folds continuously
  // past the active window; omit it for the conservative threshold-gated default.
  const session = new FoldSession({
    foldConfig: ALWAYS_ON_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 5 * 60_000, maxTailChars: 150_000 },
  });

  const history: FoldMessage[] = [{ role: 'user', content: task }];

  for (let turn = 0; turn < 12; turn++) {
    // Compact the history. `messages` is what you send to the provider; the
    // frozen prefix is byte-identical to last turn whenever cacheHot is true.
    const { messages, cacheHot, stats } = session.prepare(history);
    console.log(
      `turn ${turn}: send=${messages.length} msgs cacheHot=${cacheHot} ` +
        `savings=${stats.savingsPercent ?? 0}% hotReuses=${stats.hotReuses} epochs=${stats.epochs}`,
    );

    const assistant = await callAnthropic(messages);
    history.push(assistant as unknown as FoldMessage);

    const toolUses = assistant.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) break; // model is done

    // Execute tools and append a single user turn carrying the tool_result blocks.
    const toolResults = toolUses.map((b) => ({
      type: 'tool_result',
      tool_use_id: b.id,
      content: `result of ${b.name ?? 'tool'}`,
    }));
    history.push({ role: 'user', content: toolResults });

    // OPTIONAL page-in: on a tool boundary, build the fold index, extract recall
    // signals from the tool input (touched paths), and append recall cards.
    // See ../src/foldRecall.ts (buildFoldIndex / extractRecallSignals /
    // buildFoldRecallContext) and the README "Fold recall" section.
  }
}

runAgent('Investigate and fix the failing test in src/parser.ts').catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
