/**
 * Fold Recall — ambient page-in for folded context.
 *
 * The rolling fold pages content OUT of context (inter-turn turn skeletons,
 * intra-turn folded tool results); this module pages it back IN when current
 * activity proves it relevant again. Ambient-Atlas-style discipline applied
 * to the fold: tiered relevance triggers, TTL'd residency dedupe, a
 * context-pressure budget ladder, and deterministic rendering.
 *
 * ── Shape ──
 * - The fold INDEX is the page table. It is rebuilt ONLY at fold-freeze epoch
 *   commits (the only moments the folded view changes): inter-turn entries by
 *   replaying the deterministic turn detection over raw history and reading
 *   the folded-view fold block's exact "N turns folded" count; intra-turn
 *   entries by scanning the folded view for the fold's own
 *   "[Folded: tool path — n,nnn chars | self-tap to recover]" markers, keyed
 *   by provider tool ids (tool_use_id / tool_call_id) as recovery handles.
 * - TRIGGERS (tool-boundary only): tier 0 = a tool call re-touches a folded
 *   path; tier 1 = a file claim lands on a folded path. Tier 2 distinctive-term
 *   overlap is available behind WARP_FOLD_RECALL_TERMS (default OFF).
 * - INJECTION: the session appends rendered cards/hints to the tool result's
 *   post-dispatch context (the same channel as tool-boundary mesh digest
 *   deltas; payloads are body-only strings). Cards land durably in raw
 *   history, APPEND-ONLY, riding the freeze tail — the frozen prefix stays
 *   byte-identical, the provider prompt cache stays HOT, and recall never
 *   forces an epoch.
 * - PAGE-OUT-AGAIN: cards/hints carry RECALL_CARD_PREFIX / RECALL_HINT_PREFIX,
 *   which rollingFold treats as synthetic (never a turn boundary); at the
 *   next epoch the card's turn refolds and the body leaves the view again.
 *   Fully cyclic: content breathes in and out of context on demand.
 *
 * Pure CPU, zero I/O, zero LLM calls, no clock reads. Deterministic by
 * construction: identical inputs produce byte-identical output, and no
 * Set/Map iteration order is observable in any rendered string (entries are
 * explicitly ordered: tier asc, recency desc, id asc).
 *
 * Kill switch: WARP_FOLD_RECALL=0. Recall only ever runs when fold mode is
 * 'on' and the fold freeze is active — no fold, no index, no recall.
 */

import {
  classifyTurn,
  countChars,
  detectTurns,
  extractAssistantText,
  extractPath,
  extractToolPathSet,
  isSyntheticContextText,
  nominateVerbatim,
  normalizeToolPath,
  RECALL_CARD_PREFIX,
  RECALL_HINT_PREFIX,
  type FoldMessage,
  type Turn,
  type TurnCategory,
} from './rollingFold.ts';
import type { ContextUtilizationLevel } from './contextWindow.ts';
import { extractDistinctiveTerms, idfFromDocumentFrequency, scoreTermOverlap } from './foldTerms.ts';

// ══════════════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════════════

export interface FoldRecallConfig {
  /** Master switch (WARP_FOLD_RECALL). Default ON when fold mode is 'on'. */
  enabled: boolean;
  /** Max full-content cards injected per pass (healthy pressure). */
  maxCards: number;
  /** Max total recall chars (cards + hints) injected per pass. */
  maxTotalChars: number;
  /** Max chars per card body (char-safe head+tail excerpt beyond this). */
  maxCardChars: number;
  /** Residency TTL in recall passes — an injected entry is suppressed for this many subsequent passes. */
  ttlPasses: number;
  /** Tier-2 distinctive-term matching. Default OFF; path tiers stay unchanged. */
  termRecallEnabled: boolean;
  /**
   * Exact verbatim-token page-in (WARP_FOLD_RECALL_VERBATIM). When a kept
   * identifier (a hash/UUID conserved by the Coordinate Closet) re-surfaces in the
   * active window, its source turn pages back in. A single EXACT match suffices
   * (vs the ≥2 fuzzy-term gate). Default ON (operator-blessed, Jonah 2026-06-14);
   * set WARP_FOLD_RECALL_VERBATIM=0 for byte-identical legacy behavior. Path/
   * claim tiers still outrank.
   */
  verbatimRecallEnabled: boolean;
  /**
   * Curated Code Radar — source-highlight guideposts (WARP_FOLD_RECALL_HIGHLIGHTS).
   * Prepends Atlas-curated `⌖ label (a–b)` lines to a recall card so the agent
   * sees the file's key regions the moment it pages back in. Default ON
   * (operator-blessed, Jonah 2026-06-17). Renders only when enrichment is
   * resident in FoldRecallState; absence is byte-identical to legacy recall.
   */
  highlightsEnabled: boolean;
  /**
   * Curated Code Radar — hazard guideposts (WARP_FOLD_RECALL_HAZARDS).
   * Prepends Atlas-curated `⚠️ text (L85)` lines (hazard-first, above highlights)
   * so a hazard the agent is about to trip surfaces on re-touch. Default ON
   * (operator-blessed, Jonah 2026-06-17). Same residency/byte-identity contract.
   */
  hazardsEnabled: boolean;
}

export const DEFAULT_FOLD_RECALL_CONFIG: FoldRecallConfig = {
  enabled: true,
  maxCards: 2,
  maxTotalChars: 12_000,
  maxCardChars: 6_000,
  ttlPasses: 8,
  termRecallEnabled: false,
  verbatimRecallEnabled: true,
  highlightsEnabled: true,
  hazardsEnabled: true,
};

/** Hints injected per pass never exceed this, regardless of pressure. */
const MAX_HINTS_PER_PASS = 4;
/** Minimum remaining char budget worth spending on a card; below this, downgrade to hint. */
const MIN_USEFUL_CARD_CHARS = 400;
/** Bounded lowercased per-turn digest length (reserved for deferred tier-2 term matching). */
const TURN_DIGEST_MAX_CHARS = 400;
const TERM_RECALL_MIN_DISTINCTIVE_COUNT = 2;

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve config from environment. Default ON (recall is already gated on
 * fold mode 'on' + an active fold-freeze index upstream).
 *   WARP_FOLD_RECALL=0|false|off|no       → disable
 *   WARP_FOLD_RECALL_MAX_CARDS=<n>        → cards per pass (default 2)
 *   WARP_FOLD_RECALL_MAX_TOTAL_CHARS=<n>  → total chars per pass (default 12000)
 *   WARP_FOLD_RECALL_MAX_CARD_CHARS=<n>   → chars per card body (default 6000)
 *   WARP_FOLD_RECALL_TTL_PASSES=<n>       → residency TTL in passes (default 8)
 *   WARP_FOLD_RECALL_TERMS=1|true|on|yes  → enable tier-2 term matching (default off)
 *   WARP_FOLD_RECALL_VERBATIM=0|false|off|no → disable exact verbatim-token tier (default ON)
 *   WARP_FOLD_RECALL_HIGHLIGHTS=0|false|off|no → disable source-highlight radar (default ON)
 *   WARP_FOLD_RECALL_HAZARDS=0|false|off|no → disable hazard radar (default ON)
 */
export function resolveFoldRecallConfig(
  env: Record<string, string | undefined> = process.env,
): FoldRecallConfig {
  const raw = (env.WARP_FOLD_RECALL ?? '').trim().toLowerCase();
  const enabled = raw === '' || (raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no');
  const termRaw = (env.WARP_FOLD_RECALL_TERMS ?? '').trim().toLowerCase();
  const verbatimRaw = (env.WARP_FOLD_RECALL_VERBATIM ?? '').trim().toLowerCase();
  const highlightsRaw = (env.WARP_FOLD_RECALL_HIGHLIGHTS ?? '').trim().toLowerCase();
  const hazardsRaw = (env.WARP_FOLD_RECALL_HAZARDS ?? '').trim().toLowerCase();
  return {
    enabled,
    maxCards: parsePositiveInt(env.WARP_FOLD_RECALL_MAX_CARDS) ?? DEFAULT_FOLD_RECALL_CONFIG.maxCards,
    maxTotalChars: parsePositiveInt(env.WARP_FOLD_RECALL_MAX_TOTAL_CHARS) ?? DEFAULT_FOLD_RECALL_CONFIG.maxTotalChars,
    maxCardChars: parsePositiveInt(env.WARP_FOLD_RECALL_MAX_CARD_CHARS) ?? DEFAULT_FOLD_RECALL_CONFIG.maxCardChars,
    ttlPasses: parsePositiveInt(env.WARP_FOLD_RECALL_TTL_PASSES) ?? DEFAULT_FOLD_RECALL_CONFIG.ttlPasses,
    termRecallEnabled: termRaw === '1' || termRaw === 'true' || termRaw === 'on' || termRaw === 'yes',
    // Default ON (operator-blessed); only explicit disable values turn it off.
    verbatimRecallEnabled:
      verbatimRaw === '' || (verbatimRaw !== '0' && verbatimRaw !== 'false' && verbatimRaw !== 'off' && verbatimRaw !== 'no'),
    // Curated Code Radar (operator-blessed, Jonah 2026-06-17): both default ON;
    // only explicit 0/false/off/no disable. Same idiom as verbatimRecallEnabled.
    highlightsEnabled:
      highlightsRaw === '' || (highlightsRaw !== '0' && highlightsRaw !== 'false' && highlightsRaw !== 'off' && highlightsRaw !== 'no'),
    hazardsEnabled:
      hazardsRaw === '' || (hazardsRaw !== '0' && hazardsRaw !== 'false' && hazardsRaw !== 'off' && hazardsRaw !== 'no'),
  };
}

// ══════════════════════════════════════════════════════════════════════
// Bash path extraction
// ══════════════════════════════════════════════════════════════════════

const BASH_TOOL_NAME_RE = /^(run_bash|bash)$/i;
const COMPACT_TOOL_TRACE_RE = /⟨tool\s+(?!result\b)[^\s⟩]+(?:\s+([^⟩]+))?⟩/g;
const COMPACT_TRACE_PATH_RE = /"(file_path|path|filePath|file)"\s*:\s*"((?:\\.|[^"\\])+)"/g;

