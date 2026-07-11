/**
 * foldEpisodes.ts — Episodic continuity engine, pure core.
 *
 * An episode is the durable memory of one work burst: which files were touched
 * together (the blast radius / activation zone), in what order (the
 * structural-verbatim branch trace), and what the agent itself said at the time
 * (voice annotations mined verbatim from atlas_commit / tap_star / typed chat,
 * plus tier-B narration distilled deterministically from burst-final
 * assistant prose — see extractNarrationLines).
 * Episodes are derived at fold-epoch boundaries, persisted by the worker pool
 * (fold-episodes.sqlite), and recalled as chain cards when any member of a zone
 * is touched again. Trigger semantics are zone-based, never lock-and-key:
 * touching ONE member recalls the WHOLE zone.
 *
 * INVARIANTS
 * - Pure CPU island: zero I/O, zero imports, zero ambient reads (no Date.now,
 *   no randomness). Same inputs → byte-identical output. Safe to import from
 *   worker handlers, capture seams, backfill scripts, and replay studies alike.
 * - NO-NARRATOR RULE: traces and cards contain only structural tokens (tools,
 *   targets, outcomes, order, counts) plus VERBATIM agent-authored text.
 *   Nothing retrospective, nothing paraphrased, no voice that wasn't there.
 *   Truncation of verbatim text (with a trailing ellipsis) is permitted;
 *   rewording is not. Narration annotations stay inside this rule: they are
 *   the agent's own contemporaneous words, selected by a deterministic shape
 *   gate (never an LLM), provenance-marked as kind 'narration' (🗣), and
 *   ranked below every deliberate voice channel unless promoted by a declared
 *   SOP register glyph (🏁/⚠️).
 *   The only derived line is the episode summary header,
 *   built from the agent's own changelog/rail words first, structural facts
 *   (top member paths) as the last fallback.
 * - Gradient law: the hot chapter renders full (members + trace + voice +
 *   since-then deltas), warm chapters render one-liners, cold chapters collapse
 *   to a single line. The same compression law applies at every chain level.
 * - Episodes must outlive their source transcripts: persist `trace` and
 *   `annotations` denormalized at write time (aa-ledger ENOENT lesson).
 *   Nothing in this module reaches back to transcript files at render time.
 */

export type EpisodeTouchKind = 'edit' | 'read' | 'mention';

export type EpisodeClosedBy = 'epoch' | 'rebirth' | 'release' | 'idle' | 'backfill';

export type EpisodeAnnotationKind =
  | 'star:decision'
  | 'star:discovery'
  | 'star:pivot'
  | 'star:handoff'
  | 'star:gotcha'
  | 'star:result'
  | 'changelog'
  | 'chat'
  // Rail ACK voice: a contemporaneous step-completion / blocker note the agent
  // typed into task_rail. Deliberate operational voice (see ANNOTATION_PRIORITY).
  | 'rail'
  /**
   * Tier-B voice: burst-final assistant prose through the deterministic verdict
   * gate. Three trust tiers, set by the register the agent DECLARED (SOP P23
   * first-glyph): a 🏁-declared verdict and a ⚠️-declared hazard are promoted
   * into the deliberate tier (they rank with star:result / star:gotcha and a
   * declared hazard feeds the chain-surfacing boost), because a declared
   * conclusion is a deliberate act on par with a pinned star — not a
   * shape-detected guess. Untagged narration stays the priority-last backstop.
   * Absence-safe: at 0% glyph compliance every line is untagged 'narration', so
   * ranking is byte-identical to the pre-promotion engine.
   */
  | 'narration:verdict'
  | 'narration:hazard'
  | 'narration';

export interface EpisodeAnnotation {
  /** ISO-8601 timestamp of the moment the agent wrote this. */
  ts: string;
  kind: EpisodeAnnotationKind;
  /** VERBATIM agent-authored text, ≤ VOICE_TEXT_CAP_CHARS at write time. */
  text: string;
  /** Optional file path this annotation was about (e.g. atlas_commit target). */
  path?: string;
}

export interface EpisodeMember {
  path: string;
  /** Strongest touch kind observed in the burst (edit > read > mention). */
  touchKind: EpisodeTouchKind;
  touchCount: number;
  /** Event-index ordinals within the source session (chronology anchors). */
  firstSeen: number;
  lastSeen: number;
}

export interface Episode {
  /** Store-assigned id; absent before persistence. */
  id?: number;
  workspace: string;
  instanceId: string;
  lineageRoot?: string;
  /**
   * Authoring agent's stable display name at capture time (e.g. "turbo-ocelot").
   * Absent on legacy rows and before capture persistence wires it; attribution
   * rendering falls back to lineageRoot/instanceId when absent.
   */
  authorName?: string;
  startedAt: string;
  endedAt: string;
  closedBy: EpisodeClosedBy;
  /** One-line header; see deriveEpisodeSummary fallback chain. */
  summary: string;
  /**
   * Verbatim operator ask that drove this burst — the nearest genuine user
   * message at/before the burst start, mined from the RAW capture window (not the
   * recency-capped transient send-view vault) and denormalized here at write time
   * so the "why" outlives its source transcript. Absent when the burst was
   * agent-initiated (no preceding operator message) or on legacy rows. This is
   * operator-authored verbatim text: the one voice on the spine that is NOT the
   * agent's own — it stays inside the no-narrator rule (real, contemporaneous,
   * never paraphrased).
   */
  intent?: string;
  gitHead?: string;
  railId?: string;
  railStep?: string;
  /**
   * TRUE when the capturing session was force-siloed (sealed experiment /
   * blinded research arm) at the moment of record. Siloed rows are visible
   * to other siloed callers only; unsealed callers never see them. The
   * invariant is: capture-but-quarantine — never refuse to form memory,
   * gate the read.
   */
  siloed?: boolean;
  members: EpisodeMember[];
  /** Structural-verbatim branch trace (buildBranchTrace output). */
  trace: string;
  annotations: EpisodeAnnotation[];
  /**
   * Worker-derived distinctive terms (summary + annotations), capped and stored
   * for tier-2 pathless recall. Optional before persistence and on legacy rows.
   */
  terms?: string[];
  /**
   * EMA of terminal recall outcomes in [0,1]. Absent for unmeasured legacy rows
   * and the -1 sentinel; used only by opt-in ranking experiments.
   */
  recallUtility?: number;
}

export const RECALL_UTILITY_MIN_MULTIPLIER = 0.75;
export const RECALL_UTILITY_MAX_MULTIPLIER = 1.25;

export interface RecallUtilityDebugFields {
  recallUtility: number;
  recallUtilityMultiplier: number;
}

export function normalizeRecallUtility(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(1, Math.max(0, value));
}

export function recallUtilityMultiplier(value: unknown): number {
  const utility = normalizeRecallUtility(value);
  if (utility === undefined) return 1;
  return RECALL_UTILITY_MIN_MULTIPLIER
    + utility * (RECALL_UTILITY_MAX_MULTIPLIER - RECALL_UTILITY_MIN_MULTIPLIER);
}

export function recallUtilityDebugFields(value: unknown): RecallUtilityDebugFields | undefined {
  const utility = normalizeRecallUtility(value);
  if (utility === undefined) return undefined;
  return { recallUtility: utility, recallUtilityMultiplier: recallUtilityMultiplier(utility) };
}

export interface EpisodeTouch {
  eventIndex: number;
  path: string;
  kind: EpisodeTouchKind;
  /** ISO-8601; optional — grouping falls back to event-count gaps without it. */
  ts?: string;
}

export interface EpisodePivotMarker {
  eventIndex: number;
  ts?: string;
}

export interface EpisodeGroupingOptions {
  /** Seal the burst when the event-index gap between touches exceeds this. */
  gapEvents?: number;
  /** Seal the burst when the wall-clock gap between touches exceeds this. */
  gapMs?: number;
  /** Max members per episode; edits prioritized when trimming. */
  memberCap?: number;
  /** Force-split a single burst once it spans this many events from its start. */
  maxBurstEvents?: number;
  /** Force-split a single burst once it spans this much wall-clock (ms) from its start. */
  maxBurstMs?: number;
  /** star:pivot markers — an agent-declared chapter break seals the burst. */
  pivots?: readonly EpisodePivotMarker[];
  /**
   * task_rail execution / ACK markers. These carry no file touch themselves,
   * but they are deliberate lifecycle seams: sprint starts work, shoot/audit
   * ACK closes it, and load/start switches intent. When one falls between two
   * file touches, it seals the current burst like a pivot. Omitting =
   * byte-identical legacy grouping.
   */
  railSealEventIndexes?: readonly number[];
  /**
   * VOICE FLOOR: when true, a burst is NOT sealed by a gap/pivot alone unless
   * it contains at least one voice event (from voiceEventIndexes) OR the
   * force-split cap (maxBurstEvents/maxBurstMs) fires. This produces fewer,
   * fatter episodes that each carry voice by construction — the chunk boundary
   * flexes to where the voice actually is instead of cutting before it arrives.
   * Force-split always overrides — a burst can't grow indefinitely.
   */
  voiceFloor?: boolean;
  /**
   * Sorted event indexes where voice annotations (changelog/star/chat) were
   * emitted. Used by voiceFloor to check if the current burst has voice.
   * If absent or empty, voiceFloor is a no-op (no voice data → never hold).
   */
  voiceEventIndexes?: readonly number[];
  /**
   * Sorted event indexes where operator INTENT messages (the user's ask)
   * appear. Intent typically sits BEFORE a burst's first touch (the ask
   * motivates the work), so burstHasVoice checks a WIDER range for intent
   * than for annotations: [prevBurstEnd, currentLast] vs [first, last].
   * This prevents the 91.7% of "voiceless" episodes that actually carry
   * the operator's ask from being counted as voice-deprived.
   */
  intentEventIndexes?: readonly number[];
  /**
   * VALUE FLOOR: paths that carry forward-reference value (e.g. actively edited
   * files, claim&edit > read). A burst containing any valueFloorPath gets its
   * gapMs multiplied by valueFloorGapMultiplier so high-value paths hold open
   * longer to accumulate more voice before sealing. Omitting the array or
   * passing multiplier ≤ 1 ⇒ byte-identical to not having the option.
   */
  valueFloorPaths?: readonly string[];
  /** Multiplier applied to gapMs when a burst contains a value-floor path. */
  valueFloorGapMultiplier?: number;
  /**
   * TAP-STAR FLOOR: event indexes carrying a deliberate operator pin
   * (star:decision, star:pivot, star:gotcha). A deliberately-pinned waypoint
   * is the strongest 'resurface this' signal — stronger than mined narration.
   * A burst containing any tapStarFloor event holds open gapMs ×
   * tapStarFloorGapMultiplier (default 2.0) AND is never sealed voiceless.
   * Omitting = byte-identical.
   */
  tapStarFloorEventIndexes?: readonly number[];
  /** Multiplier applied to gapMs when a burst contains a tap-star pin. */
  tapStarFloorGapMultiplier?: number;
  /**
   * AFFINITY FLOOR: behavioral co-occurrence scores. When a gap would seal but
   * a (currentBurstPath, nextEventPath) pair has affinity ≥ affinityGapThreshold,
   * extend gapMs by affinityGapMultiplier. This keeps a burst open when the
   * agent likely stayed in the same conceptual zone. Path→neighbor→score (0-1).
   * Omitting = byte-identical.
   */
  affinityFloor?: Readonly<Record<string, Record<string, number>>>;
  /** Affinity score threshold above which a gap is widened (default 0.5). */
  affinityGapThreshold?: number;
  /** Multiplier applied to gapMs when affinity ≥ threshold (default 2.0). */
  affinityGapMultiplier?: number;
}

export interface EpisodeBurst {
  startEventIndex: number;
  endEventIndex: number;
  startedAt?: string;
  endedAt?: string;
  touchTotal: number;
  members: EpisodeMember[];
}

export interface TraceStep {
  tool: string;
  target?: string;
  outcome?: 'ok' | 'error';
  /** Short verbatim detail: test count ('49'), error count ('3'), commit head. */
  detail?: string;
  /** When set, this step renders as a voice inlay instead of a tool token. */
  voice?: EpisodeAnnotation;
}

export interface WalkPosition {
  /** 1-based position of this chapter in the walk (1 = first promoted). */
  index: number;
  /** Total chapters in the chain. */
  total: number;
}

export interface WalkSpineCitation {
  chapter: Episode;
  /**
   * 'origin' = the TRUE chain root: rendered as a full anchor (inline gist +
   * `| reopen:` pointer) — the rehydratable north star that rides every walk
   * card from step one. 'waypoint' = an intermediate breadcrumb: compact and
   * VIEW-ONLY (inline gist + distance-from-now, no reopen pointer).
   */
  kind: 'origin' | 'waypoint';
  /** Waypoints only: chapters-back from the served chapter (the walk's "now"). */
  backDistance?: number;
  /** Optional explicit role override; else derived from the chapter annotations. */
  label?: string;
}

export interface ChainCardOptions {
  /** Pre-rendered session-adjacent one-liners (resolved at recall by the store). */
  bookends?: { before?: string; after?: string };
  /** Hard cap for the rendered card; pointer line is never sacrificed. */
  charBudget?: number;
  maxVoiceInlays?: number;
  /** How many previous chapters render with full body detail before warm one-liners. */
  fullPreviousCount?: number;
  /** How many previous chapters render as warm one-liners. */
  warmCount?: number;
  /**
   * Caller's own-lineage instance-id set (own id + lineage/predecessor ids).
   * A chapter whose authoring instanceId is NOT in this set renders as foreign
   * (peer-lineage banner + attributed voice). Supplying ownLineage OR selfName
   * activates attribution; with neither, voice renders bare for backward-compat.
   */
  ownLineage?: ReadonlySet<string>;
  /** Caller's friendly display name, used to label own-lineage voice lines. */
  selfName?: string;
  /**
   * When true, suppress peer-lineage chapters entirely. This is for own-memory
   * surfaces such as wake/rebirth packages; live swarm recall can leave it false
   * to keep cross-lineage coordination signal.
   */
  selfLineageOnly?: boolean;
}

export const DEFAULT_EPISODE_GROUPING = {
  gapEvents: 25,
  gapMs: 1_200_000,
  memberCap: 16,
  // FORCE-SPLIT caps. A single uninterrupted burst that grows past EITHER cap
  // (measured from its FIRST touch) is split into chapters anyway, even with no
  // inter-touch gap. Without this a continuously-busy instance (dense touches,
  // no gap > gapEvents/gapMs, no pivot) produces ONE perpetually-open burst that
  // never seals: the capture cursor parks at its start and ALL its voice
  // (changelog/star/chat + narration) is dropped — the live 2026-06-13
  // regression where ep_persist went dead for 8h while sweeper/editor instances
  // ran nonstop. Splitting sheds older chapters MID-RUN so their voice harvests
  // (each sealed chapter's narration is mined) and the cursor advances past
  // them, unblocking eviction. Set well above gapEvents/gapMs so normal
  // (pausing) instances never trip them — only genuinely long continuous runs.
  maxBurstEvents: 240,
  maxBurstMs: 1_800_000,
} as const;

