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
 * Tool-only turns have no assistant text to register-tag. Categorized tap_star
 * pin calls are intentional continuity decisions, so they enter the durable
 * lane as ⭐ waypoints even when ordinary assistant speech exists. Ambient
 * uncategorized tap_star calls and set_thought remain bounded transient 💭
 * fallbacks. Generic tool traces are transport echoes and are discarded.
 *
 * Pure, zero I/O, no side effects. Shared across all transports:
 * Claude CLI, Codex CLI, and FC engines (claude-api/OpenAI/Gemini/GLM/
 * Grok/Mistral/MiniMax).
 */

import {
  parseRegisterGlyph,
  CARD_GLYPHS,
  type AssistantRegister,
} from './glyphs.ts';
import { foldMessageSourceIdentities, type FoldMessage } from './rollingFold.ts';
import { renderEmbeddedContinuityArtifactProvenance } from './chronologicalProvenance.ts';

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

export type CognitiveArtifactAuthorityClass = 'pointer' | 'historical_observation';
export type CognitiveArtifactCurrentStatus = 'current' | 'superseded' | 'unresolved';

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
  register: AssistantRegister | 'untagged' | 'tap_star';
  /** Glyph character for rendering ('·' for untagged speech, '💭' for thought fallback). */
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
  /** Declared category for a durable tap_star waypoint. */
  tapStarCategory?: TapStarCategory;
  /** Authoritative source time copied from FoldMessage.tsMs, when available. */
  sourceTimestamp?: string;
  /** Stable provider call id or deterministic fold-window coordinate. */
  sourceIdentity: string;
  /** Exact only when the identity came from a persisted source row/provider call. */
  sourceIdentityAuthority: 'exact' | 'synthetic-position';
  /** Whether this is a pointer or an observation; neither proves completion. */
  authorityClass: CognitiveArtifactAuthorityClass;
  /** A single cognitive waypoint cannot establish completion on its own. */
  completionSupport: 'insufficient_alone';
  /** Current only when a deterministic replacement chain is known. */
  currentStatus: CognitiveArtifactCurrentStatus;
  /** Stable identity of the immutable replacement when superseded. */
  supersededByIdentity?: string;
  /**
   * Set when a durable waypoint (🏁/⚠️/❓) at a later message index settles
   * the work this transient note was narrating. The renderer keeps the note
   * visible as an audit trail but marks it ⊘ so an obsolete working
   * hypothesis cannot masquerade as current guidance.
   */
  supersededByMessageIndex?: number;
}

export const TAP_STAR_CATEGORIES = [
  'decision',
  'discovery',
  'pivot',
  'handoff',
  'gotcha',
  'result',
] as const;

export type TapStarCategory = typeof TAP_STAR_CATEGORIES[number];

/** Options for extractCognitiveArtifacts / enrichFoldedBandBody. */
export interface ExtractCognitiveArtifactsOptions {
  /**
   * Admit the bounded transient flow-note lane (default true): short 🔍/▶
   * narrations and short cleanly-untagged narrations that carry mid-flow
   * micro-conclusions. Set false to restore durable-only extraction.
   */
  includeFlowNotes?: boolean;
}

/** Maximum number of durable artifacts to extract per band window. */
const MAX_ARTIFACTS = 20;

/** Maximum characters per artifact headline. */
const MAX_HEADLINE_CHARS = 200;

/** Maximum number of transient flow notes conserved per band window. */
const MAX_FLOW_NOTES = 6;

/**
 * Length gate for the transient lane: only SHORT assistant narrations
 * qualify as flow notes. Shortness is the deterministic noise filter — a
 * between-tool-calls diagnosis beat is short; a speculative multi-paragraph
 * hypothesis dump is not, and stays excluded as the original design intended.
 */
const MAX_FLOW_NOTE_SOURCE_CHARS = 240;

/** Registers that produce durable artifacts (settled outcomes). */
const DURABLE_REGISTERS: ReadonlySet<AssistantRegister> = new Set([
  'verdict',
  'hazard',
  'blocked',
]);