/** Quote-aware shell tokenizer. Honors '...' and "..." as single tokens. */
function tokenizeShell(cmd: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    while (i < cmd.length && (cmd[i] === ' ' || cmd[i] === '\t' || cmd[i] === '\n' || cmd[i] === '\r')) i++;
    if (i >= cmd.length) break;
    let token = '';
    while (i < cmd.length && cmd[i] !== ' ' && cmd[i] !== '\t' && cmd[i] !== '\n' && cmd[i] !== '\r') {
      const ch = cmd[i];
      if (ch === "'") {
        i++;
        while (i < cmd.length && cmd[i] !== "'") token += cmd[i++];
        if (i < cmd.length) i++;
      } else if (ch === '"') {
        i++;
        while (i < cmd.length && cmd[i] !== '"') {
          if (cmd[i] === '\\' && i + 1 < cmd.length) i++;
          token += cmd[i++];
        }
        if (i < cmd.length) i++;
      } else {
        token += ch;
        i++;
      }
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * Extract file paths from a bash command string.
 *
 * Quote-aware tokenize; a token qualifies if: it contains '/', does not
 * contain '://', does not start with '-', contains no shell redirect chars
 * (`<`/`>`), is not a `/dev/...` device path, and length ≤ 256. Trailing
 * punctuation (;:,)"') is stripped before qualifying. First-occurrence order,
 * deduped, capped at 4 paths per command. Each result is normalized with
 * normalizeToolPath — identical to structured-tool path normalization.
 */
export function extractPathsFromBashCommand(command: string): string[] {
  const tokens = tokenizeShell(command);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tokens) {
    if (result.length >= 4) break;
    const token = raw.replace(/[;:,)"']+$/, '');
    if (!token) continue;
    if (!token.includes('/')) continue;
    if (token.includes('://')) continue;
    if (token.startsWith('-')) continue;
    if (/[<>]/.test(token)) continue;
    if (token.length > 256) continue;
    const normalized = normalizeToolPath(token);
    if (normalized === '/dev' || normalized.startsWith('/dev/')) continue;
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/** Collect normalized bash-command paths from tool_use blocks in a turn's messages. */
function extractBashPathsFromMessages(messages: readonly FoldMessage[]): string[] {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_use' && typeof block.name === 'string' && BASH_TOOL_NAME_RE.test(block.name)) {
          const cmd = (block.input as any)?.command;
          if (typeof cmd === 'string') {
            for (const p of extractPathsFromBashCommand(cmd)) paths.add(p);
          }
        }
      }
    }
    if (Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls as any[]) {
        if (tc?.id && tc?.function?.name && BASH_TOOL_NAME_RE.test(tc.function.name)) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments ?? '{}'); } catch { /* skip */ }
          const cmd = args.command;
          if (typeof cmd === 'string') {
            for (const p of extractPathsFromBashCommand(cmd)) paths.add(p);
          }
        }
      }
    }
  }
  return Array.from(paths);
}

function unescapeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/**
 * Codex fold seed history inlines tool_use rows as compact text traces:
 * `⟨tool Read {"file_path":"src/x.ts"}⟩`. Those are intentionally strings
 * (Responses injection portability), so the FC structured-tool extractor cannot
 * see their path arguments. Parse only the bounded trace wrapper emitted by
 * foldBirthHydration; arbitrary prose remains ignored.
 */
function extractCompactToolTracePaths(messages: readonly FoldMessage[]): string[] {
  const paths = new Set<string>();
  const scan = (text: string): void => {
    COMPACT_TOOL_TRACE_RE.lastIndex = 0;
    let trace: RegExpExecArray | null;
    while ((trace = COMPACT_TOOL_TRACE_RE.exec(text)) !== null) {
      const payload = trace[1];
      if (!payload) continue;
      COMPACT_TRACE_PATH_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = COMPACT_TRACE_PATH_RE.exec(payload)) !== null) {
        const rawPath = unescapeJsonStringFragment(match[2]);
        const normalized = normalizeToolPath(rawPath);
        if (normalized) paths.add(normalized);
      }
    }
  };
  for (const msg of messages) {
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    if (typeof msg.content === 'string') {
      scan(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; text?: unknown } | string>) {
        if (typeof block === 'string') scan(block);
        else if (block?.type === 'text' && typeof block.text === 'string') scan(block.text);
      }
    }
  }
  return Array.from(paths).sort();
}

// ══════════════════════════════════════════════════════════════════════
// Index (page table)
// ══════════════════════════════════════════════════════════════════════

/** A whole turn paged out by the inter-turn fold (skeletonized in the view). */
export interface InterTurnIndexEntry {
  kind: 'turn';
  /** Deterministic id, stable across rebuilds while raw history is append-only. */
  id: string;
  /** Raw history message range [rawStart, rawEnd) — the recall content source. */
  rawStart: number;
  rawEnd: number;
  /** Recency coordinate (raw message index) used for deterministic ordering. */
  recency: number;
  category: TurnCategory;
  /** Normalized tool-arg paths touched in this turn, sorted (trigger matching). */
  paths: string[];
  /** Bounded lowercased turn text (reserved for deferred tier-2 term matching). */
  digest: string;
  /** Original turn size in chars (telemetry / card header). */
  chars: number;
  /**
   * Sorted verbatim identifiers (UUIDs/hex/paths/KV — nominateVerbatim, cap 40)
   * this turn paged out, the same family the Coordinate Closet conserves. Drives the
   * exact-token page-in tier (WARP_FOLD_RECALL_VERBATIM). Bounded to the turn's
   * own nomination — no dense search/embeddings.
   */
  verbatimTokens?: string[];
}

/** A single tool result paged out by the intra-turn fold (marker in the view). */
export interface IntraTurnIndexEntry {
  kind: 'tool';
  /** Deterministic id: `tool:<toolId>`. */
  id: string;
  /** Provider recovery handle: tool_use_id (Anthropic) / tool_call_id (OpenAI). */
  toolId: string;
  /** Short tool name parsed from the fold marker. */
  tool: string;
  /** Normalized path parsed from the fold marker ('' when the tool had none). */
  path: string;
  /** Recency coordinate (raw message index of the folded result). */
  recency: number;
  /** Folded chars parsed from the marker (telemetry / card header). */
  chars: number;
}

export type FoldIndexEntry = InterTurnIndexEntry | IntraTurnIndexEntry;

export interface FoldRecallIndex {
  /** Raw history length at build time — staleness guard against rewinds. */
  rawCount: number;
  /** Entries in deterministic build order (turns by rawStart asc, then tools by raw position asc). */
  entries: FoldIndexEntry[];
}

/** Matches the folded view's fold-block header: "[Conversation Context — N turns folded, …". */
const FOLD_BLOCK_COUNT_RE = /^\[Conversation Context — (\d+) turns folded,/;
/** Whole-content intra-fold marker (generic replacement by foldSummaryText). */
const INTRA_GENERIC_MARKER_RE = /^\[Folded: (\S+)(?: (.+?))? — ([\d,]+) chars \| self-tap to recover\]$/;
/** Suffix intra-fold marker (atlas metadata-preserving variant). */
const INTRA_ATLAS_MARKER_RE = /\n## Source \[Folded: (\S+)(?: (.+?))? — ([\d,]+) chars of source code \| self-tap to recover\]$/;

function parseMarkerChars(raw: string): number {
  const n = Number.parseInt(raw.replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Join an Anthropic tool_result block's content into plain text (mirrors rollingFold). */
function blockContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b))).join('\n');
  }
  return JSON.stringify(content ?? '');
}

interface ParsedIntraMarker {
  tool: string;
  path: string;
  chars: number;
}

/**
 * Parse an intra-fold marker out of a folded tool result's content. Anchored
 * matching (whole-content for the generic marker, suffix for the atlas
 * variant) so markers merely QUOTED inside live tool output never index.
 */
