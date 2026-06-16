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
  chat: 9,
  // UNTAGGED tier-B distillate: still always LAST, so it fills voice vacuum but
  // never displaces deliberate voice under the inlay cap. At 0% glyph
  // compliance all narration lands here — ranking stays byte-identical to the
  // pre-promotion engine.
  narration: 10,
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

// Line-level register tags: a line the agent itself opened with 🔍/❓ is
// declared in-progress/blocked — never voice, even inside an eligible message.
// 🏁/⚠️ line openers strip as decoration and are handled by the caller's declared
// vs untagged extraction mode.
const NARRATION_NONVERDICT_LINE_RE = /^[🔍❓❔]/u;

// ── Message glyph grammar (register tags) ────────────────────────────────

/** Register an agent declares by opening a message with one SOP glyph. */
export type MessageGlyphMode = 'working' | 'verdict' | 'hazard' | 'blocked';

// SOP taxonomy (sop/master.md P23): 🔍 in-progress · 🏁 verified verdict ·
// ⚠️ hazard/gotcha · ❓ blocked. Bare ⚠/❔ forms cover engines that emit
// emoji without the VS16 presentation selector. Card-grammar glyphs
// (✎⭐💬🗣⌖Δ↞↠) are deliberately NOT modes — they mark quoted memory.
const MESSAGE_GLYPHS: readonly (readonly [string, MessageGlyphMode])[] = [
  ['🔍', 'working'],
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
 * (🔍 working / ❓ blocked) self-exclude — the false-positive class no shape
 * filter can catch ("Found the likely culprit…" inside a 🔍 message is a
 * hypothesis wearing verdict clothes). 🏁/⚠️ and untagged stay eligible:
 * untagged still needs the lexical verdict gate, while declared 🏁/⚠️ uses the
 * glyph as the deliberate trust signal.
 */
export function isNarrationEligibleGlyph(mode: MessageGlyphMode | undefined): boolean {
  return mode !== 'working' && mode !== 'blocked';
}

/**
 * Map the DECLARED message register onto the narration trust tier — the
 * promotion key. A 🏁-declared verdict and ⚠️-declared hazard become the
 * promoted kinds (they rank in the deliberate tier, and a declared hazard feeds
 * the chain-surfacing boost); everything else stays the priority-last backstop.
 * 'working'/'blocked' never reach harvest (isNarrationEligibleGlyph excludes
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
 * burst). Members are aggregated per path with the strongest touch kind; when
 * trimming to memberCap, edits are prioritized, then touch volume.
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

  const sorted = touches
    .filter((touch) => isEpisodeMemberPath(touch.path))
    .sort(
      (a, b) => a.eventIndex - b.eventIndex || comparePaths(a.path, b.path) || TOUCH_KIND_RANK[b.kind] - TOUCH_KIND_RANK[a.kind],
    );

  const bursts: EpisodeTouch[][] = [];
  let current: EpisodeTouch[] = [];
  let pivotCursor = 0;

  for (const touch of sorted) {
    const prev = current[current.length - 1];
    if (prev) {
      while (pivotCursor < pivotIndexes.length && pivotIndexes[pivotCursor] <= prev.eventIndex) pivotCursor++;
      const pivotBetween = pivotCursor < pivotIndexes.length && pivotIndexes[pivotCursor] <= touch.eventIndex;
      const eventGap = touch.eventIndex - prev.eventIndex;
      const prevMs = parseTsMs(prev.ts);
      const touchMs = parseTsMs(touch.ts);
      const msGap = prevMs !== undefined && touchMs !== undefined ? touchMs - prevMs : undefined;
      // FORCE-SPLIT: cap the SPAN of one uninterrupted burst, measured from its
      // FIRST touch (not prev). A continuous run never gaps, so without this it
      // never seals — its voice is dropped and the cursor parks. See
      // DEFAULT_EPISODE_GROUPING.maxBurst* for the live-regression rationale.
      const burstStart = current[0] ?? prev;
      const spanEvents = touch.eventIndex - burstStart.eventIndex;
      const burstStartMs = parseTsMs(burstStart.ts);
      const spanMs = burstStartMs !== undefined && touchMs !== undefined ? touchMs - burstStartMs : undefined;
      const spanExceeded = spanEvents > maxBurstEvents || (spanMs !== undefined && spanMs > maxBurstMs);
      if (eventGap > gapEvents || (msGap !== undefined && msGap > gapMs) || pivotBetween || spanExceeded) {
        bursts.push(current);
        current = [];
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

function renderVoiceLine(annotation: EpisodeAnnotation, label: string): string {
  const text = truncateVerbatim(annotation.text, VOICE_TEXT_CAP_CHARS);
  const at = voiceTimeSuffix(annotation);
  const who = label ? ` ${label}` : '';
  if (annotation.kind.startsWith('star:')) return `  ⭐${who}${who ? ' ' : ''}${annotation.kind.slice(5)}:"${text}"${at}`;
  if (annotation.kind === 'changelog') return `  ✎${who}:"${text}"${at}`;
  if (annotation.kind.startsWith('narration')) return `  🗣${who}:"${text}"${at}`;
  return `  💬${who}:"${text}"${at}`;
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
  const budget = opts.charBudget ?? CHAIN_CARD_DEFAULT_BUDGET_CHARS;
  const maxVoice = opts.maxVoiceInlays ?? 2;
  const warmCount = Math.max(0, Math.floor(opts.warmCount ?? 2));
  const fullPreviousCount = Math.max(0, Math.floor(opts.fullPreviousCount ?? 0));

  const ordered = [...chapters].sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));
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
  opts: Pick<ChainCardOptions, 'charBudget' | 'maxVoiceInlays' | 'ownLineage' | 'selfName'> & {
    /**
     * Origin-anchored breadcrumb trail (nearest waypoint → … → origin).
     * Optional and additive: absent ⇒ byte-identical pre-breadcrumb grammar.
     */
    spines?: readonly WalkSpineCitation[];
  } = {},
): string {
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
export interface EpisodicRecallCardLike {
  targetPath: string;
  renderedCard: string;
  chapterIds: number[];
  memberPaths: string[];
  kind: 'chain' | 'walk' | 'mention' | 'pointer' | 'term' | 'rail';
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
   * Hot/recent card to keep as logical working memory while the agent keeps
   * touching this zone. Walk/pointer cards do not replace it — they advance the
   * older-chapter cursor while the hot card remains the path anchor.
   */
  activeCard?: EpisodicRecallCardLike;
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
  /**
   * Boundaries where the inhale + pin were skipped because a pure bookkeeping
   * tool dispatched (see isEpisodicBookkeepingTool). The exhale of already-earned
   * cards still runs on those boundaries — this counts only the suppressed NEW
   * fires, the noise-reduction signal for the bookkeeping-suppression A/B.
   */
  episodicBookkeepingSuppressed: number;
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
    episodicSkippedAtPressure: 0,
    episodicPinsInjected: 0,
    episodicPinChars: 0,
    completedChainTargetPaths: new Set(),
    episodicBookkeepingSuppressed: 0,
  };
}

