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
 *   the folded-view fold blocks' "N turns folded" counts (summed in view order —
 *   FC append-only tail epochs seal one fold block per band); intra-turn
 *   entries by scanning the folded view for the fold's own
 *   "[Folded: tool path — n,nnn chars | self-tap to recover]" markers, keyed
 *   by provider tool ids (tool_use_id / tool_call_id) as recovery handles.
 * - TRIGGERS (tool-boundary only): tier 0 = a tool call re-touches a folded
 *   path; tier 1 = a file claim lands on a folded path. Tier 2 distinctive-term
 *   overlap is default ON after rail-c63e326e A/B; disable with
 *   WARP_FOLD_RECALL_TERMS=0|false|off|no.
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
 * explicitly ordered: tier asc, tier-2 relevance desc, recency desc, id asc).
 *
 * Kill switch: WARP_FOLD_RECALL=0. Recall only ever runs when fold mode is
 * 'on' and the fold freeze is active — no fold, no index, no recall.
 */
import { type FoldMessage, type SyntheticContextOptions, type Turn, type TurnCategory } from './rollingFold.ts';
import type { ContextUtilizationLevel } from './contextWindow.ts';
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
    /** Tier-2 distinctive-term matching. Default ON after A/B; path tiers stay unchanged. */
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
    /**
     * Episodic voice carriers (WARP_FOLD_RECALL_EPISODES).
     * Prepends self-lineage episode voice lines for recalled paths. Default ON.
     * Same residency/byte-identity contract.
     */
    episodesEnabled: boolean;
    /**
     * Atlas identity metadata carrier (WARP_FOLD_RECALL_ATLAS_META).
     * Prepends purpose/blurb and tags for recalled paths. Default ON; renders
     * only when pathAtlasMeta is resident, so empty/missing remains byte-identical.
     */
    atlasMetaEnabled: boolean;
}
export declare const DEFAULT_FOLD_RECALL_CONFIG: FoldRecallConfig;
/** Minimum remaining char budget worth spending on a card; below this, downgrade to hint. */
export declare const MIN_USEFUL_CARD_CHARS = 400;
/**
 * Reserved gap subtracted from the remaining pass budget before sizing a card
 * body (see the bodyBudget computation in renderRecallPlan), so a rendered
 * card's trailing punctuation/metadata never exactly exhausts the pass
 * budget. Named + exported so validateFoldGeometry() shares the same source
 * of truth as the render path instead of duplicating the literal.
 */
export declare const RECALL_BODY_RESERVED_GAP_CHARS = 200;
/**
 * Repeat-recall card shrink (rail-c63e326e s6). A path that has already been
 * carded once or more this session and has NOT changed content since (see
 * `RecallSourceDelta.stableSincePrior`, or no live-source info at all — the
 * folded historical entry itself is fixed regardless of live source
 * tracking) does not need the full body budget again: the agent has already
 * seen it. Each repeat multiplies the available body budget by this ratio,
 * floored at REPEAT_CARD_MIN_RATIO so a card never shrinks to uselessness —
 * MIN_USEFUL_CARD_CHARS still governs the eventual card→hint downgrade.
 */
export declare const REPEAT_CARD_SHRINK_RATIO = 0.6;
/** Floor on the cumulative shrink multiplier — never shrink a repeat card below 35% of its unshrunk budget. */
export declare const REPEAT_CARD_MIN_RATIO = 0.35;
/**
 * Pure arithmetic: the body-budget multiplier for the (priorShowCount+1)-th
 * card injection of the same path this session. priorShowCount=0 (first-ever
 * card for this path) → 1 (no shrink). Deterministic, no I/O.
 */
export declare function repeatCardBudgetRatio(priorShowCount: number): number;
/**
 * Historical bug: ttlPasses=8 vs activeWindowTurns=1 (buffer=7) created a
 * 7-pass recall dead zone where a folded marker was present but the card
 * could not re-show (rail-ed5588b5, fixed 2026-06-24; refined further by
 * rail-dccaa1a1 on 2026-07-02). The fix landed at ttlPasses=4 (buffer=3).
 * Ceiling is set with headroom above the fixed value for legitimate tuning,
 * while still catching a regression back toward the old buggy shape.
 */
