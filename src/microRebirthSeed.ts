/**
 * Micro Rebirth Seed — trajectory preservation for tail-epoch fold bands.
 *
 * A hard epoch re-renders the entire visible history through the rebirth-seed
 * pipeline, so the successor lands with explicit orientation: last operator
 * ask, resume point, active edit delta. A tail epoch is append-only: it
 * silently skeletonizes the freshest window — exactly the material that
 * orientation is made of — and the surviving agent keeps the frozen prefix
 * but loses direction: what was asked, what was in flight, which files were
 * mid-edit. Measured live, that asymmetry shows up as post-fold "bearings
 * checks" after tail epochs that never happen after hard epochs.
 *
 * This module recovers that trajectory at band-commit time. From the
 * fold-window raw messages (the window being destroyed) it extracts:
 *   1. the newest genuine operator ask (chatroom deliveries, digest deltas,
 *      and ephemeral coordination turns filtered out),
 *   2. the newest assistant headline — the in-flight work statement,
 *      deliberately including transient 🔍/▶ registers that the [cognitive]
 *      block excludes (transient registers ARE the direction signal),
 *   3. the file paths touched by edit/write/claim tool calls in the window.
 *
 * The result renders as a compact [micro-seed] block appended to the band
 * body alongside the [cognitive] block. Pure (no I/O — this runs on the fold
 * hot path), bounded, and byte-stable: no timestamps or counters, so a
 * committed band never churns the injection cache. Complements [cognitive]:
 * that block preserves durable RESULTS (verdicts, hazards, blockers); this
 * one preserves DIRECTION (ask, in-flight focus, edit surface).
 */

import type { FoldMessage } from './rollingFold.ts';
import { flattenFoldMessageText } from './cognitiveArtifacts.ts';
import { isPortableGenuineOperatorMessage } from './rawRebirthSeed.ts';

// ══════════════════════════════════════════════════════════════════════
// Bounds
// ══════════════════════════════════════════════════════════════════════

/** Maximum characters per rendered seed line (ask / in-flight headlines). */
const MAX_LINE_CHARS = 200;

/** Maximum edit paths rendered before collapsing to a "+N more" suffix. */
const MAX_EDIT_PATHS = 10;

// ══════════════════════════════════════════════════════════════════════
// Tool-call shapes
// ══════════════════════════════════════════════════════════════════════

/**
 * Tool names whose invocation marks a file as part of the active edit
 * surface. Claims are included deliberately: a claim in the destroyed window
 * is a declared edit intent the successor must not lose.
 */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'edit_file',
  'write_file',
  'str_replace_editor',
  'partner_claim_file',
]);

/** Input keys that carry the target path across tool schemas. */
const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'] as const;

/**
 * Roles that represent assistant/model output across all transports.
 * Gemini FC uses `role: 'model'` instead of `'assistant'`.
 */
const ASSISTANT_ROLES: ReadonlySet<string> = new Set(['assistant', 'model']);

/** Pull a path string out of a tool input object, checking known keys. */
function pathFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  for (const key of PATH_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Collapse MCP/function namespace wrappers to the leaf tool name. */
function normalizeToolName(name: string): string {
  return name.split('__').pop()?.split('.').pop() ?? name;
}

/**
 * Extract edit-surface paths from one message, covering both transport
 * shapes: Anthropic-style content blocks (`{type:'tool_use', name, input}`)
 * and OpenAI-style `tool_calls` (`{function:{name, arguments:jsonString}}`,
 * with a tolerant fallback for flattened `{name, arguments|input}` entries).
 */
function editPathsFromMessage(msg: FoldMessage): string[] {
  const paths: string[] = [];

  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (!EDIT_TOOL_NAMES.has(normalizeToolName(b.name))) continue;
      const path = pathFromToolInput(b.input);
      if (path) paths.push(path);
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      if (!call || typeof call !== 'object') continue;
      const c = call as {
        function?: { name?: unknown; arguments?: unknown };
        name?: unknown;
        arguments?: unknown;
        input?: unknown;
      };
      const name = typeof c.function?.name === 'string'
        ? c.function.name
        : typeof c.name === 'string' ? c.name : null;
      if (!name || !EDIT_TOOL_NAMES.has(normalizeToolName(name))) continue;
      let args: unknown = c.function?.arguments ?? c.arguments ?? c.input;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          continue;
        }
      }
      const path = pathFromToolInput(args);
      if (path) paths.push(path);
    }
  }

  return paths;
}