export const BRANCH_TRACE_CAP_CHARS = 450;
export const SUMMARY_CAP_CHARS = 120;
export const HEADER_SUMMARY_CAP_CHARS = 60;
export const VOICE_TEXT_CAP_CHARS = 200;
export const TRACE_VOICE_TEXT_CAP_CHARS = 60;
/**
 * Verbatim cap for the operator-ask intent anchor (Episode.intent). The driving
 * user message can run long; bound it like voice and keep it to a single anchor
 * line on the card.
 */
export const INTENT_TEXT_CAP_CHARS = 200;
export const CHAIN_CARD_DEFAULT_BUDGET_CHARS = 1_600;

const TOUCH_KIND_RANK: Record<EpisodeTouchKind, number> = { edit: 2, read: 1, mention: 0 };

const ANNOTATION_PRIORITY: Record<EpisodeAnnotationKind, number> = {
  'star:gotcha': 0,
  'star:decision': 1,
  'star:pivot': 2,
  'star:result': 3,
  'star:discovery': 4,
  'star:handoff': 5,
  // DECLARED commentary (SOP P23 glyphs) is promoted INTO the deliberate tier:
  // a ⚠️-declared hazard and a 🏁-declared verdict are deliberate acts on par
  // with pinned stars, so they outrank a routine changelog blurb / ambient chat
  // line for an inlay slot. A declared hazard sits just under the gotcha star
  // (both say "beware — resurface"); a declared verdict just under result.
  'narration:hazard': 6,
  'narration:verdict': 7,
  changelog: 8,
  // RAIL ACK voice: deliberate agent operational voice (step-completion / blocker
  // evidence the agent typed into task_rail), peer to a changelog blurb and above
  // ambient chat — it is an explicit, contemporaneous statement about the work.
  rail: 9,
  chat: 10,
  // UNTAGGED tier-B distillate: still always LAST, so it fills voice vacuum but
  // never displaces deliberate voice under the inlay cap. At 0% glyph
  // compliance all narration lands here — ranking stays byte-identical to the
  // pre-promotion engine.
  narration: 11,
};

/**
 * Membership eligibility: zone members must be real workspace-ish artifacts.
 * System binaries, device paths, package internals, and bare segment-less
 * tokens (e.g. 'app') make degenerate zones — /bin/bash as a member would
 * re-engage its zone on every shell command, poisoning walk calibration and
 * recall ranking alike (measured: /bin/bash was the longest "chain" in the
 * first replay smoke, 28 chapters; directories like `relay/src` and the repo
 * root topped the first backfill smoke the same way — and import-edges only
 * contain files, so directory members would asymmetrically inflate the
 * episodic tier in any head-to-head). Members must be FILES: the final path
 * segment needs an extension (deliberate loss: extensionless files like
 * Makefile/LICENSE — rare as recall targets, cheap vs the noise). Shell-token
 * characters disqualify outright: the full-corpus backfill showed 65% of
 * distinct members (26,129/40,111) were whole command strings whose final
 * word happened to end in an extension ("node --check scripts/x.mjs",
 * "sed -n '1,260p' scripts/y.ts"), plus 1,272 env-assignment tokens
 * (DB=/path/z.sqlite) and ~1,300 semicolon-fused fragments. Whitespace,
 * quotes, backticks, semicolons, and '=' never appear in real touched paths
 * here — but parens/brackets DO (Next route groups: app/(hypermath)/... had
 * 308 legit members incl. a rank-4 zone), so those stay allowed.
 * groupTouchesIntoEpisodes applies this internally so every caller inherits
 * the same rule.
 */
export function isEpisodeMemberPath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 512) return false;
  if (/[\s"'`;=]/.test(candidate)) return false;
  // Glob/exclusion tokens from tool args (vitest patterns, rg globs) are not
  // file touches. '[' and ']' stay legal — Next.js dynamic-route segments
  // like app/.../[id]/page.tsx are real members.
  if (candidate.startsWith('!')) return false;
  if (candidate.includes('*') || candidate.includes('{') || candidate.includes('}')) return false;
  const lastSegment = candidate.includes('/') ? candidate.slice(candidate.lastIndexOf('/') + 1) : candidate;
  if (!lastSegment.includes('.')) return false;
  if (
    candidate === '/bin' || candidate.startsWith('/bin/')
    || candidate === '/sbin' || candidate.startsWith('/sbin/')
    || candidate === '/dev' || candidate.startsWith('/dev/')
    || candidate.startsWith('/usr/')
    || candidate.startsWith('/etc/')
    || candidate.startsWith('/opt/')
    || candidate.startsWith('/proc/')
    || candidate.startsWith('/sys/')
  ) return false;
  if (candidate.includes('node_modules')) return false;
  return true;
}

/** Truncate verbatim text to a cap, marking the cut with a single ellipsis. */
export function truncateVerbatim(text: string, cap: number): string {
  if (text.length <= cap) return text;
  if (cap <= 1) return '…';
  return `${text.slice(0, cap - 1)}…`;
}

// ── Narration (tier-B voice) ─────────────────────────────────────────────

/**
 * Rationale backstop: lines that express the agent's REASONING behind a
 * decision — trade-offs, alternatives considered, why one approach was chosen
 * over another. These lines don't match NARRATION_VERDICT_RE (they're not
 * "Found/Fixed/Confirmed" verdicts) but carry the "why" that verdict-shaped
 * mining drops. extractRationaleLines runs as the pass-3 backstop after
 * narration pass 1 (deliberate glyphs) and pass 2 (verdict shape) both fail.
 *
 * The pattern matches the agent's own decision-reasoning vocabulary — NOT
 * conclusions or outcomes (those are narration), but the reasoning that led
 * to them. Provenance-marked as kind 'narration' (lowest priority deliberate
 * voice), so declared glyphs and verdict narration always rank higher.
 */
// Tightened against non-decision prose: bare `alternative` dropped (covered by
// instead of / rather than / rejected / chose-over); bare `as` removed from the
// over-branch ("over the weekend as usual" was a false hit); `due to` excludes
// resource-meta follow-ons ("due to time I'll stop here") via negative lookahead.
export const RATIONALE_RE = /\b(?:chose|selected|prefer(?:red)?|went with|opt(?:ed)?|decided|trade[- ]?off|instead of|rather than|rejected|over .{1,40}\b(?:because|since|given)\b|the (?:reason|rationale)\b|due to(?! (?:time|space|length|brevity|budget|the hour)\b)|the (?:key|main|real) (?:reason|factor)\b)\b/i;

/** Max rationale lines per episode (rationale is a supplementary backstop). */
export const RATIONALE_MAX_LINES = 2;

/**
 * Deterministic rationale filter over assistant prose. Extracts lines that
 * contain decision-reasoning markers — the "why" behind choices — that the
 * verdict gate (NARRATION_VERDICT_RE) misses. Same safety gates as
 * extractNarrationLines: code-block awareness, synthetic rejection, quoted-
 * voice rejection, length bounds, truncation. Zero LLM, byte-identical for
 * identical inputs.
 *
 * Used as the pass-3 backstop in mineNarrationForGap: runs ONLY when both the
 * deliberate glyph pass (1) and the verdict-shape pass (2) found nothing.
 */
export function extractRationaleLines(
  text: string,
  isSyntheticLine: (line: string) => boolean,
  cap = RATIONALE_MAX_LINES,
): string[] {
  if (!text) return [];
  const out: string[] = [];
  let inCodeBlock = false;
  for (const rawLine of text.split('\n')) {
    if (out.length >= cap) break;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock || trimmed.length === 0) continue;
    if (isSyntheticLine(trimmed) || NARRATION_QUOTED_VOICE_RE.test(trimmed) || NARRATION_NONVERDICT_LINE_RE.test(trimmed)) continue;
    const stripped = trimmed.replace(NARRATION_DECORATION_RE, '');
    if (stripped.length < NARRATION_MIN_LINE_CHARS || stripped.length > NARRATION_MAX_LINE_CHARS) continue;
    if (stripped.endsWith('?')) continue;
    if (!RATIONALE_RE.test(stripped)) continue;
    out.push(truncateVerbatim(stripped, VOICE_TEXT_CAP_CHARS));
  }
  return out;
}

/** Max narration lines carried per episode (untagged backstop). */
export const NARRATION_MAX_LINES = 2;
/**
 * Higher cap for DECLARED 🏁/⚠️ messages: the tag itself is the trust signal, so
 * a multi-line verdict/hazard form ("Fixed X. Verified Y. Risk Z.") is captured
 * more fully than untagged prose. Still bounded — synthetic/card-quote guards,
 * length/question gates, position windows, and the per-card inlay cap remain.
 */
export const NARRATION_MAX_LINES_TAGGED = 3;
/** Shape bounds: shorter is filler ("Done."), longer is paragraph prose. */
export const NARRATION_MIN_LINE_CHARS = 25;
export const NARRATION_MAX_LINE_CHARS = 300;

// Conclusion-shaped openers for UNTAGGED narration only. A curated whitelist —
// additive over time, never loosened to position-only: mid-work hypotheses
// ("the bug must be in X") are confidently wrong often enough that shape AND
// position (burst-final prose only, enforced by the capture layer) must BOTH
// hold before untagged narration becomes memory. DECLARED 🏁/⚠️ messages use
// the glyph itself as the trust signal and bypass only this lexical opener gate;
// hard safety gates (synthetic/card quotes, length bounds, no questions) remain.
const NARRATION_VERDICT_RE = /^(?:(?:found|fixed|confirmed|verified|implemented|landed|shipped|resolved|diagnosed|root cause|turns out|it was|caused by|no longer|tests? pass(?:ed|ing)?|typecheck (?:clean|passes)|all \d+ tests)\b|(?:done|result(?:s)?|conclusion|verdict)\s*[:—–-]|the (?:bug|fix|issue|problem|culprit|root cause)\b)/i;

// Leading list/heading/status decorations stripped before the verdict gate
// ("- ✅ Fixed ..." → "Fixed ..."). Includes the eligible message-register
// glyphs 🏁/⚠️ so stored declared lines do not retain transport decoration.
const NARRATION_DECORATION_RE = /^[\s#>*\-•·–—\d.)✓✗✅❌🎯⚠️🏁]+/u;

// Card-grammar glyphs: a line opening with one is QUOTED memory (a recalled
// card's voice/pointer/delta line), never fresh narration — reject outright.
const NARRATION_QUOTED_VOICE_RE = /^[✎⭐💬🗣⌖Δ↞↠]/u;

// Line-level register tags: a line the agent itself opened with 🔍/▶/❓ is
// declared in-progress/executing/blocked — never voice, even inside an eligible message.
// 🏁/⚠️ line openers strip as decoration and are handled by the caller's declared
// vs untagged extraction mode.
const NARRATION_NONVERDICT_LINE_RE = /^[🔍▶❓❔]/u;

// ── Message glyph grammar (register tags) ────────────────────────────────

/** Register an agent declares by opening a message with one SOP glyph. */
export type MessageGlyphMode = 'working' | 'executing' | 'verdict' | 'hazard' | 'blocked';

// SOP taxonomy (sop/master.md P23): 🔍 in-progress · ▶ executing ·
// 🏁 verified verdict · ⚠️ hazard/gotcha · ❓ blocked. Bare ▶/⚠/❔
// forms cover engines that emit emoji without the VS16 presentation selector. Card-grammar glyphs
// (✎⭐💬🗣⌖Δ↞↠) are deliberately NOT modes — they mark quoted memory.
const MESSAGE_GLYPHS: readonly (readonly [string, MessageGlyphMode])[] = [
  ['🔍', 'working'],
  ['▶️', 'executing'],
  ['▶', 'executing'],
  ['🏁', 'verdict'],
  ['⚠️', 'hazard'],
  ['⚠', 'hazard'],
  ['❓', 'blocked'],
  ['❔', 'blocked'],
];

/**
 * First-glyph register classifier — the SOURCE side of narration noise
 * control. Deterministic, engine-agnostic, transcript-only: an agent declares
 * what its message IS (hypothesis vs verified verdict) by how it opens it —
 * knowledge no shape regex can recover from phrasing alone. Returns undefined
 * for untagged text; callers MUST treat undefined as "shape-only gating",
 * never as exclusion, so harvest keeps working at 0% compliance (legacy
 * transcripts, non-adopting engines).
 */
export function classifyMessageGlyph(text: string | undefined): MessageGlyphMode | undefined {
  if (!text) return undefined;
  const head = text.trimStart();
  for (const [glyph, mode] of MESSAGE_GLYPHS) {
    if (head.startsWith(glyph)) return mode;
  }
  return undefined;
}

/**
 * Harvest eligibility under the glyph gate: declared non-verdict registers
 * (🔍 working / ▶ executing / ❓ blocked) self-exclude — the false-positive class no shape
 * filter can catch ("Found the likely culprit…" inside a 🔍 message is a
 * hypothesis wearing verdict clothes). 🏁/⚠️ and untagged stay eligible:
 * untagged still needs the lexical verdict gate, while declared 🏁/⚠️ uses the
 * glyph as the deliberate trust signal.
 */
export function isNarrationEligibleGlyph(mode: MessageGlyphMode | undefined): boolean {
  return mode !== 'working' && mode !== 'executing' && mode !== 'blocked';
}

/**
 * Map the DECLARED message register onto the narration trust tier — the
 * promotion key. A 🏁-declared verdict and ⚠️-declared hazard become the
 * promoted kinds (they rank in the deliberate tier, and a declared hazard feeds
 * the chain-surfacing boost); everything else stays the priority-last backstop.
 * 'working'/'executing'/'blocked' never reach harvest (isNarrationEligibleGlyph excludes
 * them upstream), so in practice this only ever sees 'verdict'/'hazard'/
 * undefined — but it stays total so the kind taxonomy has one authority.
 */
export function narrationKindForGlyph(mode: MessageGlyphMode | undefined): EpisodeAnnotationKind {
  if (mode === 'verdict') return 'narration:verdict';
  if (mode === 'hazard') return 'narration:hazard';
  return 'narration';
}

/**
 * Does this episode's voice imply a gotcha for chain-surfacing? A pinned gotcha
 * star OR a ⚠️-DECLARED hazard ('narration:hazard') — both are deliberate
 * "beware, resurface this" acts, so both earn the chainScore GOTCHA_BOOST. A 🏁
 * verdict deliberately does NOT (it mirrors star:result, which also does not
 * boost which chains surface). Exported so the handler's hasGotcha derivation
 * and its parity test share one authority.
 */
export function annotationsImplyGotcha(annotations: readonly EpisodeAnnotation[]): boolean {
  return annotations.some((a) => a.kind === 'star:gotcha' || a.kind === 'narration:hazard');
}

/**
 * Deterministic narration filter over assistant prose. By default it applies
 * the lexical verdict opener gate — the SHAPE half of the untagged narration
 * AND-gate (the POSITION half lives in foldEpisodeCapture). Callers may disable
 * only that opener gate for DECLARED 🏁/⚠️ messages, where the glyph is already
 * the trust signal; synthetic/card-quote rejection, length bounds, and question
 * rejection still apply. Zero LLM, byte-identical for identical inputs, so
 * episodic re-derivation stays idempotent. isSyntheticLine is dependency-
 * injected (this module imports nothing — same idiom as
 * extractEpisodeMentionPaths): callers pass rollingFold's isSyntheticContextText
 * so quoted fold/recall/episodic blocks are never laundered into voice.
 */
export function extractNarrationLines(
  text: string,
  isSyntheticLine: (line: string) => boolean,
  cap = NARRATION_MAX_LINES,
  options?: { requireVerdictShape?: boolean },
): string[] {
  if (!text) return [];
  const requireVerdictShape = options?.requireVerdictShape ?? true;
  const out: string[] = [];
  let inCodeBlock = false;
  for (const rawLine of text.split('\n')) {
    if (out.length >= cap) break;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock || trimmed.length === 0) continue;
    if (isSyntheticLine(trimmed) || NARRATION_QUOTED_VOICE_RE.test(trimmed) || NARRATION_NONVERDICT_LINE_RE.test(trimmed)) continue;
    const stripped = trimmed.replace(NARRATION_DECORATION_RE, '');
    if (stripped.length < NARRATION_MIN_LINE_CHARS || stripped.length > NARRATION_MAX_LINE_CHARS) continue;
    if (stripped.endsWith('?')) continue;
    if (requireVerdictShape && !NARRATION_VERDICT_RE.test(stripped)) continue;
    out.push(truncateVerbatim(stripped, VOICE_TEXT_CAP_CHARS));
  }
  return out;
}

