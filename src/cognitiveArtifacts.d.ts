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
 * Transient flow-note lane (2026-07-17): live 7-band dogfood showed durable
 * registers are RARE under real flow — a full engineering day can emit one
 * 🏁 while every mid-flight diagnosis rides in short 🔍/▶ or untagged
 * narration ("Single mount, always `embedded`"), so bands rendered empty
 * [cognitive] blocks exactly when they were needed most. The extractor
 * therefore also conserves a bounded lane of SHORT transient narrations
 * (tagged 🔍/▶ or cleanly untagged), labeled trust='transient' and rendered
 * under an explicit unverified-caveat line. Shortness (≤240 source chars)
 * is the deterministic noise gate: diagnosis beats are short; speculative
 * hypothesis dumps are long and stay excluded, honoring the original
 * durable-only intent for long-form reasoning.
 *
 * Pure, zero I/O, no side effects. Shared across all transports:
 * Claude CLI, Codex CLI, and FC engines (claude-api/OpenAI/Gemini/GLM/
 * Grok/Mistral/MiniMax).
 */
import { type AssistantRegister } from './glyphs.ts';
import type { FoldMessage } from './rollingFold.ts';
/**
 * A single cognitive artifact extracted from an assistant message in the
 * fold window. Captures the register glyph, a headline summary, and the
 * message index for chronological ordering.
 */
export interface CognitiveArtifact {
    /**
     * The register type, or 'untagged' for a short glyphless narration
     * admitted through the transient flow-note lane.
     */
    register: AssistantRegister | 'untagged';
    /** Glyph character for rendering ('·' for untagged flow notes). */
    glyph: string;
    /** First meaningful line(s) of the message body, truncated to maxHeadlineChars. */
    headline: string;
    /** Index in the source messages array (for chronological ordering). */
    messageIndex: number;
    /**
     * Trust class: 'durable' artifacts are settled verdicts/hazards/blockers;
     * 'transient' artifacts are unverified mid-flow narration conserved for
     * continuity only. Renderers must keep the distinction visible.
     */
    trust: 'durable' | 'transient';
}
/** Options for extractCognitiveArtifacts / enrichFoldedBandBody. */
export interface ExtractCognitiveArtifactsOptions {
    /**
     * Admit the bounded transient flow-note lane (default true): short 🔍/▶
     * narrations and short cleanly-untagged narrations that carry mid-flow
     * micro-conclusions. Set false to restore durable-only extraction.
     */
    includeFlowNotes?: boolean;
}
/**
 * Public flattener for FoldMessage content across all transport shapes
 * (string, content-block array, Gemini `parts` array). Exported so sibling
 * band-enrichment modules (e.g. the micro rebirth seed) read message text
 * through the exact same shape handling instead of duplicating it.
 */
export declare function flattenFoldMessageText(content: FoldMessage['content'], parts?: unknown): string;
/**
 * Scan a list of raw messages for cognitive artifacts.
 *
 * Durable lane: assistant turns that start with a verdict (🏁), hazard (⚠️),
 * or blocked (❓) glyph — capped at MAX_ARTIFACTS, never displaced by notes.
 *
 * Transient flow-note lane (default on, see module docstring): SHORT
 * assistant narrations — tagged 🔍/▶, or cleanly untagged (parse failure
 * reason 'missing_register' only, never card-glyph-opened text, never
 * host-synthetic error surrogates) — capped at MAX_FLOW_NOTES, newest kept.
 *
 * Returns all artifacts merged in chronological order (by message index).
 * Pure function — no side effects, no I/O.
 *
 * @param messages Raw messages from the fold window (before skeletonization)
 * @param options  Lane control; omit for default durable+flow-note behavior
 */
export declare function extractCognitiveArtifacts(messages: readonly FoldMessage[], options?: ExtractCognitiveArtifactsOptions): CognitiveArtifact[];
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
export declare function renderCognitiveBlock(artifacts: readonly CognitiveArtifact[]): string;
/**
 * Compact provenance line for a single cognitive artifact — the "where this
 * came from" audit trail that turns the [cognitive] block from a bare list
 * into inspectable continuity. Surfaces the source message index and the
 * register kind; stable (no timestamps/counters) so it never churns the
 * injection cache.
 */
export declare function formatCognitiveArtifactProvenance(artifact: CognitiveArtifact): string;
/**
 * Enrich a band body parts array with cognitive artifacts extracted from
 * the raw messages. If artifacts are found, appends a [cognitive] block
 * to the parts array (mutates in place — caller owns the array).
 * Returns the parts array for chaining.
 *
 * @param parts The bandBodyParts array being assembled (mutated in place)
 * @param rawMessages The raw messages from the fold window
 * @param options Lane control forwarded to extractCognitiveArtifacts
 * @returns The same parts array, with cognitive block appended if artifacts found
 */
export declare function enrichFoldedBandBody(parts: string[], rawMessages: readonly FoldMessage[], options?: ExtractCognitiveArtifactsOptions): string[];
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
export declare function mergeBlockIntoViewTail<T extends FoldMessage>(view: readonly T[], block: string): T[];
