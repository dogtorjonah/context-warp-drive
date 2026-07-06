/**
 * Birth-fold hydration — pure conversion from relay transcript rows to a
 * provider-agnostic alternating seed history for FC sessions.
 *
 * Library resume ("resume-as") preserves an instance's id and transcript but
 * historically woke the new session blank, relying on lazy-rebirth to
 * synthesize a package on first message (a session swap). This module instead
 * pours the archived transcript into the reborn session's native
 * messageHistory as text-inlined turns at construction; the first
 * applyCompaction pass folds everything past the active window exactly like
 * live history (skeletons + recall index + episodic capture), giving
 * rebirth-grade continuity with no session swap mid-turn.
 *
 * Zero runtime imports by design (same residency rule as foldEpisodes.ts):
 * the resume path, FC engines, and tests consume this module without coupling
 * the persistence and engine type graphs. Source rows are a structural subset
 * of persistence/localMessages LocalMessage; seed messages are plain
 * role+string-content pairs that every FC provider shape can adopt via the
 * mappers at the bottom.
 */

// ── Types ──

export interface BirthFoldSeedMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Structural subset of persistence LocalMessage — deliberately no import. */
export interface BirthFoldSourceRow {
  /** Row type: user, assistant_text, tool_use, tool_result, system_reminder, reasoning. */
  ty: string;
  /** Text content. */
  tx?: string | null;
  /** Tool name (tool_use / tool_result rows). */
  tn?: string | null;
  /** Tool input (tool_use rows). */
  ti?: unknown;
  /** ISO timestamp. */
  ts?: string;
  /** Streaming-in-progress flag — such rows are transient duplicates. */
  sg?: boolean;
}

export interface BirthFoldConversionStats {
  sourceRows: number;
  /** Rows that contributed content to the seed (skips reasoning/system/streaming/empty). */
  usedRows: number;
  emittedMessages: number;
  totalChars: number;
  truncated: boolean;
  droppedOlderMessages: number;
  /** Rows excluded by the bounded pre-trim before block assembly. */
  preTrimmedRows: number;
  /** Rendered blocks clipped to the per-block ceiling (newest tail kept, elision note inlined). */
  clippedBlocks: number;
}

export interface BirthFoldConversionOptions {
  /** Newest-first retention budget over emitted content chars. */
  maxChars?: number;
  /** Per tool_use input JSON preview bound. */
  maxToolInputChars?: number;
  /** Per tool_result preview bound. */
  maxToolResultChars?: number;
  /** Defensive per-part bound against single pathological rows. */
  maxMessageChars?: number;
}

// ── Defaults ──

/**
 * Newest-first retention cap for the seeded history. Sized so the first fold
 * pass (which runs pre-request on the relay event loop, like every live fold)
 * stays in the measured clean/warn band — see the event-loop measurement note
 * in the Atlas changelog for this file before raising it.
 */
export const DEFAULT_BIRTH_FOLD_MAX_CHARS = 600_000;
const DEFAULT_TOOL_INPUT_CHARS = 160;
const DEFAULT_TOOL_RESULT_CHARS = 240;
const DEFAULT_MESSAGE_CHARS = 24_000;

export const BIRTH_FOLD_TAG = '[birth-fold]';

/**
 * Strip a synthetic `[birth-fold]` note from inherited seed content so it is not
 * recorded as genuine operator prose (e.g. when seeding the User Message Vault).
 * A standalone synthetic note — no real body after the note's blank-line
 * separator (the truncation/begins-mid-conversation markers) — collapses to '';
 * a `[birth-fold] …\n\n<real message>` elision/truncation PREFIX is removed,
 * returning the genuine remainder. Untagged content is returned unchanged.
 */
export function stripBirthFoldSyntheticPrefix(content: string): string {
  if (!content.startsWith(BIRTH_FOLD_TAG)) return content;
  const sep = content.indexOf('\n\n');
  return sep >= 0 ? content.slice(sep + 2).trim() : '';
}

/** The `[YYYY-MM-DD HH:MM] ` orientation stamp prepended to user rows by convertLocalMessagesToSeedHistory. */
const SEED_USER_TS_PREFIX = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] /;