function parseTsMs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ISO timestamp → compact deterministic display form (YYYY-MM-DD HH:mm). */
export function formatEpisodeDate(iso: string): string {
  if (iso.length >= 16 && iso.charAt(10) === 'T') return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  return iso.slice(0, 16);
}

function episodeEventRange(episode: Episode): { first: number; last: number } {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const member of episode.members) {
    if (member.firstSeen < first) first = member.firstSeen;
    if (member.lastSeen > last) last = member.lastSeen;
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return { first: 0, last: 0 };
  return { first, last };
}

/**
 * Deterministic burst grouping. A new touch seals the current burst when the
 * event-index gap exceeds gapEvents, the wall-clock gap exceeds gapMs (only
 * when both timestamps parse), an agent-declared star:pivot falls between the
 * two touches, OR the current burst has already SPANNED past maxBurstEvents
 * events / maxBurstMs wall-clock from its FIRST touch (the force-split cap that
 * stops a continuous run from forming one perpetually-open, never-sealing
 * burst). When voiceFloor is enabled, a burst that would seal on gap/pivot
 * alone is held open until it contains at least one voice event (from
 * voiceEventIndexes), UNLESS force-split fires. Members are aggregated per path
 * with the strongest touch kind; when trimming to memberCap, edits are
 * prioritized, then touch volume.
 */
export function groupTouchesIntoEpisodes(
  touches: readonly EpisodeTouch[],
  opts: EpisodeGroupingOptions = {},
): EpisodeBurst[] {
  const gapEvents = opts.gapEvents ?? DEFAULT_EPISODE_GROUPING.gapEvents;
  const gapMs = opts.gapMs ?? DEFAULT_EPISODE_GROUPING.gapMs;
  const memberCap = opts.memberCap ?? DEFAULT_EPISODE_GROUPING.memberCap;
  const maxBurstEvents = opts.maxBurstEvents ?? DEFAULT_EPISODE_GROUPING.maxBurstEvents;
  const maxBurstMs = opts.maxBurstMs ?? DEFAULT_EPISODE_GROUPING.maxBurstMs;
  const pivotIndexes = (opts.pivots ?? [])
    .map((pivot) => pivot.eventIndex)
    .sort((a, b) => a - b);
  const railSealIndexes = [...(opts.railSealEventIndexes ?? [])].sort((a, b) => a - b);

  // VOICE FLOOR: if enabled, a burst with zero voice annotations refuses to
  // seal on gap/pivot alone — it stays open until voice arrives or force-split
  // fires. This produces fewer, fatter episodes where each carries voice by
  // construction. The chunk boundary flexes to where voice actually is instead
  // of cutting before it arrives (the 54% voicelessness problem).
  const voiceFloor = opts.voiceFloor === true;
  const voiceIdxSet = voiceFloor && opts.voiceEventIndexes && opts.voiceEventIndexes.length > 0
    ? new Set(opts.voiceEventIndexes)
    : null;
  // INTENT VOICE: operator intent (the ask) sits BEFORE the burst's first touch
  // — it motivated the work. Annotation voice lives INSIDE [first, last]; intent
  // lives in the preceding gap, so we check a wider range [prevBurstEnd, last].
  const intentIdxSet = voiceFloor && opts.intentEventIndexes && opts.intentEventIndexes.length > 0
    ? new Set(opts.intentEventIndexes)
    : null;

  // VALUE FLOOR: when provided, a burst containing any valueFloorPath gets its
  // gapMs multiplied so high-value paths hold open longer. Multiplier ≤ 1 or
  // no valueFloorPaths = byte-identical (no effect on seal timing).
  const valueFloorSet = opts.valueFloorPaths && opts.valueFloorPaths.length > 0
    ? new Set(opts.valueFloorPaths)
    : null;
  const valueFloorMult = opts.valueFloorGapMultiplier ?? 1.5;

  // TAP-STAR FLOOR: when provided, a burst containing a deliberate operator pin
  // (star:decision/pivot/gotcha) holds open gapMs × tapStarFloorGapMultiplier
  // AND is never sealed voiceless. Omitting = byte-identical.
  const tapStarFloorSet = opts.tapStarFloorEventIndexes && opts.tapStarFloorEventIndexes.length > 0
    ? new Set(opts.tapStarFloorEventIndexes)
    : null;
  const tapStarFloorMult = opts.tapStarFloorGapMultiplier ?? 2.0;

  // AFFINITY FLOOR defaults
  const affinityGapThreshold = opts.affinityGapThreshold ?? 0.5;
  const affinityGapMult = opts.affinityGapMultiplier ?? 2.0;

  const sorted = touches
    .filter((touch) => isEpisodeMemberPath(touch.path))
    .sort(
      (a, b) => a.eventIndex - b.eventIndex || comparePaths(a.path, b.path) || TOUCH_KIND_RANK[b.kind] - TOUCH_KIND_RANK[a.kind],
    );

  // Helper: check whether the current burst has voice. Two channels:
  //  1. ANNOTATION voice (changelog/star/chat/narration): lives INSIDE [first, last]
  //  2. INTENT voice (operator's ask): lives in the gap BEFORE the burst, so we
  //     check [prevBurstEnd, last] — wider than annotations. Without this, 91.7%
  //     of voiceless bursts would still be held open despite carrying the operator's
  //     ask that motivated them.
  const burstHasVoice = (burstTouches: EpisodeTouch[], prevBurstEnd: number): boolean => {
    if (!voiceIdxSet && !intentIdxSet) return true; // no voice data → never hold
    const first = burstTouches[0]?.eventIndex ?? 0;
    const last = burstTouches[burstTouches.length - 1]?.eventIndex ?? 0;
    // Annotation voice: must be inside the burst's touch range
    if (voiceIdxSet) {
      for (const idx of voiceIdxSet) {
        if (idx >= first && idx <= last) return true;
      }
    }
    // Intent voice: check the wider range [prevBurstEnd, last] — the ask that
    // motivated this burst sits in the gap before its first touch.
    if (intentIdxSet) {
      for (const idx of intentIdxSet) {
        if (idx >= prevBurstEnd && idx <= last) return true;
      }
    }
    return false;
  };

  /** Check if any touch in the burst has an event index in the given set. */
  const burstHasEvent = (burstTouches: EpisodeTouch[], eventSet: Set<number>): boolean => {
    for (const t of burstTouches) {
      if (eventSet.has(t.eventIndex)) return true;
    }
    return false;
  };

  const bursts: EpisodeTouch[][] = [];
  let current: EpisodeTouch[] = [];
  let prevBurstEnd = 0; // End event index of the last sealed burst (for intent range)
  let pivotCursor = 0;
  let railSealCursor = 0;

  for (const touch of sorted) {
    const prev = current[current.length - 1];
    if (prev) {
      while (pivotCursor < pivotIndexes.length && pivotIndexes[pivotCursor] <= prev.eventIndex) pivotCursor++;
      const pivotBetween = pivotCursor < pivotIndexes.length && pivotIndexes[pivotCursor] <= touch.eventIndex;
      while (railSealCursor < railSealIndexes.length && railSealIndexes[railSealCursor] <= prev.eventIndex) railSealCursor++;
      const railSealBetween = railSealCursor < railSealIndexes.length && railSealIndexes[railSealCursor] <= touch.eventIndex;
      const eventGap = touch.eventIndex - prev.eventIndex;
      const prevMs = parseTsMs(prev.ts);
      const touchMs = parseTsMs(touch.ts);
      const msGap = prevMs !== undefined && touchMs !== undefined ? touchMs - prevMs : undefined;
      // VALUE FLOOR: if the current burst contains a value-floor path, widen
      // the time gap threshold so high-value bursts absorb more before sealing.
      // TAP-STAR FLOOR: if the burst contains a deliberate operator pin, widen
      // even further (tap-star multiplier > value multiplier by default).
      const hasValueFloor = valueFloorSet && valueFloorMult > 1
        && current.some((t) => valueFloorSet.has(t.path));
      const hasTapStarFloor = tapStarFloorSet && tapStarFloorMult > 1
        && burstHasEvent(current, tapStarFloorSet);
      // AFFINITY FLOOR: if any current-burst path has affinity ≥ threshold
      // with the incoming touch's path, widen the gap — the agent likely
      // stayed in the same conceptual zone.
      const hasAffinity = !!opts.affinityFloor
        && current.some((t) => {
          const neighbors = opts.affinityFloor![t.path];
          return neighbors && (neighbors[touch.path] ?? 0) >= affinityGapThreshold;
        });
      const effectiveGapMs = hasTapStarFloor
        ? gapMs * tapStarFloorMult
        : hasValueFloor
          ? gapMs * valueFloorMult
          : hasAffinity
            ? gapMs * affinityGapMult
            : gapMs;
      // FORCE-SPLIT: cap the SPAN of one uninterrupted burst, measured from its
      // FIRST touch (not prev). A continuous run never gaps, so without this it
      // never seals — its voice is dropped and the cursor parks. See
      // DEFAULT_EPISODE_GROUPING.maxBurst* for the live-regression rationale.
      const burstStart = current[0] ?? prev;
      const spanEvents = touch.eventIndex - burstStart.eventIndex;
      const burstStartMs = parseTsMs(burstStart.ts);
      const spanMs = burstStartMs !== undefined && touchMs !== undefined ? touchMs - burstStartMs : undefined;
      const spanExceeded = spanEvents > maxBurstEvents || (spanMs !== undefined && spanMs > maxBurstMs);

      const shouldSeal = eventGap > gapEvents || (msGap !== undefined && msGap > effectiveGapMs) || pivotBetween || railSealBetween || spanExceeded;

      if (shouldSeal) {
        // VOICE FLOOR GATE: if enabled and the burst about to seal has NO voice
        // (neither annotations nor intent), hold it open — UNLESS force-split
        // fires (can't grow indefinitely). The burst absorbs this touch and
        // stays open for voice.
        const hasVoiceData = voiceIdxSet !== null || intentIdxSet !== null;
        // Pivot/rail markers are explicit split boundaries; the voice floor must
        // never suppress them (else the boundary's own voice absorbs the next
        // burst). The closing burst still receives gap voice via
        // assignAnnotationsToBursts, so it is not left voiceless.
        if (hasVoiceData && !spanExceeded && !pivotBetween && !railSealBetween && !burstHasVoice(current, prevBurstEnd)) {
          // Don't seal — keep growing. The burst now spans into this touch's
          // territory, and will seal on the NEXT gap once voice arrives.
        } else {
          bursts.push(current);
          prevBurstEnd = current[current.length - 1]?.eventIndex ?? 0;
          current = [];
        }
      }
    }
    current.push(touch);
  }
  if (current.length > 0) bursts.push(current);

  return bursts.map((burstTouches) => assembleBurst(burstTouches, memberCap));
}

function assembleBurst(burstTouches: readonly EpisodeTouch[], memberCap: number): EpisodeBurst {
  const byPath = new Map<string, EpisodeMember>();
  for (const touch of burstTouches) {
    const existing = byPath.get(touch.path);
    if (existing) {
      existing.touchCount += 1;
      if (TOUCH_KIND_RANK[touch.kind] > TOUCH_KIND_RANK[existing.touchKind]) existing.touchKind = touch.kind;
      if (touch.eventIndex < existing.firstSeen) existing.firstSeen = touch.eventIndex;
      if (touch.eventIndex > existing.lastSeen) existing.lastSeen = touch.eventIndex;
    } else {
      byPath.set(touch.path, {
        path: touch.path,
        touchKind: touch.kind,
        touchCount: 1,
        firstSeen: touch.eventIndex,
        lastSeen: touch.eventIndex,
      });
    }
  }

  let members = Array.from(byPath.values());
  if (members.length > memberCap) {
    members = members
      .sort(
        (a, b) =>
          TOUCH_KIND_RANK[b.touchKind] - TOUCH_KIND_RANK[a.touchKind]
          || b.touchCount - a.touchCount
          || a.firstSeen - b.firstSeen
          || comparePaths(a.path, b.path),
      )
      .slice(0, memberCap);
  }
  members.sort((a, b) => a.firstSeen - b.firstSeen || comparePaths(a.path, b.path));

  const first = burstTouches[0];
  const last = burstTouches[burstTouches.length - 1];
  const startedAt = first?.ts;
  const endedAt = last?.ts ?? startedAt;
  return {
    startEventIndex: first?.eventIndex ?? 0,
    endEventIndex: last?.eventIndex ?? 0,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    touchTotal: burstTouches.length,
    members,
  };
}

/**
 * Assign annotations (carrying source event indexes) to bursts. An annotation
 * inside a burst's event range belongs to that burst; one falling in a gap
 * attaches to the PRECEDING burst (it is the closing thought of that chapter
 * — pivot stars sealing a burst land on the chapter they ended); anything
 * before the first burst attaches to the first. Returns one annotation array
 * per burst, chronological by event index.
 */
export function assignAnnotationsToBursts(
  bursts: readonly EpisodeBurst[],
  annotated: readonly { eventIndex: number; annotation: EpisodeAnnotation }[],
): EpisodeAnnotation[][] {
  const result: EpisodeAnnotation[][] = bursts.map(() => []);
  if (bursts.length === 0) return result;
  const sorted = [...annotated].sort((a, b) => a.eventIndex - b.eventIndex);
  for (const { eventIndex, annotation } of sorted) {
    let target = 0;
    for (let i = 0; i < bursts.length; i++) {
      if (eventIndex >= bursts[i].startEventIndex) target = i;
      else break;
    }
    result[target].push(annotation);
  }
  return result;
}

function renderStructuralStep(step: TraceStep): string {
  let token = step.target ? `${step.tool}(${step.target})` : step.tool;
  if (step.outcome) {
    token += ` ${step.outcome === 'ok' ? '✓' : '✗'}${step.detail ?? ''}`;
  } else if (step.detail) {
    token += `("${step.detail}")`;
  }
  return token;
}

