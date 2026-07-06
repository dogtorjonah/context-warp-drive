/**
 * Adapter — bidirectional mapping between OpenCode's { info, parts } message
 * format and Context Warp Drive's universal FoldMessage format.
 *
 * OpenCode messages use a rich schema with discriminated unions for parts
 * (text, tool, reasoning, file, etc). CWD's FoldMessage is a minimal
 * { role, content } shape optimized for deterministic fold heuristics.
 *
 * The adapter preserves enough structure for the fold engine to classify turns,
 * detect tool calls, and produce structural skeletons. On the reverse trip,
 * folded messages are synthesized as text, while the unfolded active window is
 * passed through as ORIGINAL OCMessage objects (byte-identical parts intact).
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

// ── Minimal OpenCode message types (duck-typed at the plugin boundary) ──
// We intentionally avoid importing OpenCode's effect Schema types at compile
// time — the plugin runs in OpenCode's process, and we access message fields
// by duck-typing on the runtime shape. This keeps the plugin dependency-free
// beyond context-warp-drive itself.

/** An OpenCode assistant message with token telemetry */
interface OCAssistantInfo {
  role: 'assistant';
  id: string;
  sessionID: string;
  agent: string;
  modelID: string;
  providerID: string;
  cost: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
    total?: number;
  };
  finish?: string;
}

/** An OpenCode user message */
interface OCUserInfo {
  role: 'user';
  id: string;
  sessionID: string;
  agent: string;
  model: { providerID: string; modelID: string; variant?: string };
}

export type OCMessageInfo = OCUserInfo | OCAssistantInfo;

/** OpenCode part types we understand */
interface OCPartBase {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
}

interface OCTextPart extends OCPartBase {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
}

interface OCReasoningPart extends OCPartBase {
  type: 'reasoning';
  text: string;
}

interface OCToolPart extends OCPartBase {
  type: 'tool';
  callID: string;
  tool: string;
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
  };
}

interface OCCompactionPart extends OCPartBase {
  type: 'compaction';
  auto: boolean;
  overflow?: boolean;
}

interface OCFilePart extends OCPartBase {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}

interface OCStepStartPart extends OCPartBase {
  type: 'step-start';
}

interface OCStepFinishPart extends OCPartBase {
  type: 'step-finish';
}

/** Any OpenCode part */
export type OCPart =
  | OCTextPart
  | OCReasoningPart
  | OCToolPart
  | OCCompactionPart
  | OCFilePart
  | OCStepStartPart
  | OCStepFinishPart
  | (OCPartBase & { type: string; [key: string]: unknown });

/** The OpenCode message-with-parts shape used in transform hooks */
export interface OCMessage {
  info: OCMessageInfo;
  parts: OCPart[];
}

/**
 * Extract model info from either user or assistant message info.
 * User messages have `model: { providerID, modelID }`; assistant messages
 * have `providerID` and `modelID` as separate fields.
 */
function getModelRef(info: OCMessageInfo): { providerID: string; modelID: string; variant?: string } {
  if (info.role === 'user') {
    return info.model;
  }
  return { providerID: info.providerID, modelID: info.modelID };
}

// ── Forward adapter: OpenCode → CWD FoldMessage ────────────────────────

/**
 * Identity map: source FoldMessage object -> source OCMessage index.
 * Folded views can insert, remove, or reuse older FoldMessage objects, so
 * reverse mapping must key by object identity rather than array position.
 */
export interface FoldIndexMap {
  readonly sourceByFoldMessage: ReadonlyMap<FoldMessage, number>;
}

/**
 * Result of forward conversion — fold messages plus a map back to source
 * OCMessage indices for active-window passthrough.
 */
export interface ToFoldResult {
  messages: FoldMessage[];
  indexMap: FoldIndexMap;
}

const DEFAULT_MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };

/**
 * Extract the compaction summary text from a compaction part, if present.
 * This preserves context from sessions that were compacted before the plugin
 * was installed. Returns undefined if there is no compaction part or no
 * usable text content.
 */
function extractCompactionText(msg: OCMessage): string | undefined {
  for (const part of msg.parts) {
    if (part.type === 'compaction') {
      // OpenCode stores the compaction summary as a text part on the same
      // message. If present, return it; otherwise the compaction part alone
      // has no summary text we can use.
      const textPart = msg.parts.find(
        (p): p is OCTextPart => p.type === 'text' && !p.ignored,
      );
      return textPart?.text;
    }
  }
  return undefined;
}

/**
 * Convert an array of OpenCode { info, parts } messages into CWD's
 * FoldMessage format. Each OpenCode message maps to one or more FoldMessages
 * (e.g., an assistant turn with a tool call produces both a tool_call message
 * and a text message, matching how the fold engine segments turns).
 *
 * Returns the fold messages plus an index map linking each fold message back
 * to its source OCMessage, so the reverse adapter can pass original messages
 * through for the active window.
 */