function parseIntraMarker(content: string): ParsedIntraMarker | null {
  const generic = INTRA_GENERIC_MARKER_RE.exec(content);
  if (generic) {
    return { tool: generic[1], path: normalizeToolPath(generic[2] ?? ''), chars: parseMarkerChars(generic[3]) };
  }
  const atlas = INTRA_ATLAS_MARKER_RE.exec(content);
  if (atlas) {
    return { tool: atlas[1], path: normalizeToolPath(atlas[2] ?? ''), chars: parseMarkerChars(atlas[3]) };
  }
  return null;
}

function buildTurnDigest(turnMessages: FoldMessage[]): string {
  const parts: string[] = [];
  const user = extractFirstUserText(turnMessages);
  if (user) parts.push(user);
  const assistant = extractAssistantText(turnMessages);
  if (assistant) parts.push(assistant);
  return parts.join(' ').toLowerCase().slice(0, TURN_DIGEST_MAX_CHARS);
}

/** First REAL user text in a slice (synthetic fold/recall blocks excluded). */
function extractFirstUserText(messages: readonly FoldMessage[]): string {
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      if (msg.content.length > 0 && !isSyntheticContextText(msg.content)) return msg.content;
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (typeof block === 'string' && block.length > 0 && !isSyntheticContextText(block)) return block;
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0 && !isSyntheticContextText(block.text)) {
          return block.text;
        }
      }
    }
  }
  return '';
}

/** Cap on the active-window query text fed to tier-2 term extraction — a few
 *  turns of recent cognition; recency-favored when the unfolded tail exceeds it. */
const ACTIVE_WINDOW_MAX_CHARS = 1600;

/**
 * Active-window text for tier-2 distinctive-term matching: the user- and
 * assistant-authored text of the live, unfolded raw tail (messages added since
 * the fold index was last built — raw.slice(foldedRawCount)). Mirrors
 * buildTurnDigest's surface (first real user text + assistant text; tool results
 * and synthetic recall/fold blocks excluded) so the query terms and the index's
 * per-turn digest terms are drawn from the same vocabulary. Recency-favored cap
 * keeps extraction cheap and focused on current cognition. Pure; returns '' when
 * the unfolded tail is empty. The live caller passes activeText only when term
 * recall is flag-enabled, so default-off behavior is unaffected.
 */
export function extractActiveWindowText(
  rawHistory: readonly FoldMessage[],
  foldedRawCount: number,
): string {
  if (foldedRawCount < 0 || foldedRawCount >= rawHistory.length) return '';
  const tail = rawHistory.slice(foldedRawCount);
  const user = extractFirstUserText(tail);
  const assistant = extractAssistantText(tail);
  const combined = [user, assistant].filter((s) => s.length > 0).join(' ');
  return combined.length > ACTIVE_WINDOW_MAX_CHARS
    ? combined.slice(combined.length - ACTIVE_WINDOW_MAX_CHARS)
    : combined;
}

/**
 * Concatenate a turn's verbatim-bearing text (user text, assistant text, and
 * tool-result bodies across Anthropic content[], OpenAI tool messages, and
 * Gemini parts) for exact-token indexing. Pure; bounded by the turn's own size.
 * Feeds nominateVerbatim so the indexed tokens are the same family the Verbatim
 * Keep conserves.
 */
function extractTurnVerbatimText(turnMessages: readonly FoldMessage[]): string {
  const parts: string[] = [];
  const pushBlockContent = (content: unknown): void => {
    if (typeof content === 'string') {
      if (content) parts.push(content);
    } else if (Array.isArray(content)) {
      for (const b of content as any[]) {
        if (typeof b === 'string') parts.push(b);
        else if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
  };
  for (const msg of turnMessages) {
    const content = (msg as any).content;
    if (typeof content === 'string') {
      if (content) parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content as any[]) {
        if (typeof block === 'string') parts.push(block);
        else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        else if (block?.type === 'tool_result') pushBlockContent(block.content);
      }
    }
    // OpenAI role:'tool' string content is already captured by the string branch above.
    if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts as any[]) {
        if (typeof part?.text === 'string' && part.text) parts.push(part.text);
        const resp = part?.functionResponse?.response;
        if (resp !== undefined) {
          try {
            parts.push(typeof resp === 'string' ? resp : JSON.stringify(resp));
          } catch {
            /* non-serializable response — skip */
          }
        }
      }
    }
  }
  return parts.join('\n');
}

/** Map of toolId → raw message index for every tool result present in raw history. */
function buildToolResultPositions(rawHistory: readonly FoldMessage[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (let i = 0; i < rawHistory.length; i++) {
    const msg = rawHistory[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && !positions.has(block.tool_use_id)) {
          positions.set(block.tool_use_id, i);
        }
      }
    }
    if (msg.role === 'tool' && typeof (msg as any).tool_call_id === 'string') {
      const id = (msg as any).tool_call_id as string;
      if (!positions.has(id)) positions.set(id, i);
    }
  }
  return positions;
}

/**
 * Build the fold index (page table) from the raw history and the freshly
 * recomputed folded view. Call ONLY at fold-freeze epoch commits — the fold
 * is deterministic, so replaying detectTurns over raw plus reading the view's
 * own fold-block count reproduces exactly which turns folded, with zero extra
 * fold passes and zero I/O.
 *
 * Caveat: turn replay assumes upstream pipeline stages preserve user-text
 * message structure (they replace/truncate content; they don't add or remove
 * turn-boundary messages). The clamp below bounds any pathological drift, and
 * the index is advisory — recall degrades to "no entry", never to wrong slices
 * (entries carry raw ranges that are bounds-checked at render time).
 *
 * precomputedTurns: when the fold was produced with an explicit turn tiling
 * (foldContext's precomputedTurns seam — e.g. the Codex synthetic step-fold,
 * where detectTurns would collapse the flattened one-user-turn seed to a single
 * turn and yield zero inter-turn entries), pass that SAME tiling here so each
 * folded step becomes recall-addressable. Omit it on the normal multi-turn path
 * where detectTurns(rawHistory) reproduces the fold segmentation byte-for-byte.
 */
export function buildFoldIndex(
  rawHistory: readonly FoldMessage[],
  foldedView: readonly FoldMessage[],
  precomputedTurns?: readonly Turn[],
): FoldRecallIndex {
  const entries: FoldIndexEntry[] = [];

  // ── Inter-turn entries: replay turn detection over raw, count from the view's fold block ──
  let interFoldedCount = 0;
  for (const msg of foldedView) {
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const match = FOLD_BLOCK_COUNT_RE.exec(msg.content);
    if (match) {
      interFoldedCount = Number.parseInt(match[1], 10) || 0;
      break;
    }
  }
  if (interFoldedCount > 0) {
    const turns = precomputedTurns ?? detectTurns(rawHistory as FoldMessage[]);
    const count = Math.min(interFoldedCount, Math.max(0, turns.length - 1));
    for (let j = 0; j < count; j++) {
      const turn = turns[j];
      const structuredPaths = Array.from(extractToolPathSet(turn.messages));
      const bashPaths = extractBashPathsFromMessages(turn.messages);
      const compactTracePaths = extractCompactToolTracePaths(turn.messages);
      const paths = Array.from(new Set([...structuredPaths, ...bashPaths, ...compactTracePaths])).sort();
      const verbatimTokens = nominateVerbatim(extractTurnVerbatimText(turn.messages)).sort();
      entries.push({
        kind: 'turn',
        id: `turn:${turn.startIndex}`,
        rawStart: turn.startIndex,
        rawEnd: turn.endIndex,
        recency: turn.startIndex,
        category: classifyTurn(turn.messages),
        paths,
        digest: buildTurnDigest(turn.messages),
        chars: countChars(turn.messages),
        ...(verbatimTokens.length > 0 ? { verbatimTokens } : {}),
      });
    }
  }

  // ── Intra-turn entries: scan the view for fold markers, anchor to raw by tool id ──
  const rawPositions = buildToolResultPositions(rawHistory);
  for (const msg of foldedView) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        if (typeof block.content !== 'string') continue; // folded blocks always carry string content
        const marker = parseIntraMarker(block.content);
        if (!marker) continue;
        const rawIndex = rawPositions.get(block.tool_use_id);
        if (rawIndex === undefined) continue; // cannot recall what raw no longer holds
        const id = `tool:${block.tool_use_id}`;
        if (entries.some(e => e.id === id)) continue;
        entries.push({
          kind: 'tool',
          id,
          toolId: block.tool_use_id,
          tool: marker.tool,
          path: marker.path,
          recency: rawIndex,
          chars: marker.chars,
        });
      }
    }
    if (msg.role === 'tool' && typeof (msg as any).tool_call_id === 'string' && typeof msg.content === 'string') {
      const toolId = (msg as any).tool_call_id as string;
      const marker = parseIntraMarker(msg.content);
      if (!marker) continue;
      const rawIndex = rawPositions.get(toolId);
      if (rawIndex === undefined) continue;
      const id = `tool:${toolId}`;
      if (entries.some(e => e.id === id)) continue;
      entries.push({
        kind: 'tool',
        id,
        toolId,
        tool: marker.tool,
        path: marker.path,
        recency: rawIndex,
        chars: marker.chars,
      });
    }
  }

  return { rawCount: rawHistory.length, entries };
}