function renderVoiceInline(annotation: EpisodeAnnotation): string {
  const text = truncateVerbatim(annotation.text, TRACE_VOICE_TEXT_CAP_CHARS);
  if (annotation.kind.startsWith('star:')) return `⭐${annotation.kind.slice(5)}:"${text}"`;
  if (annotation.kind === 'changelog') return `✎:"${text}"`;
  if (annotation.kind.startsWith('narration')) return `🗣:"${text}"`;
  if (annotation.kind === 'rail') return `🛤:"${text}"`;
  return `💬:"${text}"`;
}

function structuralKey(step: TraceStep): string {
  return `${step.tool}\u0000${step.target ?? ''}`;
}

function fullKey(step: TraceStep): string {
  return `${structuralKey(step)}\u0000${step.outcome ?? ''}\u0000${step.detail ?? ''}`;
}

/**
 * Structural-verbatim branch trace: the exact sequence of real actions with
 * real targets and real outcomes, bodies stripped. `Tool(target) → outcome`
 * tokens joined by ` → `, with run-length collapse (identical consecutive
 * steps → `×N`) and edit⇄check loop collapse (alternating A·B pairs →
 * `[A ⇄ B ×N → final]`). Voice steps render inline at their chronological
 * position, verbatim. Over-cap traces elide from the MIDDLE — the opening
 * move and the final outcome are the load-bearing ends.
 */
export function buildBranchTrace(steps: readonly TraceStep[], capChars = BRANCH_TRACE_CAP_CHARS): string {
  if (steps.length === 0) return '';

  interface Token { text: string; voice: boolean }
  const tokens: Token[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (step.voice) {
      tokens.push({ text: renderVoiceInline(step.voice), voice: true });
      i += 1;
      continue;
    }

    // Loop collapse: A B A B [A B ...] where A and B are structural and the
    // pattern repeats at least twice. Final B carries the loop's outcome.
    if (i + 3 < steps.length) {
      const a = steps[i];
      const b = steps[i + 1];
      if (!b.voice && structuralKey(steps[i + 2]) === structuralKey(a) && !steps[i + 2].voice
        && i + 3 < steps.length && structuralKey(steps[i + 3]) === structuralKey(b) && !steps[i + 3].voice) {
        let pairs = 2;
        let end = i + 4;
        while (end + 1 < steps.length
          && !steps[end].voice && !steps[end + 1].voice
          && structuralKey(steps[end]) === structuralKey(a)
          && structuralKey(steps[end + 1]) === structuralKey(b)) {
          pairs += 1;
          end += 2;
        }
        const lastB = steps[end - 1];
        const finalMark = lastB.outcome ? `${lastB.outcome === 'ok' ? '✓' : '✗'}${lastB.detail ?? ''}` : '·';
        const aToken = a.target ? `${a.tool}(${a.target})` : a.tool;
        const bToken = b.target ? `${b.tool}(${b.target})` : b.tool;
        tokens.push({ text: `[${aToken} ⇄ ${bToken} ×${pairs} → ${finalMark}]`, voice: false });
        i = end;
        continue;
      }
    }

    // Run-length collapse on fully identical consecutive steps.
    let run = 1;
    while (i + run < steps.length && !steps[i + run].voice && fullKey(steps[i + run]) === fullKey(step)) run += 1;
    const rendered = renderStructuralStep(step);
    tokens.push({ text: run > 1 ? `${rendered} ×${run}` : rendered, voice: false });
    i += run;
  }

  const join = (parts: readonly Token[]): string => parts.map((t) => t.text).join(' → ');
  if (join(tokens).length <= capChars) return join(tokens);

  // Middle elision: drop tokens nearest the center until under cap, then mark.
  const working = [...tokens];
  let dropped = 0;
  while (working.length > 2) {
    const mid = Math.floor(working.length / 2);
    working.splice(mid, 1);
    dropped += 1;
    const marker = ` → … ⟨${dropped} steps⟩ … → `;
    const head = working.slice(0, Math.ceil(working.length / 2));
    const tail = working.slice(Math.ceil(working.length / 2));
    const candidate = `${join(head)}${marker}${join(tail)}`;
    if (candidate.length <= capChars) return candidate;
  }
  return truncateVerbatim(join(working), capChars);
}

/**
 * One-line episode header. Fallback chain (most-verbatim first):
 * changelog heads → star result/decision notes → rail step/title words →
 * narration verdict lines → top member paths.
 */
export function deriveEpisodeSummary(
  input: {
    annotations?: readonly EpisodeAnnotation[];
    railTitle?: string;
    members: readonly EpisodeMember[];
  },
  capChars = SUMMARY_CAP_CHARS,
): string {
  const changelogs = (input.annotations ?? []).filter((a) => a.kind === 'changelog');
  if (changelogs.length > 0) {
    const head = changelogs[0].text.split('\n')[0].trim();
    if (head.length > 0) return truncateVerbatim(head, capChars);
  }
  const starResults = (input.annotations ?? []).filter((a) => a.kind === 'star:result' || a.kind === 'star:decision');
  if (starResults.length > 0) {
    const head = starResults[0].text.split('\n')[0].trim();
    if (head.length > 0) return truncateVerbatim(head, capChars);
  }
  if (input.railTitle && input.railTitle.trim().length > 0) {
    return truncateVerbatim(input.railTitle.trim(), capChars);
  }
  const narrationLines = (input.annotations ?? []).filter((a) => a.kind.startsWith('narration'));
  if (narrationLines.length > 0) {
    // Prefer the DECLARED line (hazard/verdict outrank untagged in
    // ANNOTATION_PRIORITY) so a commentary-only episode's headline is the
    // agent's declared conclusion, not whichever prose line happened first.
    const best = [...narrationLines].sort(
      (a, b) => ANNOTATION_PRIORITY[a.kind] - ANNOTATION_PRIORITY[b.kind],
    )[0];
    const head = best.text.split('\n')[0].trim();
    if (head.length > 0) return truncateVerbatim(head, capChars);
  }
  const byPriority = [...input.members].sort(
    (a, b) =>
      TOUCH_KIND_RANK[b.touchKind] - TOUCH_KIND_RANK[a.touchKind]
      || b.touchCount - a.touchCount
      || comparePaths(a.path, b.path),
  );
  const names = byPriority.slice(0, 3).map((m) => {
    const base = m.path.split('/').pop() ?? m.path;
    return m.touchKind === 'edit' ? `${base}*` : base;
  });
  const extra = input.members.length > 3 ? ` (+${input.members.length - 3})` : '';
  return truncateVerbatim(`${names.join(', ')}${extra}`, capChars);
}

/**
 * Pick ≤max voice inlays for card rendering. Priority: gotcha (the landmine
 * map) > decision > pivot > result > discovery > handoff > changelog > chat
 * > narration; ties break chronologically. Display order is chronological.
 */
export function selectVoiceInlays(
  annotations: readonly EpisodeAnnotation[],
  max = 2,
): EpisodeAnnotation[] {
  const chosen = [...annotations]
    .sort(
      (a, b) =>
        ANNOTATION_PRIORITY[a.kind] - ANNOTATION_PRIORITY[b.kind]
        || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)
        || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
    )
    .slice(0, Math.max(0, max));
  chosen.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return chosen;
}

/**
 * Per-line timestamp for a voice line. Every annotation carries its own `ts`
 * (the moment the agent wrote it), so a card's voice lines form a real
 * intra-episode timeline instead of all inheriting the header's endedAt — a
 * gotcha said near the start of a burst is stamped earlier than the changelog
 * that closed it. The stamp is a SUFFIX, never a prefix: the card glyph must
 * stay line-leading so NARRATION_QUOTED_VOICE_RE (which rejects only lines that
 * OPEN with a card glyph) keeps catching recalled voice as quoted memory — a
 * leading date would defeat that self-excitation guard. formatEpisodeDate is a
 * pure deterministic slice, so byte-identical output is preserved; legacy rows
 * with an absent/unparseable ts simply render with no suffix.
 */
function voiceTimeSuffix(annotation: EpisodeAnnotation): string {
  const stamp = annotation.ts ? formatEpisodeDate(annotation.ts) : '';
  return stamp ? ` ${stamp}` : '';
}

/**
 * Attribution context: the caller's own-lineage instance-id set and friendly
 * display name. Threaded into card rendering so every voice line and foreign
 * chapter can be labeled with WHO authored it — the identity-bleed guard for
 * cross-lineage recall.
 */
type AttributionOpts = Pick<ChainCardOptions, 'ownLineage' | 'selfName'>;

/**
 * Voice/identity attribution label for an episode, or '' when attribution is
 * inactive. Attribution activates only when the caller supplies identity
 * context (selfName or ownLineage); with neither, voice renders bare (legacy
 * single-agent backward-compat — byte-identical output). When active: a
 * persisted authorName wins; else own-lineage voice takes the caller's friendly
 * selfName; foreign (or unnamed-own) voice takes the stable lineageRoot,
 * falling back to the rotating instanceId. Always returns a non-empty label
 * once active, so a foreign voice can never silently read as the caller's own.
 */
function episodeAuthorLabel(episode: Episode, opts: AttributionOpts): string {
  if (opts.selfName === undefined && opts.ownLineage === undefined) return '';
  if (episode.authorName) return episode.authorName;
  const isOwn = !opts.ownLineage || opts.ownLineage.has(episode.instanceId);
  if (isOwn) return opts.selfName ?? episode.lineageRoot ?? episode.instanceId;
  return episode.lineageRoot ?? episode.instanceId;
}

/** True when a chapter's author is outside the caller's own lineage. */
function isForeignChapter(episode: Episode, opts: Pick<ChainCardOptions, 'ownLineage'>): boolean {
  return opts.ownLineage !== undefined && !opts.ownLineage.has(episode.instanceId);
}

function filterSelfLineageChapters(
  chapters: readonly Episode[],
  opts: Pick<ChainCardOptions, 'ownLineage' | 'selfLineageOnly'>,
): Episode[] {
  if (opts.selfLineageOnly !== true) return [...chapters];
  return chapters.filter((chapter) => !isForeignChapter(chapter, opts));
}

function renderVoiceLine(annotation: EpisodeAnnotation, label: string): string {
  const text = truncateVerbatim(annotation.text, VOICE_TEXT_CAP_CHARS);
  const at = voiceTimeSuffix(annotation);
  const who = label ? ` ${label}` : '';
  if (annotation.kind.startsWith('star:')) return `  ⭐${who}${who ? ' ' : ''}${annotation.kind.slice(5)}:"${text}"${at}`;
  if (annotation.kind === 'changelog') return `  ✎${who}:"${text}"${at}`;
  if (annotation.kind.startsWith('narration')) return `  🗣${who}:"${text}"${at}`;
  if (annotation.kind === 'rail') return `  🛤${who}:"${text}"${at}`;
  return `  💬${who}:"${text}"${at}`;
}

/**
 * Compact pre-rendered voice lines for one episode, for the unified fold-recall
 * card. Reuses the EXISTING selectVoiceInlays + episodeAuthorLabel +
 * renderVoiceLine chain so glyph/attribution/timestamp rendering is byte-identical
 * to full chain cards. Returns voice lines only (no members/trace/deltas — those
 * live in the fold-recall card body already). The intent anchor is returned
 * separately so the caller can place it on the EpisodeVoice without re-parsing.
 *
 * Pure CPU: no I/O, no ambient reads. Safe from worker handlers and pure tests.
 */
export function renderEpisodeVoiceLines(
  episode: Episode,
  opts: Pick<ChainCardOptions, 'ownLineage' | 'selfName'>,
  maxLines = 2,
): { voiceLines: string[]; intent: string | null } {
  const voiceLabel = episodeAuthorLabel(episode, opts);
  const voiceLines = selectVoiceInlays(episode.annotations, maxLines).map((inlay) =>
    renderVoiceLine(inlay, voiceLabel),
  );
  const intent = episode.intent ?? null;
  return { voiceLines, intent };
}

function renderMembersLine(episode: Episode): string {
  const rendered = episode.members.map((m) => (m.touchKind === 'edit' ? `${m.path}*` : m.path));
  return `  members: ${rendered.join(', ')}`;
}

/** Pointer into the full verbatim record — exactness is reachable, not resident. */
export function formatPointerLine(episode: Episode): string {
  const range = episodeEventRange(episode);
  return `  ⌖ verbatim: ${episode.instanceId} events ${range.first}..${range.last}`;
}

function renderChapterBody(
  episode: Episode,
  sinceDeltas: readonly string[],
  maxVoiceInlays: number,
  voiceLabel: string,
): string[] {
  const lines: string[] = [];
  // Operator-ask anchor first: the "why" the burst happened, above the structural
  // members/trace. Hot + full-previous chapters render full bodies so both surface
  // it; warm/cold collapse to one-liners and never reach here. Guarded so episodes
  // with no mined ask (agent-initiated / legacy) stay byte-identical to before.
  if (episode.intent) lines.push(`  ↳ ask:"${truncateVerbatim(episode.intent, INTENT_TEXT_CAP_CHARS)}"`);
  lines.push(renderMembersLine(episode));
  if (episode.trace.length > 0) lines.push(`  trace: ${episode.trace}`);
  for (const inlay of selectVoiceInlays(episode.annotations, maxVoiceInlays)) {
    lines.push(renderVoiceLine(inlay, voiceLabel));
  }
  for (const delta of sinceDeltas) {
    lines.push(`  Δ ${delta}`);
  }
  return lines;
}

function warmLine(episode: Episode, opts: AttributionOpts): string {
  const peer = isForeignChapter(episode, opts) ? ` (peer ${episodeAuthorLabel(episode, opts)})` : '';
  return `  prev ${formatEpisodeDate(episode.endedAt)}${peer}: "${truncateVerbatim(episode.summary, HEADER_SUMMARY_CAP_CHARS)}"`;
}

function fullPreviousChapterLines(episode: Episode, maxVoiceInlays: number, opts: AttributionOpts): string[] {
  const voiceLabel = episodeAuthorLabel(episode, opts);
  const lines = [`  prev full ${formatEpisodeDate(episode.endedAt)}: "${truncateVerbatim(episode.summary, HEADER_SUMMARY_CAP_CHARS)}"`];
  if (isForeignChapter(episode, opts)) lines.push(`  ↞ from ${voiceLabel} (peer lineage)`);
  lines.push(...renderChapterBody(episode, [], maxVoiceInlays, voiceLabel));
  return lines;
}

/**
 * Render a chain card: the file's biography. Chapters arrive ascending by
 * endedAt (hot = last). HOT renders full (header + members + trace + voice +
 * since-then deltas), optional full previous chapters render body detail,
 * WARM (previous `warmCount`) render one-liners, and COLD collapses to one
 * line. Bookends (session-adjacent one-liners, resolved at recall) render
 * after the hot chapter. The card ALWAYS ends with the pointer line into full
 * verbatim; budget enforcement never sacrifices it.
 */
