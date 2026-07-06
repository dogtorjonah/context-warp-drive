/**
 * Adapter — bidirectional mapping between Pi's AgentMessage format and
 * Context Warp Drive's universal FoldMessage format.
 *
 * Pi messages use a flat { role, content, timestamp } shape where content is
 * either a string (user) or an array of typed content objects (TextContent,
 * ThinkingContent, ToolCall, ImageContent). This is simpler than OpenCode's
 * { info, parts } wrapper — the adapter layer is correspondingly leaner.
 *
 * The adapter preserves enough structure for the fold engine to classify turns,
 * detect tool calls, and produce structural skeletons. On the reverse trip,
 * folded messages are synthesized as user messages with text content, while
 * the unfolded active window is passed through as ORIGINAL AgentMessage
 * objects (byte-identical content arrays intact).
 */

// ── CWD fold message shape ──────────────────────────────────────────────
// Matches FoldMessage from src/rollingFold.ts — kept as a local interface
// to avoid a cross-package import dependency at the adapter boundary.

export interface FoldMessage {
  role: string;
  content: string | null | unknown[];
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
  reasoning_content?: unknown;
}

// ── Minimal Pi message types (duck-typed at the plugin boundary) ────────
// We duck-type Pi's AgentMessage rather than importing @earendil-works types
// at compile time. The plugin runs in Pi's process and accesses message fields
// by duck-typing on the runtime shape. This keeps the plugin dependency-free
// beyond context-warp-drive itself.

/** Pi content block types we understand */
export interface PiTextContent {
  type: 'text';
  text: string;
}

export interface PiThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface PiToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export type PiContent =
  | PiTextContent
  | PiThinkingContent
  | PiToolCall
  | PiImageContent
  | { type: string; [key: string]: unknown };

/** Pi user message */
export interface PiUserMessage {
  role: 'user';
  content: string | PiContent[];
  timestamp: number;
}

/** Pi assistant message with built-in token telemetry */
export interface PiAssistantMessage {
  role: 'assistant';
  content: PiContent[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

/** Pi tool result message */
export interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: PiContent[];
  isError: boolean;
  timestamp: number;
}

/** Pi compaction summary message (from prior compaction) */
export interface PiCompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  timestamp: number;
}

/** Pi branch summary message */
export interface PiBranchSummaryMessage {
  role: 'branchSummary';
  summary: string;
  timestamp: number;
}

/** Union of Pi message types we handle */
export type PiMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiCompactionSummaryMessage
  | PiBranchSummaryMessage
  | { role: string; [key: string]: unknown };

/** Pi usage type (built into every AssistantMessage) */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
}

// ── Forward adapter: Pi → CWD FoldMessage ───────────────────────────────

/**
 * Identity map: source FoldMessage object -> source PiMessage index.
 * Folded views can insert, remove, or reuse older FoldMessage objects, so
 * reverse mapping must key by object identity rather than array position.
 */
export interface FoldIndexMap {
  readonly sourceByFoldMessage: ReadonlyMap<FoldMessage, number>;
}

/**
 * Result of forward conversion — fold messages plus a map back to source
 * PiMessage indices for active-window passthrough.
 */
export interface ToFoldResult {
  messages: FoldMessage[];
  indexMap: FoldIndexMap;
}

/**
 * Extract text content from a Pi content array.
 */
function extractText(content: string | PiContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c): c is PiTextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Extract thinking content from a Pi content array.
 */
function extractThinking(content: PiContent[]): string {
  return content
    .filter((c): c is PiThinkingContent => c.type === 'thinking')
    .map((c) => c.thinking)
    .join('\n');
}

/**
 * Convert an array of Pi AgentMessages into CWD's FoldMessage format.
 * Each Pi message maps to one or more FoldMessages (e.g., an assistant turn
 * with a tool call produces both a tool_call message and a tool result
 * message, matching how the fold engine segments turns).
 *
 * Returns the fold messages plus an index map linking each fold message back
 * to its source PiMessage, so the reverse adapter can pass original messages
 * through for the active window.
 */