export declare const MAX_TTL_DEADZONE_BUFFER_PASSES = 5;
export interface FoldGeometryInputs {
    /** Recall residency TTL in passes (FoldRecallConfig.ttlPasses). */
    ttlPasses: number;
    /** Inter-turn fold's guaranteed-verbatim window in turns (FoldConfig.activeWindowTurns). */
    activeWindowTurns: number;
    /** Fidelity-value eviction floor in turns (DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS or override). */
    recencyFloorTurns: number;
    /** FoldRecallConfig.maxTotalChars. */
    maxTotalChars: number;
    /** FoldRecallConfig.maxCardChars. */
    maxCardChars: number;
}
export interface FoldGeometryViolation {
    rule: 'ttl-deadzone' | 'recency-floor-below-window' | 'auto-compact-card-too-small';
    message: string;
}
/**
 * Pure cross-knob invariant checker for fold/recall geometry. Each rule
 * encodes a specific interaction class that has previously shipped as a live
 * dogfood regression (see file history for rail-ed5588b5 / rail-dccaa1a1)
 * before being caught and fixed by hand. This does not prove the geometry is
 * "correct" — it only catches a regression back toward a known-bad shape, or
 * flags a genuinely new bad combination in the same families. Violations are
 * data for the caller to log/assert on in dev/test; this function itself
 * never throws or logs, keeping it pure and safe to call from any context.
 */
export declare function validateFoldGeometry(inputs: FoldGeometryInputs): FoldGeometryViolation[];
/**
 * Resolve config from environment. Default ON (recall is already gated on
 * fold mode 'on' + an active fold-freeze index upstream).
 *   WARP_FOLD_RECALL=0|false|off|no       → disable
 *   WARP_FOLD_RECALL_MAX_CARDS=<n>        → cards per pass (default 3; band-coupled)
 *   WARP_FOLD_RECALL_MAX_TOTAL_CHARS=<n>  → total chars per pass (default 12000)
 *   WARP_FOLD_RECALL_MAX_CARD_CHARS=<n>   → chars per card body (default 6000)
 *   WARP_FOLD_RECALL_TTL_PASSES=<n>       → residency TTL in passes (default 4)
 *   WARP_FOLD_RECALL_TERMS=0|false|off|no → disable tier-2 term matching (default ON)
 *   WARP_FOLD_RECALL_VERBATIM=0|false|off|no → disable exact verbatim-token tier (default ON)
 *   WARP_FOLD_RECALL_HIGHLIGHTS=0|false|off|no → disable source-highlight radar (default ON)
 *   WARP_FOLD_RECALL_HAZARDS=0|false|off|no → disable hazard radar (default ON)
 *   WARP_FOLD_RECALL_EPISODES=0|false|off|no → disable episodic voice (default ON)
 *   WARP_FOLD_RECALL_ATLAS_META=0|false|off|no → disable Atlas identity meta (default ON)
 */
export declare function resolveFoldRecallConfig(env?: Record<string, string | undefined>): FoldRecallConfig;
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
export declare function extractPathsFromBashCommand(command: string): string[];
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
    /**
     * Exact fold-recall card blocks still literally present in the built view.
     * Undefined means a legacy/manually-built index that cannot answer residency
     * by view presence; buildFoldIndex always supplies a bounded array.
     */
    visibleRecallCards?: readonly string[];
    /**
     * Normalized text of the provider-ready view used to build this index. This
     * is the information-residency surface: recall must not page in a body that
     * is already literally present elsewhere in the model's POV just because it
     * is not wrapped in a prior recall card. Bounded and optional for legacy
     * manually-built indexes.
     */
    visiblePovText?: string;
}
/** Provider-view text retained for literal information-residency checks. */
export declare const FOLD_RECALL_POV_TEXT_MAX_CHARS = 96000;
/** Whitespace/quote-stable normalization for exact provider-POV containment. */
export declare function normalizeFoldRecallPovText(text: string): string;
/**
 * Current provider-visible text: the last committed folded view plus the raw
 * messages appended since that view/index was built. Pure and bounded; callers
 * may pass null during pre-fold warmup.
 */
