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
export type EpisodeAnnotationKind = 'star:decision' | 'star:discovery' | 'star:pivot' | 'star:handoff' | 'star:gotcha' | 'star:result' | 'changelog' | 'chat' | 'rail'
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
 | 'narration:verdict' | 'narration:hazard'
/**
 * Bounded, explicitly low-trust process voice. These preserve how an agent
 * investigated and chose a direction without laundering an in-progress
 * hypothesis into verdict memory. Capture requires a substantive tool burst;
 * read-time priority keeps every process kind below deliberate voice.
 */
 | 'process:decision' | 'process:discovery' | 'process:investigation' | 'narration';
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
export declare const RECALL_UTILITY_MIN_MULTIPLIER = 0.75;
export declare const RECALL_UTILITY_MAX_MULTIPLIER = 1.25;
export interface RecallUtilityDebugFields {
    recallUtility: number;
    recallUtilityMultiplier: number;
}
export declare function normalizeRecallUtility(value: unknown): number | undefined;
export declare function recallUtilityMultiplier(value: unknown): number;
export declare function recallUtilityDebugFields(value: unknown): RecallUtilityDebugFields | undefined;
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
    /** One burst-local tool-result excerpt that explains the decisive turn. */
    result?: string;
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
    bookends?: {
        before?: string;
        after?: string;
    };
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
export declare const DEFAULT_EPISODE_GROUPING: {
    readonly gapEvents: 25;
    readonly gapMs: 1200000;
    readonly memberCap: 16;
    readonly maxBurstEvents: 240;
    readonly maxBurstMs: 1800000;
};
export declare const BRANCH_TRACE_CAP_CHARS = 450;
export declare const SUMMARY_CAP_CHARS = 120;
export declare const HEADER_SUMMARY_CAP_CHARS = 60;
export declare const VOICE_TEXT_CAP_CHARS = 200;
export declare const TRACE_VOICE_TEXT_CAP_CHARS = 60;
export declare const TRACE_RESULT_TEXT_CAP_CHARS = 96;
/**
 * Verbatim cap for the operator-ask intent anchor (Episode.intent). The driving
 * user message can run long; bound it like voice and keep it to a single anchor
 * line on the card.
 */
export declare const INTENT_TEXT_CAP_CHARS = 200;
export declare const CHAIN_CARD_DEFAULT_BUDGET_CHARS = 1600;
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
export declare function isEpisodeMemberPath(candidate: string): boolean;
/** Truncate verbatim text to a cap, marking the cut with a single ellipsis. */
export declare function truncateVerbatim(text: string, cap: number): string;
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
export declare const RATIONALE_RE: RegExp;
/** Max rationale lines per episode (rationale is a supplementary backstop). */
export declare const RATIONALE_MAX_LINES = 2;
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
export declare function extractRationaleLines(text: string, isSyntheticLine: (line: string) => boolean, cap?: number): string[];
/** Max narration lines carried per episode (untagged backstop). */
export declare const NARRATION_MAX_LINES = 2;
/**
 * Higher cap for DECLARED 🏁/⚠️ messages: the tag itself is the trust signal, so
 * a multi-line verdict/hazard form ("Fixed X. Verified Y. Risk Z.") is captured
 * more fully than untagged prose. Still bounded — synthetic/card-quote guards,
 * length/question gates, position windows, and the per-card inlay cap remain.
 */
export declare const NARRATION_MAX_LINES_TAGGED = 3;
/** Shape bounds: shorter is filler ("Done."), longer is paragraph prose. */
export declare const NARRATION_MIN_LINE_CHARS = 25;
export declare const NARRATION_MAX_LINE_CHARS = 300;
/** Minimum structural tool steps before process narration can be harvested. */
export declare const PROCESS_MIN_TOOL_STEPS = 2;
/** Investigation-only prose needs a thicker trail than a shaped decision/discovery. */
export declare const PROCESS_INVESTIGATION_MIN_TOOL_STEPS = 3;
/** Hard write-time cap; card rendering applies its own independent inlay budget. */
export declare const PROCESS_MAX_LINES = 2;
export interface ProcessNarrationLine {
    kind: Extract<EpisodeAnnotationKind, `process:${string}`>;
    text: string;
}
/**
 * Extract bounded process memory from assistant prose inside a substantive tool
 * burst. Unlike verdict narration, working/executing registers are accepted —
 * but their lines are labelled as process, never durable truth. Decisions and
 * discoveries require a shaped signal plus two tool steps; generic investigation
 * requires three. Questions, synthetic/card voice, code, filler, and blocked or
 * terminal registers are excluded. Pure and deterministic.
 */