/** Registers admitted through the transient flow-note lane. */
const TRANSIENT_REGISTERS: ReadonlySet<AssistantRegister> = new Set([
  'in_progress',
  'executing',
]);

/** Rendering glyph for untagged flow notes (neither a register nor a card glyph). */
const UNTAGGED_GLYPH = '·';

/** A visibly lower-trust waypoint recovered from an explicit thought tool. */
const THOUGHT_BUBBLE_GLYPH = '💭';

/** A categorized tap_star is an intentional durable continuity waypoint. */
const TAP_STAR_GLYPH = '⭐';

/** Matches the relay tap_star long-note persistence ceiling. */
const MAX_LONG_TAP_STAR_CHARS = 4_000;

/** Matches the relay tap_star compact-note persistence ceiling. */
const MAX_TAP_STAR_NOTE_CHARS = 200;

/** Glyph for a transient note superseded by a later durable waypoint. */
const SUPERSEDED_GLYPH = '⊘';

function foldArtifactContract(
  messageIndex: number,
  authorityClass: CognitiveArtifactAuthorityClass,
  sourceTimestamp?: string,
  sourceIdentity?: string,
): Pick<
  CognitiveArtifact,
  | 'sourceIdentity'
  | 'sourceIdentityAuthority'
  | 'sourceTimestamp'
  | 'authorityClass'
  | 'completionSupport'
  | 'currentStatus'
> {
  return {
    sourceIdentity: sourceIdentity ?? `fold-window:message:${messageIndex}`,
    sourceIdentityAuthority: sourceIdentity && !sourceIdentity.startsWith('fold-window:message:')
      ? 'exact'
      : 'synthetic-position',
    sourceTimestamp,
    authorityClass,
    completionSupport: 'insufficient_alone',
    currentStatus: 'unresolved',
  };
}

/**
 * Stable substring of the transient-lane disclaimer line. Elder-band
 * supersession detectors search frozen band text for this marker instead of
 * re-parsing artifacts — keep it byte-identical with the rendered disclaimer.
 */
export const TRANSIENT_FLOW_NOTE_DISCLAIMER_MARKER =
  'lines are transient flow notes';

/** Compact tool trace emitted by birth/CLI transcript hydration. */
const TOOL_TRACE_SEGMENT_RE = /^⟨tool\s+(\S+?)(?:\s+([\s\S]*))?⟩$/;

/**
 * Host-synthetic assistant text that must never be conserved as a flow note.
 * These are relay/CLI error surrogates injected into transcripts as
 * assistant-role messages — noise, not narration.
 */
const SYNTHETIC_NOISE_PREFIXES = ['API Error', '[Request interrupted'] as const;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseToolArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

type ThoughtToolName = 'set_thought' | 'tap_star';

interface ExtractedToolWaypoint {
  tool: ThoughtToolName;
  text: string;
  category?: TapStarCategory;
  preserveVerbatim: boolean;
  sourceIdentity?: string;
}

function normalizeThoughtToolName(name: string): ThoughtToolName | null {
  const leaf = name.split('__').at(-1)?.split('.').at(-1);
  return leaf === 'set_thought' || leaf === 'tap_star' ? leaf : null;
}

function parseTapStarCategory(value: unknown): TapStarCategory | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (TAP_STAR_CATEGORIES as readonly string[]).includes(normalized)
    ? normalized as TapStarCategory
    : undefined;
}

function normalizeSourceIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function sourceIdentityFromRecord(record: Record<string, unknown>): string | undefined {
  return normalizeSourceIdentity(record.id)
    ?? normalizeSourceIdentity(record.call_id)
    ?? normalizeSourceIdentity(record.callId);
}