export declare function foldRecallProviderPovText(index: FoldRecallIndex | null | undefined, rawHistory: readonly FoldMessage[] | null | undefined): string;
/**
 * Active-window text for tier-2 distinctive-term matching: the user- and
 * assistant-authored text of the live, unfolded raw tail (messages added since
 * the fold index was last built — raw.slice(foldedRawCount)). Mirrors
 * buildTurnDigest's surface (first real user text + assistant text; tool results
 * and synthetic recall/fold blocks excluded) so the query terms and the index's
 * per-turn digest terms are drawn from the same vocabulary. Recency-favored cap
 * keeps extraction cheap and focused on current cognition. Pure; returns ''
 * when the unfolded tail is empty or when term recall is explicitly disabled.
 */
export declare function extractActiveWindowText(rawHistory: readonly FoldMessage[], foldedRawCount: number, syntheticContext?: SyntheticContextOptions): string;
/**
 * Build the fold index (page table) from the raw history and the freshly
 * recomputed folded view. Call ONLY at fold-freeze epoch commits — the fold
 * is deterministic, so replaying detectTurns over raw plus summing the view's
 * fold-block counts (one block per sealed band on FC append-only tail epochs;
 * a single cumulative block on whole-view rebuilds) reproduces exactly which turns
 * folded, with zero extra fold passes and zero I/O.
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
 *
 * seedFoldsEntireRaw (BuildFoldIndexOptions): hard-epoch portable-reset case.
 * The foldedView is a flattened rebirth-package seed that carries NO
 * "[Conversation Context — N turns folded]" block marker, yet the ENTIRE
 * pre-reset raw history (minus the trailing live turn) folded into it. Without
 * a marker the inter-turn gate stays 0 and the page table comes back empty, so
 * recall would go dormant across portable resets. When this flag is set and no
 * marker is found, the folded-turn count is taken from the detected raw turns
 * (clamped to all-but-the-live-turn) so every pre-reset turn becomes
 * recall-addressable against the retained (push-based) raw backing store.
 */
export interface BuildFoldIndexOptions {
    /**
     * Hard-epoch markerless seed: treat the whole pre-reset raw as folded when the
     * foldedView carries no fold-block count marker. Default false ⇒ legacy
     * marker-gated behavior (byte-identical for all existing callers).
     */
    seedFoldsEntireRaw?: boolean;
}
export declare function buildFoldIndex(rawHistory: readonly FoldMessage[], foldedView: readonly FoldMessage[], precomputedTurns?: readonly Turn[], syntheticContext?: SyntheticContextOptions, options?: BuildFoldIndexOptions): FoldRecallIndex;
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
    /**
     * Set by the relay when this path's full-file liveHash is unchanged since the
     * prior epoch's snapshot. Lets the renderer suppress a *repeat* beyond-window
     * fresh-read nudge for a settled (unchanged) file, while the first epoch a
     * change appears (liveHash differs) still warns.
     */
    stableSincePrior?: boolean;
}
/**
 * Pre-rendered episodic voice for a recalled path. Each entry carries the
 * agent's own words from past work bursts on this path — already rendered
 * and attributed by the fold-episodes worker using the canonical episode
 * voice renderer helpers (changelog, tap_star, chatroom). foldRecall must NOT
 * parse annotation kinds or invent a second attribution scheme; it renders
 * voiceLines verbatim into the recall card.
 */