/**
 * Minimal zero-dependency verbatim token extractor for birth-fold elision markers.
 * Inlined here because birthHydration is a zero-import pure leaf by design.
 * Extracts the same token shapes nominateVerbatim looks for: UUIDs, hex hashes,
 * short mixed hex (8-11), file paths, key=value pairs, changelog IDs (#NNNNN),
 * and kebab-case identifiers.
 */
const BIRTH_FOLD_TOKEN_RE = [
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, // UUIDs
  /[0-9a-f]{12,}/gi,            // hex hashes ≥12
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,11}\b/gi, // short mixed hex (rail-xxx, git SHA)
  /\/[\w./-]{4,60}/g,           // file paths
  /\b[A-Za-z_][\w.-]{0,40}[=:][ ]?[\w./:@-]{4,60}/g, // key=value pairs (port=3002)
  /#[0-9]{3,8}/g,               // changelog IDs (#12345)
  /[a-z][a-z0-9]+(?:-[a-z0-9]+){2,}/gi, // kebab-case (3+ segments)
];

function extractBirthFoldTokens(text: string): string[] {
  const MAX = 8;
  const MAX_LEN = 60;
  const MIN_LEN = 4;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const re of BIRTH_FOLD_TOKEN_RE) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const tok = m[0];
      if (tok.length < MIN_LEN || tok.length > MAX_LEN) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      result.push(tok);
      if (result.length >= MAX) return result;
    }
  }
  return result;
}

/**
 * Sanitize an inherited fold-seed user message for the User Message Vault.
 * Strips the synthetic `[birth-fold]` note (via stripBirthFoldSyntheticPrefix)
 * AND lifts the leading `[YYYY-MM-DD HH:MM] ` orientation stamp (added by
 * convertLocalMessagesToSeedHistory) out of the body into `createdAt`. The vault
 * then stores the same clean operator prose it records for live turns, so seeded
 * and live copies of the same message dedup by exact text instead of diverging
 * on the stamp, and the renderer shows the timestamp in the entry title (its
 * createdAt slot) rather than jammed inside the message body.
 */
export function parseInheritedUserMessageForVault(content: string): { text: string; createdAt?: string } {
  const withoutSynthetic = stripBirthFoldSyntheticPrefix(content);
  const match = SEED_USER_TS_PREFIX.exec(withoutSynthetic);
  if (!match) return { text: withoutSynthetic };
  return { text: withoutSynthetic.slice(match[0].length), createdAt: match[1] };
}

// ── Helpers ──

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function safeJsonPreview(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  try {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    if (!json) return '';
    return clip(collapseWhitespace(json), max);
  } catch {
    return '';
  }
}

/** "2026-06-11T23:41:02.123Z" → "2026-06-11 23:41" (empty when malformed). */
function shortTs(ts: string | undefined): string {
  if (!ts || ts.length < 16) return '';
  return ts.slice(0, 16).replace('T', ' ');
}