export function formatChainCard(
  chapters: readonly Episode[],
  targetPath: string,
  sinceDeltas: readonly string[],
  opts: ChainCardOptions = {},
): string {
  if (chapters.length === 0) return '';
  const visibleChapters = filterSelfLineageChapters(chapters, opts);
  if (visibleChapters.length === 0) return '';
  const budget = opts.charBudget ?? CHAIN_CARD_DEFAULT_BUDGET_CHARS;
  const maxVoice = opts.maxVoiceInlays ?? 2;
  const warmCount = Math.max(0, Math.floor(opts.warmCount ?? 2));
  const fullPreviousCount = Math.max(0, Math.floor(opts.fullPreviousCount ?? 0));

  const ordered = visibleChapters.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));
  const hot = ordered[ordered.length - 1];
  const fullPreviousStart = Math.max(0, ordered.length - 1 - fullPreviousCount);
  const fullPrevious = ordered.slice(fullPreviousStart, ordered.length - 1).reverse();
  const warmEnd = fullPreviousStart;
  const warm = ordered.slice(Math.max(0, warmEnd - warmCount), warmEnd).reverse();
  const cold = ordered.slice(0, Math.max(0, warmEnd - warmCount));

  const hotLabel = episodeAuthorLabel(hot, opts);
  const header = `[Episode recall ${targetPath} — ${formatEpisodeDate(hot.endedAt)}, "${truncateVerbatim(hot.summary, HEADER_SUMMARY_CAP_CHARS)}"]`;
  const body = [
    ...(isForeignChapter(hot, opts) ? [`  ↞ from ${hotLabel} (peer lineage)`] : []),
    ...renderChapterBody(hot, sinceDeltas, maxVoice, hotLabel),
  ];

  const bookendLines: string[] = [];
  if (opts.bookends?.before) bookendLines.push(`  ↞ before: ${opts.bookends.before}`);
  if (opts.bookends?.after) bookendLines.push(`  after: ↠ ${opts.bookends.after}`);

  const fullPreviousLines = fullPrevious.map((episode) => fullPreviousChapterLines(episode, maxVoice, opts));
  const warmLines = warm.map((episode) => warmLine(episode, opts));
  const coldLine = cold.length > 0
    ? `  older: ${cold.length} chapter${cold.length === 1 ? '' : 's'} ${formatEpisodeDate(cold[0].endedAt)} → ${formatEpisodeDate(cold[cold.length - 1].endedAt)}`
    : undefined;

  const pointer = formatPointerLine(hot);

  // Assembly order: header, hot body, bookends, full previous, warm, cold, pointer.
  // Budget degradation order (drop first): cold line → warm lines (oldest
  // first) → full previous bodies (oldest first) → delta lines (last first) →
  // bookends → trim trace. Pointer and header are never dropped.
  const assemble = (parts: {
    body: string[]; bookends: string[]; fullPrevious: string[][]; warms: string[]; cold?: string;
  }): string => [
    header,
    ...parts.body,
    ...parts.bookends,
    ...parts.fullPrevious.flat(),
    ...parts.warms,
    ...(parts.cold ? [parts.cold] : []),
    pointer,
  ].join('\n');

  const state = {
    body: [...body],
    bookends: [...bookendLines],
    fullPrevious: fullPreviousLines.map((lines) => [...lines]),
    warms: [...warmLines],
    cold: coldLine,
  };
  let rendered = assemble(state);
  if (rendered.length <= budget) return rendered;

  if (state.cold) { state.cold = undefined; rendered = assemble(state); if (rendered.length <= budget) return rendered; }
  while (state.warms.length > 0 && rendered.length > budget) {
    state.warms.pop();
    rendered = assemble(state);
  }
  if (rendered.length <= budget) return rendered;
  while (state.fullPrevious.length > 0 && rendered.length > budget) {
    state.fullPrevious.pop();
    rendered = assemble(state);
  }
  if (rendered.length <= budget) return rendered;
  while (rendered.length > budget && state.body.some((line) => line.startsWith('  Δ '))) {
    for (let idx = state.body.length - 1; idx >= 0; idx--) {
      if (state.body[idx].startsWith('  Δ ')) { state.body.splice(idx, 1); break; }
    }
    rendered = assemble(state);
  }
  if (rendered.length <= budget) return rendered;
  if (state.bookends.length > 0) { state.bookends = []; rendered = assemble(state); if (rendered.length <= budget) return rendered; }
  const traceIdx = state.body.findIndex((line) => line.startsWith('  trace: '));
  if (traceIdx >= 0) {
    const overhead = rendered.length - state.body[traceIdx].length;
    const room = Math.max('  trace: '.length + 8, budget - overhead);
    state.body[traceIdx] = truncateVerbatim(state.body[traceIdx], room);
    rendered = assemble(state);
  }
  return rendered;
}

/**
 * Render a walk-promotion card: an OLDER chapter served because the agent
 * stayed engaged with the zone (attention-metered paging). Same body grammar
 * as the hot card, with an explicit walking-back header carrying the chain
 * position so the agent knows where the cursor is.
 */
export function formatWalkPromotionCard(
  chapter: Episode,
  position: WalkPosition,
  sinceDeltas: readonly string[],
  opts: Pick<ChainCardOptions, 'charBudget' | 'maxVoiceInlays' | 'ownLineage' | 'selfName' | 'selfLineageOnly'> & {
    /**
     * Origin-anchored breadcrumb trail (nearest waypoint → … → origin).
     * Optional and additive: absent ⇒ byte-identical pre-breadcrumb grammar.
     */
    spines?: readonly WalkSpineCitation[];
  } = {},
): string {
  if (opts.selfLineageOnly === true && isForeignChapter(chapter, opts)) return '';
  const budget = opts.charBudget ?? CHAIN_CARD_DEFAULT_BUDGET_CHARS;
  const maxVoice = opts.maxVoiceInlays ?? 2;
  const label = episodeAuthorLabel(chapter, opts);
  const header = `[Episode recall — walking back, chapter ${position.index}/${position.total}, ${formatEpisodeDate(chapter.endedAt)}, "${truncateVerbatim(chapter.summary, HEADER_SUMMARY_CAP_CHARS)}"]`;
  const body = [
    ...(isForeignChapter(chapter, opts) ? [`  ↞ from ${label} (peer lineage)`] : []),
    ...(opts.spines && opts.spines.length > 0
      ? opts.spines.map((crumb) => formatBreadcrumb(chapter, crumb))
      : []),
    ...renderChapterBody(chapter, sinceDeltas, maxVoice, label),
  ];
  const pointer = formatPointerLine(chapter);

  const assemble = (bodyLines: string[]): string => [header, ...bodyLines, pointer].join('\n');
  const state = [...body];
  let rendered = assemble(state);
  while (rendered.length > budget && state.some((line) => line.startsWith('  Δ '))) {
    for (let idx = state.length - 1; idx >= 0; idx--) {
      if (state[idx].startsWith('  Δ ')) { state.splice(idx, 1); break; }
    }
    rendered = assemble(state);
  }
  if (rendered.length <= budget) return rendered;
  const traceIdx = state.findIndex((line) => line.startsWith('  trace: '));
  if (traceIdx >= 0) {
    const overhead = rendered.length - state[traceIdx].length;
    const room = Math.max('  trace: '.length + 8, budget - overhead);
    state[traceIdx] = truncateVerbatim(state[traceIdx], room);
    rendered = assemble(state);
  }
  return rendered;
}

/**
 * Render one breadcrumb on a walk card. The trail anchors to two FIXED poles —
 * NOW (the served chapter, named in the card header) and ORIGIN (the true chain
 * root) — with optional log-spaced waypoints between. Every line is
 * self-describing: a waypoint announces its distance-back ("4 back"), the origin
 * announces itself ("origin"), and both carry a time delta — so an AI consumer
 * never has to reverse-engineer the walk axis (the exact failure this whole
 * change fixes). The gist is ALWAYS inline, so a breadcrumb delivers its value
 * with zero tool calls; only the origin carries a `| reopen:` pointer for
 * optional deep-dive. Waypoints are view-only (compact, no pointer).
 */
function formatBreadcrumb(current: Episode, crumb: WalkSpineCitation): string {
  const delta = formatRelativeWalkDelta(current.endedAt, crumb.chapter.endedAt);
  const gist = nonDegenerateGist(crumb.chapter);
  if (crumb.kind === 'origin') {
    const pointer = formatPointerLine(crumb.chapter).replace(/^  ⌖ verbatim: /, '');
    const prefix = `  ↞ origin [${delta}] `;
    const suffix = ` | reopen: ${pointer}`;
    const room = Math.max(1, 180 - prefix.length - suffix.length);
    return `${prefix}${truncateVerbatim(gist, room)}${suffix}`;
  }
  const role = crumb.label ?? walkSpineRole(crumb.chapter);
  const back = crumb.backDistance ?? 0;
  const prefix = `  ↳ ${back} back [${delta}] ${role}: `;
  const room = Math.max(1, 160 - prefix.length);
  return `${prefix}${truncateVerbatim(gist, room)}`;
}

/** Annotation-derived role for a waypoint (the origin is labeled by kind, not here). */
function walkSpineRole(chapter: Episode): string {
  if (chapter.annotations.some((a) => a.kind === 'star:gotcha' || a.kind === 'narration:hazard')) return 'gotcha';
  if (chapter.annotations.some((a) => a.kind === 'star:pivot')) return 'pivot';
  if (chapter.annotations.some((a) => a.kind === 'star:decision')) return 'decision';
  return 'context';
}

/**
 * A breadcrumb's value is its inline gist, so it must never render a dead line.
 * A chapter's raw summary is sometimes degenerate — empty, or a bare path/file
 * list like "foldEpisodes.ts, foldEpisodes.test.ts (+5)" — which tells an AI
 * reader nothing about what the chapter was. When that happens, fall back to the
 * chapter's strongest agent-authored annotation prose (ANNOTATION_PRIORITY
 * order: gotcha/decision/pivot/result/discovery/handoff ahead of declared
 * hazard/verdict, then changelog/chat/untagged narration). Last resort: the raw
 * summary itself (a path list still beats an empty line).
 */
function nonDegenerateGist(chapter: Episode): string {
  const summary = (chapter.summary ?? '').trim();
  if (summary && !isDegenerateGist(summary)) return summary;
  const best = chapter.annotations
    .filter((a) => typeof a.text === 'string' && a.text.trim().length > 0 && !isDegenerateGist(a.text))
    .sort((a, b) => ANNOTATION_PRIORITY[a.kind] - ANNOTATION_PRIORITY[b.kind])[0];
  if (best) return best.text.trim();
  return summary || '(no summary)';
}

/** A gist is degenerate when it is empty or reads as a bare path/file list (no prose). */
function isDegenerateGist(value: string): boolean {
  const text = value.trim();
  if (text.length === 0) return true;
  // Drop trailing more-counts like "(+5)" so they do not dilute the ratio.
  const tokens = text.split(/[,\s]+/).filter((t) => t.length > 0 && !/^\(\+?\d+\)?$/.test(t));
  if (tokens.length === 0) return true;
  const pathLike = tokens.filter(
    (t) => t.includes('/') || t.includes('\\') || /\.[a-z0-9]{1,6}$/i.test(t),
  ).length;
  return pathLike >= Math.ceil(tokens.length * 0.8);
}

function formatRelativeWalkDelta(currentIso: string, spineIso: string): string {
  const currentMs = Date.parse(currentIso);
  const spineMs = Date.parse(spineIso);
  if (!Number.isFinite(currentMs) || !Number.isFinite(spineMs)) return formatEpisodeDate(spineIso);
  const diffMs = spineMs - currentMs;
  const prefix = diffMs <= 0 ? 'T-' : 'T+';
  const absMs = Math.abs(diffMs);
  const dayMs = 24 * 3_600_000;
  if (absMs >= dayMs) return `${prefix}${Math.max(1, Math.round(absMs / dayMs))}d`;
  const hourMs = 3_600_000;
  if (absMs >= hourMs) return `${prefix}${Math.max(1, Math.round(absMs / hourMs))}h`;
  const minuteMs = 60_000;
  return `${prefix}${Math.max(1, Math.round(absMs / minuteMs))}m`;
}

// ══════════════════════════════════════════════════════════════════════
// Injection state — session-side breathing (stash, zone residency, ledger)
// ══════════════════════════════════════════════════════════════════════
//
// The recall worker is stateless; the SESSION owns the breathing rhythm.
// Because the tool boundary can never await the worker (event-loop GOD rule:
// the boundary is sync string work), recall runs on a one-boundary stagger —
// the STASH pattern (precedent: pendingFoldEpochStamp): boundary N fires
// foldEpisodes:recall void+swallowed; its .then parks the cards here; boundary
// N+1 injects them. A stash older than the TTL describes a context the agent
// has already moved past — dropped, counted as suppressed, never injected
// late. All helpers below are pure mutations of an explicit state object so
// the whole breathing cycle is unit-testable without a session.

/** How many boundaries a stashed recall result stays injectable (inclusive). */
export const EPISODIC_STASH_MAX_AGE_BOUNDARIES = 2;
/** Default sliding zone-residency TTL, in tool boundaries (mirrors fold-recall's 8-pass default). */
export const EPISODIC_ZONE_TTL_BOUNDARIES = 8;
/** Default per-boundary char budget for the episodic block (one breath). */
export const EPISODIC_DEFAULT_CHAR_BUDGET = 2000;
/** Default max distinct chains served per boundary. */
export const EPISODIC_DEFAULT_MAX_CHAINS = 2;
/** Default max active hot cards re-pinned while a zone is still being walked. */
export const EPISODIC_ACTIVE_PIN_DEFAULT_MAX_CARDS = 2;
/** Default active-path pin budget; small enough to stay as working memory. */
export const EPISODIC_ACTIVE_PIN_DEFAULT_CHAR_BUDGET = 1200;

/** Mirror of the worker's FoldEpisodesRecallCard (kept structural — this module imports nothing). */
export interface EpisodicRecallCardDebugLike {
  annotationBoost: number;
  annotationBoostKind?: EpisodeAnnotationKind;
  score?: number;
  observationalUtilityProxy?: number;
  observationalUtilityMultiplier?: number;
  baselineRank?: number;
  observationalShadowScore?: number;
  observationalShadowRank?: number;
}

export interface EpisodicRecallCardLike {
  targetPath: string;
  renderedCard: string;
  chapterIds: number[];
  memberPaths: string[];
  kind: 'chain' | 'walk' | 'mention' | 'pointer' | 'term' | 'rail';
  /** Optional worker-provided scoring trace; render-agnostic and safe to omit. */
  debug?: EpisodicRecallCardDebugLike;
}

export interface EpisodicZoneResidency {
  /** Boundary seq at which this zone expires (slides forward on re-engagement). */
  expiresAtBoundary: number;
  /**
   * Chapter ids served for this zone while resident — the attention walk's
   * served-set. Expiry deletes the zone record, which removes these ids from
   * the recall payload's servedChapterIds: the walk cursor RESETS, and the
   * next touch serves the hot chapter fresh instead of resuming the walk.
   */
  chapterIds: number[];
  /**
   * Byte-stable card headers currently known to remain provider-visible for
   * this zone. Boundary TTL is only a fallback for legacy/unreconciled state;
   * a visible card keeps its served cursor resident until a fold view proves
   * that header left POV.
   */
  visibleCardHeaders?: string[];
  /**
   * Hot/recent card to keep as logical working memory while the agent keeps
   * touching this zone. Walk/pointer cards do not replace it — they advance the
   * older-chapter cursor while the hot card remains the path anchor.
   */
  activeCard?: EpisodicRecallCardLike;
  // ── Value-ledger engagement signals (additive; absent → neutral/legacy) ──
  // Pure bookkeeping: populated on every inject/refresh even when the ledger is
  // disabled, so the data is always available; only TTL/re-pin READ them, and
  // only when the value-ledger config is enabled.
  /** Boundary at which this zone first became resident. */
  firstSeenBoundary?: number;
  /** Last boundary the zone's exact target path was (re)engaged by a touch. */
  lastEngagedBoundary?: number;
  /** Distinct engagement events: initial inject + each exact-path refresh. */
  engagementCount?: number;
  /** Strongest card kind seen for this zone (anchor-strength signal). */
  kind?: EpisodicRecallCardLike['kind'];
}