function extractToolWaypoint(
  name: unknown,
  rawArguments: unknown,
  sourceIdentity?: string,
): ExtractedToolWaypoint | null {
  if (typeof name !== 'string') return null;
  const tool = normalizeThoughtToolName(name);
  if (!tool) return null;
  const args = parseToolArguments(rawArguments);
  if (!args) return null;
  if (tool === 'tap_star') {
    if (args.harvest === true) return null;
    if (typeof args.action === 'string' && args.action.trim().toLowerCase() !== 'pin') return null;
  }
  const value = tool === 'set_thought' ? args.thought : args.note;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const category = tool === 'tap_star' ? parseTapStarCategory(args.category) : undefined;
  if (tool === 'tap_star' && args.category !== undefined && category === undefined) return null;
  const preserveVerbatim = tool === 'tap_star' && category !== undefined && args.long === true;
  const maxChars = preserveVerbatim
    ? MAX_LONG_TAP_STAR_CHARS
    : tool === 'tap_star' && category !== undefined
      ? MAX_TAP_STAR_NOTE_CHARS
      : MAX_FLOW_NOTE_SOURCE_CHARS;
  if (text.length > maxChars) return null;

  // Durable categorized stars may intentionally quote glyph/card/error text.
  // Transient thought/status fallbacks keep the original noise guards.
  if (category === undefined) {
    if (CARD_GLYPHS.some((glyph) => text.startsWith(glyph))) return null;
    if (SYNTHETIC_NOISE_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  }

  return {
    tool,
    text,
    category,
    preserveVerbatim,
    sourceIdentity,
  };
}

function extractWaypointFromToolRecord(value: unknown): ExtractedToolWaypoint | null {
  const record = asRecord(value);
  if (!record) return null;
  const outerIdentity = sourceIdentityFromRecord(record);
  const direct = extractToolWaypoint(
    record.name,
    record.input ?? record.arguments ?? record.args,
    outerIdentity,
  );
  if (direct) return direct;
  const fn = asRecord(record.function);
  if (fn) {
    const fromFunction = extractToolWaypoint(
      fn.name,
      fn.arguments ?? fn.args,
      outerIdentity ?? sourceIdentityFromRecord(fn),
    );
    if (fromFunction) return fromFunction;
  }
  const functionCall = asRecord(record.functionCall);
  return functionCall
    ? extractToolWaypoint(
        functionCall.name,
        functionCall.args ?? functionCall.arguments,
        outerIdentity ?? sourceIdentityFromRecord(functionCall),
      )
    : null;
}

function extractStructuredToolWaypoints(message: FoldMessage): ExtractedToolWaypoint[] {
  const rawMessage = message as FoldMessage & { parts?: unknown };
  const candidates = [message.content, message.tool_calls, rawMessage.parts];
  const waypoints: ExtractedToolWaypoint[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const waypoint = extractWaypointFromToolRecord(entry);
      if (waypoint) waypoints.push(waypoint);
    }
  }
  return waypoints;
}

function splitCompactToolTraces(text: string): { speech: string; waypoints: ExtractedToolWaypoint[] } {
  if (!text) return { speech: '', waypoints: [] };
  const speech: string[] = [];
  const waypoints: ExtractedToolWaypoint[] = [];
  for (const segment of text.split('\n')) {
    const trimmed = segment.trim();
    const match = TOOL_TRACE_SEGMENT_RE.exec(trimmed);
    if (!match) {
      speech.push(segment);
      continue;
    }
    const waypoint = extractToolWaypoint(match[1], match[2]);
    if (waypoint) waypoints.push(waypoint);
    // All compact tool traces are transport echoes, never assistant speech.
  }
  return { speech: speech.join('\n'), waypoints };
}