// ══════════════════════════════════════════════════════════════════════
// Headline extraction
// ══════════════════════════════════════════════════════════════════════

/**
 * First meaningful line of a message body, truncated to MAX_LINE_CHARS.
 * Skips relay coordination headers (bracketed marker lines like
 * `[Temporal Context] …` or `[DIGEST DELTA …]`), markdown headers, and code
 * fences so the headline is the actual human/assistant statement.
 */
function extractHeadline(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[')) continue;
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^```/.test(trimmed)) continue;
    if (/^---/.test(trimmed) && trimmed.length <= 5) continue;
    return trimmed.length > MAX_LINE_CHARS
      ? `${trimmed.slice(0, MAX_LINE_CHARS - 1)}…`
      : trimmed;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════

export interface MicroSeed {
  /** Newest genuine operator ask in the fold window, or null when none. */
  lastAsk: string | null;
  /** Newest assistant headline in the fold window (any register), or null. */
  inFlight: string | null;
  /** Deduped edit-surface paths, in first-touch order. */
  editPaths: string[];
}

/**
 * Scan the fold-window raw messages for trajectory state: newest genuine
 * operator ask, newest assistant headline, and the edit surface. Newest-wins
 * for both headlines (iterate forward, overwrite). Pure — no side effects.
 */
export function extractMicroSeed(messages: readonly FoldMessage[]): MicroSeed {
  let lastAsk: string | null = null;
  let inFlight: string | null = null;
  const seen = new Set<string>();
  const editPaths: string[] = [];

  for (const msg of messages) {
    if (!msg) continue;
    const rawMsg = msg as FoldMessage & { parts?: unknown };

    for (const path of editPathsFromMessage(msg)) {
      if (!seen.has(path)) {
        seen.add(path);
        editPaths.push(path);
      }
    }

    if (msg.role === 'user') {
      const text = flattenFoldMessageText(msg.content, rawMsg.parts);
      if (text && isPortableGenuineOperatorMessage(text)) {
        const headline = extractHeadline(text);
        if (headline) lastAsk = headline;
      }
    } else if (ASSISTANT_ROLES.has(msg.role)) {
      const text = flattenFoldMessageText(msg.content, rawMsg.parts);
      if (text) {
        const headline = extractHeadline(text);
        if (headline) inFlight = headline;
      }
    }
  }

  return { lastAsk, inFlight, editPaths };
}

/**
 * Render a micro seed as a compact [micro-seed] block for a tail-epoch band
 * body. Lines are omitted when their component is empty; an entirely empty
 * seed renders as ''. Output is byte-stable for a given seed (no timestamps
 * or counters).
 *
 * Format:
 *   [micro-seed]
 *   👤 ask: fix the churning before the tool-loss work
 *   ▶ in flight: ▶ Checking the counter mutation context…
 *   ✏ edits: src/session/FoldSession.ts:820-1094, src/foldFreeze.ts (+3 more)
 */
export function renderMicroSeedBlock(seed: MicroSeed): string {
  const lines: string[] = [];
  if (seed.lastAsk) lines.push(`👤 ask: ${seed.lastAsk}`);
  if (seed.inFlight) lines.push(`▶ in flight: ${seed.inFlight}`);
  if (seed.editPaths.length > 0) {
    const shown = seed.editPaths.slice(0, MAX_EDIT_PATHS);
    const overflow = seed.editPaths.length - shown.length;
    const suffix = overflow > 0 ? ` (+${overflow} more)` : '';
    lines.push(`✏ edits: ${shown.join(', ')}${suffix}`);
  }
  if (lines.length === 0) return '';
  return `[micro-seed]\n${lines.join('\n')}`;
}

/**
 * Convenience: extract + render in one call. Returns '' when the window
 * yields no trajectory state (the band then carries no [micro-seed] block).
 */
export function buildMicroSeedBlock(messages: readonly FoldMessage[]): string {
  return renderMicroSeedBlock(extractMicroSeed(messages));
}