// ══════════════════════════════════════════════════════════════════════
// Episodic card VALUE LEDGER (rail-c16912c9)
// ══════════════════════════════════════════════════════════════════════
//
// Flat residency (every zone lives EPISODIC_ZONE_TTL_BOUNDARIES regardless of
// worth) treats a deeply-walked, currently-engaged zone exactly like an
// incidental one-touch. The value ledger scores each resident zone from signals
// it ALREADY carries (engagement recency/frequency, walk depth, anchor kind)
// plus optional host-fed MEASURED signals (claimed paths, rail target), then
// PRESERVES high-value zones longer and DROPS low-value ones sooner, and picks
// the most valuable cards first when the re-pin budget is tight.
//
// CACHE / EVENT-LOOP SAFETY: pure CPU, zero imports, zero ambient reads (module
// invariant — boundary distance is the only clock; no Date.now, no randomness).
// It only changes residency DECISIONS (how long a zone stays resident, which
// cards re-pin under budget); it never mutates already-sent tail bytes. Re-pin
// rides the existing excludeHeaderLines idempotency, so a card re-pastes only
// after its live copy has folded away — "preserve / re-pin at the fold epoch" is
// already wired, the ledger only makes that decision value-aware.
//
// ── Standalone knobs (host maps env → config; kill switch disables entirely) ──
//   enabled            master switch; false → exact flat-TTL behavior (byte-identical)
//   minTtlMultiplier   value=0 zones get baseTTL × this (drop sooner)
//   maxTtlMultiplier   value=1 zones get baseTTL × this (preserve longer)
//   repinInactive      re-pin a high-value zone NOT touched this boundary (default off)
//   repinValueFloor    min value for an inactive re-pin (only when repinInactive)
// Neutral value (0.5) maps to ×1.0 → unchanged TTL; only clearly high/low zones move.

/**
 * Measured prompt-pressure level (mirrors the host's ContextUtilizationLevel).
 * Kept as a LOCAL union so this module imports nothing — the host passes
 * measured token telemetry, never a character-derived estimate.
 */
export type EpisodicPressureLevel = 'healthy' | 'warning' | 'critical' | 'auto_compact';

/** Host-fed live signals for value scoring. All optional; absent = neutral. */
export interface EpisodicValueContext {
  /** Paths the agent currently holds a file claim on (active-engagement signal). */
  claimedPaths?: ReadonlySet<string>;
  /** Active rail target/scope paths, when the host can supply them cheaply. */
  railTargetPaths?: ReadonlySet<string>;
  /** Measured prompt pressure (never char-derived). Informational; not scored in v1. */
  pressure?: EpisodicPressureLevel;
}

/** Tunable weights + saturation points for the value score. */
export interface EpisodicValueWeights {
  recency: number;
  frequency: number;
  walkDepth: number;
  anchorKind: number;
  /** Additive bonus (NOT normalized) when the zone path is currently claimed. */
  claimed: number;
  /** Additive bonus (NOT normalized) when the zone path is an active rail target. */
  railTarget: number;
  /** Boundaries over which the recency component halves (engagement decay). */
  recencyHalfLifeBoundaries: number;
  /** engagementCount that saturates the frequency component. */
  frequencySaturation: number;
  /** Walk depth (chapterIds count) that saturates the depth component. */
  walkDepthSaturation: number;
}

export const DEFAULT_EPISODIC_VALUE_WEIGHTS: EpisodicValueWeights = {
  // Engagement components — normalized into the [0,1] base score.
  recency: 1,
  frequency: 0.8,
  walkDepth: 0.6,
  anchorKind: 0.8,
  // Host-signal BONUSES — added on top of the base, then clamped to 1.
  claimed: 0.25,
  railTarget: 0.25,
  recencyHalfLifeBoundaries: 6,
  frequencySaturation: 5,
  walkDepthSaturation: 4,
};

export interface EpisodicValueLedgerConfig {
  /** Master switch. false → exact flat-TTL, path-sorted touch-only re-pin (byte-identical). */
  enabled: boolean;
  /** baseTTL multiplier for value 0 (low-value zones drop sooner). */
  minTtlMultiplier: number;
  /** baseTTL multiplier for value 1 (high-value zones are preserved longer). */
  maxTtlMultiplier: number;
  /** Re-pin a high-value zone NOT touched this boundary (more aggressive; default off). */
  repinInactive: boolean;
  /** Minimum value for an inactive re-pin (only consulted when repinInactive). */
  repinValueFloor: number;
}

export const DEFAULT_EPISODIC_VALUE_LEDGER_CONFIG: EpisodicValueLedgerConfig = {
  enabled: true,
  minTtlMultiplier: 0.5,
  maxTtlMultiplier: 2,
  repinInactive: false,
  repinValueFloor: 0.6,
};

/** Bundled optional value-ledger args threaded into note/refresh/pin (absent → flat behavior). */
export interface EpisodicValueLedgerOptions {
  config?: EpisodicValueLedgerConfig;
  context?: EpisodicValueContext;
  weights?: EpisodicValueWeights;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/** Anchor strength by card kind: real work chains + rail targets are strongest. */
export function anchorKindScore(kind: EpisodicRecallCardLike['kind'] | undefined): number {
  switch (kind) {
    case 'chain':
    case 'rail':
      return 1;
    case 'mention':
      return 0.6;
    case 'walk':
      return 0.5;
    case 'pointer':
    case 'term':
      return 0.3;
    default:
      return 0.5;
  }
}

/** Stronger of two kinds by anchor score (a zone keeps its strongest-seen anchor). */
export function strongerEpisodicKind(
  a: EpisodicRecallCardLike['kind'] | undefined,
  b: EpisodicRecallCardLike['kind'],
): EpisodicRecallCardLike['kind'] {
  if (a === undefined) return b;
  return anchorKindScore(a) >= anchorKindScore(b) ? a : b;
}

/**
 * Pure value of a resident zone in [0,1]: a weighted blend of engagement recency
 * (decays by boundary distance), engagement frequency, walk depth, anchor kind,
 * and optional host signals (claimed path, rail target). Deterministic; no I/O,
 * no Date.now — boundary distance is the only clock.
 */
export function scoreEpisodicZoneValue(
  targetPath: string,
  zone: EpisodicZoneResidency,
  context: EpisodicValueContext = {},
  boundarySeq: number = zone.lastEngagedBoundary ?? 0,
  weights: EpisodicValueWeights = DEFAULT_EPISODIC_VALUE_WEIGHTS,
): number {
  const sinceEngaged = Math.max(0, boundarySeq - (zone.lastEngagedBoundary ?? boundarySeq));
  const recency = Math.pow(0.5, sinceEngaged / Math.max(1, weights.recencyHalfLifeBoundaries));
  const frequency = clamp01((zone.engagementCount ?? 1) / Math.max(1, weights.frequencySaturation));
  const walkDepth = clamp01((zone.chapterIds?.length ?? 0) / Math.max(1, weights.walkDepthSaturation));
  const anchor = anchorKindScore(zone.kind);
  // Base: normalized weighted blend of always-available engagement signals (0..1).
  const engagementWeight = weights.recency + weights.frequency + weights.walkDepth + weights.anchorKind;
  const base =
    engagementWeight > 0
      ? (weights.recency * recency +
          weights.frequency * frequency +
          weights.walkDepth * walkDepth +
          weights.anchorKind * anchor) /
        engagementWeight
      : 0;
  // Host signals are ADDITIVE bonuses so an unwired host (no claims/rail) still
  // gets the full base range instead of a deflated score.
  const claimedBonus = context.claimedPaths?.has(targetPath) ? weights.claimed : 0;
  const railBonus = context.railTargetPaths?.has(targetPath) ? weights.railTarget : 0;
  return clamp01(base + claimedBonus + railBonus);
}

/** TTL multiplier anchored so value 0.5 → ×1.0 (neutral/unchanged), 0 → min, 1 → max. */
export function episodicValueTtlMultiplier(value: number, config: EpisodicValueLedgerConfig): number {
  const v = clamp01(value);
  return v <= 0.5
    ? lerp(config.minTtlMultiplier, 1, v / 0.5)
    : lerp(1, config.maxTtlMultiplier, (v - 0.5) / 0.5);
}

/** Effective residency TTL for a zone given its value; flat baseTtl when disabled. */
export function effectiveEpisodicZoneTtl(
  baseTtlBoundaries: number,
  value: number,
  config: EpisodicValueLedgerConfig,
): number {
  if (!config.enabled) return baseTtlBoundaries;
  return Math.max(1, Math.round(baseTtlBoundaries * episodicValueTtlMultiplier(value, config)));
}

export interface EpisodicInjectionState {
  /** Injectable-boundary counter (declined/disabled boundaries do not advance it). */
  boundarySeq: number;
  /** Cards from the last fired recall, awaiting injection at the next boundary. */
  stash: { cards: EpisodicRecallCardLike[]; bornAtBoundary: number } | null;
  /** Zone targetPath → sliding residency window. */
  zones: Map<string, EpisodicZoneResidency>;
  /** Raw-history index after the last assistant-text mention scan. */
  mentionScanIndex: number;
  // ── Breathing-ledger lifetime counters ([<engine>-fold-episodes] log line) ──
  /** Touch-tier cards injected (kind chain/walk/pointer). */
  chainCardsInjected: number;
  /** Mention-tier hot cards injected (kind mention). */
  episodeCardsInjected: number;
  episodicChars: number;
  /** Stale stashes dropped (result outlived its context). */
  episodicSuppressed: number;
  /** Cards withheld because their substantive narrative already occupied provider POV. */
  episodicPovSuppressed: number;
  /** Boundaries where breathing paused entirely at critical pressure. */
  episodicSkippedAtPressure: number;
  /**
   * Active-path pin cards re-emitted as working memory while a zone stays live.
   * Deliberately separate from chainCardsInjected/episodicChars: pins re-page an
   * already-served hot card, so folding them into the served-set counters would
   * double-count. Bounded only by VOXXO_FOLD_EPISODES_PIN_BUDGET_CHARS.
   */
  episodicPinsInjected: number;
  /** Chars emitted via active-path pin blocks (NOT included in episodicChars). */
  episodicPinChars: number;
  /** Target paths whose completed-chain pointer was already shown during the current live zone. */
  completedChainTargetPaths: Set<string>;
  /** Exact card headers still believed to occupy the provider-visible context. */
  visibleCardHeaders: Set<string>;
  /**
   * Boundaries where the inhale + pin were skipped because a pure bookkeeping
   * tool dispatched (see isEpisodicBookkeepingTool). The exhale of already-earned
   * cards still runs on those boundaries — this counts only the suppressed NEW
   * fires, the noise-reduction signal for the bookkeeping-suppression A/B.
   */
  episodicBookkeepingSuppressed: number;
  /**
   * Read-boundary serve rate gate (see consumeEpisodicStashRateGated): gated-class
   * boundaries (read/search/other non-edit, non-rail-anchor tools) elapsed since
   * the last NEW-card serve. Edit and rail-anchor boundaries bypass the gate and
   * do not advance or reset this.
   */
  episodicGatedBoundariesSinceServe: number;
  /** Gated boundaries where a pending stash was HELD closed by the read-rate gate. */
  episodicRateHeld: number;
  /** Stash cards dropped by the one-new-card-per-open-boundary serve cap. */
  episodicRateTrimmed: number;
}

export function createEpisodicInjectionState(): EpisodicInjectionState {
  return {
    boundarySeq: 0,
    stash: null,
    zones: new Map(),
    mentionScanIndex: 0,
    chainCardsInjected: 0,
    episodeCardsInjected: 0,
    episodicChars: 0,
    episodicSuppressed: 0,
    episodicPovSuppressed: 0,
    episodicSkippedAtPressure: 0,
    episodicPinsInjected: 0,
    episodicPinChars: 0,
    completedChainTargetPaths: new Set(),
    visibleCardHeaders: new Set(),
    episodicBookkeepingSuppressed: 0,
    episodicGatedBoundariesSinceServe: 0,
    episodicRateHeld: 0,
    episodicRateTrimmed: 0,
  };
}

/**
 * Drop expired zones only after their exact cards have left provider POV.
 * Hosts reconcile visibleCardHeaders after each fold epoch; between epochs an
 * injected card remains visible even if its old boundary TTL elapses.
 */
export function expireEpisodicZones(state: EpisodicInjectionState): void {
  for (const [path, zone] of state.zones) {
    if (zone.expiresAtBoundary <= state.boundarySeq) {
      const remainsVisible = zone.visibleCardHeaders?.some((header) => state.visibleCardHeaders.has(header)) === true;
      if (remainsVisible) continue;
      state.zones.delete(path);
      state.completedChainTargetPaths.delete(path);
    }
  }
}

/** Union of live zones' served chapter ids — the recall payload's servedChapterIds. */
export function episodicServedChapterIds(state: EpisodicInjectionState): number[] {
  const ids = new Set<number>();
  for (const zone of state.zones.values()) {
    for (const id of zone.chapterIds) ids.add(id);
  }
  return Array.from(ids).sort((a, b) => a - b);
}

/** Chain targets whose walk-complete pointer has already been injected while the zone is live. */
export function episodicCompletedChainPaths(state: EpisodicInjectionState): string[] {
  return Array.from(state.completedChainTargetPaths).sort();
}

/**
 * Live zones keyed by a term-cluster target ('term:...') — the recall payload's
 * servedTermKeys. Unlike servedChapterIds (which only blocks re-serving the
 * IDENTICAL episodes), a resident term key tells the worker the session already
 * holds a card for that term cluster, so near-duplicate sibling episodes under
 * the same cluster are skipped instead of re-fired on back-to-back boundaries.
 */
export function episodicServedTermKeys(state: EpisodicInjectionState): string[] {
  const keys: string[] = [];
  for (const targetPath of state.zones.keys()) {
    if (targetPath.startsWith('term:')) keys.push(targetPath);
  }
  return keys.sort();
}

function cloneEpisodicCard(card: EpisodicRecallCardLike): EpisodicRecallCardLike {
  return {
    targetPath: card.targetPath,
    renderedCard: card.renderedCard,
    chapterIds: [...card.chapterIds],
    memberPaths: [...card.memberPaths],
    kind: card.kind,
    ...(card.debug ? { debug: { ...card.debug } } : {}),
  };
}

function isActivePathAnchorCard(card: EpisodicRecallCardLike): boolean {
  return card.kind === 'chain' || card.kind === 'mention';
}

function zoneMatchesTouchedPath(targetPath: string, touched: ReadonlySet<string>): boolean {
  return touched.has(targetPath);
}

/**
 * Consume the stash if it is still fresh; drop it (counted as suppressed) when
 * it has aged past maxAge boundaries. Always clears the stash either way —
 * a result is injectable exactly once.
 */
export function consumeEpisodicStash(
  state: EpisodicInjectionState,
  maxAgeBoundaries: number = EPISODIC_STASH_MAX_AGE_BOUNDARIES,
): EpisodicRecallCardLike[] | null {
  const stash = state.stash;
  if (!stash) return null;
  state.stash = null;
  if (state.boundarySeq - stash.bornAtBoundary > maxAgeBoundaries) {
    state.episodicSuppressed += stash.cards.length;
    return null;
  }
  const unseen = stash.cards.filter((card) => !state.visibleCardHeaders.has(episodicCardHeaderLine(card)));
  state.episodicSuppressed += stash.cards.length - unseen.length;
  return unseen.length > 0 ? unseen : null;
}

// ── Read-boundary serve rate gate ────────────────────────────────────────────
// Investigation bursts (read/grep/search sprees) can exhale a new episodic card
// at nearly every boundary, swamping the live thread with memory. The gate
// classifies each inject boundary by its dispatched tool and rations NEW-card
// serving on the gated class (read/search and other non-edit, non-rail tools)
// to at most one card per N gated boundaries. Edit and rail-anchor boundaries —
// the high-signal moments where recall pays for itself — always serve in full.

/** Default N for the read-boundary serve rate: 1 new card per 3 gated boundaries. */
export const EPISODIC_READ_RATE_DEFAULT_BOUNDARIES = 3;

/**
 * Edit-shaped tool-name hints. Mirrors foldEpisodeCapture's EDIT_TOOL_HINTS
 * (keep the two lists in sync): capture uses them to classify touch kinds,
 * this gate uses them to classify inject boundaries.
 */
const EPISODIC_EDIT_TOOL_HINTS = ['edit', 'write', 'apply_patch', 'notebookedit', 'str_replace', 'create_file'] as const;

export type EpisodicBoundaryToolClass = 'edit' | 'rail_anchor' | 'gated';

/**
 * Classify the dispatched tool at an inject boundary for the read-rate gate.
 * Unknown/absent tool names classify as 'gated' — the conservative side: a
 * misclassified boundary rations recall, it never over-serves. TodoWrite is
 * excluded from the 'write' hint because a todo update is paperwork, not a
 * file edit; task_rail (bare or MCP-prefixed) anchors the rail bypass.
 */
export function classifyEpisodicBoundaryTool(toolName: string | null | undefined): EpisodicBoundaryToolClass {
  if (typeof toolName !== 'string' || toolName.length === 0) return 'gated';
  const lower = toolName.toLowerCase();
  if (lower === 'task_rail' || lower.endsWith('__task_rail')) return 'rail_anchor';
  if (!lower.includes('todowrite') && EPISODIC_EDIT_TOOL_HINTS.some((hint) => lower.includes(hint))) return 'edit';
  return 'gated';
}

/**
 * Pure parser for the read-rate knob (env VOXXO_FOLD_EPISODIC_READ_RATE_BOUNDARIES,
 * passed in as a raw string so the package stays host-agnostic). 0 disables the
 * gate (legacy serve-every-boundary behavior); absent/invalid/negative falls back
 * to EPISODIC_READ_RATE_DEFAULT_BOUNDARIES.
 */
export function resolveEpisodicReadRateBoundaries(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return EPISODIC_READ_RATE_DEFAULT_BOUNDARIES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return EPISODIC_READ_RATE_DEFAULT_BOUNDARIES;
  return parsed;
}

export interface EpisodicStashRateGateOptions {
  /** Dispatched tool name at THIS boundary — the classification source. */
  toolName: string | null | undefined;
  /** Serve new cards on at most 1 of every N gated boundaries. 0 disables the gate. */
  rateBoundaries: number;
  /** Stash freshness bound forwarded to consumeEpisodicStash. */
  maxAgeBoundaries?: number;
  /** Provider-visible text used to reject duplicate candidates before spending the gated allowance. */
  providerPovText?: string;
}

/**
 * Rate-gated stash consume. Behavior by boundary class:
 * - 'edit' / 'rail_anchor' (or rate 0): plain consumeEpisodicStash — full
 *   bypass. Bypass serves do NOT advance or reset the gated counter; the
 *   ration is a contract on the gated class alone.
 * - 'gated': the boundary advances the counter. Below the rate the stash is
 *   HELD in place, not consumed — its own boundary TTL keeps aging it honestly
 *   (pressure-pause precedent), and a fresher fire overwrites it anyway. At or
 *   above the rate the stash is consumed, provider-visible duplicates are
 *   removed, and AT MOST ONE novel card serves (worker card order is
 *   strongest-tier-first). The counter resets only when an injectable card
 *   survives, so an open boundary that finds an empty, stale, or wholly
 *   duplicate stash keeps the accrued allowance.
 */
export function consumeEpisodicStashRateGated(
  state: EpisodicInjectionState,
  options: EpisodicStashRateGateOptions,
): EpisodicRecallCardLike[] | null {
  const rate = Math.floor(options.rateBoundaries);
  if (rate <= 0 || classifyEpisodicBoundaryTool(options.toolName) !== 'gated') {
    return consumeEpisodicStash(state, options.maxAgeBoundaries);
  }
  state.episodicGatedBoundariesSinceServe++;
  if (state.episodicGatedBoundariesSinceServe < rate) {
    if (state.stash) state.episodicRateHeld++;
    return null;
  }
  const cards = suppressEpisodicCardsAlreadyInPov(
    state,
    consumeEpisodicStash(state, options.maxAgeBoundaries),
    options.providerPovText ?? '',
  );
  if (!cards || cards.length === 0) return cards;
  state.episodicGatedBoundariesSinceServe = 0;
  if (cards.length > 1) {
    state.episodicRateTrimmed += cards.length - 1;
    return [cards[0]];
  }
  return cards;
}

const EPISODIC_POV_PROBE_MIN_CHARS = 40;

function normalizeEpisodicPovText(text: string): string {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? ` ${normalized} ` : '';
}

function cleanEpisodicPovProbe(text: string): string {
  return text.trim().replace(/(?:\.{3}|…)+$/, '').trim();
}

function episodicCardPovProbes(card: EpisodicRecallCardLike): string[] {
  const probes = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const cleaned = cleanEpisodicPovProbe(raw);
    if (cleaned.length < EPISODIC_POV_PROBE_MIN_CHARS || isDegenerateGist(cleaned)) return;
    const normalized = normalizeEpisodicPovText(cleaned);
    if (normalized) probes.add(normalized);
  };
  const lines = card.renderedCard.split('\n');
  const header = lines[0] ?? '';
  const headerSummary = /,\s*["“](.*?)["”]\]$/.exec(header)?.[1];
  add(headerSummary);
  for (const line of lines.slice(1)) {
    const voice = /^\s*🗣\s+[^:]+:\s*["“](.*?)["”](?:\s+\S+)?$/.exec(line)?.[1];
    const intent = /^\s*↞\s+intent:\s*["“](.*?)["”]/.exec(line)?.[1];
    const beforeAfter = /^\s*(?:↞\s+before:|after:\s+↠)\s*["“](.*?)["”]/.exec(line)?.[1];
    const sinceDelta = /^\s*Δ\s+(.+)/.exec(line)?.[1];
    add(voice ?? intent ?? beforeAfter ?? sinceDelta);
  }
  return [...probes];
}

