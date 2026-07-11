/**
 * Cognitive Artifact Extraction — enrich tail-epoch band bodies with
 * chronological cognitive waypoints extracted from the raw fold window.
 *
 * Tail-epoch bands currently carry raw skeleton text ([assistant]\n<text> +
 * [user]\n<text>). When an agent emits a 🏁 verdict, ⚠️ hazard, or ❓ blocked
 * marker during that window, it dies in the fold — the band becomes a
 * cognitive desert. This module extracts those artifacts from the raw
 * messages being folded and renders them into a compact [cognitive] block
 * appended to the band body, preserving continuity at near-zero token cost.
 *
 * The rebirth seed already carries curated cognitive sections (starredMoments,
 * lineageGlyphLog). This brings the same density to within-session tail
 * epochs, smoothing the continuity gradient: dense recent context →
 * artifact-enriched tail bands → fully archived episodes via recall.
 *
 * Pure, zero I/O, no side effects. Shared across all transports:
 * Claude CLI, Codex CLI, and FC engines (claude-api/OpenAI/Gemini/GLM/
 * Grok/Mistral/MiniMax).
 */

import {
  parseRegisterGlyph,
  type AssistantRegister,
} from './glyphs.ts';
import type { FoldMessage } from './rollingFold.ts';
import { renderEmbeddedContinuityArtifactProvenance } from './chronologicalProvenance.ts';

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

/**
 * A single cognitive artifact extracted from an assistant message in the
 * fold window. Captures the register glyph, a headline summary, and the
 * message index for chronological ordering.
 */
export interface CognitiveArtifact {
  /** The register type (verdict, hazard, blocked, executing, in_progress). */
  register: AssistantRegister;
  /** Glyph character for rendering. */
  glyph: string;
  /** First meaningful line(s) of the message body, truncated to maxHeadlineChars. */
  headline: string;
  /** Index in the source messages array (for chronological ordering). */
  messageIndex: number;
}

/** Maximum number of artifacts to extract per band window. */
const MAX_ARTIFACTS = 20;

/** Maximum characters per artifact headline. */
const MAX_HEADLINE_CHARS = 200;

/** Registers worth extracting — exclude transient in_progress/executing. */
const DURABLE_REGISTERS: ReadonlySet<AssistantRegister> = new Set([
  'verdict',
  'hazard',
  'blocked',
]);

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/** Glyphs by register for rendering. */
const REGISTER_GLYPHS: Record<AssistantRegister, string> = {
  verdict: '🏁',
  hazard: '⚠️',
  blocked: '❓',
  executing: '▶',
  in_progress: '🔍',
};

/**
 * Roles that represent assistant/model output across all transports.
 * Gemini FC uses `role: 'model'` instead of `'assistant'`.
 */
const ASSISTANT_ROLES: ReadonlySet<string> = new Set(['assistant', 'model']);

/**
 * Flatten message content into a plain string for glyph parsing.
 * Handles three content shapes:
 *   1. string (Claude CLI, Codex, most FC engines)
 *   2. content-block array (OpenAI Responses API, Anthropic API)
 *   3. Gemini-style `parts` array (stored on a `.parts` property, not `.content`)
 * Also handles the raw Gemini message shape where `parts` lives on the message
 * object directly instead of under `content`.
 */
function flattenContent(
  content: FoldMessage['content'],
  parts?: unknown,
): string {
  if (typeof content === 'string') return content;
  if (content == null && parts != null) {
    return flattenPartsArray(parts);
  }
  if (content != null && Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') return text;
        }
        return '';
      })
      .join('\n');
  }
  // Gemini raw shape: { role: 'model', parts: [{ text: '...' }] }
  if (parts != null) {
    return flattenPartsArray(parts);
  }
  return '';
}

/**
 * Flatten a Gemini-style `parts` array of { text } objects.
 */
function flattenPartsArray(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') return text;
      }
      return '';
    })
    .join('\n');
}

/**
 * Public flattener for FoldMessage content across all transport shapes
 * (string, content-block array, Gemini `parts` array). Exported so sibling
 * band-enrichment modules (e.g. the micro rebirth seed) read message text
 * through the exact same shape handling instead of duplicating it.
 */
export function flattenFoldMessageText(
  content: FoldMessage['content'],
  parts?: unknown,
): string {
  return flattenContent(content, parts);
}

/**
 * Extract a headline from the glyph body — the first non-empty line,
 * truncated to MAX_HEADLINE_CHARS. Skips leading markdown headers
 * and code fences that would render as noise.
 */