// ══════════════════════════════════════════════════════════════════════
// Curated Code Radar — Atlas enrichment carried on recall state (Atlas-free)
// ══════════════════════════════════════════════════════════════════════
//
// Atlas source_highlights + ranged hazards, fetched OFF-THREAD by the relay
// (worker-pool atlas:recallEnrichment) and merged into FoldRecallState keyed by
// normalized path. This package stays pure: it only HOLDS and RENDERS these — it
// never reads Atlas. Absent/empty ⇒ recall renders exactly as before (byte-
// identical), so the radar is a strict superset enhancement.

/** A curated source-highlight guidepost for a file (mirrors Atlas source_highlights). */
export interface RecallSourceHighlight {
  label: string;
  startLine: number;
  endLine: number;
}

/** A curated hazard for a file. Null start/endLine = file-level (whole-file) hazard. */
export interface RecallHazard {
  text: string;
  startLine: number | null;
  endLine: number | null;
}

/** Worker-provided live file snapshot for historical-vs-current recall deltas. */
export interface RecallSourceDelta {
  /** Normalized workspace-relative path. */
  path: string;
  /** Stable hash of the live source snapshot, supplied by the relay worker. */
  liveHash: string;
  /** Current file text, bounded by the worker before crossing back to the main thread. */
  liveSource: string;
  /** True when liveSource is a prefix because the file exceeded the worker cap. */
  truncated?: boolean;
}

// ══════════════════════════════════════════════════════════════════════
// State (per-session; lives beside foldFreezeState)
// ══════════════════════════════════════════════════════════════════════

export interface ResidencyRecord {
  level: 'card' | 'hint';
  /** Pass number at which this residency expires (suppression while passSeq < expiresAtPass). */
  expiresAtPass: number;
}

export interface FoldRecallState {
  index: FoldRecallIndex | null;
  /** entryId → residency. Map iteration order is never observable in output. */
  resident: Map<string, ResidencyRecord>;
  /**
   * Normalized path → CARD residency. Content-level suppression that survives
   * index rebuilds: after a refold the same logical content can reappear
   * under a NEW entry id (e.g. the turn that received a recall card folds and
   * itself becomes an entry for the same path) — path residency keeps recently
   * shown content quiet regardless of which entry would carry it.
   */
  residentPaths: Map<string, ResidencyRecord>;
  /**
   * Curated Code Radar carriers, keyed by normalized workspace-relative path
   * (== Atlas file_path == index entry path). Populated OFF-THREAD by the relay
   * after each epoch's buildFoldIndex; read at render time with zero I/O. Empty
   * until enrichment resolves (and whenever both flags are off) — recall degrades
   * silently to its pre-radar (byte-identical) output.
   */
  pathHighlights: Map<string, RecallSourceHighlight[]>;
  pathHazards: Map<string, RecallHazard[]>;
  /** Live source snapshots, keyed by normalized path, supplied off-thread by the relay worker. */
  pathSourceDeltas: Map<string, RecallSourceDelta>;
  /**
   * Tier-1 behavioral co-activation affinity carrier. Keyed by a composite
   * "anchor\x00zonePath" string (see affinityKey), value = normalized 0-1
   * relevance score (1.0 = strongest co-activation). Populated OFF-THREAD by the
   * relay worker from real touch/edit history (NOT recall output — closing the
   * loop on recall output creates a self-reinforcing echo chamber). Empty in
   * standalone/no-host mode → orderZoneByRelevance falls back to tier-0 proximity.
   */
  pathAffinity: Map<string, number>;
  /** Recall pass counter — one pass per tool boundary that carried signals. */
  passSeq: number;
  // ── Lifetime telemetry counters ──
  cardsInjected: number;
  hintsInjected: number;
  recallChars: number;
  suppressed: number;
}