export function toFoldMessages(piMessages: PiMessage[]): ToFoldResult {
  const foldMessages: FoldMessage[] = [];
  const sourceByFoldMessage = new Map<FoldMessage, number>();

  const pushMapped = (foldMessage: FoldMessage, piIdx: number) => {
    foldMessages.push(foldMessage);
    sourceByFoldMessage.set(foldMessage, piIdx);
  };

  for (let piIdx = 0; piIdx < piMessages.length; piIdx++) {
    const msg = piMessages[piIdx];

    if (msg.role === 'user') {
      const text = extractText((msg as PiUserMessage).content);
      if (text) {
        pushMapped({ role: 'user', content: text }, piIdx);
      }
    } else if (msg.role === 'assistant') {
      const assistant = msg as PiAssistantMessage;
      const content = Array.isArray(assistant.content) ? assistant.content : [];

      const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];

      for (const c of content) {
        if (c.type === 'toolCall') {
          const tc = c as PiToolCall;
          toolCalls.push({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments ?? {}),
            },
          });
        }
      }

      const assistantText = content
        .filter((c): c is PiTextContent => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const reasoningText = extractThinking(content);

      if (toolCalls.length > 0) {
        const foldMsg: FoldMessage = {
          role: 'assistant',
          content: assistantText || null,
          tool_calls: toolCalls,
        };
        if (reasoningText) foldMsg.reasoning_content = reasoningText;
        pushMapped(foldMsg, piIdx);
      } else if (assistantText || reasoningText) {
        const foldMsg: FoldMessage = {
          role: 'assistant',
          content: assistantText || null,
        };
        if (reasoningText) foldMsg.reasoning_content = reasoningText;
        pushMapped(foldMsg, piIdx);
      }
    } else if (msg.role === 'toolResult') {
      const tr = msg as PiToolResultMessage;
      const text = extractText(tr.content);
      const resultText = tr.isError ? `[Tool Error] ${text}` : text;
      pushMapped(
        {
          role: 'tool',
          content: resultText,
          tool_call_id: tr.toolCallId,
          name: tr.toolName,
        },
        piIdx,
      );
    } else if (msg.role === 'compactionSummary') {
      // Preserve context from sessions compacted before the plugin was installed
      const summary = (msg as PiCompactionSummaryMessage).summary;
      if (summary) {
        pushMapped(
          {
            role: 'user',
            content: `[Previous session compaction summary]\n${summary}`,
          },
          piIdx,
        );
      }
    } else if (msg.role === 'branchSummary') {
      const summary = (msg as PiBranchSummaryMessage).summary;
      if (summary) {
        pushMapped(
          {
            role: 'user',
            content: `[Branch summary]\n${summary}`,
          },
          piIdx,
        );
      }
    }
    // Skip bashExecution, custom, and other non-conversation roles — they
    // don't contribute to fold-eligible LLM context.
  }

  return { messages: foldMessages, indexMap: { sourceByFoldMessage } };
}

// ── Reverse adapter: CWD FoldMessage → Pi messages ──────────────────────

/**
 * Marker text that identifies a CWD fold block in the folded output.
 * These match the real output of renderFoldedBlock() in rollingFold.ts.
 */
const FOLD_BLOCK_MARKERS = [
  '[Conversation Context —',
  'COORDINATE CLOSET',
  '[End Folded Context]',
];
const CONTINUITY_SEED_PREFIX = 'Continuity refresh:';

let timestampCounter = 0;
function nextTimestamp(): number {
  // Pi messages need timestamps; use a synthetic counter for fold-state messages
  return 1_000_000 + timestampCounter++;
}

/**
 * Result of reverse conversion — Pi messages plus the count of folded
 * context messages synthesized (fold blocks and hard-epoch seeds, for debug).
 */
export interface ToPiResult {
  messages: PiMessage[];
  foldBlockCount: number;
}