function mergeConsecutiveRoles(messages: BirthFoldSeedMessage[]): BirthFoldSeedMessage[] {
  const out: BirthFoldSeedMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

// ── Conversion ──

/**
 * Convert deduped transcript rows (oldest → newest) into a strictly
 * alternating user/assistant seed history:
 *
 * - `user` rows open/extend user blocks, timestamp-prefixed for orientation.
 * - `assistant_text` rows extend assistant blocks at full (bounded) fidelity.
 * - `tool_use` / `tool_result` rows inline as compact ⟨tool …⟩ trace lines in
 *   the assistant block — turn boundaries stay aligned with real user turns,
 *   so detectTurns sees the same turn structure the original session had.
 * - reasoning / system_reminder / streaming rows are dropped: model-internal
 *   or injected content must not masquerade as conversation.
 *
 * Retention is newest-first under `maxChars`; a truncation note is merged
 * into the first kept user block. Alternation is repaired at both ends so
 * the seed is valid for providers that require user-first alternating
 * history and the next live user message never lands user-on-user.
 */
export function convertLocalMessagesToSeedHistory(
  rows: readonly BirthFoldSourceRow[],
  options?: BirthFoldConversionOptions,
): { messages: BirthFoldSeedMessage[]; stats: BirthFoldConversionStats } {
  const maxChars = options?.maxChars ?? DEFAULT_BIRTH_FOLD_MAX_CHARS;
  const maxToolInputChars = options?.maxToolInputChars ?? DEFAULT_TOOL_INPUT_CHARS;
  const maxToolResultChars = options?.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS;
  const maxMessageChars = options?.maxMessageChars ?? DEFAULT_MESSAGE_CHARS;

  // Event-loop guard: bound conversion work before any string assembly by
  // pre-trimming to the newest rows that can plausibly survive the cap
  // (approximate row weight; 2.5× headroom preserves block alignment). The
  // resume path runs on the relay main thread — conversion cost must stay
  // bounded no matter how large the archived transcript is.
  let sourceRows: readonly BirthFoldSourceRow[] = rows;
  let preTrimmedRows = 0;
  if (rows.length > 1) {
    const budget = maxChars * 2.5;
    let acc = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      acc += typeof rows[i].tx === 'string' ? (rows[i].tx as string).length + 32 : 96;
      if (acc > budget && i < rows.length - 1) {
        preTrimmedRows = i + 1;
        sourceRows = rows.slice(i + 1);
        break;
      }
    }
  }

  interface MutableBlock { role: 'user' | 'assistant'; parts: string[] }
  const blocks: MutableBlock[] = [];
  let usedRows = 0;

  const append = (role: 'user' | 'assistant', part: string): void => {
    if (!part.trim()) return;
    const last = blocks[blocks.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else blocks.push({ role, parts: [part] });
    usedRows += 1;
  };

  const renderBudgets: RowRenderBudgets = { maxToolInputChars, maxToolResultChars, maxMessageChars };
  for (const row of sourceRows) {
    const part = renderRowPart(row, renderBudgets);
    if (!part) continue;
    append(part.role, part.text);
  }

  const rendered: BirthFoldSeedMessage[] = blocks.map((b) => ({
    role: b.role,
    content: b.parts.join('\n\n'),
  }));

  // Per-block ceiling. Retention below never cuts the newest block (dropping
  // it would gut the seed), so a single block bigger than maxChars — e.g. a
  // long autonomous stretch of tool parts and narration with no interleaving
  // user row — would otherwise ship oversized no matter what retention does,
  // and with one detected turn the first fold pass keeps it verbatim
  // (provider context overflow on the first post-resume message). Clip to the
  // newest tail: chronological parts put the freshest content at the end.
  // Keeps kept-content total ≤ maxChars unconditionally.
  //
  // The elided marker includes verbatim recall tokens extracted from the
  // clipped front, so the fold recall engine can self-activate recovery when
  // the agent writes those tokens in subsequent turns.
  let clippedBlocks = 0;
  for (let i = 0; i < rendered.length; i++) {
    const content = rendered[i].content;
    if (content.length > maxChars) {
      const keep = Math.max(1, maxChars - 160);
      const elidedText = content.slice(0, content.length - keep);
      const elided = content.length - keep;
      const tokens = extractBirthFoldTokens(elidedText);
      const tokenStr = tokens.length > 0 ? ` — write any token to recall: ${tokens.join(', ')}` : '';
      rendered[i] = {
        role: rendered[i].role,
        content: `${BIRTH_FOLD_TAG} (oversized block: ${elided} chars elided${tokenStr}; newest tail kept)\n\n…${content.slice(-keep)}`,
      };
      clippedBlocks += 1;
    }
  }

  // Newest-first retention under maxChars.
  let cutStart = 0;
  {
    let total = 0;
    cutStart = 0;
    for (let i = rendered.length - 1; i >= 0; i--) {
      total += rendered[i].content.length;
      if (total > maxChars && i < rendered.length - 1) {
        cutStart = i + 1;
        break;
      }
    }
    if (cutStart > 0) {
      // Align the kept slice to a user block so turn structure starts clean.
      let aligned = cutStart;
      while (aligned < rendered.length && rendered[aligned].role !== 'user') aligned += 1;
      if (aligned < rendered.length) cutStart = aligned;
    }
  }

  const dropped = cutStart;
  let droppedChars = 0;
  for (let i = 0; i < cutStart; i++) droppedChars += rendered[i].content.length;
  let kept = rendered.slice(cutStart);

  const wasTruncated = dropped > 0 || preTrimmedRows > 0;
  if (wasTruncated && kept.length > 0) {
    const omitted = dropped > 0
      ? `${dropped} older message block(s) (~${droppedChars} chars)`
      : `${preTrimmedRows} older transcript row(s)`;
    const note = `${BIRTH_FOLD_TAG} Inherited transcript truncated: ${omitted} omitted. Episodic memory can still recall that era on file touch.`;
    if (kept[0].role === 'user') {
      kept[0] = { role: 'user', content: `${note}\n\n${kept[0].content}` };
    } else {
      kept = [{ role: 'user', content: note }, ...kept];
    }
  }

  kept = mergeConsecutiveRoles(kept);
  if (kept.length > 0 && kept[0].role === 'assistant') {
    kept.unshift({ role: 'user', content: `${BIRTH_FOLD_TAG} Inherited transcript begins mid-conversation.` });
  }
  if (kept.length > 0 && kept[kept.length - 1].role === 'user') {
    kept.push({ role: 'assistant', content: `${BIRTH_FOLD_TAG} (Archived before the assistant replied; continuing from here.)` });
  }

  let totalChars = 0;
  for (const m of kept) totalChars += m.content.length;

  return {
    messages: kept,
    stats: {
      sourceRows: rows.length,
      usedRows,
      emittedMessages: kept.length,
      totalChars,
      truncated: wasTruncated,
      droppedOlderMessages: dropped,
      preTrimmedRows,
      clippedBlocks,
    },
  };
}

// ── Per-row rendering (shared by block + trace converters) ──

/** Per-row render budgets shared by the block and trace converters. */
interface RowRenderBudgets {
  maxToolInputChars: number;
  maxToolResultChars: number;
  maxMessageChars: number;
}

/**
 * Render one transcript row to its seed part. Single source of truth for both
 * convertLocalMessagesToSeedHistory (block-merged birth seeds) and
 * convertLocalMessagesToTraceMessages (per-row hard-epoch traces). Returns
 * null for rows that contribute nothing (streaming duplicates, reasoning,
 * system reminders, empty text).
 */
function renderRowPart(
  row: BirthFoldSourceRow,
  budgets: RowRenderBudgets,
): { role: 'user' | 'assistant'; text: string } | null {
  if (row.sg === true) return null;
  switch (row.ty) {
    case 'user': {
      const text = typeof row.tx === 'string' ? row.tx : '';
      if (!text.trim()) return null;
      const stamp = shortTs(row.ts);
      return { role: 'user', text: clip(stamp ? `[${stamp}] ${text}` : text, budgets.maxMessageChars) };
    }
    case 'assistant_text': {
      const text = typeof row.tx === 'string' ? row.tx : '';
      if (!text.trim()) return null;
      return { role: 'assistant', text: clip(text, budgets.maxMessageChars) };
    }
    case 'tool_use': {
      const name = typeof row.tn === 'string' && row.tn ? row.tn : 'tool';
      const preview = safeJsonPreview(row.ti, budgets.maxToolInputChars);
      return { role: 'assistant', text: preview ? `⟨tool ${name} ${preview}⟩` : `⟨tool ${name}⟩` };
    }
    case 'tool_result': {
      const text = typeof row.tx === 'string' ? collapseWhitespace(row.tx) : '';
      if (!text) return null;
      const name = typeof row.tn === 'string' && row.tn ? ` ${row.tn}` : '';
      return { role: 'assistant', text: `⟨tool result${name}: ${clip(text, budgets.maxToolResultChars)}⟩` };
    }
    default:
      return null;
  }
}

// ── Per-row trace conversion (hard-epoch seed bodies) ──

/** Stats for convertLocalMessagesToTraceMessages. */
export interface BirthFoldTraceConversionStats {
  sourceRows: number;
  /** Rendered per-row messages before newest-first retention. */
  renderedMessages: number;
  droppedOlderMessages: number;
  /** Rows excluded by the bounded pre-trim before rendering. */
  preTrimmedRows: number;
  totalChars: number;
  truncated: boolean;
}

/**
 * Per-row trace conversion for hard-epoch seed bodies (rail-2dcc0c4f).
 *
 * Renders the SAME per-row parts as convertLocalMessagesToSeedHistory but
 * WITHOUT consecutive-role block merging, alternation repair, or synthetic
 * trailers. Why: the block converter collapses tool-only stretches into one
 * giant assistant block (a transcript with no real user rows becomes a single
 * mega-block). Downstream newest-first section builders (buildRawHardEpochSeed)
 * truncate each MESSAGE from the front, so a seed built over merged blocks
 * pins to the oldest content of the mega-block and never advances as the
 * trace grows — the byte-identical hard-epoch seed bug. Per-row granularity
 * restores a real chronological message list so newest-first fills see the
 * newest work and the seed advances with the trace.
 *
 * ⚠ NOT provider-history-safe: output does NOT alternate roles and must never
 * be fed to a provider as message history. Consumers are text-section builders
 * (buildRawHardEpochSeed) only. Birth hydration keeps using
 * convertLocalMessagesToSeedHistory, whose alternation contract is untouched.
 *
 * Newest-first retention under maxChars drops the OLDEST messages first; the
 * newest message is never dropped (tail-clipped if singly oversized). A
 * compact truncation marker is prepended when anything was dropped.
 */
export function convertLocalMessagesToTraceMessages(
  rows: readonly BirthFoldSourceRow[],
  options?: BirthFoldConversionOptions,
): { messages: BirthFoldSeedMessage[]; stats: BirthFoldTraceConversionStats } {
  const maxChars = options?.maxChars ?? DEFAULT_BIRTH_FOLD_MAX_CHARS;
  const maxToolInputChars = options?.maxToolInputChars ?? DEFAULT_TOOL_INPUT_CHARS;
  const maxToolResultChars = options?.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS;
  const maxMessageChars = options?.maxMessageChars ?? DEFAULT_MESSAGE_CHARS;

  // Same event-loop pre-trim guard as convertLocalMessagesToSeedHistory: bound
  // rendering work before any string assembly (hard epochs run on the relay
  // main thread against full transcripts).
  let sourceRows: readonly BirthFoldSourceRow[] = rows;
  let preTrimmedRows = 0;
  if (rows.length > 1) {
    const budget = maxChars * 2.5;
    let acc = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      acc += typeof rows[i].tx === 'string' ? (rows[i].tx as string).length + 32 : 96;
      if (acc > budget && i < rows.length - 1) {
        preTrimmedRows = i + 1;
        sourceRows = rows.slice(i + 1);
        break;
      }
    }
  }

  const budgets: RowRenderBudgets = { maxToolInputChars, maxToolResultChars, maxMessageChars };
  const rendered: BirthFoldSeedMessage[] = [];
  for (const row of sourceRows) {
    const part = renderRowPart(row, budgets);
    if (!part) continue;
    rendered.push({ role: part.role, content: part.text });
  }

  // Newest-first retention over whole messages; the newest message always survives.
  let cutStart = 0;
  {
    let total = 0;
    for (let i = rendered.length - 1; i >= 0; i--) {
      const len = rendered[i].content.length;
      if (i < rendered.length - 1 && total + len > maxChars) {
        cutStart = i + 1;
        break;
      }
      total += len;
    }
  }
  let kept = rendered.slice(cutStart);
  if (kept.length === 1 && kept[0].content.length > maxChars) {
    const keep = Math.max(1, maxChars - 160);
    const elided = kept[0].content.length - keep;
    kept = [{
      role: kept[0].role,
      content: `${BIRTH_FOLD_TAG} (oversized message: ${elided} chars elided; newest tail kept)\n\n…${kept[0].content.slice(-keep)}`,
    }];
  }

  const droppedOlderMessages = cutStart;
  const truncated = droppedOlderMessages > 0 || preTrimmedRows > 0;
  if (truncated && kept.length > 0) {
    const omitted = droppedOlderMessages > 0
      ? `${droppedOlderMessages} older message(s)`
      : `${preTrimmedRows} older transcript row(s)`;
    kept.unshift({ role: 'user', content: `${BIRTH_FOLD_TAG} Trace truncated: ${omitted} omitted.` });
  }

  let totalChars = 0;
  for (const m of kept) totalChars += m.content.length;

  return {
    messages: kept,
    stats: {
      sourceRows: rows.length,
      renderedMessages: rendered.length,
      droppedOlderMessages,
      preTrimmedRows,
      totalChars,
      truncated,
    },
  };
}