export function toFoldMessages(ocMessages: OCMessage[]): ToFoldResult {
  const foldMessages: FoldMessage[] = [];
  const sourceByFoldMessage = new Map<FoldMessage, number>();

  const pushMapped = (foldMessage: FoldMessage, ocIdx: number) => {
    foldMessages.push(foldMessage);
    sourceByFoldMessage.set(foldMessage, ocIdx);
  };

  for (let ocIdx = 0; ocIdx < ocMessages.length; ocIdx++) {
    const msg = ocMessages[ocIdx];

    // Skip agent-switched, model-switched, system, shell — these are metadata
    // messages that don't contribute to the fold-eligible conversation history.
    if (msg.info.role !== 'user' && msg.info.role !== 'assistant') continue;

    // For compaction messages, extract the summary text instead of skipping
    // wholesale — sessions compacted pre-plugin keep that context.
    const compactionText = extractCompactionText(msg);
    if (compactionText) {
      pushMapped({
        role: 'user',
        content: `[Previous session compaction summary]\n${compactionText}`,
      }, ocIdx);
      continue;
    }

    // If the message has a compaction part but no extractable text, skip it
    if (msg.parts.some((p) => p.type === 'compaction') && !compactionText) continue;

    if (msg.info.role === 'user') {
      const textParts = msg.parts
        .filter((p): p is OCTextPart => p.type === 'text' && !p.ignored)
        .map((p) => p.text);
      const text = textParts.join('\n');
      if (text) {
        pushMapped({ role: 'user', content: text }, ocIdx);
      }
    } else {
      // Assistant: extract text, reasoning, tool calls, and tool results
      const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];

      for (const part of msg.parts) {
        if (part.type === 'tool') {
          const toolPart = part as OCToolPart;
          // Record the tool call
          const inputJson = JSON.stringify(toolPart.state.input ?? {});
          toolCalls.push({
            id: toolPart.callID,
            type: 'function' as const,
            function: {
              name: toolPart.tool,
              arguments: inputJson,
            },
          });
        }
      }

      const textParts = msg.parts
        .filter((p): p is OCTextPart => p.type === 'text')
        .map((p) => p.text);
      const reasoningParts = msg.parts
        .filter((p): p is OCReasoningPart => p.type === 'reasoning')
        .map((p) => p.text);

      // Build the assistant fold message
      const assistantText = textParts.join('\n');
      const reasoningText = reasoningParts.join('\n');

      if (toolCalls.length > 0) {
        // Assistant turn with tool calls — produce a message with tool_calls
        // and the text content. The fold engine segments on these.
        const foldMsg: FoldMessage = {
          role: 'assistant',
          content: assistantText || null,
          tool_calls: toolCalls,
        };
        if (reasoningText) {
          foldMsg.reasoning_content = reasoningText;
        }
        pushMapped(foldMsg, ocIdx);

        // Emit tool result messages for completed tools
        for (const part of msg.parts) {
          if (part.type === 'tool') {
            const toolPart = part as OCToolPart;
            if (toolPart.state.status === 'completed' && toolPart.state.output !== undefined) {
              pushMapped({
                role: 'tool',
                content: toolPart.state.output,
                tool_call_id: toolPart.callID,
                name: toolPart.tool,
              }, ocIdx);
            } else if (toolPart.state.status === 'error' && toolPart.state.error) {
              pushMapped({
                role: 'tool',
                content: `[Tool Error] ${toolPart.state.error}`,
                tool_call_id: toolPart.callID,
                name: toolPart.tool,
              }, ocIdx);
            }
          }
        }
      } else if (assistantText || reasoningText) {
        // Plain assistant text turn
        const foldMsg: FoldMessage = {
          role: 'assistant',
          content: assistantText || null,
        };
        if (reasoningText) {
          foldMsg.reasoning_content = reasoningText;
        }
        pushMapped(foldMsg, ocIdx);
      }
    }
  }

  return { messages: foldMessages, indexMap: { sourceByFoldMessage } };
}

// ── Reverse adapter: CWD FoldMessage → OpenCode messages ───────────────

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

let partIdCounter = 0;
function nextPartId(): string {
  return `cwd_part_${Date.now()}_${partIdCounter++}`;
}

let messageIdCounter = 0;
function nextMessageId(): string {
  return `cwd_msg_${Date.now()}_${messageIdCounter++}`;
}

/**
 * Result of reverse conversion — OpenCode messages plus the count of folded
 * context messages synthesized (fold blocks and hard-epoch seeds, for debug).
 */
export interface ToOCResult {
  messages: OCMessage[];
  foldBlockCount: number;
}

/**
 * Convert CWD's folded FoldMessage array back into OpenCode { info, parts }
 * messages.
 *
 * Strategy:
 * - Folded messages (the fold block + ack) are synthesized as text messages.
 * - Unfolded active-window messages are passed through as ORIGINAL OCMessage
 *   objects, preserving all parts (tool calls, tool results, file/images,
 *   reasoning) byte-identical.
 *
 * @param foldMessages  The folded output from FoldSession.prepare()
 * @param indexMap      Maps original FoldMessage objects back to OCMessage indices
 * @param ocMessages    The original OpenCode messages (for active-window passthrough)
 * @param sessionID     Session ID for synthesized messages
 */