/**
 * Convert CWD's folded FoldMessage array back into Pi AgentMessages.
 *
 * Strategy:
 * - Folded messages (the fold block + ack) are synthesized as user messages
 *   with text content.
 * - Unfolded active-window messages are passed through as ORIGINAL PiMessage
 *   objects, preserving all content arrays (tool calls, tool results, images,
 *   thinking) byte-identical.
 *
 * @param foldMessages  The folded output from FoldSession.prepare()
 * @param indexMap      Maps original FoldMessage objects back to PiMessage indices
 * @param piMessages    The original Pi messages (for active-window passthrough)
 */
export function toPiMessages(
  foldMessages: FoldMessage[],
  indexMap: FoldIndexMap,
  piMessages: PiMessage[],
): ToPiResult {
  const result: PiMessage[] = [];
  let foldBlockCount = 0;
  const emittedSourceIndices = new Set<number>();

  for (let i = 0; i < foldMessages.length; i++) {
    const fm = foldMessages[i];
    const content = typeof fm.content === 'string' ? fm.content : JSON.stringify(fm.content ?? '');

    const sourceIdx = indexMap.sourceByFoldMessage.get(fm);
    const sourceMessage = sourceIdx === undefined ? undefined : piMessages[sourceIdx];
    if (sourceIdx !== undefined && sourceMessage) {
      if (!emittedSourceIndices.has(sourceIdx)) {
        result.push(sourceMessage);
        emittedSourceIndices.add(sourceIdx);
      }
      continue;
    }

    // Telemetry only: identity-map misses are synthesized below. Count all
    // fold-state messages we recognize, including hard-epoch continuity seeds.
    const isFoldBlock =
      fm.role === 'user' && FOLD_BLOCK_MARKERS.some((marker) => content.includes(marker));
    const isContinuitySeed = fm.role === 'user' && content.startsWith(CONTINUITY_SEED_PREFIX);
    const isFoldStateMessage = isFoldBlock || isContinuitySeed;
    if (isFoldStateMessage) {
      foldBlockCount++;
    }

    // Synthesize a message from the fold message content
    const ts = nextTimestamp();

    if (fm.role === 'user') {
      result.push({
        role: 'user',
        content: [{ type: 'text', text: content }],
        timestamp: ts,
      });
    } else if (fm.role === 'assistant') {
      // Minimal assistant message — fold-state messages are never tool-bearing
      result.push({
        role: 'assistant',
        content: [{ type: 'text', text: content }],
        timestamp: ts,
      });
    } else if (fm.role === 'tool') {
      result.push({
        role: 'toolResult',
        toolCallId: String(fm.tool_call_id ?? 'unknown'),
        toolName: String(fm.name ?? 'unknown'),
        content: [{ type: 'text', text: content }],
        isError: false,
        timestamp: ts,
      });
    }
    // System and other roles are dropped.
  }

  return { messages: result, foldBlockCount };
}

// ── Telemetry extraction ───────────────────────────────────────────────

/**
 * Extract measured input tokens from a Pi AssistantMessage's usage field.
 *
 * Pi's Usage type includes: input, output, cacheRead, cacheWrite, totalTokens.
 * On Anthropic, `input` EXCLUDES cache reads — using input alone would
 * massively understate pressure and hard epochs would never trigger by
 * measured pressure. We prefer totalTokens, then fall back to the sum.
 *
 * Returns undefined if the message doesn't carry usage telemetry.
 */
export function extractInputTokens(message: PiMessage): number | undefined {
  if (message.role !== 'assistant') return undefined;
  const usage = (message as PiAssistantMessage).usage;
  if (!usage) return undefined;

  // Prefer totalTokens if the provider reports it
  if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) {
    return usage.totalTokens;
  }

  // Otherwise sum all components
  const input = typeof usage.input === 'number' ? usage.input : 0;
  const output = typeof usage.output === 'number' ? usage.output : 0;
  const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0;
  const cacheWrite = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0;

  const computed = input + output + cacheRead + cacheWrite;
  if (computed > 0) return computed;

  return undefined;
}