export interface EpisodeVoice {
    /** Normalized workspace-relative path that triggered the episode recall. */
    path: string;
    /** Pre-rendered, already-attributed voice lines from the episode chain. */
    voiceLines: string[];
    /** The operator ask that motivated the work burst, or null. */
    intent: string | null;
    /** Chapter IDs in the episode chain for this path. */
    chapterIds: number[];
    /** ISO-8601 timestamp of when the episode ended. */
    endedAt: string;
}
/**
 * Atlas file identity metadata for a recalled path. Carries the timeless
 * identity fields (purpose, blurb, tags) from the Atlas record — the same
 * fields that appear in Ambient Atlas blocks. Does NOT duplicate
 * highlights/hazards (those already ride pathHighlights/pathHazards).
 */
export interface AtlasFileMeta {
    /** Normalized workspace-relative path. */
    path: string;
    /** Timeless file purpose from Atlas (null when not curated). */
    purpose: string | null;
    /** Short one-line file identity from Atlas (null when not curated). */
    blurb: string | null;
    /** Canonical tag list from Atlas (empty when not curated). */
    tags: string[];
}
export interface ResidencyRecord {
    level: 'card' | 'hint';
    /** Pass number at which TTL fallback expires (suppression while passSeq < expiresAtPass). */
    expiresAtPass: number;
    /**
     * Exact rendered card text that created CARD path residency. When present and
     * the index has moved since injection, suppression follows literal view
     * presence instead of this pass-count fallback.
     */
    renderedCard?: string;
    /** Fold-index signature in force when `renderedCard` was injected. */
    indexSignature?: string;
}
export interface FoldRecallState {
    index: FoldRecallIndex | null;
    /** entryId → residency. Map iteration order is never observable in output. */
    resident: Map<string, ResidencyRecord>;
    /**
     * Normalized path → lifetime count of CARD-level injections this session
     * (rail-c63e326e s6). Unlike `residentPaths`, this NEVER expires or gets
     * cleared on index rebuild — it is a pure session-lifetime counter used
     * only to shrink same-content repeat cards, never to suppress them.
     */
    pathCardShowCounts: Map<string, number>;
    /**
     * Normalized path → CARD residency. Content-level suppression that survives
     * index rebuilds only while the exact rendered card is still literally present
     * in the rebuilt view. TTL remains a bounded cleanup fallback for legacy/manual
     * indexes and same-index immediate repeats.
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
    /**
     * Episodic voice carriers: normalized path → EpisodeVoice entries from the
     * caller's own lineage episode chain. Populated OFF-THREAD by the relay
     * after epoch boundaries via foldEpisodes:recallEnrichment. Empty in
     * standalone/no-host mode → recall degrades to byte-identical output.
     */
    pathEpisodes: Map<string, EpisodeVoice[]>;
    /**
     * Optional Atlas file identity metadata carriers: normalized path →
     * AtlasFileMeta (purpose, blurb, tags). Populated OFF-THREAD by the relay
     * alongside the atlas:recallEnrichment batch. Optional for package API
     * compatibility; missing = empty (byte-identical). Does NOT duplicate
     * pathHighlights/pathHazards.
     */
    pathAtlasMeta?: Map<string, AtlasFileMeta>;
    /** Recall pass counter — one pass per tool boundary that carried signals. */
    passSeq: number;
    /**
     * Signature of the index seen on the previous pass (rawCount|firstId|lastId).
     * When the index is rebuilt by a freeze epoch (refold), the entry ids change
     * identity even though path residency stays content-keyed — so entry-id
     * residency must be cleared on index change to avoid suppressing a genuinely
     * fresh refolded entry that legitimately re-cards. Path residency survives
     * (content-keyed, intentionally post-refold-stable). null/undefined =
     * first pass (undefined preserves compatibility with older state objects).
     */
    lastIndexSignature?: string | null;
    /** Last bounded suppressed-manifest composition shown to the provider. */
    lastSuppressedManifestKey?: string | null;
    /** Matching suppression passes since that manifest was last shown. */
    suppressedManifestQuietPasses?: number;
    cardsInjected: number;
    hintsInjected: number;
    recallChars: number;
    suppressed: number;
}
export declare function createFoldRecallState(): FoldRecallState;
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
export declare function radarDuplicatesActiveAtlasRead(toolName: string | null | undefined, action: unknown): boolean;
/**
 * True when the dispatched tool is an Atlas DISCOVERY read whose text output
 * leads each result line with a workspace path: search (`atlas_search` or
 * `atlas_query action=search`), catalog, and cluster. lookup/brief/snippet/
 * history/graph/diff are excluded — they render per-file bodies or analytics,
 * not a path-led result list. Gating here is what keeps arbitrary tool stdout
 * (and non-discovery Atlas reads) from ever becoming a recall trigger source.
 */