export function createFoldRecallState(): FoldRecallState {
  return {
    index: null,
    resident: new Map(),
    residentPaths: new Map(),
    pathHighlights: new Map(),
    pathHazards: new Map(),
    pathSourceDeltas: new Map(),
    pathAffinity: new Map(),
    passSeq: 0,
    cardsInjected: 0,
    hintsInjected: 0,
    recallChars: 0,
    suppressed: 0,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Signals (v1: tool-boundary path triggers only)
// ══════════════════════════════════════════════════════════════════════

export interface RecallSignals {
  /** Normalized paths touched by the just-executed tool call, sorted. */
  touchedPaths: string[];
  /** Normalized currently-claimed paths, sorted. */
  claimedPaths: string[];
  /** Active-window distinctive terms for tier-2 matching. Empty/omitted unless supplied by caller. */
  terms?: string[];
  /** Exact verbatim identifiers seen in the active window, sorted. Drives the verbatim-token tier; omitted unless supplied. */
  verbatimTokens?: string[];
  /**
   * Paths whose Curated Code Radar is suppressed because the current boundary's
   * tool is an Atlas read (lookup/brief/snippet) of them — the agent is seeing
   * that file's full source_highlights+hazards live, so the compressed radar
   * would just parrot the tool output. Omitted unless the relay supplies it; the
   * folded card BODY still pages in, and tier matching is unaffected.
  */
  atlasReadPaths?: string[];
}

/**
 * Leaf-normalize a dispatched tool name for Atlas-read matching. Mirrors the
 * relay's normalizeAmbientAtlasToolName (kept local so this carve-out package
 * stays relay-dependency-free): strips MCP server namespaces
 * (mcp__server__atlas_query), provider prefixes (functions.atlas_query), and
 * mcp_/mcp_to_ leaders, then lowercases the leaf.
 */
function normalizeAtlasReadToolLeaf(toolName: string | null | undefined): string {
  const raw = (toolName ?? '').trim();
  if (!raw) return '';
  const doubleUnderscoreLeaf = raw.split('__').at(-1) ?? raw;
  const dottedLeaf = doubleUnderscoreLeaf.split('.').at(-1) ?? doubleUnderscoreLeaf;
  return dottedLeaf.replace(/^mcp_to_/, '').replace(/^mcp_/, '').trim().toLowerCase();
}

/**
 * True when the just-dispatched tool is itself a highlight/hazard-rendering
 * Atlas read of the touched path — atlas_lookup/atlas_brief/atlas_snippet, or
 * atlas_query with action in {lookup,brief,snippet}. The agent is then already
 * seeing that file's full source_highlights+hazards live, so the (compressed)
 * Curated Code Radar would just parrot the tool output and is suppressed for
 * those paths (the folded card BODY still pages in). The tool name is
 * leaf-normalized so namespaced MCP forms (mcp__voxxo-swarm-bridge__atlas_query)
 * and provider-prefixed forms match — not only bare names. search/history/graph/
 * diff do NOT match: they do not render the curated per-file record.
 */
export function radarDuplicatesActiveAtlasRead(
  toolName: string | null | undefined,
  action: unknown,
): boolean {
  const leaf = normalizeAtlasReadToolLeaf(toolName);
  if (leaf === 'atlas_lookup' || leaf === 'atlas_brief' || leaf === 'atlas_snippet') return true;
  if (leaf === 'atlas_query') return action === 'lookup' || action === 'brief' || action === 'snippet';
  return false;
}

/**
 * Derive recall signals at a tool boundary from the just-executed tool call,
 * the current global claims set, and optional active-window text for tier-2
 * distinctive-term matching. The term tier is config-gated default OFF.
 */
export function extractRecallSignals(
  toolInput: Record<string, unknown> | null,
  claimedPaths: ReadonlySet<string>,
  activeText: string | readonly string[] = '',
): RecallSignals {
  const touched = new Set<string>();
  if (toolInput) {
    const primary = extractPath(toolInput);
    if (primary) touched.add(primary);
    const multi = (toolInput as { paths?: unknown }).paths;
    if (Array.isArray(multi)) {
      for (const p of multi) {
        if (typeof p === 'string' && p.trim()) touched.add(normalizeToolPath(p.trim()));
      }
    }
    const cmd = (toolInput as { command?: unknown }).command;
    if (typeof cmd === 'string') {
      for (const p of extractPathsFromBashCommand(cmd)) touched.add(p);
    }
  }
  const claimed = new Set<string>();
  for (const p of claimedPaths) claimed.add(normalizeToolPath(p));
  const termText = typeof activeText === 'string' ? activeText : activeText.join('\n');
  const terms = extractDistinctiveTerms(termText);
  return {
    touchedPaths: Array.from(touched).sort(),
    claimedPaths: Array.from(claimed).sort(),
    ...(terms.length > 0 ? { terms } : {}),
  };
}

/**
 * Compose the tool-boundary recall query exactly as the live GET path consumes
 * it: derive active-window terms (flag-gated; '' when term recall is off so the
 * default path stays byte-identical), build signals, and decide whether recall
 * should proceed. `proceed` mirrors buildFoldRecallContext's internal admit
 * guard — path-touch OR claim OR (only when flag-on) distinctive term signals —
 * so pathless cognition is no longer short-circuited before terms are weighed.
 * Pure; the single seam shared by the live caller and its wiring tests.
 */
export function deriveBoundaryRecallSignals(
  toolInput: Record<string, unknown> | null,
  claimedPaths: ReadonlySet<string>,
  rawHistory: readonly FoldMessage[],
  foldedRawCount: number,
  config: FoldRecallConfig,
): { signals: RecallSignals; proceed: boolean } {
  const needActive = config.termRecallEnabled || config.verbatimRecallEnabled;
  const activeText = needActive ? extractActiveWindowText(rawHistory, foldedRawCount) : '';
  const signals = extractRecallSignals(toolInput, claimedPaths, activeText);
  // extractRecallSignals always derives terms from activeText; but the verbatim
  // tier also needs activeText, so when term recall is OFF keep terms OUT of the
  // signal (planRecall ignores them anyway) — byte-identical term behavior.
  if (!config.termRecallEnabled) delete signals.terms;
  // Exact verbatim-token signal: hashes/ids re-surfacing in the active window.
  // Flag-gated; nominateVerbatim is bounded (cap 40), sorted for firstIntersection.
  if (config.verbatimRecallEnabled && activeText) {
    const tokens = nominateVerbatim(activeText).sort();
    if (tokens.length > 0) signals.verbatimTokens = tokens;
  }
  const hasTermSignals = config.termRecallEnabled && (signals.terms?.length ?? 0) > 0;
  const hasVerbatimSignals = config.verbatimRecallEnabled && (signals.verbatimTokens?.length ?? 0) > 0;
  const proceed =
    signals.touchedPaths.length > 0 || signals.claimedPaths.length > 0 || hasTermSignals || hasVerbatimSignals;
  return { signals, proceed };
}

// ══════════════════════════════════════════════════════════════════════
// Planning (pure)
// ══════════════════════════════════════════════════════════════════════

export type RecallTier = 0 | 1 | 2;

export interface RecallPlanItem {
  entry: FoldIndexEntry;
  tier: RecallTier;
  /** Matched path for tiers 0/1; a deterministic term-residency key for tier 2. */
  matchedPath: string;
  trigger: string;
  /** Planned render level before measured char budgeting. */
  render: 'card' | 'hint';
  /** True when a resident HINT is being escalated by a fresh hard trigger. */
  escalatedFromHint: boolean;
}

export interface RecallPlan {
  items: RecallPlanItem[];
  /** Entries suppressed by card residency (or non-escalatable hint residency). */
  suppressed: number;
  /** Live residency records that caused suppression and should slide forward. */
  suppressedResidencies: RecallSuppressedResidency[];
}

export interface RecallSuppressedResidency {
  entryId: string;
  matchedPath: string;
  refreshEntry: boolean;
  refreshPath: boolean;
}

interface PressureBudget {
  cardBudget: number;
  charBudget: number;
}

function pressureBudget(level: ContextUtilizationLevel, config: FoldRecallConfig): PressureBudget {
  switch (level) {
    case 'healthy':
      return { cardBudget: config.maxCards, charBudget: config.maxTotalChars };
    case 'warning':
      return { cardBudget: config.maxCards, charBudget: Math.floor(config.maxTotalChars / 2) };
    case 'critical':
      return { cardBudget: 1, charBudget: Math.floor(config.maxTotalChars / 4) };
    case 'auto_compact':
      return { cardBudget: 0, charBudget: Math.min(800, config.maxTotalChars) };
  }
}

function entryPaths(entry: FoldIndexEntry): readonly string[] {
  return entry.kind === 'turn' ? entry.paths : entry.path ? [entry.path] : [];
}

function isSyntheticRecallKey(matchedPath: string): boolean {
  return matchedPath.startsWith('verbatim:') || matchedPath.startsWith('term:');
}

/** Maximum number of zone paths that participate in enrichment (radar + source deltas). */
const ZONE_ENRICHMENT_MAX_PATHS = 3;

function dirSegments(p: string): string[] {
  const i = p.lastIndexOf('/');
  return (i < 0 ? '' : p.slice(0, i)).split('/').filter(Boolean);
}

function sharedPrefix(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Order zone paths by directory proximity to the anchor: anchor first, then
 * closest sibling dirs, cross-cluster paths last. Stable within ties.
 * Pure string work — zero I/O. Used for enrichment ranking, not body collection.
 */
function orderZoneByProximity(anchor: string, paths: readonly string[]): string[] {
  const aSegs = dirSegments(anchor);
  return paths
    .map((p, i) => ({ p, i, score: p === anchor ? Infinity : sharedPrefix(dirSegments(p), aSegs) }))
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .map(z => z.p);
}

/**
 * Composite key for the pairwise pathAffinity carrier. Null-byte separator
 * avoids path collision (paths never contain \x00).
 */
function affinityKey(anchor: string, zonePath: string): string {
  return `${anchor}\x00${zonePath}`;
}

/**
 * Order zone paths by behavioral co-activation affinity from the host-supplied
 * pathAffinity carrier (tier-1): anchor first, then by descending affinity score.
 * Directory proximity (tier-0) is the deterministic tie-breaker AND the per-anchor
 * fallback: paths with equal or absent affinity keep proximity order, so a
 * behaviorally-cold zone (this anchor has no affinity entries → every score -1)
 * collapses to pure tier-0 proximity instead of arbitrary entry/insertion order —
 * even when the carrier is non-empty for some OTHER anchor. An empty carrier
 * short-circuits straight to proximity (byte-identical standalone behavior).
 */
function orderZoneByRelevance(
  anchor: string,
  paths: readonly string[],
  affinity: ReadonlyMap<string, number>,
): string[] {
  if (affinity.size === 0) return orderZoneByProximity(anchor, paths);
  // Proximity rank is the fallback ordering: it tie-breaks equal affinity scores
  // and fully orders a zone whose anchor has no affinity keys (all score -1),
  // preserving tier-0 proximity rather than collapsing to insertion order.
  const proximityRank = new Map(
    orderZoneByProximity(anchor, paths).map((p, rank) => [p, rank] as const),
  );
  return paths
    .map((p) => ({
      p,
      rank: proximityRank.get(p) ?? Number.MAX_SAFE_INTEGER,
      score: p === anchor ? Infinity : (affinity.get(affinityKey(anchor, p)) ?? -1),
    }))
    .sort((x, y) => y.score - x.score || x.rank - y.rank)
    .map((z) => z.p);
}

// ── Tier-1b booster math (BENCHED) ──────────────────────────────────────────
// Pure import-graph-distance ranking helpers. BENCHED: nothing in the live
// pipeline calls these. The host-side affinity worker computes behavioral-only
// affinity — the import booster was demoted by its own thesis to a minority-case
// tie-breaker, could not resolve the workspace root inside a worker thread
// (process.chdir throws there), and had no relevance telemetry to justify it.
// They live HERE, in the fold-engine package, because they are pure recall-ranking
// math (the natural sibling of orderZoneByRelevance) so standalone and any host
// share one source of truth. Revive only after measuring tier-1 lift AND threading
// the impact-graph root explicitly (never via process.chdir). Kept unit-tested.
const BEHAVIORAL_WEIGHT = 0.7;
const IMPORT_BOOSTER_WEIGHT = 0.3;

/**
 * BENCHED (tier-1b). Convert import-graph distance to a 0-1 booster signal:
 * distance 0 (same file / direct dependency) → 1.0; distance ∞ (cross-cluster) →
 * 0 (no boost, NO penalty). Formula: max(0, 1 - distance / 6) — the 6-hop bound
 * matches the host impact graph's max traversal depth.
 */
export function distanceToBooster(distance: number): number {
  if (!Number.isFinite(distance)) return 0; // cross-cluster → zero boost, no penalty
  return Math.max(0, 1 - distance / 6);
}

/**
 * BENCHED (tier-1b). Blend behavioral affinity with the import-graph booster.
 * Booster-only invariant: the result is never below the behavioral baseline (import
 * distance only RAISES a score, never penalizes). Cold-start (behavioral 0) falls
 * back to the booster.
 * finalScore = max(behavioral, behavioral*BEHAVIORAL_WEIGHT + importBooster*IMPORT_BOOSTER_WEIGHT)
 */
export function blendScores(behavioral: number, importBooster: number): number {
  const blended = behavioral * BEHAVIORAL_WEIGHT + importBooster * IMPORT_BOOSTER_WEIGHT;
  // Booster-only invariant: never below behavioral baseline; clamp to [0,1].
  return Math.max(behavioral, Math.max(0, Math.min(1, blended)));
}

/**
 * Paths that share the same recall body/enrichment zone. A folded inter-turn
 * entry is one temporal read burst, so touching any member path should recover
 * the whole co-folded source context. Intra-tool entries stay exact-path.
 *
 * For real anchors (tier-0/1 path touches) the zone is relevance-ordered:
 * tier-1 behavioral affinity when the carrier is populated, tier-0 directory
 * proximity as fallback. Synthetic keys (verbatim:/term:) have no real anchor,
 * so they keep entry order.
 */
function recallZonePaths(item: RecallPlanItem, state?: FoldRecallState): readonly string[] {
  if (item.entry.kind === 'turn' || isSyntheticRecallKey(item.matchedPath)) {
    if (isSyntheticRecallKey(item.matchedPath)) return entryPaths(item.entry);
    const affinity = state?.pathAffinity;
    return affinity
      ? orderZoneByRelevance(item.matchedPath, entryPaths(item.entry), affinity)
      : orderZoneByProximity(item.matchedPath, entryPaths(item.entry));
  }
  return [item.matchedPath];
}

/** Smallest path present in both sorted lists, or null. Both inputs sorted. */
function firstIntersection(sortedA: readonly string[], sortedB: readonly string[]): string | null {
  let i = 0;
  let j = 0;
  while (i < sortedA.length && j < sortedB.length) {
    if (sortedA[i] === sortedB[j]) return sortedA[i];
    if (sortedA[i] < sortedB[j]) i++;
    else j++;
  }
  return null;
}

function turnTerms(entry: FoldIndexEntry): string[] {
  return entry.kind === 'turn' ? extractDistinctiveTerms(entry.digest) : [];
}

function idfForTurnDigests(
  entries: readonly FoldIndexEntry[],
  getTerms: (entry: FoldIndexEntry) => string[] = turnTerms,
): Map<string, number> {
  const df = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    if (entry.kind !== 'turn') continue;
    const terms = getTerms(entry);
    if (terms.length === 0) continue;
    total++;
    for (const term of new Set(terms)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return idfFromDocumentFrequency(df, total);
}

/**
 * Plan which folded entries to page back in this pass. Pure — reads residency,
 * never mutates. Ordering is fully deterministic: tier asc, recency desc,
 * id asc. Residency: resident cards suppress (by entry id AND by content
 * path — path residency survives index rebuilds); resident hints escalate to
 * card-eligible on a fresh hard trigger (tiers 0-1 are both hard in v1) and
 * suppress otherwise.
 */
export function planRecall(
  index: FoldRecallIndex,
  resident: ReadonlyMap<string, ResidencyRecord>,
  residentPaths: ReadonlyMap<string, ResidencyRecord>,
  passSeq: number,
  signals: RecallSignals,
  utilization: ContextUtilizationLevel,
  config: FoldRecallConfig,
): RecallPlan {
  const budget = pressureBudget(utilization, config);
  const matched: RecallPlanItem[] = [];
  const suppressedResidencies: RecallSuppressedResidency[] = [];
  const queryTerms = config.termRecallEnabled ? (signals.terms ?? []) : [];
  const queryTokens = config.verbatimRecallEnabled ? (signals.verbatimTokens ?? []) : [];
  // Memoize per-turn distinctive-term extraction for this pass: idfForTurnDigests
  // and the tier-2 match loop below would otherwise tokenize each turn digest
  // twice. Pure cache keyed by entry.id — identical content per entry, so plan
  // output stays byte-identical.
  const turnTermsCache = new Map<string, string[]>();
  const getTurnTerms = (entry: FoldIndexEntry): string[] => {
    let terms = turnTermsCache.get(entry.id);
    if (terms === undefined) {
      terms = turnTerms(entry);
      turnTermsCache.set(entry.id, terms);
    }
    return terms;
  };
  const termIdf = queryTerms.length >= TERM_RECALL_MIN_DISTINCTIVE_COUNT
    ? idfForTurnDigests(index.entries, getTurnTerms)
    : null;
  let suppressed = 0;

  for (const entry of index.entries) {
    const paths = entryPaths(entry);
    // Exact verbatim-token re-surface: a single kept hash/id matching the active
    // window pages this turn in. Stronger than fuzzy term overlap (evaluated
    // first within tier 2), but path-touch/claim still outrank.
    const tokenEligible =
      queryTokens.length > 0 && entry.kind === 'turn' && (entry.verbatimTokens?.length ?? 0) > 0;
    const tokenHit = tokenEligible
      ? firstIntersection(entry.verbatimTokens ?? [], queryTokens)
      : null;
    if (paths.length === 0 && (termIdf === null || entry.kind !== 'turn') && tokenHit === null) continue;
    let tier: RecallTier | null = null;
    let matchedPath: string | null = null;
    let trigger: string | null = null;
    const touch = firstIntersection(paths, signals.touchedPaths);
    if (touch !== null) {
      tier = 0;
      matchedPath = touch;
      trigger = `path-touch ${matchedPath}`;
    } else {
      const claim = firstIntersection(paths, signals.claimedPaths);
      if (claim !== null) {
        tier = 1;
        matchedPath = claim;
        trigger = `claim ${matchedPath}`;
      } else if (tokenHit !== null) {
        tier = 2;
        matchedPath = `verbatim:${tokenHit}`;
        trigger = `verbatim-token ${tokenHit}`;
      } else if (termIdf !== null && entry.kind === 'turn') {
        const overlap = scoreTermOverlap(queryTerms, getTurnTerms(entry), termIdf);
        if (overlap.distinctiveCount >= TERM_RECALL_MIN_DISTINCTIVE_COUNT) {
          tier = 2;
          const matchedTerms = overlap.matched.map((m) => m.term);
          matchedPath = `term:${matchedTerms.join('+')}`;
          trigger = `term-overlap ${matchedTerms.join(', ')}`;
        }
      }
    }
    if (tier === null || matchedPath === null || trigger === null) continue;

    // Content-level suppression: this path's content was carded recently
    // (possibly under a different entry id before a refold). Stay quiet.
    const pathRecord = residentPaths.get(matchedPath);
    const pathLive = pathRecord !== undefined && passSeq < pathRecord.expiresAtPass;
    const record = resident.get(entry.id);
    const entryLive = record !== undefined && passSeq < record.expiresAtPass;
    if (pathLive) {
      suppressed++;
      suppressedResidencies.push({
        entryId: entry.id,
        matchedPath,
        refreshEntry: entryLive,
        refreshPath: true,
      });
      continue;
    }

    let escalatedFromHint = false;
    if (entryLive) {
      if (record!.level === 'card') {
        suppressed++;
        suppressedResidencies.push({
          entryId: entry.id,
          matchedPath,
          refreshEntry: true,
          refreshPath: false,
        });
        continue;
      }
      // Resident hint + fresh hard trigger → card-eligible escalation.
      escalatedFromHint = true;
    }

    matched.push({
      entry,
      tier,
      matchedPath,
      trigger,
      render: 'card',
      escalatedFromHint,
    });
  }

  matched.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.entry.recency !== b.entry.recency) return b.entry.recency - a.entry.recency;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });

  // Assign planned render levels against the pressure card budget.
  const items: RecallPlanItem[] = [];
  let cards = 0;
  let hints = 0;
  for (const item of matched) {
    if (cards < budget.cardBudget) {
      items.push(item);
      cards++;
    } else if (hints < MAX_HINTS_PER_PASS) {
      items.push({ ...item, render: 'hint' });
      hints++;
    }
    // Overflow beyond cards+hints is silently omitted (re-eligible next pass).
  }

  return { items, suppressed, suppressedResidencies };
}

// ══════════════════════════════════════════════════════════════════════
// Rendering (deterministic, char-safe)
// ══════════════════════════════════════════════════════════════════════

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Slice that never splits a surrogate pair at either boundary. */
function charSafeSlice(s: string, start: number, end: number): string {
  let a = start;
  let b = end;
  if (a > 0 && a < s.length && isLowSurrogate(s.charCodeAt(a))) a++;
  if (b > 0 && b < s.length && isLowSurrogate(s.charCodeAt(b))) b--;
  return s.slice(a, Math.max(a, b));
}

function formatChars(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Head+tail excerpt with an omission note, char-safe on multibyte content.
 * Returns the input unchanged when it fits.
 */
export function excerptForRecall(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = Math.max(0, maxChars - headLen);
  const omitted = text.length - headLen - tailLen;
  const head = charSafeSlice(text, 0, headLen);
  const tail = tailLen > 0 ? charSafeSlice(text, text.length - tailLen, text.length) : '';
  return `${head}\n…[${formatChars(omitted)} chars omitted — self-tap for full content]…\n${tail}`;
}

/**
 * Strip previously-injected recall blocks from text before re-recalling it.
 * Feedback-loop guard: injected cards land inside tool results in raw
 * history; when that turn later folds and is itself recalled, re-quoting the
 * embedded card would nest stale copies and double-spend budget.
 */
export function stripRecallBlocks(text: string): string {
  if (!text.includes(RECALL_CARD_PREFIX) && !text.includes(RECALL_HINT_PREFIX)) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let inCard = false;
  for (const line of lines) {
    if (inCard) {
      if (line === '[End fold recall]') inCard = false;
      continue;
    }
    if (line.startsWith(RECALL_CARD_PREFIX)) {
      inCard = true;
      continue;
    }
    if (line.startsWith(RECALL_HINT_PREFIX)) continue; // hints are single lines
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.join('\n');
}

/** Find the original (pre-fold) tool result text in raw history by tool id. */
export function findToolResultText(rawHistory: readonly FoldMessage[], toolId: string): string | null {
  for (const msg of rawHistory) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_result' && block.tool_use_id === toolId) {
          return blockContentText(block.content);
        }
      }
    }
    if (msg.role === 'tool' && (msg as any).tool_call_id === toolId) {
      return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }
  }
  return null;
}