function extractHeadline(body: string): string {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip markdown headers and code fences
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^```/.test(trimmed)) continue;
    if (/^---/.test(trimmed) && trimmed.length <= 5) continue;
    return trimmed.length > MAX_HEADLINE_CHARS
      ? `${trimmed.slice(0, MAX_HEADLINE_CHARS - 1)}…`
      : trimmed;
  }
  // Fallback: first 100 chars of body
  return body.slice(0, 100).trim() || '(empty)';
}

// ══════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════

/**
 * Scan a list of raw messages for durable cognitive artifacts — assistant
 * turns that start with a verdict (🏁), hazard (⚠️), or blocked (❓) glyph.
 * Returns artifacts in chronological order (by message index), capped at
 * MAX_ARTIFACTS. Pure function — no side effects, no I/O.
 *
 * @param messages Raw messages from the fold window (before skeletonization)
 */
export function extractCognitiveArtifacts(
  messages: readonly FoldMessage[],
): CognitiveArtifact[] {
  const artifacts: CognitiveArtifact[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !ASSISTANT_ROLES.has(msg.role)) continue;

    // Handle Gemini raw message shape: { role: 'model', parts: [...] }
    const rawMsg = msg as FoldMessage & { parts?: unknown };
    const text = flattenContent(msg.content, rawMsg.parts);
    if (!text) continue;

    const parseResult = parseRegisterGlyph(text);
    if (!parseResult.ok) continue;
    if (!DURABLE_REGISTERS.has(parseResult.register)) continue;

    artifacts.push({
      register: parseResult.register,
      glyph: REGISTER_GLYPHS[parseResult.register],
      headline: extractHeadline(parseResult.body),
      messageIndex: i,
    });
  }

  return artifacts.length > MAX_ARTIFACTS
    ? artifacts.slice(-MAX_ARTIFACTS)
    : artifacts;
}

/**
 * Render a list of cognitive artifacts into a compact [cognitive] block
 * suitable for appending to a tail-epoch band body. Each artifact is one
 * body line preceded by a provenance line so the block is inspectable:
 * a successor can see which source message and register produced it.
 * Returns empty string when no artifacts.
 *
 * Format:
 *   [cognitive]
 *   ↞ msg#2 · verdict
 *   🏁 PASS — no bugs found
 *   ↞ msg#5 · hazard
 *   ⚠️ sync I/O risk in adminRoutes
 *   ↞ msg#8 · blocked
 *   ❓ blocked: relay restart required
 */
export function renderCognitiveBlock(
  artifacts: readonly CognitiveArtifact[],
): string {
  if (artifacts.length === 0) return '';
  const firstMessageIndex = artifacts[0].messageIndex;
  const lastMessageIndex = artifacts[artifacts.length - 1].messageIndex;
  const provenance = renderEmbeddedContinuityArtifactProvenance({
    artifact: 'cognitive-waypoints',
    contentClass: 'synthesized-history',
    traceId: 'fold-window',
    unit: 'message',
    sourceStart: firstMessageIndex,
    sourceEndExclusive: lastMessageIndex + 1,
    authority: 'historical-background',
  });
  const lines = artifacts.flatMap(
    (a) => [formatCognitiveArtifactProvenance(a), `${a.glyph} ${a.headline}`],
  );
  return [
    '[cognitive — historical waypoints from the folded window, NOT your current state]',
    provenance,
    ...lines,
  ].filter(Boolean).join('\n');
}

/**
 * Compact provenance line for a single cognitive artifact — the "where this
 * came from" audit trail that turns the [cognitive] block from a bare list
 * into inspectable continuity. Surfaces the source message index and the
 * register kind; stable (no timestamps/counters) so it never churns the
 * injection cache.
 */
export function formatCognitiveArtifactProvenance(
  artifact: CognitiveArtifact,
): string {
  return `↞ msg#${artifact.messageIndex} · ${artifact.register}`;
}

/**
 * Enrich a band body parts array with cognitive artifacts extracted from
 * the raw messages. If artifacts are found, appends a [cognitive] block
 * to the parts array (mutates in place — caller owns the array).
 * Returns the parts array for chaining.
 *
 * @param parts The bandBodyParts array being assembled (mutated in place)
 * @param rawMessages The raw messages from the fold window
 * @returns The same parts array, with cognitive block appended if artifacts found
 */
export function enrichFoldedBandBody(
  parts: string[],
  rawMessages: readonly FoldMessage[],
): string[] {
  const artifacts = extractCognitiveArtifacts(rawMessages);
  const block = renderCognitiveBlock(artifacts);
  if (block) {
    parts.push(block);
  }
  return parts;
}

/**
 * Merge a rendered enrichment block ([cognitive] / [micro-seed]) into the LAST
 * message of a folded view WITHOUT appending a new message.
 *
 * Why this exists: appending the enrichment as a separate trailing
 * `role:'assistant'` message crashes providers that require the conversation
 * to end with a user message (Anthropic 400 "This model does not support
 * assistant message prefill") whenever the fold consumes the entire raw tail —
 * the folded view IS the full request body, so its terminal role must be
 * whatever the last folded raw message had (a tool-result/user boundary).
 * Merging into the final message preserves both the terminal role and the
 * message count, so band metadata indexes stay valid.
 *
 * Copy-on-write: returns a new array with a new last-message object; the input
 * array and its other elements are not mutated. Content handling:
 * string → appended with a blank-line separator; array of parts → a text part
 * is pushed; null/absent → the block becomes the content. Empty views return
 * the input unchanged (nothing safe to merge into — callers always have at
 * least the seed message in practice).
 */
export function mergeBlockIntoViewTail<T extends FoldMessage>(
  view: readonly T[],
  block: string,
): T[] {
  if (!block) return view.slice() as T[];
  if (view.length === 0) return view.slice() as T[];
  const last = view[view.length - 1];
  let content: FoldMessage['content'];
  if (typeof last.content === 'string' && last.content.length > 0) {
    content = `${last.content}\n\n${block}`;
  } else if (Array.isArray(last.content)) {
    content = [...last.content, { type: 'text', text: block }];
  } else {
    content = block;
  }
  return [...view.slice(0, -1), { ...last, content }] as T[];
}