export declare function isAtlasDiscoveryResultTool(toolName: string | null | undefined, action: unknown): boolean;
/**
 * Extract bounded path anchors from Atlas discovery result text (search,
 * catalog, cluster). Intentionally narrower than generic output parsing: only
 * Atlas discovery tools qualify (isAtlasDiscoveryResultTool) and only leading
 * result paths are accepted, so arbitrary tool stdout cannot become a recall
 * trigger source. Bounded by construction: at most the first 200 lines are
 * scanned and at most maxPaths anchors are returned.
 */
export declare function extractAtlasSearchResultPaths(toolName: string | null | undefined, action: unknown, output: string | null | undefined, maxPaths?: number): string[];
/**
 * Derive recall signals at a tool boundary from the just-executed tool call,
 * the current global claims set, and optional active-window text for tier-2
 * distinctive-term matching. The term tier is config-gated default OFF.
 */
export declare function extractRecallSignals(toolInput: Record<string, unknown> | null, claimedPaths: ReadonlySet<string>, activeText?: string | readonly string[]): RecallSignals;
/**
 * Compose the tool-boundary recall query exactly as the live GET path consumes
 * it: derive active-window terms ('' when term recall is explicitly off), build
 * signals, and decide whether recall should proceed. `proceed` mirrors
 * buildFoldRecallContext's internal admit guard — path-touch OR claim OR
 * distinctive term signals — so pathless cognition is no longer short-circuited
 * before terms are weighed.
 * Pure; the single seam shared by the live caller and its wiring tests.
 */