function sourceTimestampFromMessage(message: FoldMessage): string | undefined {
  if (typeof message.tsMs !== 'number' || !Number.isFinite(message.tsMs)) return undefined;
  const date = new Date(message.tsMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
 * Scan a list of raw messages for cognitive artifacts.
 *
 * Durable lane: assistant turns that start with a verdict (🏁), hazard (⚠️),
 * or blocked (❓) glyph — capped at MAX_ARTIFACTS, never displaced by notes.
 *
 * Transient flow-note lane (default on, see module docstring): SHORT
 * assistant narrations — tagged 🔍/▶, or cleanly untagged (parse failure
 * reason 'missing_register' only, never card-glyph-opened text, never
 * host-synthetic error surrogates) — capped at MAX_FLOW_NOTES, newest kept.
 * Categorized tap_star pin calls join the durable lane even when speech exists.
 * A tool-only window may also contribute bounded ambient tap_star/set_thought
 * payloads; those transient fallbacks are used only when no durable or speech
 * flow-note artifact exists.
 *
 * Returns all artifacts merged in chronological order (by message index).
 * Pure function — no side effects, no I/O.
 *
 * @param messages Raw messages from the fold window (before skeletonization)
 * @param options  Lane control; omit for default durable+flow-note behavior
 */
export function extractCognitiveArtifacts(
  messages: readonly FoldMessage[],
  options: ExtractCognitiveArtifactsOptions = {},
): CognitiveArtifact[] {
  const includeFlowNotes = options.includeFlowNotes !== false;
  const durable: CognitiveArtifact[] = [];
  const flowNotes: CognitiveArtifact[] = [];
  const thoughtFallbacks: CognitiveArtifact[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !ASSISTANT_ROLES.has(msg.role)) continue;

    // Handle Gemini raw message shape: { role: 'model', parts: [...] }
    const rawMsg = msg as FoldMessage & { parts?: unknown };
    const rawText = flattenContent(msg.content, rawMsg.parts);
    const compact = splitCompactToolTraces(rawText);
    const messageSourceIdentities = foldMessageSourceIdentities(msg);
    const messageSourceIdentity = msg.sourceIdentity?.trim()
      || (messageSourceIdentities.length === 1 ? messageSourceIdentities[0] : undefined);
    const uniqueToolWaypoints = new Map<string, ExtractedToolWaypoint>();
    for (const waypoint of [
      ...extractStructuredToolWaypoints(msg),
      ...compact.waypoints,
    ]) {
      const key = `${waypoint.tool}\u0000${waypoint.category ?? ''}\u0000${waypoint.text}`;
      const prior = uniqueToolWaypoints.get(key);
      if (!prior || (!prior.sourceIdentity && waypoint.sourceIdentity)) {
        uniqueToolWaypoints.set(key, waypoint);
      }
    }
    const sourceTimestamp = sourceTimestampFromMessage(msg);
    for (const waypoint of uniqueToolWaypoints.values()) {
      if (waypoint.tool === 'tap_star' && waypoint.category) {
        const headline = waypoint.preserveVerbatim
          ? waypoint.text
          : extractHeadline(waypoint.text);
        durable.push({
          ...foldArtifactContract(
            i,
            'pointer',
            sourceTimestamp,
            waypoint.sourceIdentity
              ?? messageSourceIdentity
              ?? `fold-window:message:${i}/tap_star:${waypoint.category}/${encodeURIComponent(headline)}`,
          ),
          register: 'tap_star',
          glyph: TAP_STAR_GLYPH,
          headline,
          messageIndex: i,
          trust: 'durable',
          tapStarCategory: waypoint.category,
        });
      } else if (includeFlowNotes) {
        const headline = extractHeadline(waypoint.text);
        thoughtFallbacks.push({
          ...foldArtifactContract(
            i,
            'historical_observation',
            sourceTimestamp,
            waypoint.sourceIdentity
              ?? messageSourceIdentity
              ?? `fold-window:message:${i}/${waypoint.tool}/${encodeURIComponent(headline)}`,
          ),
          register: 'untagged',
          glyph: THOUGHT_BUBBLE_GLYPH,
          headline,
          messageIndex: i,
          trust: 'transient',
        });
      }
    }
    const text = compact.speech;
    if (!text) continue;

    const parseResult = parseRegisterGlyph(text);
    if (parseResult.ok && DURABLE_REGISTERS.has(parseResult.register)) {
      const headline = extractHeadline(parseResult.body);
      durable.push({
        ...foldArtifactContract(i, 'historical_observation', sourceTimestamp, messageSourceIdentity),
        register: parseResult.register,
        glyph: REGISTER_GLYPHS[parseResult.register],
        headline,
        messageIndex: i,
        trust: 'durable',
      });
      continue;
    }

    if (!includeFlowNotes) continue;
    if (text.length > MAX_FLOW_NOTE_SOURCE_CHARS) continue;

    if (parseResult.ok && TRANSIENT_REGISTERS.has(parseResult.register)) {
      const headline = extractHeadline(parseResult.body);
      flowNotes.push({
        ...foldArtifactContract(i, 'historical_observation', sourceTimestamp, messageSourceIdentity),
        register: parseResult.register,
        glyph: REGISTER_GLYPHS[parseResult.register],
        headline,
        messageIndex: i,
        trust: 'transient',
      });
      continue;
    }

    // Untagged short narration: admit ONLY the clean missing_register case.
    // Card-glyph-opened text is quoted folded memory and must never re-enter
    // a band as fresh narration (echo-contamination guard); leading
    // whitespace, markdown containers, and duplicate-register text stay out.
    if (
      !parseResult.ok &&
      parseResult.reason === 'missing_register' &&
      !CARD_GLYPHS.some((cardGlyph) => text.startsWith(cardGlyph)) &&
      !SYNTHETIC_NOISE_PREFIXES.some((prefix) => text.startsWith(prefix))
    ) {
      const headline = extractHeadline(text);
      flowNotes.push({
        ...foldArtifactContract(i, 'historical_observation', sourceTimestamp, messageSourceIdentity),
        register: 'untagged',
        glyph: UNTAGGED_GLYPH,
        headline,
        messageIndex: i,
        trust: 'transient',
      });
    }
  }

  const cappedDurable =
    durable.length > MAX_ARTIFACTS ? durable.slice(-MAX_ARTIFACTS) : durable;
  const cappedFlowNotes =
    flowNotes.length > MAX_FLOW_NOTES ? flowNotes.slice(-MAX_FLOW_NOTES) : flowNotes;

  const speechArtifacts = [...cappedDurable, ...cappedFlowNotes].sort(
    (a, b) => a.messageIndex - b.messageIndex,
  );
  if (speechArtifacts.length > 0) return markSupersededFlowNotes(speechArtifacts);

  // A thought tool is a fallback for windows with no waypoint-bearing assistant
  // speech. Keep the newest occurrence of repeated tool calls and never render
  // the serialized ⟨tool …⟩ wrapper itself.
  const newestByHeadline = new Map<string, CognitiveArtifact>();
  for (const artifact of thoughtFallbacks) {
    newestByHeadline.set(artifact.headline, artifact);
  }
  const dedupedThoughts = [...newestByHeadline.values()].sort(
    (a, b) => a.messageIndex - b.messageIndex,
  );
  return dedupedThoughts.length > MAX_FLOW_NOTES
    ? dedupedThoughts.slice(-MAX_FLOW_NOTES)
    : dedupedThoughts;
}

/**
 * Within-window supersession: a transient flow note (🔍/▶/·) is working
 * narration, not a conclusion. When a durable waypoint lands later in the
 * same fold window, the note is settled — mark it so renderers can show the
 * supersession instead of letting a stale hypothesis read as live guidance.
 * Thought-fallback-only windows contain no durable waypoint by construction,
 * so they pass through unchanged (their supersession is the cross-epoch
 * elder-band case handled by the render option below).
 */
function markSupersededFlowNotes(
  artifacts: readonly CognitiveArtifact[],
): CognitiveArtifact[] {
  const marked = new Array<CognitiveArtifact>(artifacts.length);
  let nextDurableIndex = -1;
  let nextDurableIdentity: string | undefined;
  const replacementIdentities = new Set<string>();
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    if (artifact.trust === 'durable') {
      nextDurableIndex = artifact.messageIndex;
      nextDurableIdentity = artifact.sourceIdentity;
      marked[i] = artifact;
      continue;
    }
    marked[i] =
      nextDurableIndex >= 0 && nextDurableIdentity
        ? {
            ...artifact,
            currentStatus: 'superseded',
            supersededByMessageIndex: nextDurableIndex,
            supersededByIdentity: nextDurableIdentity,
          }
        : artifact;
    if (nextDurableIndex >= 0 && nextDurableIdentity) {
      replacementIdentities.add(nextDurableIdentity);
    }
  }
  for (let i = 0; i < marked.length; i += 1) {
    if (replacementIdentities.has(marked[i].sourceIdentity)) {
      marked[i] = { ...marked[i], currentStatus: 'current' };
    }
  }
  return marked;
}