export declare function extractProcessNarrationLines(text: string, messageMode: MessageGlyphMode | undefined, isSyntheticLine: (line: string) => boolean, toolStepCount: number, cap?: number): ProcessNarrationLine[];
/** Register an agent declares by opening a message with one SOP glyph. */
export type MessageGlyphMode = 'working' | 'executing' | 'verdict' | 'hazard' | 'blocked';
/**
 * First-glyph register classifier — the SOURCE side of narration noise
 * control. Deterministic, engine-agnostic, transcript-only: an agent declares
 * what its message IS (hypothesis vs verified verdict) by how it opens it —
 * knowledge no shape regex can recover from phrasing alone. Returns undefined
 * for untagged text; callers MUST treat undefined as "shape-only gating",
 * never as exclusion, so harvest keeps working at 0% compliance (legacy
 * transcripts, non-adopting engines).
 */
export declare function classifyMessageGlyph(text: string | undefined): MessageGlyphMode | undefined;
/**
 * Harvest eligibility under the glyph gate: declared non-verdict registers
 * (🔍 working / ▶ executing / ❓ blocked) self-exclude — the false-positive class no shape
 * filter can catch ("Found the likely culprit…" inside a 🔍 message is a
 * hypothesis wearing verdict clothes). 🏁/⚠️ and untagged stay eligible:
 * untagged still needs the lexical verdict gate, while declared 🏁/⚠️ uses the
 * glyph as the deliberate trust signal.
 */
export declare function isNarrationEligibleGlyph(mode: MessageGlyphMode | undefined): boolean;
/**
 * Map the DECLARED message register onto the narration trust tier — the
 * promotion key. A 🏁-declared verdict and ⚠️-declared hazard become the
 * promoted kinds (they rank in the deliberate tier, and a declared hazard feeds
 * the chain-surfacing boost); everything else stays the priority-last backstop.
 * 'working'/'executing'/'blocked' never reach harvest (isNarrationEligibleGlyph excludes
 * them upstream), so in practice this only ever sees 'verdict'/'hazard'/
 * undefined — but it stays total so the kind taxonomy has one authority.
 */
export declare function narrationKindForGlyph(mode: MessageGlyphMode | undefined): EpisodeAnnotationKind;
/**
 * Does this episode's voice imply a gotcha for chain-surfacing? A pinned gotcha
 * star OR a ⚠️-DECLARED hazard ('narration:hazard') — both are deliberate
 * "beware, resurface this" acts, so both earn the chainScore GOTCHA_BOOST. A 🏁
 * verdict deliberately does NOT (it mirrors star:result, which also does not
 * boost which chains surface). Exported so the handler's hasGotcha derivation
 * and its parity test share one authority.
 */
export declare function annotationsImplyGotcha(annotations: readonly EpisodeAnnotation[]): boolean;
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
export declare function extractNarrationLines(text: string, isSyntheticLine: (line: string) => boolean, cap?: number, options?: {
    requireVerdictShape?: boolean;
}): string[];
/** ISO timestamp → compact deterministic display form (YYYY-MM-DD HH:mm). */
export declare function formatEpisodeDate(iso: string): string;
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
export declare function groupTouchesIntoEpisodes(touches: readonly EpisodeTouch[], opts?: EpisodeGroupingOptions): EpisodeBurst[];
/**
 * Assign annotations (carrying source event indexes) to bursts. An annotation
 * inside a burst's event range belongs to that burst; one falling in a gap
 * attaches to the PRECEDING burst (it is the closing thought of that chapter
 * — pivot stars sealing a burst land on the chapter they ended); anything
 * before the first burst attaches to the first. Returns one annotation array
 * per burst, chronological by event index.
 */