export declare function deriveBoundaryRecallSignals(toolInput: Record<string, unknown> | null, claimedPaths: ReadonlySet<string>, rawHistory: readonly FoldMessage[], foldedRawCount: number, config: FoldRecallConfig, syntheticContext?: SyntheticContextOptions): {
    signals: RecallSignals;
    proceed: boolean;
};
export type RecallTier = 0 | 1 | 2;
export interface RecallPlanItem {
    entry: FoldIndexEntry;
    tier: RecallTier;
    /** Matched path for tiers 0/1; a deterministic term-residency key for tier 2. */
    matchedPath: string;
    trigger: string;
    /** Tier-2 relevance only; path tiers continue to sort by recency. */
    relevanceScore?: number;
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
/**
 * BENCHED (tier-1b). Convert import-graph distance to a 0-1 booster signal:
 * distance 0 (same file / direct dependency) → 1.0; distance ∞ (cross-cluster) →
 * 0 (no boost, NO penalty). Formula: max(0, 1 - distance / 6) — the 6-hop bound
 * matches the host impact graph's max traversal depth.
 */
export declare function distanceToBooster(distance: number): number;
/**
 * BENCHED (tier-1b). Blend behavioral affinity with the import-graph booster.
 * Booster-only invariant: the result is never below the behavioral baseline (import
 * distance only RAISES a score, never penalizes). Cold-start (behavioral 0) falls
 * back to the booster.
 * finalScore = max(behavioral, behavioral*BEHAVIORAL_WEIGHT + importBooster*IMPORT_BOOSTER_WEIGHT)
 */
export declare function blendScores(behavioral: number, importBooster: number): number;
/**
 * Plan which folded entries to page back in this pass. Pure — reads residency,
 * never mutates. Ordering is fully deterministic: tier asc, tier-2 relevance
 * desc, recency desc, id asc. Path tiers keep their recency ordering; only
 * fuzzy/exact tier-2 matches spend card budget by relevance before falling
 * back to recency. Residency: resident cards suppress (by entry id AND by
 * content path — path residency survives index rebuilds); resident hints
 * escalate to card-eligible on a fresh hard trigger (tiers 0-1 are both hard
 * in v1) and suppress otherwise.
 */
export declare function planRecall(index: FoldRecallIndex, resident: ReadonlyMap<string, ResidencyRecord>, residentPaths: ReadonlyMap<string, ResidencyRecord>, passSeq: number, signals: RecallSignals, utilization: ContextUtilizationLevel, config: FoldRecallConfig): RecallPlan;
/**
 * Head+tail excerpt with an omission note, char-safe on multibyte content.
 * Returns the input unchanged when it fits.
 */
export declare function excerptForRecall(text: string, maxChars: number): string;
/**
 * Strip previously-injected recall blocks from text before re-recalling it.
 * Feedback-loop guard: injected cards land inside tool results in raw
 * history; when that turn later folds and is itself recalled, re-quoting the
 * embedded card would nest stale copies and double-spend budget.
 */
export declare function stripRecallBlocks(text: string): string;
/** Find the original (pre-fold) tool result text in raw history by tool id. */
export declare function findToolResultText(rawHistory: readonly FoldMessage[], toolId: string): string | null;
/**
 * Compact source-highlight radar — Atlas-curated guideposts to a touched file's
 * key regions, rendered as `⌖ label (a–b)` lines. Deterministic (startLine asc),
 * bounded by RECALL_RADAR_MAX_LINES and charBudget. Returns '' when nothing fits.
 */
export declare function formatHighlightsRadar(highlights: readonly RecallSourceHighlight[], charBudget: number): string;
/**
 * Compact hazard radar — `⚠️ text (L85)` / `⚠️ text (L85–95)` for ranged hazards,
 * `⚠️ text` for file-level (null range). Ranged hazards sort by startLine asc;
 * file-level hazards sort last. Deterministic, bounded. '' when nothing fits.
 */
export declare function formatHazardRadar(hazards: readonly RecallHazard[], charBudget: number): string;
/** Where a pass's injected card chars went + how many bodies were swapped. */
export interface RecallCompositionStats {
    /** Chars of body excerpts across injected cards. */
    bodyChars: number;
    /** Chars of source-delta notifier blocks. */
    notifierChars: number;
    /** Chars of Curated Code Radar blocks. */
    radarChars: number;
    /** Chars of episodic voice blocks. */
    episodeVoiceChars: number;
    /** Chars of Atlas identity metadata blocks. */
    atlasMetaChars: number;
    /** Paths whose card body was swapped to CURRENT box source (claim-tier). */
    swappedPaths: number;
}
export interface FoldRecallOutcome {
    /** Rendered body-only recall block, or null when nothing injects. */
    text: string | null;
    cards: number;
    hints: number;
    chars: number;
    suppressed: number;
    /** Bounded paths/source-coordinates-only account of bodies withheld this pass. */
    suppressedManifest?: string;
    triggers: string[];
    /**
     * Additive per-pass card composition breakdown — answers "where did the
     * injected chars go, and were any bodies swapped to current source?".
     * Present only when at least one card rendered this pass; optional so
     * standalone hosts consuming FoldRecallOutcome are unaffected.
     */
    composition?: RecallCompositionStats;
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
export declare function buildFoldRecallContext(state: FoldRecallState, rawHistory: readonly FoldMessage[], signals: RecallSignals, utilization: ContextUtilizationLevel, config: FoldRecallConfig, syntheticContext?: SyntheticContextOptions): FoldRecallOutcome;