export function toOpenCodeMessages(
  foldMessages: FoldMessage[],
  indexMap: FoldIndexMap,
  ocMessages: OCMessage[],
  sessionID: string,
): ToOCResult {
  const result: OCMessage[] = [];
  let foldBlockCount = 0;
  const emittedSourceIndices = new Set<number>();

  // Get model info from the first available message for synthesized messages
  const firstMsg = ocMessages[0];
  const modelRef = firstMsg ? getModelRef(firstMsg.info) : { ...DEFAULT_MODEL };
  const agentName = firstMsg?.info.agent ?? 'build';

  for (let i = 0; i < foldMessages.length; i++) {
    const fm = foldMessages[i];
    const content = typeof fm.content === 'string' ? fm.content : JSON.stringify(fm.content ?? '');

    const sourceIdx = indexMap.sourceByFoldMessage.get(fm);
    const sourceMessage = sourceIdx === undefined ? undefined : ocMessages[sourceIdx];
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
      fm.role === 'user' &&
      FOLD_BLOCK_MARKERS.some((marker) => content.includes(marker));
    const isContinuitySeed = fm.role === 'user' && content.startsWith(CONTINUITY_SEED_PREFIX);
    const isFoldStateMessage = isFoldBlock || isContinuitySeed;
    if (isFoldStateMessage) {
      foldBlockCount++;
    }

    // Fallback: synthesize a message from the fold message content
    // (fold blocks, hard-epoch seeds, acks, old frozen-prefix rows, and
    // vault-modified or otherwise host-synthesized messages).
    const msgId = nextMessageId();

    if (fm.role === 'user') {
      result.push({
        info: {
          role: 'user',
          id: msgId,
          sessionID,
          agent: agentName,
          model: { ...modelRef },
        },
        parts: [
          {
            id: nextPartId(),
            sessionID,
            messageID: msgId,
            type: 'text' as const,
            text: content,
            synthetic: true,
          },
        ],
      });
    } else if (fm.role === 'assistant') {
      result.push({
        info: {
          role: 'assistant',
          id: msgId,
          sessionID,
          agent: agentName,
          modelID: modelRef.modelID,
          providerID: modelRef.providerID,
          cost: 0,
        },
        parts: [
          {
            id: nextPartId(),
            sessionID,
            messageID: msgId,
            type: 'text' as const,
            text: content,
            synthetic: true,
          },
        ],
      });
    } else if (fm.role === 'tool') {
      result.push({
        info: {
          role: 'user',
          id: msgId,
          sessionID,
          agent: agentName,
          model: { ...modelRef },
        },
        parts: [
          {
            id: nextPartId(),
            sessionID,
            messageID: msgId,
            type: 'text' as const,
            text: `[Tool Result: ${fm.name ?? 'unknown'}]\n${content}`,
            synthetic: true,
          },
        ],
      });
    }
    // System and other roles are dropped — the system prompt is injected
    // via the experimental.chat.system.transform hook instead.
  }

  return { messages: result, foldBlockCount };
}

// ── Telemetry extraction ───────────────────────────────────────────────

/**
 * Extract measured input tokens from an OpenCode SDK Event.
 *
 * OpenCode's event system emits "message.updated" events with the full
 * Message info on every assistant response. The tokens field contains
 * measured token counts from the provider response.
 *
 * Mirrors OpenCode's own overflow math (overflow.ts:31-33):
 *   total || (input + output + cache.read + cache.write)
 *
 * This matters because on Anthropic, `input` EXCLUDES cache reads —
 * using input alone would massively understate pressure and hard epochs
 * would never trigger by measured pressure.
 *
 * Returns undefined if the event doesn't carry token telemetry.
 */
export function extractInputTokens(event: {
  type: string;
  properties?: {
    info?: {
      role?: string;
      tokens?: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
        total?: number;
      };
    };
  };
}): number | undefined {
  if (event.type !== 'message.updated') return undefined;
  const tokens = event.properties?.info?.tokens;
  if (!tokens) return undefined;

  // Prefer total if the provider reports it
  if (typeof tokens.total === 'number' && tokens.total > 0) return tokens.total;

  // Otherwise sum all components, mirroring OpenCode's overflow.ts math
  const input = typeof tokens.input === 'number' ? tokens.input : 0;
  const output = typeof tokens.output === 'number' ? tokens.output : 0;
  const cacheRead = typeof tokens.cache?.read === 'number' ? tokens.cache.read : 0;
  const cacheWrite = typeof tokens.cache?.write === 'number' ? tokens.cache.write : 0;

  const computed = input + output + cacheRead + cacheWrite;
  if (computed > 0) return computed;

  return undefined;
}

/**
 * Extract the session ID from an OpenCode event for per-session keying.
 */
export function extractSessionId(event: {
  type: string;
  properties?: {
    info?: {
      sessionID?: string;
    };
  };
}): string | undefined {
  return event.properties?.info?.sessionID;
}