export declare function assignAnnotationsToBursts(bursts: readonly EpisodeBurst[], annotated: readonly {
    eventIndex: number;
    annotation: EpisodeAnnotation;
}[]): EpisodeAnnotation[][];
/**
 * Structural-verbatim branch trace: the exact sequence of real actions with
 * real targets and real outcomes, bodies stripped. `Tool(target) → outcome`
 * tokens joined by ` → `, with run-length collapse (identical consecutive
 * steps → `×N`) and edit⇄check loop collapse (alternating A·B pairs →
 * `[A ⇄ B ×N → final]`). Voice steps render inline at their chronological
 * position, verbatim. Over-cap traces preserve the opening and closing action,
 * pin one decisive result/voice/error token, then fill remaining room by
 * information priority while retaining exact omitted-step counts.
 */
export declare function buildBranchTrace(steps: readonly TraceStep[], capChars?: number): string;
/**
 * One-line episode header. Fallback chain (most-verbatim first):
 * changelog heads → star result/decision notes → rail step/title words →
 * narration verdict/process lines → top member paths.
 */
export declare function deriveEpisodeSummary(input: {
    annotations?: readonly EpisodeAnnotation[];
    railTitle?: string;
    members: readonly EpisodeMember[];
}, capChars?: number): string;
/**
 * Pick ≤max voice inlays for card rendering. Priority: gotcha (the landmine
 * map) > decision > pivot > result > discovery > handoff > changelog > chat
 * > narration; ties break chronologically. Display order is chronological.
 */
export declare function selectVoiceInlays(annotations: readonly EpisodeAnnotation[], max?: number): EpisodeAnnotation[];
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
export declare function renderEpisodeVoiceLines(episode: Episode, opts: Pick<ChainCardOptions, 'ownLineage' | 'selfName'>, maxLines?: number): {
    voiceLines: string[];
    intent: string | null;
};
/** Pointer into the full verbatim record — exactness is reachable, not resident. */
export declare function formatPointerLine(episode: Episode): string;
/**
 * Render a chain card: the file's biography. Chapters arrive ascending by
 * endedAt (hot = last). HOT renders full (header + members + trace + voice +
 * since-then deltas), optional full previous chapters render body detail,
 * WARM (previous `warmCount`) render one-liners, and COLD collapses to one
 * line. Bookends (session-adjacent one-liners, resolved at recall) render
 * after the hot chapter. The card ALWAYS ends with the pointer line into full
 * verbatim; budget enforcement never sacrifices it.
 */
export declare function formatChainCard(chapters: readonly Episode[], targetPath: string, sinceDeltas: readonly string[], opts?: ChainCardOptions): string;
/**
 * Render a walk-promotion card: an OLDER chapter served because the agent
 * stayed engaged with the zone (attention-metered paging). Same body grammar
 * as the hot card, with an explicit walking-back header carrying the chain
 * position so the agent knows where the cursor is.
 */