/** Collect tool result texts within a turn slice whose tool-arg path matches any recall-zone path. */
function collectToolResultTextsForPaths(slice: readonly FoldMessage[], paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const wanted = new Set(paths);
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const pushId = (id: string): void => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    ids.push(id);
  };
  for (const msg of slice) {
    if (msg.role !== 'assistant') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const path = extractPath(block.input ?? {});
          if (path && wanted.has(path)) {
            pushId(block.id);
          } else if (typeof block.name === 'string' && BASH_TOOL_NAME_RE.test(block.name)) {
            const cmd = (block.input as any)?.command;
            if (typeof cmd === 'string' && extractPathsFromBashCommand(cmd).some(p => wanted.has(p))) {
              pushId(block.id);
            }
          }
        }
      }
    }
    if (Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        if (tc?.id && tc?.function?.name) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments ?? '{}'); } catch { /* skip */ }
          const path = extractPath(args);
          if (path && wanted.has(path)) {
            pushId(tc.id);
          } else if (BASH_TOOL_NAME_RE.test(tc.function.name)) {
            const cmd = args.command;
            if (typeof cmd === 'string' && extractPathsFromBashCommand(cmd).some(p => wanted.has(p))) {
              pushId(tc.id);
            }
          }
        }
      }
    }
  }
  const texts: string[] = [];
  for (const id of ids) {
    const text = findToolResultText(slice, id);
    if (text) texts.push(text);
  }
  return texts;
}

