/**
 * Example — wiring context-warp-drive into an OpenAI-compatible function-calling loop
 * (OpenAI, DeepSeek, Kimi, GLM, Mistral, Grok, MiniMax — anything with the
 * chat-completions `tool_calls` shape).
 *
 * Self-contained so it typechecks without the SDK installed. In your project:
 * `import { FoldSession } from 'context-warp-drive'` and replace `callOpenAI` with a
 * real `openai` chat.completions.create call. OpenAI prompt caching is automatic;
 * the optional provider knob is a stable `prompt_cache_key` for related requests.
 */
import { FoldSession, type FoldMessage } from '../src/index.ts';

// --- Your provider call (stub). OpenAI returns an assistant message. ---
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OpenAIAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAICacheOptions {
  promptCacheKey?: string;
}

async function callOpenAI(messages: FoldMessage[], cache: OpenAICacheOptions = {}): Promise<OpenAIAssistantMessage> {
  // const client = new OpenAI();
  // const res = await client.chat.completions.create({
  //   model,
  //   messages,
  //   tools,
  //   prompt_cache_key: cache.promptCacheKey,
  // });
  // console.log(res.usage?.prompt_tokens_details?.cached_tokens ?? 0);
  // return res.choices[0].message as OpenAIAssistantMessage;
  void messages;
  void cache;
  return { role: 'assistant', content: '(stub assistant reply)' };
}

async function runAgent(task: string): Promise<void> {
  // Default config: conservative threshold-gated fold + freeze on. Tune ttlMs to
  // your provider's real prompt-cache window (e.g. 3_600_000 for a 1h cache).
  const session = new FoldSession({ freeze: { enabled: true, ttlMs: 5 * 60_000, maxTailChars: 150_000 } });

  const history: FoldMessage[] = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: task },
  ];

  for (let turn = 0; turn < 12; turn++) {
    const { messages, cacheHot, stats } = session.prepare(history);
    console.log(
      `turn ${turn}: send=${messages.length} msgs cacheHot=${cacheHot} ` +
        `savings=${stats.savingsPercent ?? 0}% epochs=${stats.epochs}`,
    );

    const assistant = await callOpenAI(messages, { promptCacheKey: 'coding-agent-v1' });
    history.push(assistant as unknown as FoldMessage);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) break; // model is done

    // Append one tool message per tool_call (OpenAI shape).
    for (const call of calls) {
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: `result of ${call.function.name}`,
      } as FoldMessage);
    }
  }
}

runAgent('Add retry-with-backoff to the HTTP client in src/http.ts').catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