/** Options for renderCognitiveBlock. */
export interface RenderCognitiveBlockOptions {
  /**
   * Set when the frozen elder bands ahead of this one carry transient flow
   * notes. With at least one durable waypoint in the current window, the
   * block declares those elder notes superseded (elder bytes stay immutable;
   * the supersession is stated additively in the newest band).
   */
  supersedesElderTransientNotes?: boolean;
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
  options: RenderCognitiveBlockOptions = {},
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
  const lines = artifacts.flatMap((a) => [
    formatCognitiveArtifactProvenance(a),
    `${a.supersededByMessageIndex != null ? SUPERSEDED_GLYPH : a.glyph} ${
      a.register === 'tap_star' ? `[${a.tapStarCategory ?? 'unknown'}] ` : ''
    }${a.headline}`,
  ]);
  const hasFlowNotes = artifacts.some((a) => a.trust === 'transient');
  const hasDurable = artifacts.some((a) => a.trust === 'durable');
  return [
    '[cognitive — historical waypoints from the folded window, NOT your current state]',
    '— authority is per artifact; completion=insufficient_alone for every waypoint —',
    ...(hasFlowNotes
      ? [`— 🔍/▶/·/💭 ${TRANSIENT_FLOW_NOTE_DISCLAIMER_MARKER}: unverified mid-flow narration, not conclusions —`]
      : []),
    // Cross-epoch supersession: elder bands are immutable, so the newest band
    // declares their transient narration replaced. Only a genuine durable
    // waypoint in THIS window can supersede — without one, elder flow notes
    // remain the freshest (still transient) working state.
    ...(options.supersedesElderTransientNotes && hasDurable
      ? ['— durable waypoints below supersede transient flow notes frozen in elder band(s); elder 🔍/▶/·/💭 narration is replaced working state, not live guidance —']
      : []),
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
  const sourceIdentity = artifact.sourceIdentity ?? `fold-window:message:${artifact.messageIndex}`;
  const authorityClass = artifact.authorityClass
    ?? (artifact.register === 'tap_star' ? 'pointer' : 'historical_observation');
  const completionSupport = artifact.completionSupport ?? 'insufficient_alone';
  const currentStatus = artifact.currentStatus ?? 'unresolved';
  const supersession =
    artifact.supersededByMessageIndex != null
      ? ` · superseded-by=${artifact.supersededByIdentity ?? `fold-window:message:${artifact.supersededByMessageIndex}`} (msg#${artifact.supersededByMessageIndex})`
      : '';
  const register = artifact.register === 'tap_star'
    ? `tap_star:${artifact.tapStarCategory ?? 'unknown'}`
    : artifact.register;
  const current = currentStatus === 'unresolved'
    ? ''
    : ` · current=${currentStatus}`;
  return [
    `↞ msg#${artifact.messageIndex}`,
    register,
    `authority=${authorityClass}`,
    `completion=${completionSupport}`,
    `source-time=${artifact.sourceTimestamp ?? 'unknown'}`,
    `source-id=${sourceIdentity}`,
    `source-identity=${artifact.sourceIdentityAuthority ?? 'synthetic-position'}`,
  ].join(' · ') + current + supersession;
}

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
export function enrichFoldedBandBody(
  parts: string[],
  rawMessages: readonly FoldMessage[],
  options?: ExtractCognitiveArtifactsOptions,
  renderOptions?: RenderCognitiveBlockOptions,
): string[] {
  const artifacts = extractCognitiveArtifacts(rawMessages, options);
  const block = renderCognitiveBlock(artifacts, renderOptions);
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
  return [
    ...view.slice(0, -1),
    { ...last, content, contextWarpSynthetic: 'cognitive-overlay' },
  ] as T[];
}