/** Drop expired zones; their chapterIds leave the served-set (walk cursor reset). */
export function expireEpisodicZones(state: EpisodicInjectionState): void {
  for (const [path, zone] of state.zones) {
    if (zone.expiresAtBoundary <= state.boundarySeq) {
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

function cloneEpisodicCard(card: EpisodicRecallCardLike): EpisodicRecallCardLike {
  return {
    targetPath: card.targetPath,
    renderedCard: card.renderedCard,
    chapterIds: [...card.chapterIds],
    memberPaths: [...card.memberPaths],
    kind: card.kind,
  };
}

function isActivePathAnchorCard(card: EpisodicRecallCardLike): boolean {
  return card.kind === 'chain' || card.kind === 'mention';
}

function zoneMatchesTouchedPath(targetPath: string, zone: EpisodicZoneResidency, touched: ReadonlySet<string>): boolean {
  if (touched.has(targetPath)) return true;
  const active = zone.activeCard;
  if (!active) return false;
  for (const memberPath of active.memberPaths) {
    if (touched.has(memberPath)) return true;
  }
  return false;
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
  return stash.cards.length > 0 ? stash.cards : null;
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
): void {
  for (const card of cards) {
    const existing = state.zones.get(card.targetPath);
    const merged = new Set(existing ? existing.chapterIds : []);
    for (const id of card.chapterIds) merged.add(id);
    const activeCard = isActivePathAnchorCard(card)
      ? cloneEpisodicCard(card)
      : existing?.activeCard;
    state.zones.set(card.targetPath, {
      expiresAtBoundary: state.boundarySeq + ttlBoundaries,
      chapterIds: Array.from(merged).sort((a, b) => a - b),
      ...(activeCard ? { activeCard } : {}),
    });
    if (card.kind === 'pointer') state.completedChainTargetPaths.add(card.targetPath);
    else state.completedChainTargetPaths.delete(card.targetPath);
    if (card.kind === 'mention') state.episodeCardsInjected++;
    else state.chainCardsInjected++;
    state.episodicChars += card.renderedCard.length;
  }
}

/**
 * Sliding TTL: touching a live zone again pushes its expiry forward. Touch is
 * the ONLY residency-extending signal — a zone refreshes when touchPaths hits
 * its targetPath OR any member path of its active pin card. Mentions are handled
 * separately by activeEpisodicPathCards: a mention re-surfaces an existing pin
 * but intentionally does NOT extend the zone's TTL, so a path that is only
 * talked about (never re-touched) lets its pin age out and fold on schedule.
 * "Pin until the agent leaves the path" == until the agent stops touching it.
 */
export function refreshEpisodicZones(
  state: EpisodicInjectionState,
  touchPaths: readonly string[],
  ttlBoundaries: number = EPISODIC_ZONE_TTL_BOUNDARIES,
): void {
  if (touchPaths.length === 0) return;
  const touched = new Set(touchPaths);
  for (const [targetPath, zone] of state.zones) {
    if (zoneMatchesTouchedPath(targetPath, zone, touched)) {
      zone.expiresAtBoundary = state.boundarySeq + ttlBoundaries;
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
  if (touchPaths.length === 0) return [];
  const touched = new Set(touchPaths);
  const excluded = new Set(options.excludeRenderedCards ?? []);
  const maxCards = Math.max(0, options.maxCards ?? EPISODIC_ACTIVE_PIN_DEFAULT_MAX_CARDS);
  if (maxCards === 0) return [];
  const out: EpisodicRecallCardLike[] = [];
  for (const [targetPath, zone] of [...state.zones.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const card = zone.activeCard;
    if (!card) continue;
    if (!zoneMatchesTouchedPath(targetPath, zone, touched)) continue;
    if (excluded.has(card.renderedCard)) continue;
    // Cross-boundary idempotency: a live copy of this card's header is already
    // resident in the send view, so re-pasting it would only duplicate. Skip
    // until it folds away (its header leaves the set) and the pin re-pastes full.
    if (options.excludeHeaderLines && options.excludeHeaderLines.has(episodicCardHeaderLine(card))) continue;
    out.push(cloneEpisodicCard(card));
    if (out.length >= maxCards) break;
  }
  return out;
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
  '[🗣 above is recovered agent voice — it survived into memory because an agent tagged its messages by register. Open yours with one of 🔍 working · 🏁 verdict · ⚠️ hazard · ❓ blocked and future agents inherit your conclusions the same way.]';

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
  const header = `${syntheticPrefix} ${cards.length} zone card(s) — blast-radius memory; touch or mention any member path to unfold its zone]`;
  const parts = [header, ...cards.map((c) => c.renderedCard)];
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