export declare function formatWalkPromotionCard(chapter: Episode, position: WalkPosition, sinceDeltas: readonly string[], opts?: Pick<ChainCardOptions, 'charBudget' | 'maxVoiceInlays' | 'ownLineage' | 'selfName' | 'selfLineageOnly'> & {
    /**
     * Origin-anchored breadcrumb trail (nearest waypoint → … → origin).
     * Optional and additive: absent ⇒ byte-identical pre-breadcrumb grammar.
     */
    spines?: readonly WalkSpineCitation[];
}): string;
/** How many boundaries a stashed recall result stays injectable (inclusive). */
export declare const EPISODIC_STASH_MAX_AGE_BOUNDARIES = 2;
/** Default sliding zone-residency TTL, in tool boundaries (mirrors fold-recall's 8-pass default). */
export declare const EPISODIC_ZONE_TTL_BOUNDARIES = 8;
/** Default per-boundary char budget for the episodic block (one breath). */
export declare const EPISODIC_DEFAULT_CHAR_BUDGET = 2000;
/** Default max distinct chains served per boundary. */
export declare const EPISODIC_DEFAULT_MAX_CHAINS = 2;
/** Default max active hot cards re-pinned while a zone is still being walked. */
export declare const EPISODIC_ACTIVE_PIN_DEFAULT_MAX_CARDS = 2;
/** Default active-path pin budget; small enough to stay as working memory. */
export declare const EPISODIC_ACTIVE_PIN_DEFAULT_CHAR_BUDGET = 1200;
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
    /** Boundary at which this zone first became resident. */
    firstSeenBoundary?: number;
    /** Last boundary the zone's exact target path was (re)engaged by a touch. */
    lastEngagedBoundary?: number;
    /** Distinct engagement events: initial inject + each exact-path refresh. */
    engagementCount?: number;
    /** Strongest card kind seen for this zone (anchor-strength signal). */
    kind?: EpisodicRecallCardLike['kind'];
}
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
export declare const DEFAULT_EPISODIC_VALUE_WEIGHTS: EpisodicValueWeights;
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
export declare const DEFAULT_EPISODIC_VALUE_LEDGER_CONFIG: EpisodicValueLedgerConfig;
/** Bundled optional value-ledger args threaded into note/refresh/pin (absent → flat behavior). */
export interface EpisodicValueLedgerOptions {
    config?: EpisodicValueLedgerConfig;
    context?: EpisodicValueContext;
    weights?: EpisodicValueWeights;
}
/** Anchor strength by card kind: real work chains + rail targets are strongest. */
export declare function anchorKindScore(kind: EpisodicRecallCardLike['kind'] | undefined): number;
/** Stronger of two kinds by anchor score (a zone keeps its strongest-seen anchor). */
export declare function strongerEpisodicKind(a: EpisodicRecallCardLike['kind'] | undefined, b: EpisodicRecallCardLike['kind']): EpisodicRecallCardLike['kind'];
/**
 * Pure value of a resident zone in [0,1]: a weighted blend of engagement recency
 * (decays by boundary distance), engagement frequency, walk depth, anchor kind,
 * and optional host signals (claimed path, rail target). Deterministic; no I/O,
 * no Date.now — boundary distance is the only clock.
 */