function describeEntry(entry: FoldIndexEntry): string {
  if (entry.kind === 'tool') {
    return entry.path ? `${entry.tool} ${entry.path}` : entry.tool;
  }
  const preview = entry.paths.slice(0, 3).join(', ');
  const more = entry.paths.length > 3 ? `, +${entry.paths.length - 3} more` : '';
  return preview ? `${entry.category} turn (${preview}${more})` : `${entry.category} turn`;
}

function renderHint(item: RecallPlanItem): string {
  return `${RECALL_HINT_PREFIX} ${describeEntry(item.entry)} folded earlier (${formatChars(item.entry.chars)} chars) | trigger: ${item.trigger} | self-tap to recover]`;
}

/** Body text for a recall card, sliced from in-memory raw history only. */
function renderEntryBody(entry: FoldIndexEntry, recallPaths: readonly string[], rawHistory: readonly FoldMessage[]): string | null {
  if (entry.kind === 'tool') {
    const text = findToolResultText(rawHistory, entry.toolId);
    return text === null ? null : stripRecallBlocks(text);
  }
  if (entry.rawStart < 0 || entry.rawEnd > rawHistory.length || entry.rawStart >= entry.rawEnd) return null;
  const slice = rawHistory.slice(entry.rawStart, entry.rawEnd);
  const parts: string[] = [];
  const user = extractFirstUserText(slice);
  if (user) parts.push(`User asked: ${user.length > 300 ? charSafeSlice(user, 0, 299) + '…' : user}`);
  const assistant = extractAssistantText(slice as FoldMessage[]);
  if (assistant) parts.push(assistant);
  if (recallPaths.length > 0) {
    for (const text of collectToolResultTextsForPaths(slice, recallPaths)) {
      parts.push(stripRecallBlocks(text));
    }
  }
  const body = parts.join('\n\n');
  return body.trim() ? body : null;
}

// ── Curated Code Radar formatters (deterministic, bounded, char-safe) ──

const RECALL_RADAR_MAX_LINES = 3;