/** True only when every substantive narrative probe in a card is already in POV. */
export function episodicCardAlreadyInPov(card: EpisodicRecallCardLike, providerPovText: string): boolean {
  if (!providerPovText) return false;
  const probes = episodicCardPovProbes(card);
  return probes.length > 0 && probes.every((probe) => providerPovText.includes(probe));
}

/**
 * Suppress information-resident cards before noteEpisodicInjection mutates
 * served/walk state. Header replay is handled separately; this catches the
 * first circular injection when the source narration is already visible.
 */
export function suppressEpisodicCardsAlreadyInPov(
  state: EpisodicInjectionState,
  cards: readonly EpisodicRecallCardLike[] | null,
  providerPovText: string,
): EpisodicRecallCardLike[] | null {
  if (!cards || cards.length === 0 || !providerPovText) return cards ? [...cards] : null;
  const kept = cards.filter((card) => !episodicCardAlreadyInPov(card, providerPovText));
  const suppressed = cards.length - kept.length;
  state.episodicSuppressed += suppressed;
  state.episodicPovSuppressed += suppressed;
  return kept.length > 0 ? kept : null;
}

/**
 * Record an injection: every served zone becomes (or stays) resident with a
 * fresh sliding TTL, served chapter ids merge into the zone's walk served-set,
 * and the breathing ledger tallies by tier (chain-grade = chain/walk/pointer,
 * episode-grade = mention).
 */
export function noteEpisodicInjection(
  state: EpisodicInjectionState,
  cards: readonly EpisodicRecallCardLike[],
  ttlBoundaries: number = EPISODIC_ZONE_TTL_BOUNDARIES,
  valueOptions?: EpisodicValueLedgerOptions,
): void {
  const config = valueOptions?.config;
  for (const card of cards) {
    const existing = state.zones.get(card.targetPath);
    const merged = new Set(existing ? existing.chapterIds : []);
    for (const id of card.chapterIds) merged.add(id);
    const headerLine = episodicCardHeaderLine(card);
    state.visibleCardHeaders.add(headerLine);
    const visibleCardHeaders = new Set(existing?.visibleCardHeaders ?? []);
    visibleCardHeaders.add(headerLine);
    const activeCard = isActivePathAnchorCard(card)
      ? cloneEpisodicCard(card)
      : existing?.activeCard;
    // Engagement bookkeeping (always, even when the ledger is off — pure data,
    // never rendered; only effectiveEpisodicZoneTtl reads it, and only when on).
    const zone: EpisodicZoneResidency = {
      expiresAtBoundary: state.boundarySeq + ttlBoundaries,
      chapterIds: Array.from(merged).sort((a, b) => a - b),
      visibleCardHeaders: Array.from(visibleCardHeaders).sort(),
      ...(activeCard ? { activeCard } : {}),
      firstSeenBoundary: existing?.firstSeenBoundary ?? state.boundarySeq,
      lastEngagedBoundary: state.boundarySeq,
      engagementCount: (existing?.engagementCount ?? 0) + 1,
      kind: strongerEpisodicKind(existing?.kind, card.kind),
    };
    if (config?.enabled) {
      const value = scoreEpisodicZoneValue(
        card.targetPath,
        zone,
        valueOptions?.context,
        state.boundarySeq,
        valueOptions?.weights,
      );
      zone.expiresAtBoundary = state.boundarySeq + effectiveEpisodicZoneTtl(ttlBoundaries, value, config);
    }
    state.zones.set(card.targetPath, zone);
    if (card.kind === 'pointer') state.completedChainTargetPaths.add(card.targetPath);
    else state.completedChainTargetPaths.delete(card.targetPath);
    if (card.kind === 'mention') state.episodeCardsInjected++;
    else state.chainCardsInjected++;
    state.episodicChars += card.renderedCard.length;
  }
}

/**
 * Sliding TTL: touching a live zone again pushes its expiry forward. Touch is
 * the ONLY residency-extending signal — a zone refreshes only when touchPaths
 * hits its exact targetPath. Mention-path recall is caller opt-in and never
 * extends TTL by itself, so a path that is only talked about (never re-touched)
 * lets its pin age out and fold on schedule. "Pin until the agent leaves the
 * path" == until the agent stops touching that same target path.
 */
export function refreshEpisodicZones(
  state: EpisodicInjectionState,
  touchPaths: readonly string[],
  ttlBoundaries: number = EPISODIC_ZONE_TTL_BOUNDARIES,
  valueOptions?: EpisodicValueLedgerOptions,
): void {
  if (touchPaths.length === 0) return;
  const touched = new Set(touchPaths);
  const config = valueOptions?.config;
  for (const [targetPath, zone] of state.zones) {
    if (zoneMatchesTouchedPath(targetPath, touched)) {
      // Engagement bookkeeping (always — pure data; only the TTL below reads it).
      zone.lastEngagedBoundary = state.boundarySeq;
      zone.engagementCount = (zone.engagementCount ?? 1) + 1;
      const ttl = config?.enabled
        ? effectiveEpisodicZoneTtl(
            ttlBoundaries,
            scoreEpisodicZoneValue(targetPath, zone, valueOptions?.context, state.boundarySeq, valueOptions?.weights),
            config,
          )
        : ttlBoundaries;
      zone.expiresAtBoundary = state.boundarySeq + ttl;
    }
  }
}

export interface ActiveEpisodicPathCardOptions {
  maxCards?: number;
  excludeRenderedCards?: readonly string[];
  /**
   * Cross-boundary pin idempotency: header lines already resident in the
   * post-fold send view. A pin whose byte-stable header line is in this set is
   * SKIPPED — a live copy still occupies the window, so re-pasting the full card
   * would only duplicate it. When the copy finally folds away its header leaves
   * the set and the pin re-pastes in full, restoring resident working memory.
   * Distinct from excludeRenderedCards (within-boundary exact full-card dedupe):
   * a resident copy may be the COMPACTED form, so idempotency keys on the header
   * line, never the full rendered text.
   */
  excludeHeaderLines?: ReadonlySet<string>;
  // ── Value-ledger (additive; absent/disabled → legacy path-sorted touch-only) ──
  /** When enabled: rank pins by value and (if repinInactive) re-pin high-value untouched zones. */
  valueConfig?: EpisodicValueLedgerConfig;
  /** Host-fed measured signals for value scoring (claimed paths, rail target). */
  valueContext?: EpisodicValueContext;
  /** Optional weight overrides for value scoring. */
  valueWeights?: EpisodicValueWeights;
}

export type EpisodicPinDecisionReason = 'touched' | 'inactive';
export type EpisodicPinSkipReason = 'rendered_duplicate' | 'resident_header' | 'inactive_below_floor' | 'budget';

export interface EpisodicPinSelectionDecision {
  targetPath: string;
  reason: EpisodicPinDecisionReason;
  value: number;
  selected: boolean;
  skipped?: EpisodicPinSkipReason;
}

export interface ActiveEpisodicPathCardSelection {
  cards: EpisodicRecallCardLike[];
  decisions: EpisodicPinSelectionDecision[];
  enabled: boolean;
  repinInactive: boolean;
  repinValueFloor: number;
  maxCards: number;
}

/**
 * Byte-stable header line of a rendered episodic card — its first line, e.g.
 * `[Episode recall <path> — <date>, "..."]`. The header carries no churning
 * counters (deliberate, for injection-cache stability), so it is a stable key
 * for cross-boundary active-pin idempotency.
 */
export function episodicCardHeaderLine(card: EpisodicRecallCardLike): string {
  const nl = card.renderedCard.indexOf('\n');
  return nl === -1 ? card.renderedCard : card.renderedCard.slice(0, nl);
}