export declare function scoreEpisodicZoneValue(targetPath: string, zone: EpisodicZoneResidency, context?: EpisodicValueContext, boundarySeq?: number, weights?: EpisodicValueWeights): number;
/** TTL multiplier anchored so value 0.5 → ×1.0 (neutral/unchanged), 0 → min, 1 → max. */
export declare function episodicValueTtlMultiplier(value: number, config: EpisodicValueLedgerConfig): number;
/** Effective residency TTL for a zone given its value; flat baseTtl when disabled. */
export declare function effectiveEpisodicZoneTtl(baseTtlBoundaries: number, value: number, config: EpisodicValueLedgerConfig): number;
export interface EpisodicInjectionState {
    /** Injectable-boundary counter (declined/disabled boundaries do not advance it). */
    boundarySeq: number;
    /** Cards from the last fired recall, awaiting injection at the next boundary. */
    stash: {
        cards: EpisodicRecallCardLike[];
        bornAtBoundary: number;
    } | null;
    /** Zone targetPath → sliding residency window. */
    zones: Map<string, EpisodicZoneResidency>;
    /** Raw-history index after the last assistant-text mention scan. */
    mentionScanIndex: number;
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
export declare function createEpisodicInjectionState(): EpisodicInjectionState;
/**
 * Drop expired zones only after their exact cards have left provider POV.
 * Hosts reconcile visibleCardHeaders after each fold epoch; between epochs an
 * injected card remains visible even if its old boundary TTL elapses.
 */
export declare function expireEpisodicZones(state: EpisodicInjectionState): void;
/** Union of live zones' served chapter ids — the recall payload's servedChapterIds. */
export declare function episodicServedChapterIds(state: EpisodicInjectionState): number[];
/** Chain targets whose walk-complete pointer has already been injected while the zone is live. */
export declare function episodicCompletedChainPaths(state: EpisodicInjectionState): string[];
/**
 * Live zones keyed by a term-cluster target ('term:...') — the recall payload's
 * servedTermKeys. Unlike servedChapterIds (which only blocks re-serving the
 * IDENTICAL episodes), a resident term key tells the worker the session already
 * holds a card for that term cluster, so near-duplicate sibling episodes under
 * the same cluster are skipped instead of re-fired on back-to-back boundaries.
 */
export declare function episodicServedTermKeys(state: EpisodicInjectionState): string[];
/**
 * Consume the stash if it is still fresh; drop it (counted as suppressed) when
 * it has aged past maxAge boundaries. Always clears the stash either way —
 * a result is injectable exactly once.
 */
export declare function consumeEpisodicStash(state: EpisodicInjectionState, maxAgeBoundaries?: number): EpisodicRecallCardLike[] | null;
/** Default N for the read-boundary serve rate: 1 new card per 3 gated boundaries. */
export declare const EPISODIC_READ_RATE_DEFAULT_BOUNDARIES = 3;
export type EpisodicBoundaryToolClass = 'edit' | 'rail_anchor' | 'gated';
/**
 * Classify the dispatched tool at an inject boundary for the read-rate gate.
 * Unknown/absent tool names classify as 'gated' — the conservative side: a
 * misclassified boundary rations recall, it never over-serves. TodoWrite is
 * excluded from the 'write' hint because a todo update is paperwork, not a
 * file edit; task_rail (bare or MCP-prefixed) anchors the rail bypass.
 */
export declare function classifyEpisodicBoundaryTool(toolName: string | null | undefined): EpisodicBoundaryToolClass;
/**
 * Pure parser for the read-rate knob (env VOXXO_FOLD_EPISODIC_READ_RATE_BOUNDARIES,
 * passed in as a raw string so the package stays host-agnostic). 0 disables the
 * gate (legacy serve-every-boundary behavior); absent/invalid/negative falls back
 * to EPISODIC_READ_RATE_DEFAULT_BOUNDARIES.
 */
export declare function resolveEpisodicReadRateBoundaries(raw: string | undefined): number;
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
export declare function consumeEpisodicStashRateGated(state: EpisodicInjectionState, options: EpisodicStashRateGateOptions): EpisodicRecallCardLike[] | null;
/** True only when every substantive narrative probe in a card is already in POV. */
export declare function episodicCardAlreadyInPov(card: EpisodicRecallCardLike, providerPovText: string): boolean;
/**
 * Suppress information-resident cards before noteEpisodicInjection mutates
 * served/walk state. Header replay is handled separately; this catches the
 * first circular injection when the source narration is already visible.
 */
export declare function suppressEpisodicCardsAlreadyInPov(state: EpisodicInjectionState, cards: readonly EpisodicRecallCardLike[] | null, providerPovText: string): EpisodicRecallCardLike[] | null;
/**
 * Record an injection: every served zone becomes (or stays) resident with a
 * fresh sliding TTL, served chapter ids merge into the zone's walk served-set,
 * and the breathing ledger tallies by tier (chain-grade = chain/walk/pointer,
 * episode-grade = mention).
 */
export declare function noteEpisodicInjection(state: EpisodicInjectionState, cards: readonly EpisodicRecallCardLike[], ttlBoundaries?: number, valueOptions?: EpisodicValueLedgerOptions): void;
/**
 * Sliding TTL: touching a live zone again pushes its expiry forward. Touch is
 * the ONLY residency-extending signal — a zone refreshes only when touchPaths
 * hits its exact targetPath. Mention-path recall is caller opt-in and never
 * extends TTL by itself, so a path that is only talked about (never re-touched)
 * lets its pin age out and fold on schedule. "Pin until the agent leaves the
 * path" == until the agent stops touching that same target path.
 */
export declare function refreshEpisodicZones(state: EpisodicInjectionState, touchPaths: readonly string[], ttlBoundaries?: number, valueOptions?: EpisodicValueLedgerOptions): void;
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
export declare function episodicCardHeaderLine(card: EpisodicRecallCardLike): string;
/** Header-line shapes a rendered episodic CARD can start with (hot/walk recall + completed chain). Excludes the `[Episodic recall …` block wrappers by construction. */
export declare const EPISODIC_CARD_HEADER_PREFIX_RE: RegExp;
/**
 * Collect the episodic card header lines present in a rendered view text (the
 * post-fold send view's concatenated message text). This is the resident-pin
 * set for idempotent active-path pins: a header here means a live copy already
 * occupies the window, so re-pasting it is pure duplication. Block wrappers
 * (`[Episodic recall …]`) start with "Episodic" and are deliberately not matched.
 * Pure CPU; cheap-exits when no episodic card text is present.
 */
export declare function collectResidentEpisodicHeaders(viewText: string): Set<string>;
/**
 * Replace the visible-card ledger from a committed post-fold view. Zones with
 * no surviving card header leave the served set immediately; surviving zones
 * keep their chronological cursor and completed-pointer suppression.
 */
export declare function reconcileVisibleEpisodicHeaders(state: EpisodicInjectionState, residentHeaders: ReadonlySet<string>): void;
/** Reconcile visible cards directly from a provider-ready folded message view. */
export declare function reconcileVisibleEpisodicView(state: EpisodicInjectionState, view: readonly {
    content: string | null | unknown[];
}[]): Set<string>;
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
export declare const EPISODIC_BOOKKEEPING_TOOLS: ReadonlySet<string>;
/** True when the dispatched tool is pure bookkeeping (see EPISODIC_BOOKKEEPING_TOOLS) — the seam skips the episodic inhale + pin on it. */
export declare function isEpisodicBookkeepingTool(toolName: string | null | undefined): boolean;
/**
 * Active path pins: while the current boundary is still touching a live zone,
 * keep that zone's hot card resident as logical working memory. The served-set
 * keeps walking backward separately; these cards do not advance counters.
 */
export declare function activeEpisodicPathCards(state: EpisodicInjectionState, touchPaths: readonly string[], options?: ActiveEpisodicPathCardOptions): EpisodicRecallCardLike[];
export declare function selectActiveEpisodicPathCards(state: EpisodicInjectionState, touchPaths: readonly string[], options?: ActiveEpisodicPathCardOptions): ActiveEpisodicPathCardSelection;
export interface ActiveEpisodicPathBlockOptions {
    charBudget?: number;
}
/**
 * Render active pins as their own synthetic episodic block. This re-pages the
 * hot chapter while the path stays active, but once zone TTL expires no new
 * copy is emitted and the old prompt copy can fold away normally.
 */
export declare function renderActiveEpisodicPathBlock(cards: readonly EpisodicRecallCardLike[], syntheticPrefix: string, options?: ActiveEpisodicPathBlockOptions): string | null;
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
export declare const EPISODIC_NARRATION_REMINDER = "[\uD83D\uDDE3 above is recovered agent voice \u2014 it survived into memory because an agent tagged its messages by register. Open yours with one of \uD83D\uDD0D working \u00B7 \u25B6 executing \u00B7 \uD83C\uDFC1 verdict \u00B7 \u26A0\uFE0F hazard \u00B7 \u2753 blocked and future agents inherit your conclusions the same way.]";
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
export declare function formatEpisodicCardProvenance(card: EpisodicRecallCardLike): string;
/**
 * Render the per-boundary episodic block. The header line MUST start with the
 * synthetic episodic prefix (passed in — this module imports nothing) so the
 * fold excludes the block from real-turn detection and signal extraction, and
 * ages it out cyclically exactly like recall cards.
 */
export declare function renderEpisodicBoundaryBlock(cards: readonly EpisodicRecallCardLike[], syntheticPrefix: string, counterFooter?: string, narrationReminder?: string): string | null;
/**
 * Extract mention-tier paths from AGENT-AUTHORED prose. The caller guarantees
 * the texts are assistant-authored (structural self-excitation guard: injected
 * cards ride user-role tool results, so the matcher never reads its own
 * output); isSyntheticLine strips any quoted card/fold lines as defense in
 * depth. Tokens must look like files (final-segment extension) and pass the
 * membership predicate; the cap bounds worker lookup cost — unknown paths are
 * harmless store misses, so prose noise like "Node.js" costs one indexed miss.
 */
export declare function extractEpisodeMentionPaths(texts: readonly string[], isSyntheticLine: (line: string) => boolean, cap?: number): string[];