/** Deterministic line-range token: "L85" for a point, "L85–95" for a span. */
function formatRadarLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`;
}

/**
 * Compact source-highlight radar — Atlas-curated guideposts to a touched file's
 * key regions, rendered as `⌖ label (a–b)` lines. Deterministic (startLine asc),
 * bounded by RECALL_RADAR_MAX_LINES and charBudget. Returns '' when nothing fits.
 */
export function formatHighlightsRadar(highlights: readonly RecallSourceHighlight[], charBudget: number): string {
  if (highlights.length === 0 || charBudget <= 0) return '';
  const sorted = [...highlights].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const lines: string[] = [];
  let used = 0;
  for (const h of sorted) {
    if (lines.length >= RECALL_RADAR_MAX_LINES) break;
    const line = `⌖ ${h.label} (${formatRadarLineRange(h.startLine, h.endLine)})`;
    if (used + line.length + 1 > charBudget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Compact hazard radar — `⚠️ text (L85)` / `⚠️ text (L85–95)` for ranged hazards,
 * `⚠️ text` for file-level (null range). Ranged hazards sort by startLine asc;
 * file-level hazards sort last. Deterministic, bounded. '' when nothing fits.
 */
export function formatHazardRadar(hazards: readonly RecallHazard[], charBudget: number): string {
  if (hazards.length === 0 || charBudget <= 0) return '';
  const sorted = [...hazards].sort((a, b) => {
    const aFile = a.startLine === null;
    const bFile = b.startLine === null;
    if (aFile !== bFile) return aFile ? 1 : -1; // file-level hazards sort last
    if (aFile && bFile) return 0;
    return (a.startLine as number) - (b.startLine as number);
  });
  const lines: string[] = [];
  let used = 0;
  for (const hz of sorted) {
    if (lines.length >= RECALL_RADAR_MAX_LINES) break;
    const range = hz.startLine === null ? '' : ` (${formatRadarLineRange(hz.startLine, hz.endLine ?? hz.startLine)})`;
    const line = `⚠️ ${hz.text}${range}`;
    if (used + line.length + 1 > charBudget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * Resolve the curated enrichment for a plan item from FoldRecallState. Tier 0/1
 * matched a real file path; tier 2 (verbatim/term) keys are synthetic, so fall
 * back to the entry's own paths. Deduped across paths.
 */
function resolveItemEnrichment(
  item: RecallPlanItem,
  state: FoldRecallState,
  suppressPaths: ReadonlySet<string>,
): { highlights: RecallSourceHighlight[]; hazards: RecallHazard[] } {
  const keys = recallZonePaths(item, state).slice(0, ZONE_ENRICHMENT_MAX_PATHS);
  const highlights: RecallSourceHighlight[] = [];
  const hazards: RecallHazard[] = [];
  const seenH = new Set<string>();
  const seenZ = new Set<string>();
  for (const key of keys) {
    // Dedup vs an active Atlas read: the agent is seeing this file's full record
    // live this turn, so its radar would duplicate the tool output — skip it.
    if (suppressPaths.has(key)) continue;
    for (const h of state.pathHighlights.get(key) ?? []) {
      const sig = `${h.startLine}:${h.endLine}:${h.label}`;
      if (seenH.has(sig)) continue;
      seenH.add(sig);
      highlights.push(h);
    }
    for (const hz of state.pathHazards.get(key) ?? []) {
      const sig = `${hz.startLine}:${hz.endLine}:${hz.text}`;
      if (seenZ.has(sig)) continue;
      seenZ.add(sig);
      hazards.push(hz);
    }
  }
  return { highlights, hazards };
}

/**
 * Build the Curated Code Radar block for a card: hazard radar first (higher
 * urgency), then highlight radar — each flag-gated, the two sharing charBudget.
 * Returns '' when both flags are off, nothing is resident, or nothing fits.
 */
function buildRadar(
  item: RecallPlanItem,
  state: FoldRecallState,
  config: FoldRecallConfig,
  charBudget: number,
  suppressPaths: ReadonlySet<string>,
): string {
  if (charBudget <= 0 || (!config.highlightsEnabled && !config.hazardsEnabled)) return '';
  const { highlights, hazards } = resolveItemEnrichment(item, state, suppressPaths);
  const parts: string[] = [];
  let used = 0;
  if (config.hazardsEnabled && hazards.length > 0) {
    const block = formatHazardRadar(hazards, charBudget - used);
    if (block) { parts.push(block); used += block.length + 1; }
  }
  if (config.highlightsEnabled && highlights.length > 0) {
    const block = formatHighlightsRadar(highlights, charBudget - used);
    if (block) { parts.push(block); used += block.length + 1; }
  }
  return parts.join('\n');
}

function normalizeSourceForComparison(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function resolveItemSourceDeltas(item: RecallPlanItem, state: FoldRecallState): RecallSourceDelta[] {
  const keys = recallZonePaths(item, state).slice(0, ZONE_ENRICHMENT_MAX_PATHS);
  const deltas: RecallSourceDelta[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const delta = state.pathSourceDeltas.get(key);
    if (!delta || seen.has(delta.path)) continue;
    seen.add(delta.path);
    deltas.push(delta);
  }
  return deltas;
}

function formatSourceDelta(delta: RecallSourceDelta, historicalBody: string, charBudget: number): string {
  if (charBudget < 160) return '';
  const live = normalizeSourceForComparison(delta.liveSource);
  if (!live) return '';
  const historical = normalizeSourceForComparison(historicalBody);
  // Truncated live sources are only a prefix — the file may have changed
  // beyond the truncation point. Skip suppression so the delta always renders.
  if (!delta.truncated && historical.includes(live)) return '';
  const heading = `⚠ Live Source Delta (${delta.path}): current box source differs from this historical fold-recall body; liveHash=${delta.liveHash}${delta.truncated ? '; live snapshot truncated' : ''}`;
  const bodyBudget = charBudget - heading.length - '\nCurrent source excerpt:\n'.length;
  if (bodyBudget < 80) return '';
  return `${heading}\nCurrent source excerpt:\n${excerptForRecall(live, bodyBudget)}`;
}

function renderCard(item: RecallPlanItem, body: string, bodyBudget: number, radar: string, sourceDeltas: readonly RecallSourceDelta[]): string {
  // Radar (hazard + highlight guideposts) and live-source delta both prepend the
  // body excerpt and share the card budget — subtract their footprint so the
  // total card stays bounded. Empty carriers ⇒ output is byte-identical to
  // legacy recall.
  const radarBlock = radar ? `${radar}\n` : '';
  const deltaBudget = Math.floor(Math.max(0, bodyBudget - radarBlock.length) / 2);
  const perDeltaBudget = sourceDeltas.length > 0 ? Math.floor(deltaBudget / sourceDeltas.length) : 0;
  const deltaBlock = sourceDeltas
    .map(delta => formatSourceDelta(delta, body, perDeltaBudget))
    .filter(Boolean)
    .join('\n');
  const prefixBlock = deltaBlock ? `${radarBlock}${deltaBlock}\n` : radarBlock;
  const excerpt = excerptForRecall(body, Math.max(0, bodyBudget - prefixBlock.length));
  const header = `${RECALL_CARD_PREFIX} ${describeEntry(item.entry)} | trigger: ${item.trigger} | ${formatChars(item.entry.chars)} chars folded]`;
  return `${header}\n${prefixBlock}${excerpt}\n[End fold recall]`;
}

// ══════════════════════════════════════════════════════════════════════
// Session-facing orchestration
// ══════════════════════════════════════════════════════════════════════

export interface FoldRecallOutcome {
  /** Rendered body-only recall block, or null when nothing injects. */
  text: string | null;
  cards: number;
  hints: number;
  chars: number;
  suppressed: number;
  triggers: string[];
}

const EMPTY_OUTCOME: FoldRecallOutcome = { text: null, cards: 0, hints: 0, chars: 0, suppressed: 0, triggers: [] };

function refreshResidency(
  map: Map<string, ResidencyRecord>,
  key: string,
  expiresAtPass: number,
): void {
  const existing = map.get(key);
  if (existing) map.set(key, { ...existing, expiresAtPass });
}

/**
 * One recall pass at a tool boundary: plan against the index + residency,
 * render measured cards/hints from in-memory raw history, update residency
 * and telemetry. Mutates only `state`. Deterministic for identical inputs.
 *
 * Budget semantics: the pressure char budget caps the TOTAL rendered block;
 * a card whose remaining budget is below MIN_USEFUL_CARD_CHARS downgrades to
 * a hint (an escalated resident hint suppresses instead of re-hinting).
 */
export function buildFoldRecallContext(
  state: FoldRecallState,
  rawHistory: readonly FoldMessage[],
  signals: RecallSignals,
  utilization: ContextUtilizationLevel,
  config: FoldRecallConfig,
): FoldRecallOutcome {
  if (!config.enabled || !state.index || state.index.entries.length === 0) return EMPTY_OUTCOME;
  // Staleness guard: a rewound history invalidates raw ranges; the next
  // freeze epoch (history-rewound) rebuilds the index from current truth.
  if (rawHistory.length < state.index.rawCount) return EMPTY_OUTCOME;
  const hasTermSignals = config.termRecallEnabled && (signals.terms?.length ?? 0) > 0;
  const hasVerbatimSignals = config.verbatimRecallEnabled && (signals.verbatimTokens?.length ?? 0) > 0;
  if (
    signals.touchedPaths.length === 0 &&
    signals.claimedPaths.length === 0 &&
    !hasTermSignals &&
    !hasVerbatimSignals
  ) {
    return EMPTY_OUTCOME;
  }

  state.passSeq += 1;
  const passSeq = state.passSeq;

  // Deterministic sweep of expired residency (bounds both maps).
  for (const [id, record] of state.resident) {
    if (passSeq >= record.expiresAtPass) state.resident.delete(id);
  }
  for (const [path, record] of state.residentPaths) {
    if (passSeq >= record.expiresAtPass) state.residentPaths.delete(path);
  }

  const plan = planRecall(state.index, state.resident, state.residentPaths, passSeq, signals, utilization, config);
  let suppressed = plan.suppressed;
  const refreshedExpiresAtPass = passSeq + config.ttlPasses;
  for (const residency of plan.suppressedResidencies) {
    if (residency.refreshEntry) refreshResidency(state.resident, residency.entryId, refreshedExpiresAtPass);
    if (residency.refreshPath) refreshResidency(state.residentPaths, residency.matchedPath, refreshedExpiresAtPass);
  }
  if (plan.items.length === 0) {
    state.suppressed += suppressed;
    return { ...EMPTY_OUTCOME, suppressed };
  }

  const budget = pressureBudget(utilization, config);
  const blocks: string[] = [];
  const triggers: string[] = [];
  const injected: Array<{ id: string; level: 'card' | 'hint' }> = [];
  let charsUsed = 0;
  let cards = 0;
  let hints = 0;
  // Radar dedup: paths the current Atlas-read tool already rendered live, whose
  // radar would duplicate the tool output (empty set ⇒ byte-identical).
  const radarSuppressPaths = new Set(signals.atlasReadPaths ?? []);

  for (const item of plan.items) {
    const remaining = budget.charBudget - charsUsed;
    if (remaining <= 0) break;

    let level: 'card' | 'hint' = item.render;
    let rendered: string | null = null;

    if (level === 'card') {
      const bodyBudget = Math.min(config.maxCardChars, remaining - 200);
      if (bodyBudget < MIN_USEFUL_CARD_CHARS) {
        level = 'hint'; // measured budget overflow → card degrades to hint
      } else {
        const recallPaths = recallZonePaths(item, state);
        const body = renderEntryBody(item.entry, recallPaths, rawHistory);
        if (body === null) continue; // raw no longer recoverable — skip silently
        // Curated Code Radar may take up to half the card body budget; the
        // excerpt keeps the rest. '' (empty carriers / flags off) ⇒ byte-identical.
        const radar = buildRadar(item, state, config, Math.floor(bodyBudget / 3), radarSuppressPaths);
        const sourceDeltas = resolveItemSourceDeltas(item, state);
        rendered = renderCard(item, body, bodyBudget, radar, sourceDeltas);
        if (rendered.length > remaining) {
          level = 'hint';
          rendered = null;
        }
      }
    }

    if (level === 'hint') {
      if (item.escalatedFromHint) {
        // Already hinted recently and we cannot afford the card — stay quiet.
        suppressed++;
        refreshResidency(state.resident, item.entry.id, refreshedExpiresAtPass);
        continue;
      }
      if (hints >= MAX_HINTS_PER_PASS) continue;
      rendered ??= renderHint(item);
      if (rendered.length > remaining) continue;
    }

    if (rendered === null) continue;
    blocks.push(rendered);
    triggers.push(item.trigger);
    injected.push({ id: item.entry.id, level });
    if (level === 'card') {
      // Content-level residency: keep this path quiet across index rebuilds.
      state.residentPaths.set(item.matchedPath, { level: 'card', expiresAtPass: passSeq + config.ttlPasses });
    }
    charsUsed += rendered.length;
    if (level === 'card') cards++;
    else hints++;
  }

  for (const { id, level } of injected) {
    state.resident.set(id, { level, expiresAtPass: passSeq + config.ttlPasses });
  }
  state.cardsInjected += cards;
  state.hintsInjected += hints;
  state.recallChars += charsUsed;
  state.suppressed += suppressed;

  if (blocks.length === 0) return { ...EMPTY_OUTCOME, suppressed };
  return { text: blocks.join('\n\n'), cards, hints, chars: charsUsed, suppressed, triggers };
}