/** Header-line shapes a rendered episodic CARD can start with (hot/walk recall + completed chain). Excludes the `[Episodic recall …` block wrappers by construction. */
export const EPISODIC_CARD_HEADER_PREFIX_RE = /^\[Episode (?:recall|chain) /;

/**
 * Collect the episodic card header lines present in a rendered view text (the
 * post-fold send view's concatenated message text). This is the resident-pin
 * set for idempotent active-path pins: a header here means a live copy already
 * occupies the window, so re-pasting it is pure duplication. Block wrappers
 * (`[Episodic recall …]`) start with "Episodic" and are deliberately not matched.
 * Pure CPU; cheap-exits when no episodic card text is present.
 */
export function collectResidentEpisodicHeaders(viewText: string): Set<string> {
  const out = new Set<string>();
  if (!viewText || viewText.indexOf('[Episode ') === -1) return out;
  for (const line of viewText.split('\n')) {
    if (EPISODIC_CARD_HEADER_PREFIX_RE.test(line)) out.add(line);
  }
  return out;
}

/**
 * Replace the visible-card ledger from a committed post-fold view. Zones with
 * no surviving card header leave the served set immediately; surviving zones
 * keep their chronological cursor and completed-pointer suppression.
 */
export function reconcileVisibleEpisodicHeaders(
  state: EpisodicInjectionState,
  residentHeaders: ReadonlySet<string>,
): void {
  state.visibleCardHeaders = new Set(residentHeaders);
  for (const [targetPath, zone] of state.zones) {
    const visible = (zone.visibleCardHeaders ?? []).filter((header) => residentHeaders.has(header));
    if (visible.length === 0) {
      state.zones.delete(targetPath);
      state.completedChainTargetPaths.delete(targetPath);
      continue;
    }
    zone.visibleCardHeaders = visible;
    if (zone.activeCard && !residentHeaders.has(episodicCardHeaderLine(zone.activeCard))) {
      delete zone.activeCard;
    }
  }
}

/** Reconcile visible cards directly from a provider-ready folded message view. */
export function reconcileVisibleEpisodicView(
  state: EpisodicInjectionState,
  view: readonly { content: string | null | unknown[] }[],
): Set<string> {
  const headers = new Set<string>();
  for (const message of view) {
    if (typeof message.content === 'string') {
      for (const header of collectResidentEpisodicHeaders(message.content)) headers.add(header);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{ type?: string; text?: unknown }>) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      for (const header of collectResidentEpisodicHeaders(block.text)) headers.add(header);
    }
  }
  reconcileVisibleEpisodicHeaders(state, headers);
  return headers;
}

/**
 * Pure coordination / bookkeeping tools that incidentally carry file paths but
 * do NOT represent the agent reading, editing, or searching code. Episodic
 * recall keys off touched/mentioned paths; firing the inhale or re-paging the
 * active pin on these keeps a zone artificially hot and floods tool boundaries
 * with cards during pure paperwork (claim/release, rail bookkeeping, atlas
 * commit, chat, waves). A seam consults isEpisodicBookkeepingTool to skip the
 * INHALE + PIN (never the exhale of already-earned cards) on these boundaries.
 * Investigation tools (atlas_query/atlas_graph, read/grep/glob) are deliberately
 * ABSENT — recall SHOULD fire when the agent explores code.
 */
export const EPISODIC_BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set<string>([
  'task_rail',
  'partner_claim_file',
  'partner_release_file',
  'partner_file_claims',
  'atlas_commit',
  'chatroom',
  'tap_star',
  'raw_signal',
  'inbox_send',
  'wave_advance',
  'wave_complete',
  'wave_complete_implementation',
  'wave_set_next_directive',
  'agent_slots',
  'slot_report',
]);

/** True when the dispatched tool is pure bookkeeping (see EPISODIC_BOOKKEEPING_TOOLS) — the seam skips the episodic inhale + pin on it. */
export function isEpisodicBookkeepingTool(toolName: string | null | undefined): boolean {
  return typeof toolName === 'string' && EPISODIC_BOOKKEEPING_TOOLS.has(toolName);
}

/**
 * Active path pins: while the current boundary is still touching a live zone,
 * keep that zone's hot card resident as logical working memory. The served-set
 * keeps walking backward separately; these cards do not advance counters.
 */
export function activeEpisodicPathCards(
  state: EpisodicInjectionState,
  touchPaths: readonly string[],
  options: ActiveEpisodicPathCardOptions = {},
): EpisodicRecallCardLike[] {
  return selectActiveEpisodicPathCards(state, touchPaths, options).cards;
}

export function selectActiveEpisodicPathCards(
  state: EpisodicInjectionState,
  touchPaths: readonly string[],
  options: ActiveEpisodicPathCardOptions = {},
): ActiveEpisodicPathCardSelection {
  const config = options.valueConfig;
  const enabled = config?.enabled === true;
  const configuredRepinInactive = enabled && config?.repinInactive === true;
  const railTargetPaths = options.valueContext?.railTargetPaths;
  const hasRailTargets = (railTargetPaths?.size ?? 0) > 0;
  const repinInactive = configuredRepinInactive && (touchPaths.length > 0 || hasRailTargets);
  const repinValueFloor = config?.repinValueFloor ?? 1;
  const maxCards = Math.max(0, options.maxCards ?? EPISODIC_ACTIVE_PIN_DEFAULT_MAX_CARDS);
  const empty = (): ActiveEpisodicPathCardSelection => ({
    cards: [],
    decisions: [],
    enabled,
    repinInactive,
    repinValueFloor,
    maxCards,
  });
  // Legacy early-out preserved unless de-noised inactive re-pin is on. The old
  // "scan every zone on every boundary" behavior churned relay-wide; now a
  // pathless push needs an active rail target, and only matching target paths
  // can pass below.
  if (touchPaths.length === 0 && !repinInactive) return empty();
  const touched = new Set(touchPaths);
  const excluded = new Set(options.excludeRenderedCards ?? []);
  if (maxCards === 0) return empty();
  interface PinCandidate {
    targetPath: string;
    card: EpisodicRecallCardLike;
    value: number;
    reason: EpisodicPinDecisionReason;
  }
  const candidates: PinCandidate[] = [];
  const decisions: EpisodicPinSelectionDecision[] = [];
  for (const [targetPath, zone] of state.zones) {
    const card = zone.activeCard;
    if (!card) continue;
    const isTouched = zoneMatchesTouchedPath(targetPath, touched);
    const value = enabled
      ? scoreEpisodicZoneValue(targetPath, zone, options.valueContext, state.boundarySeq, options.valueWeights)
      : 0;
    const reason: EpisodicPinDecisionReason = isTouched ? 'touched' : 'inactive';
    const inactiveMatchesRailTarget = !isTouched && hasRailTargets && railTargetPaths?.has(targetPath) === true;
    const inactiveAllowed = isTouched
      ? true
      : repinInactive && (touchPaths.length > 0 || inactiveMatchesRailTarget);
    if (!isTouched && (!inactiveAllowed || value < repinValueFloor)) {
      if (repinInactive) {
        decisions.push({ targetPath, reason, value, selected: false, skipped: 'inactive_below_floor' });
      }
      continue;
    }
    if (excluded.has(card.renderedCard)) {
      decisions.push({ targetPath, reason, value, selected: false, skipped: 'rendered_duplicate' });
      continue;
    }
    // Cross-boundary idempotency: a live copy of this card's header is already
    // resident in the send view, so re-pasting it would only duplicate. Skip
    // until it folds away (its header leaves the set) and the pin re-pastes full.
    if (options.excludeHeaderLines && options.excludeHeaderLines.has(episodicCardHeaderLine(card))) {
      decisions.push({ targetPath, reason, value, selected: false, skipped: 'resident_header' });
      continue;
    }
    if (isTouched) {
      candidates.push({ targetPath, card, value, reason });
    } else {
      candidates.push({ targetPath, card, value, reason });
    }
  }
  // Selection order: ledger ON → value desc (path asc tie-break); OFF → path asc,
  // byte-identical to the legacy path-sorted, touch-only, first-maxCards walk.
  candidates.sort((a, b) => {
    if (enabled && b.value !== a.value) return b.value - a.value;
    return a.targetPath < b.targetPath ? -1 : a.targetPath > b.targetPath ? 1 : 0;
  });
  const out: EpisodicRecallCardLike[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (out.length < maxCards) {
      out.push(cloneEpisodicCard(candidate.card));
      decisions.push({
        targetPath: candidate.targetPath,
        reason: candidate.reason,
        value: candidate.value,
        selected: true,
      });
    } else {
      decisions.push({
        targetPath: candidate.targetPath,
        reason: candidate.reason,
        value: candidate.value,
        selected: false,
        skipped: 'budget',
      });
    }
  }
  return { cards: out, decisions, enabled, repinInactive, repinValueFloor, maxCards };
}

function compactActivePathCard(card: EpisodicRecallCardLike, budget: number): string | null {
  if (budget <= 0) return null;
  if (card.renderedCard.length <= budget) return card.renderedCard;
  const lines = card.renderedCard.split('\n');
  const header = lines[0] ?? '';
  const members = lines.find((line) => line.startsWith('  members: '));
  const pointer = lines.find((line) => line.startsWith('  ⌖ verbatim: '));
  const compact = [header, members, pointer].filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n');
  if (compact.length === 0) return null;
  return compact.length <= budget ? compact : truncateVerbatim(compact, budget);
}

export interface ActiveEpisodicPathBlockOptions {
  charBudget?: number;
}

/**
 * Render active pins as their own synthetic episodic block. This re-pages the
 * hot chapter while the path stays active, but once zone TTL expires no new
 * copy is emitted and the old prompt copy can fold away normally.
 */
export function renderActiveEpisodicPathBlock(
  cards: readonly EpisodicRecallCardLike[],
  syntheticPrefix: string,
  options: ActiveEpisodicPathBlockOptions = {},
): string | null {
  if (cards.length === 0) return null;
  const budget = Math.max(0, options.charBudget ?? EPISODIC_ACTIVE_PIN_DEFAULT_CHAR_BUDGET);
  const header = `${syntheticPrefix} active path pin, ${cards.length} hot zone card(s) held while this path stays active]`;
  let budgetLeft = budget - header.length;
  if (budgetLeft <= 0) return null;
  const renderedCards: string[] = [];
  for (const card of cards) {
    const separatorCost = 2; // the \n\n between header/cards
    const compact = compactActivePathCard(card, budgetLeft - separatorCost);
    if (!compact) continue;
    renderedCards.push(compact);
    budgetLeft -= separatorCost + compact.length;
    if (budgetLeft <= 0) break;
  }
  if (renderedCards.length === 0) return null;
  return [header, ...renderedCards].join('\n\n');
}

/**
 * Self-bootstrapping compliance line, appended to a recall block ONLY when a
 * served card carries 🗣 narration voice: show the payoff (recovered voice),
 * then make the ask, in the same breath — the memory system's OUTPUT teaches
 * the convention that feeds its INPUT. Byte-stable (no counters/timestamps) so
 * it never churns the injection cache. It rides inside the synthetic episodic
 * block (turn-excluded by the header prefix) and the narration miner only reads
 * assistant text, so there is zero self-excitation risk. Bootstraps from 0%
 * compliance: untagged prose that passes the shape gate still renders 🗣, so
 * the reminder fires and drives the tagging that upgrades future 🗣 to trusted.
 */
export const EPISODIC_NARRATION_REMINDER =
  '[🗣 above is recovered agent voice — it survived into memory because an agent tagged its messages by register. Open yours with one of 🔍 working · ▶ executing · 🏁 verdict · ⚠️ hazard · ❓ blocked and future agents inherit your conclusions the same way.]';

/**
 * Compact per-card provenance line for the episodic recall block — the "why this
 * card surfaced" audit trail that turns opaque recall into something inspectable.
 * Surfaces the selection signal (term/path/rail/mention match), the matched terms
 * for term cards, the source episode id(s), and the annotation gate that qualified
 * it — all from fields the worker already attaches to every card. Path/mention
 * cards deliberately omit the path here (it leads the card body directly below) so
 * no bare file path appears outside the synthetic card prefix and the
 * mention-extraction self-excitation guard stays intact. Pure string formatting;
 * rides inside the synthetic block so it is never mined as agent voice. Stable per
 * card (no timestamps/counters) so it never churns the injection cache.
 */
export function formatEpisodicCardProvenance(card: EpisodicRecallCardLike): string {
  const ids = card.chapterIds ?? [];
  const source = ids.length > 0
    ? `ep#${ids[0]}${ids.length > 1 ? `+${ids.length - 1}` : ''}`
    : 'ep#?';
  const gate = card.debug?.annotationBoostKind
    ? ` · gate:${card.debug.annotationBoostKind.replace(/^star:/, '')}`
    : '';
  let why: string;
  switch (card.kind) {
    case 'term': {
      const colon = card.targetPath.indexOf(':');
      const terms = colon >= 0
        ? card.targetPath.slice(colon + 1).split('+').join(', ')
        : card.targetPath;
      why = `term-match (${terms})`;
      break;
    }
    case 'rail':
      why = 'rail-match';
      break;
    case 'mention':
      why = 'mention-match';
      break;
    default:
      why = 'path-match';
  }
  return `↞ why: ${why} · ${source}${gate}`;
}

/**
 * Render the per-boundary episodic block. The header line MUST start with the
 * synthetic episodic prefix (passed in — this module imports nothing) so the
 * fold excludes the block from real-turn detection and signal extraction, and
 * ages it out cyclically exactly like recall cards.
 */
export function renderEpisodicBoundaryBlock(
  cards: readonly EpisodicRecallCardLike[],
  syntheticPrefix: string,
  counterFooter?: string,
  narrationReminder?: string,
): string | null {
  if (cards.length === 0) return null;
  const header = `${syntheticPrefix} ${cards.length} zone card(s) — trace-derived episodic recall; each card's ↞ why line shows the match (term/path/rail). Touch a path card's target to unfold its zone]`;
  const parts = [header, ...cards.map((c) => `${formatEpisodicCardProvenance(c)}\n${c.renderedCard}`)];
  if (counterFooter) parts.push(counterFooter);
  // Self-bootstrapping compliance: append the reminder ONLY when the agent is
  // actually benefiting from recovered 🗣 narration voice (value-demo, not a
  // blind nag). The byte-stable text keeps the injection cache stable.
  if (narrationReminder && cards.some((c) => c.renderedCard.includes('🗣'))) {
    parts.push(narrationReminder);
  }
  return parts.join('\n\n');
}

/**
 * Extract mention-tier paths from AGENT-AUTHORED prose. The caller guarantees
 * the texts are assistant-authored (structural self-excitation guard: injected
 * cards ride user-role tool results, so the matcher never reads its own
 * output); isSyntheticLine strips any quoted card/fold lines as defense in
 * depth. Tokens must look like files (final-segment extension) and pass the
 * membership predicate; the cap bounds worker lookup cost — unknown paths are
 * harmless store misses, so prose noise like "Node.js" costs one indexed miss.
 */
export function extractEpisodeMentionPaths(
  texts: readonly string[],
  isSyntheticLine: (line: string) => boolean,
  cap = 8,
): string[] {
  const tokenPattern = /(?:\/|~\/)?(?:[\w.()[\]-]+\/)*[\w()[\]-]+(?:\.[\w-]+)+/g;
  const found = new Set<string>();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (isSyntheticLine(line)) continue;
      for (const match of line.matchAll(tokenPattern)) {
        let token = match[0];
        if (token.startsWith('./')) token = token.slice(2);
        if (isEpisodeMemberPath(token)) found.add(token);
      }
      if (found.size >= cap * 4) break;
    }
  }
  return Array.from(found).sort().slice(0, cap);
}