// ── Env knob (pure parse; callers read process.env) ──

export function resolveBirthFoldMaxChars(raw: string | undefined): number {
  if (!raw) return DEFAULT_BIRTH_FOLD_MAX_CHARS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BIRTH_FOLD_MAX_CHARS;
}

const BIRTH_FOLD_SEED_CHARS_PER_TOKEN = 4;
const BIRTH_FOLD_SEED_WINDOW_FRACTION = 0.15;
const BIRTH_FOLD_SEED_MIN_CHARS = 40_000;

export interface BirthFoldSeedMaxOptions {
  /** Optional hard ceiling layered above the env/default ceiling. */
  ceilingChars?: number;
}

/**
 * Window-aware seed cap for provider-visible birth-fold hydration.
 *
 * `effectiveWindowTokens` is a config token ceiling, not a live text estimate:
 * FC call sites pass the resolved pressure ceiling when enabled, while CLI
 * reconstruction paths may pass the model window. The optional `ceilingChars`
 * lets callers mirror stricter package envelopes without changing the pure
 * converter's historical default.
 */
export function resolveBirthFoldSeedMaxChars(
  effectiveWindowTokens: number | null | undefined,
  rawMaxChars?: string,
  options: BirthFoldSeedMaxOptions = {},
): number {
  const configuredCeiling = resolveBirthFoldMaxChars(rawMaxChars);
  const optionCeiling = Number.isFinite(options.ceilingChars) && (options.ceilingChars ?? 0) > 0
    ? Math.floor(options.ceilingChars as number)
    : configuredCeiling;
  const ceiling = Math.min(configuredCeiling, optionCeiling);
  if (!Number.isFinite(effectiveWindowTokens) || (effectiveWindowTokens ?? 0) <= 0) {
    return ceiling;
  }
  const windowFitChars = Math.round(
    (effectiveWindowTokens as number) * BIRTH_FOLD_SEED_WINDOW_FRACTION * BIRTH_FOLD_SEED_CHARS_PER_TOKEN,
  );
  const floor = Math.min(ceiling, BIRTH_FOLD_SEED_MIN_CHARS);
  return Math.max(floor, Math.min(ceiling, windowFitChars));
}

// ── Engine mappers (structurally assignable to each engine's native types) ──

/** Anthropic-family history (claude-api, grok, glm, minimax, mistral): content is a text block array. */
export function seedToAnthropicMessage(
  m: BirthFoldSeedMessage,
):
  | { role: 'user'; content: Array<{ type: 'text'; text: string }> }
  | { role: 'assistant'; content: Array<{ type: 'text'; text: string }> } {
  return m.role === 'user'
    ? { role: 'user', content: [{ type: 'text', text: m.content }] }
    : { role: 'assistant', content: [{ type: 'text', text: m.content }] };
}

/** OpenAI Chat Completions history: plain string content. */
export function seedToOpenAIChatMessage(
  m: BirthFoldSeedMessage,
): { role: 'user' | 'assistant'; content: string } {
  return { role: m.role, content: m.content };
}

/** Gemini history: model role + parts array. */
export function seedToGeminiContent(
  m: BirthFoldSeedMessage,
): { role: 'user' | 'model'; parts: Array<{ text: string }> } {
  return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
}
