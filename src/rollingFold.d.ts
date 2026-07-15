/**
 * Rolling Fold Compaction — deterministic heuristic compression of old
 * conversation turns into structural skeletons.
 *
 * Zero LLM calls. Character-count triggered. Session-agnostic.
 *
 * Pipeline position: raw transcript -> stepCompaction -> thinContext() -> foldContext() -> repair -> API.
 * Raw transcript is NEVER mutated. Folding produces a view.
 */
export interface FoldMessage {
    role: string;
    content: string | null | unknown[];
    reasoning_content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: unknown;
    name?: unknown;
    /**
     * Epoch-millisecond timestamp of the original message creation time. When
     * present, folded-turn skeletons render a [HH:MM AM/PM] prefix so the band
     * body reads chronologically and a successor can position completed work
     * relative to user messages and the rebirth seed. Optional — older code
     * paths that don't populate it produce identical (timestampless) output.
     */
    tsMs?: number;
}
export type TurnCategory = 'research' | 'action' | 'decision' | 'navigation' | 'error' | 'coordination';
export type FoldMode = 'off' | 'dry-run' | 'on';
export interface AssistantTextBudget {
    /** Cumulative chars of assistant text to preserve at full fidelity (newest folded turns first). */
    fullRetentionChars: number;
    /** Cumulative chars to preserve via essence extraction (after full budget exhausted). */
    essenceRetentionChars: number;
}
export interface FoldConfig {
    /** Number of recent turns kept out of threshold-gated, non-continuous folds. */
    activeWindowTurns: number;
    /** Char-count soft threshold — fold oldest ~30% of foldable turns when exceeded. */
    softThresholdChars: number;
    /** Char-count hard threshold — fold oldest ~60% of foldable turns. */
    hardThresholdChars: number;
    /** Maximum turns before folding regardless of char count. */
    maxTurnsBeforeFold: number;
    /** Budget-based graduated compression for assistant text in folded turns.
     *  Replaces the old category-gated approach where nav/coord/error turns lost all text. */
    assistantTextBudget?: AssistantTextBudget;
    /** When true, fold every detected turn on every call, bypassing the soft/hard
     *  char and maxTurns thresholds (continuous always-on inter-turn fold).
     *  assistantTextBudget still governs graduated per-turn detail. Default config
     *  leaves this undefined -> existing threshold-gated behavior is unchanged. */
    continuous?: boolean;
    /**
     * Preserve the newest user text inside the fold block when a fold consumes the
     * whole view. Defaults to true for ordinary folds; cold append bands disable it
     * because vault/cognitive deltas carry continuity and the band must collapse.
     */
    retainNewestUserTextInFoldBlock?: boolean;
    /**
     * Budget in chars for the Coordinate Closet appended to the fold block.
     * Set 0 to disable. Default: 4000.
     */
    verbatimKeepChars?: number;
    /**
     * Coordinate literals already resident in an immutable earlier band. Append
     * folds use this corpus only as a conservation fence, so a new closet never
     * repeats an id/path/value already carried by the frozen prefix.
     */
    priorCoordinateCorpus?: string;
    /**
     * Host-specific preamble rendered inside each fold block. Defaults to the
     * package preamble; override only when a host lacks the default recall hooks.
     */
    foldBlockPreamble?: string;
}
export interface FoldedTurn {
    timestamp: string;
    /**
     * Original message creation time rendered before the skeleton when available.
     * Absent for older callers so their folded block text stays unchanged.
     */
    skeletonTimestamp?: string;
    category: TurnCategory;
    skeleton: string;
    retained?: string;
    charsSaved: number;
}
export interface FoldResult {
    messages: FoldMessage[];
    originalChars: number;
    foldedChars: number;
    savingsPercent: number;
    turnsFolded: number;
    turnsRetained: number;
    foldSummaries: FoldedTurn[];
    /** Updated eviction span state (present only when a FoldEvictionInput was provided). */
    evictedSpans?: FoldEvictionSpan[];
    /** Turns newly tombstoned this pass (present only when a FoldEvictionInput was provided). */
    newlyEvictedTurns?: number;
    /** Whole-view-rebuild eviction decision when a caller supplied a targeted eviction frontier. */
    evictionOutcome?: FoldEvictionOutcome;
}
export type FoldEvictionOutcome = 'evicted' | 'partial_frontier_limited' | 'nothing_eligible';
export interface FoldTrigger {
    shouldFold: boolean;
    turnsToFold: number;
    reason: string;
}
/**
 * A contiguous run of evicted fold ordinals rendered as ONE tombstone line
 * (E10 eviction). Ordinals are detectTurns positions over the folded
 * history — stable across epochs because raw history is append-only and
 * eviction is strictly oldest-first, so spans always tile a contiguous prefix
 * [0, toOrdinalExclusive) of the fold zone.
 */
export interface FoldEvictionSpan {
    /** First evicted turn ordinal (inclusive), in detectTurns order. */
    fromOrdinal: number;
    /** One past the last evicted turn ordinal. */
    toOrdinalExclusive: number;
    /** Turns evicted in this span (merged spans sum their counts). */
    turnCount: number;
    /** ISO timestamp of the oldest eviction event merged into this span. */
    firstEvictedIso: string;
    /** ISO timestamp of the newest eviction event merged into this span. */
    lastEvictedIso: string;
}
/**
 * Eviction input for one foldContext pass (E10). Provided ONLY by the freeze
 * EPOCH recompute path — the prefix is recomputing anyway, so tombstone
 * substitution is cache-safe by construction. Eligibility is computed by the
 * session (durable episodic-store coverage ∧ ≥2-epoch fold age); foldContext
 * applies geometry only.
 */
export interface FoldEvictionInput {
    /** Spans evicted at prior epochs, ascending and contiguous from ordinal 0. */
    evictedSpans: readonly FoldEvictionSpan[];
    /** Ordinals below this may be NEWLY evicted this pass. */
    evictableThroughOrdinal: number;
    /**
     * Optional whole-view-rebuild target: advance the tombstone frontier at least this
     * far, clamped by evictableThroughOrdinal and the current fold zone. When
     * absent, foldContext keeps the legacy threshold sawtooth behavior.
     */
    targetEvictThroughOrdinal?: number;
    /** Fold-block char threshold/enabled gate (VOXXO_FOLD_EVICT_THRESHOLD_CHARS). */
    thresholdChars: number;
    /** Wall-clock stamp for spans created this pass (injected for determinism). */
    nowIso: string;
}
export declare const DEFAULT_ASSISTANT_TEXT_BUDGET: AssistantTextBudget;
export declare const DEFAULT_FOLD_CONFIG: FoldConfig;
/**
 * Always-on inter-turn fold config — compresses every turn past the active
 * window into a skeleton on every call, regardless of char/turn thresholds, so
 * historical context stays lean from the moment the conversation grows past
 * activeWindowTurns. Used when an instance's rollingFold mode is 'on' (or
 * 'dry-run' for preview). This is the inter-turn sibling of
 * ALWAYS_ON_INTRA_FOLD_CONFIG: intra-turn slims consumed tool results inside the
 * working set; this slims the narrative history behind it.
 *
 * "Cheaper but still adequate signal": the soft/hard char + maxTurns gates are
 * bypassed (continuous: true → checkFoldTrigger folds all foldable turns every
 * turn), but every signal-preservation rule that made threshold-gated folding
 * safe is unchanged:
 *   - continuous folding has no hidden newest-turn floor: when enabled it asks
 *     foldContext to fold every detected turn. Non-continuous threshold folding
 *     still uses activeWindowTurns as its trigger hysteresis.
 *   - assistantTextBudget (50K full / 100K essence, allocated newest-first)
 *     governs graduated per-turn detail: newest folded turns keep their full
 *     assistant text, older turns keep an essence summary, only the oldest
 *     collapse to a pure tool-call skeleton. Reasoning degrades
 *     gradually, never cliff-edged — the exact machinery added (5/14) to fix the
 *     two layers of reasoning loss that category-gated folding caused.
 *   - the fold is recoverable, not destructive — foldContext returns a new array
 *     and never mutates the raw JSONL, so any folded turn is one self-tap away.
 *
 * Continuous mode can fold even a single detected turn; when that folds the whole
 * view, the newest user text is retained inside the folded block and the output
 * ends on the folded user message.
 */
export declare const ALWAYS_ON_FOLD_CONFIG: FoldConfig;
/**
 * Default chars-per-token assumption for converting a token-denominated band
 * target into a char budget. Claude-calibrated (~4). Denser-tokenizing engines
 * (code/JSON/path-heavy transcripts) can pass a lower ratio so a given
 * token-denominated band target (100K by default; callers may pass their own
 * live-resolved band, e.g. M40) yields a correspondingly smaller char budget
 * — i.e. the band stays pinned to real tokens, not chars. Passing 100K
 * explicitly reproduces every existing fold constant EXACTLY
 * (base-equivalence, locked by tests).
 */
export declare const BAND_CHARS_PER_TOKEN = 4;
/** Public steady-state fold-band default for omitted/undefined band targets. */
export declare const DEFAULT_FOLD_BAND_TOKENS = 100000;
export interface FoldBandBudgets {
    bandTokens: number;
    /** bandTokens × charsPerToken (default 4). */
    bandChars: number;
    /** 12.5% of band chars → assistantTextBudget.fullRetentionChars (50K at the 100K base band). */
    fullRetentionChars: number;
    /** 25% of band chars → assistantTextBudget.essenceRetentionChars (100K at the 100K base band). */
    essenceRetentionChars: number;
    /** 5.5% of band chars → fold-block eviction threshold (22K at the 100K base band; see E10). */
    evictThresholdChars: number;
    /** 0.5% of band chars → episodic boundary char budget (2K at the 100K base band; see foldEpisodes.ts). */
    episodicBoundaryBudgetChars: number;
}
/**
 * Optional fidelity overrides — when provided by the governor, these replace
 * the default 0.125/0.25 multipliers. Allows quality-driven ratio adjustment
 * without changing band size.
 */
export interface FidelityOverrides {
    /** Fraction of bandChars for full retention. Overrides default 0.125. */
    fullRetentionFraction?: number;
    /** Fraction of bandChars for essence retention. Overrides default 0.25. */
    essenceRetentionFraction?: number;
}
/**
 * Cherry-picked graduated fidelity — intrinsic trace value weights.
 *
 * The default budget allocation is a pure recency ramp (newest folded turns win
 * full/essence, oldest collapse to skeleton) regardless of whether an old turn
 * is still relevant. FidelityOverrides only tunes the GLOBAL full/essence
 * fractions; it cannot promote a specific high-value old turn. These weights
 * drive that per-turn cherry-pick, scoring value INTRINSICALLY from the trace
 * (forward path re-reference + durable glyph) — never from the episodic store.
 */
export interface FidelityValueWeights {
    /** Downstream reference where a later turn READS the same path. */
    read: number;
    /** Downstream reference where a later turn CLAIMS the same path (commits to working there). */
    claim: number;
    /** Downstream reference where a later turn EDITS the same path. */
    edit: number;
    /**
     * Downstream reference where a later turn NAMES the same path in the
     * user's own words (rail-c63e326e s5) — a file path Jonah explicitly
     * mentions in a user message, extracted via `extractUserNamedPaths`.
     * Deliberately weighted at least as high as `edit`: an operator naming a
     * path is the strongest relevance signal available (stronger than the
     * agent's own downstream tool-call behavior), so a turn an operator later
     * calls back to by name should not decay just because no tool call
     * happened to touch it.
     */
    userNamed: number;
    /** Multiplier when the downstream reference is in the live active window, not just a later folded turn. */
    activeWindowMultiplier: number;
    /** Additive bonus when the folded turn's assistant text opens with a durable register glyph (🏁 verdict / ⚠️ hazard). */
    glyphDurableBonus: number;
    /**
     * Register-shaped folding (rail-d70d3388 s7): additive PENALTY subtracted
     * from a folded turn that opens with a transient register glyph (🔍 in
     * progress / ▶ executing) when a LATER turn that touches at least one of
     * the same paths opens with a durable glyph (🏁 / ⚠️). The chain
     * 🔍🔍🔍🏁 marks which turn carried the conclusion — the superseded
     * investigation folds harder while the verdict keeps its bonus. Scores are
     * ranking-only (sorted desc before budget allocation), so a resulting
     * negative score is safe: it just folds hardest. Transient turns with no
     * later same-path durable conclusion are untouched, and untagged prose is
     * never penalized — behavior remains byte-identical at 0% glyph compliance.
     */
    glyphTransientDiscount: number;
}
export declare const DEFAULT_FIDELITY_VALUE_WEIGHTS: FidelityValueWeights;
/** Newest folded turns always allocated before value ranking — the working-set recency floor. */
export declare const DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS = 8;
/**
 * Per-call input enabling intrinsic value-aware graduated fidelity. Provided
 * ONLY by the freeze EPOCH whole-view rebuild path (cache-safe by construction, the
 * same gate as FoldEvictionInput); append/hot-reuse must never pass it. Absent →
 * the newest-first recency ramp runs byte-identically.
 */
export interface FoldFidelityValueInput {
    /** Per-call weight overrides; omitted fields fall back to DEFAULT_FIDELITY_VALUE_WEIGHTS. */
    weights?: Partial<FidelityValueWeights>;
    /** Newest K folded turns kept on the recency floor (budget priority before value). Default 8. */
    recencyFloorTurns?: number;
}
/**
 * Pure arithmetic — derive the dependent fold budgets from a target
 * steady-state band. `charsPerToken` converts the token target into chars;
 * the default (4) preserves ratio math, while a lower per-engine ratio keeps
 * the band pinned to real tokens on denser tokenizers.
 *
 * When `fidelity` is provided, the retention fractions are overridden — this
 * is the quality-driven lever (band controls total size, fidelity controls
 * what proportion stays at each tier).
 */
export declare function resolveFoldBandBudgets(bandTokens: number, charsPerToken?: number, fidelity?: FidelityOverrides): FoldBandBudgets;
/**
 * Band-aware ALWAYS_ON fold config. `undefined` (env knob unset) uses the
 * public 100K default band (DEFAULT_FOLD_BAND_TOKENS). A band returns a copy
 * with the assistant-text budget scaled by the documented ratios; explicit
 * 100K deep-equals the unscaled base config.
 *
 * When `fidelity` is provided, the retention fractions are overridden —
 * enabling quality-driven ratio adjustment.
 */
export declare function resolveFoldConfigForBand(bandTokens?: number | undefined, charsPerToken?: number, fidelity?: FidelityOverrides): FoldConfig;
/**
 * Cold append-band config for tail epochs. It keeps the same trigger geometry
 * as resolveFoldConfigForBand, but removes warm prose retention: no full/essence
 * assistant text, no newest-user text carry, and a smaller coordinate closet.
 * Tail bands should be skeleton/tool receipts plus vault/cognitive deltas.
 */
export declare function resolveColdFoldConfigForBand(bandTokens?: number | undefined, charsPerToken?: number, fidelity?: FidelityOverrides): FoldConfig;
export declare function countChars(messages: FoldMessage[]): number;
/** Result of {@link countCharsByKind}: total is always toolChars + textChars. */
export interface CharsByKind {
    total: number;
    toolChars: number;
    textChars: number;
}
/**
 * Same traversal shape as {@link countChars}, but classifies each counted
 * chunk as tool content (tool-role messages, tool_use/tool_result content
 * blocks, and function-call/response parts) or plain text/reasoning.
 * OpenAI tool_calls metadata is intentionally not added here because countChars
 * does not count it. Used for Mission Control vitals telemetry only
 * (GOD RULE 7: real measured chars, never a token estimate).
 */
export declare function countCharsByKind(messages: FoldMessage[]): CharsByKind;
export interface Turn {
    startIndex: number;
    endIndex: number;
    messages: FoldMessage[];
}
/** Prefix of full-content fold-recall cards injected at tool boundaries (see foldRecall.ts). */
export declare const RECALL_CARD_PREFIX = "[Recalled from fold \u2014";
/** Prefix of one-line fold-recall hints injected at tool boundaries (see foldRecall.ts). */
export declare const RECALL_HINT_PREFIX = "[Fold recall hint \u2014";
/**
 * Strip fold-recall card and hint blocks from text. Cards are multi-line
 * `[Recalled from fold — …]` blocks ending with `[End fold recall]`; hints
 * are single-line `[Fold recall hint — …]` entries. Both are re-derivable
 * by construction — foldRecall re-injects them on path touch — so carrying
 * their full text through fold bands wastes budget. Band-append builders
 * call this to lean band bodies before serializing.
 */
export declare function stripRecallCardBlocks(text: string): string;
/** Prefix of the one-line fold-epoch stamp emitted at the first tool boundary after a freeze epoch (see fcBaseSession.ts). */
export declare const FOLD_EPOCH_STAMP_PREFIX = "[Fold epoch #";
/**
 * Prefix of the episodic-recall block (durable blast-radius memory cards from
 * fold-episodes.sqlite) injected at tool boundaries (see fcBaseSession.ts /
 * foldEpisodes.ts). Synthetic like recall cards: excluded from real-turn
 * detection and from mention-signal extraction (self-excitation guard — the
 * matcher must never read paths out of its own injected cards), and aged out
 * by later fold epochs like any other tool-boundary payload.
 */
export declare const EPISODIC_RECALL_PREFIX = "[Episodic recall \u2014";
/** Synthetic vault note appended to live user turns with bounded operator-message excerpts. */
export declare const USER_MESSAGE_VAULT_PREFIX = "[User Message Vault]";
export declare const USER_MESSAGE_VAULT_END = "[/User Message Vault]";
/** Dedicated model-visible continuity envelope; never genuine operator text. */
export declare const CHRONOLOGICAL_PROVENANCE_PREFIX = "[Chronological Provenance v1]";
export type SyntheticContextStripMode = 'line' | 'line-or-paragraph' | 'paragraph' | 'bracketed' | 'paired';
export interface LeadingSyntheticContextBlock {
    readonly prefix: string;
    readonly mode: SyntheticContextStripMode;
    readonly end?: string;
}
export type SyntheticContextMatcher = (text: string) => boolean;
/**
 * Host-supplied synthetic context markers.
 *
 * The standalone package owns only Context Warp's fold/recall/vault markers.
 * Hosts that prepend their own envelopes (for example a runtime resume wrapper,
 * chat digest, or lifecycle package) pass those markers here so turn detection,
 * fold-recall, and episode capture can ignore them without baking host strings
 * into the generic engine.
 */
export interface SyntheticContextOptions {
    /** Extra standalone prefixes that mark a whole text block as synthetic. */
    readonly prefixes?: readonly string[];
    /** Leading user-message blocks to strip before mining genuine operator text. */
    readonly leadingBlocks?: readonly LeadingSyntheticContextBlock[];
    /** Whole-text predicates for envelopes that should be consumed completely. */
    readonly wholeTextMatchers?: readonly SyntheticContextMatcher[];
}
/**
 * Prefix of tombstone lines inside the fold block marking spans whose detail
 * was evicted to the episodic store (E10). Lives INSIDE the block (never
 * standalone injected text), so it needs no isSyntheticContextText arm; it
 * must never collide with FOLD_MARKER (the block's first-line anchor that
 * foldRecall's buildFoldIndex parses).
 */
export declare const FOLD_TOMBSTONE_PREFIX = "[Paged to episodic store \u2014 ";
/** Default fold-block char ceiling that arms eviction (override: VOXXO_FOLD_EVICT_THRESHOLD_CHARS; '0' disables). */
export declare const DEFAULT_FOLD_EVICT_THRESHOLD_CHARS = 22000;
/** Format the epoch stamp: `[Fold epoch #N — detail]`, detail capped at 120 chars. */
export declare function formatFoldEpochStamp(epoch: number, detail: string): string;
/**
 * Default self-documenting preamble rendered inside every fold block immediately
 * after the header line. Hosts can override it through FoldConfig when they do
 * not provide the default recall hooks. Single line by invariant: it must never
 * start with '[' and must never contain a line starting with FOLD_MARKER or a
 * recall prefix — the block's FIRST line stays the FOLD_MARKER header that
 * foldRecall's buildFoldIndex parses. Full mechanics: docs/context-folding.md.
 */
export declare const FOLD_BLOCK_PREAMBLE = "(Context note: older turns were auto-folded into the skeletons below. The \u2316 COORDINATE CLOSET block below conserves closet items \u2014 ids/paths/values from folded turns \u2014 trust it before re-reading files. Folded content that becomes relevant again is paged back in automatically as \"[Recalled from fold \u2014\" cards at tool boundaries. Claiming a file you already touched triggers a re-fold that unfolds it \u2014 claim deliberately. Mechanics: docs/context-folding.md)";
export declare const COORDINATE_CLOSET_MARKER = "\u2316\u2316\u2316 COORDINATE CLOSET \u2316\u2316\u2316";
/**
 * Extract only resident coordinate-carrying text from a frozen view. This keeps
 * cross-band admission bounded to closet material instead of rescanning the
 * entire immutable prompt for every nominated literal. Both the rolling-fold
 * inline closet and the rebirth package's bullet-form raw closet are supported.
 */
export declare function extractCoordinateConservationCorpus(messages: readonly FoldMessage[]): string;
/**
 * Remove entries from rendered inline closet lines when an immutable prefix
 * already carries the same bare literal. Used by transports that assemble a
 * band before they acquire the live frozen-prefix bytes (Codex/Claude CLI).
 */
export declare function dedupeCoordinateClosetText(text: string, priorCoordinateCorpus: string): string;
/**
 * Synthetic Context Warp text — fold blocks, fold-recall cards/hints,
 * fold-epoch stamps, and host-supplied markers — is never a real user turn
 * boundary. Recall payloads therefore
 * attach to the turn they follow, so they skeletonize away at later fold
 * epochs (page-out-again, fully cyclic) and never inflate turn-count
 * triggers. Exported so foldRecall.ts can apply the same exclusion when
 * extracting real user text.
 */
export declare function isSyntheticContextText(text: string, syntheticContext?: SyntheticContextOptions): boolean;
export declare function stripUserMessageVaultBlocks(text: string): string;
export declare function stripSyntheticUserContextBlocks(text: string, syntheticContext?: SyntheticContextOptions): string;
export declare function detectTurns(messages: FoldMessage[], syntheticContext?: SyntheticContextOptions): Turn[];
/** Plan produced when a single oversized active turn is eligible for step-fold. */
export interface StepFoldPlan {
    /** Full contiguous turn tiling (prior real turns + step segments of the active turn). */
    turns: Turn[];
    /** Leading segments to fold; the trailing (turns.length − this) stay full-fidelity. */
    turnsToFold: number;
}
export interface StepFoldOptions {
    /** Engage only when the active (last) turn's char size meets/exceeds this. */
    activeTurnCharBudget: number;
    /** Keep this many trailing steps at full fidelity (the live working thread). */
    keepLastSteps: number;
}
/**
 * Detect the marathon pattern — the LAST detected turn is oversized — and produce a
 * step-segmented turn tiling consumable by foldContext(..., precomputedTurns). Returns
 * null when not applicable (active turn under budget, or too few steps to gain). The
 * caller passes plan.turns as precomputedTurns and plan.turnsToFold as turnsToFold, and
 * SHOULD pass eviction=undefined — fold ordinals here are step-granular, not turn-granular,
 * so turn-keyed eviction spans must not tombstone them (episodic capture still runs on raw).
 */
export declare function planActiveTurnStepFold(messages: FoldMessage[], opts: StepFoldOptions, syntheticContext?: SyntheticContextOptions): StepFoldPlan | null;
interface ExtractedToolCall {
    name: string;
    input: Record<string, unknown>;
    resultText: string;
    toolId: string;
}
export declare function extractAssistantText(turnMessages: FoldMessage[]): string;
/**
 * Extract GENUINE user-authored text from a turn's messages — the operator's
 * own words. Deliberately mirrors extractAssistantText across Anthropic
 * string/content[] and Gemini parts[] shapes, but reads the `user` role and
 * EXCLUDES tool-output blocks (Anthropic `tool_result`, Gemini
 * `functionResponse`): those are tool results already covered by the main
 * nomination lane (toolCalls[].resultText), so re-reading them here would be a
 * pointless double-carry. Used only to feed the capped user-verbatim closet
 * lane (P1b) so operator-pasted ids/paths/ports are conserved when a turn folds.
 */
export declare function extractUserText(turnMessages: FoldMessage[], syntheticContext?: SyntheticContextOptions): string;
/**
 * Normalize an absolute `/home/<user>/<repo>/…` path to repo-relative form. The
 * canonical normalization used by claimed-path matching (`isClaimedPath`) and
 * tool-arg path extraction — exported so the fold freeze (foldFreeze.ts) can
 * test claim relevance with byte-identical semantics.
 *
 * Strips the leading `/home/<user>/<repo>/` segment (heuristic: repo one level
 * under home). foldPathCanon.ts handles arbitrary roots via injected context.
 */
export declare function normalizeToolPath(p: string): string;
/**
 * Extract the normalized file-path argument from a tool input object. The
 * canonical path-arg semantics shared by skeletons, claimed-path matching,
 * extractToolPathSet, and fold-recall trigger matching (foldRecall.ts).
 */
export declare function extractPath(input: Record<string, unknown>): string;
/**
 * Extract file-path-shaped tokens from free-form user text (rail-c63e326e
 * s5): an operator naming a path in their own words ("dive into
 * foldFreeze.ts" / "look at relay/src/fcBaseSession.ts:200") is the
 * strongest relevance signal available, stronger than the agent's own
 * downstream tool-call behavior — see `FidelityValueWeights.userNamed`. Pure
 * and deterministic: no I/O, no Date.now, same normalization
 * (`normalizeToolPath` + `fidelityPathKey`) as tool-call path extraction so
 * a user-named mention of a path collapses onto the SAME forward-index key
 * a claim/edit of that path would use.
 */
export declare function extractUserNamedPaths(text: string): string[];
/**
 * Nominate carry-worthy verbatim values from text (UUIDs, hex ids ≥12, short
 * mixed hex 8-11, absolute paths, key=value pairs with digit-bearing values,
 * issue refs #1234). Collects in PATTERN-PRIORITY order — all UUIDs, then hex,
 * then short hex, paths, KVs, refs — source order within each pattern. Under a
 * budget this priority order is the carry policy: id-shaped values win over
 * KV pairs. Truncates each value to 200 chars, dedupes exactly, stops at cap.
 *
 * @param cap Max ENTRY COUNT, not characters.
 */
export declare function nominateVerbatim(text: string, cap?: number): string[];
/**
 * Normalize a numeric string for conservation matching.
 * Makes `1.0000` ≡ `1.0` ≡ `1` via Number() coercion.
 */
export declare function normalizeNumericForm(s: string): string;
/**
 * Test whether `value` is verbatim-present in `haystack` with boundary-aware
 * matching, value-part conservation, and numeric normalization (from Bro's port):
 * 1. `6787` is NOT conserved by `67870` — non-alphanumeric boundary required.
 * 2. `id: <uuid>` IS conserved by a haystack carrying the bare uuid — a KV pair
 *    adds nothing once its value survives (belt/closet double-carry guard).
 * 3. `1.0000` ≡ `1.0` ≡ `1` — normalizeNumericForm applied to the value part.
 */
export declare function isConservedIn(haystack: string, value: string): boolean;
/** Canonical comparison key for Coordinate Closet literals. */
export declare function canonicalizeClosetLiteral(value: string): string;
/**
 * Mutating admission helper for closet literal lists. It dedupes slash/no-slash
 * twins and replaces shorter path suffixes with fuller path spellings.
 */
export declare function admitClosetLiteral(admitted: string[], candidate: string): boolean;
/** Max chars for a Coordinate Closet context label (Tier-1 annotated keep). */
export declare const LABEL_MAX_CHARS = 24;
/**
 * Derive a deterministic, IO-free context label for an OPAQUE verbatim value
 * (bare UUID / hex id) from the text it was nominated from, so a folded id like
 * `7fd5835b` carries its meaning (`changelog_id`) into the Coordinate Closet instead
 * of going dark. This is the Tier-1 "annotated keep" page-out: the fold engine is
 * deterministic zero-LLM (byte-identical output is the provider-cache invariant),
 * so the label is a pure surrounding-context heuristic, never a model call.
 *
 * Returns '' for self-describing values (absolute paths, KV pairs
 * `key=value`/`key: value`, issue refs `#1234`) — they already carry meaning —
 * and when no meaningful preceding identifier exists. Heuristic: locate the
 * value's first boundary-aware occurrence and read the nearest preceding
 * identifier word (the JSON/KV key or prose subject), e.g. `"changelog_id":
 * "7fd5835b"`, `rail 7fd5835b`, `commit b602c1e8`. A label that is itself
 * pure-hex or letterless is rejected so one hash never labels another.
 * Pure: byte-identical for identical inputs.
 */
export declare function extractVerbatimContextLabel(sourceText: string, value: string): string;
/** Reject opaque values only when no source-derived label or explicit key exists. */
export declare function isUnlabeledOpaqueClosetLiteral(value: string): boolean;
/**
 * Reject Coordinate Closet candidates that are trace-EXHAUST artifacts rather
 * than durable coordinate ids/paths. Pure + deterministic (regex only), so it
 * preserves the fold engine's byte-identical-for-identical-input provider-cache
 * invariant. Shared by BOTH closet builders — this fold closet's admit() and the
 * relay rebirth-seed buildRawTraceCoordinateCloset — so one filter cleans both.
 *
 * Discriminates by artifact TYPE, not lineage: a tool-result spool / browser
 * artifact / temp path is noise no matter which instance produced it — and that
 * is precisely what removes the BULK of cross-lineage closet leakage, since the
 * foreign refs that leak in are overwhelmingly tool-artifact paths. Real
 * source-file paths, rail/instance ids, ports, and pids are intentionally KEPT
 * even when cross-lineage (a fork sibling's file claim is coordination signal).
 */
export declare function isClosetNoiseLiteral(value: string): boolean;
export declare function classifyTurn(turnMessages: FoldMessage[]): TurnCategory;
export declare function skeletonizeTool(call: ExtractedToolCall): string;
export declare function extractAssistantEssence(text: string): string;
export declare function collapseSequences(foldedTurns: FoldedTurn[]): FoldedTurn[];
export declare function checkFoldTrigger(messages: FoldMessage[], config?: FoldConfig, syntheticContext?: SyntheticContextOptions): FoldTrigger;
/** Render one tombstone line: `[Paged to episodic store — <date-range>, N turns; recallable by touching member paths]`. */
export declare function formatFoldTombstoneLine(span: FoldEvictionSpan): string;
/** Sort spans by ordinal and merge the oldest pairs until at most maxSpans remain (date ranges union, counts sum). */
export declare function mergeEvictionSpans(spans: readonly FoldEvictionSpan[], maxSpans?: number): FoldEvictionSpan[];
/**
 * Session-side eligibility ceiling for NEW eviction (pure; exported for the
 * fcBaseSession glue and tests). A turn ordinal is evictable only when BOTH:
 *   - durable coverage: the turn ends at or below `durableCursorIndex` (the
 *     episodic capture cursor — advances past episode-bearing ranges only
 *     after the store CONFIRMS the write, and past episode-free ranges
 *     vacuously; turn endIndex is EXCLUSIVE, so coverage is endIndex ≤ cursor);
 *   - epoch age ≥2: the turn was already inside the fold frontier recorded at
 *     some epoch ≤ upcomingEpoch − 2.
 */
export declare function computeEvictableThroughOrdinal(turns: ReadonlyArray<{
    startIndex: number;
    endIndex: number;
}>, durableCursorIndex: number, epochFoldFrontiers: ReadonlyArray<{
    epoch: number;
    turnsFolded: number;
}>, upcomingEpoch: number): number;
export declare function resolveFidelityValueWeights(overrides?: Partial<FidelityValueWeights>): FidelityValueWeights;
/**
 * Pure intrinsic per-folded-turn fidelity value (cherry-picked graduated
 * fidelity). Value = downstream relevance measured from the TRACE ITSELF (no
 * episodic store, no I/O, deterministic): for each folded turn, sum the
 * weighted downstream references — later folded turns + the live active window —
 * to the paths it touched (claim/edit weighted over read; a path the OPERATOR
 * later names by hand in a user message weighted at least as high as edit —
 * see `extractUserNamedPaths` / `FidelityValueWeights.userNamed`, rail-c63e326e
 * s5), plus an additive bonus for a durable register glyph (🏁/⚠️).
 *
 * `turns` is the full detected turn list; the first `foldCount` are the folded
 * turns being scored. Returns one score per folded turn (aligned to
 * turns[0..foldCount)); active-window turns are turns[foldCount..].
 *
 * `syntheticContext` is forwarded to `extractUserText` so synthetic
 * user-context blocks (rebirth seeds, etc.) are stripped before path
 * extraction, matching the same stripping `foldContext`'s caller already
 * applies for turn detection.
 */
export declare function scoreTurnFidelityValue(turns: readonly Turn[], foldCount: number, weights?: FidelityValueWeights, syntheticContext?: SyntheticContextOptions): number[];
/**
 * Apply rolling fold compaction to a message array.
 * Returns a NEW array — never mutates input.
 */
export declare function foldContext(messages: FoldMessage[], turnsToFold: number, config?: FoldConfig, eviction?: FoldEvictionInput, counterStamp?: string, precomputedTurns?: Turn[], syntheticContext?: SyntheticContextOptions, fidelityValue?: FoldFidelityValueInput): FoldResult;
export interface IntraTurnFoldConfig {
    /** Recent tool results per turn to keep at full fidelity. */
    tailBuffer: number;
    /** Don't truncate results smaller than this (chars). */
    minTruncateSize: number;
    /** Only apply when total char count exceeds this. */
    charThreshold: number;
    /** Higher threshold for atlas_query lookup results — they carry structured metadata worth preserving. */
    atlasLookupThreshold: number;
    /** File paths currently claimed via partner_claim_file — these are never folded (auto-unfold on claim). */
    claimedPaths?: ReadonlySet<string>;
}
export declare const DEFAULT_INTRA_FOLD_CONFIG: IntraTurnFoldConfig;
/**
 * Always-on intra-turn fold config — fires every turn instead of only past a
 * char threshold, so context stays lean from turn 1. Used when an instance's
 * rollingFold mode is 'on' (or 'dry-run' for preview).
 *
 * "Cheaper but still adequate signal": the threshold gate is removed
 * (charThreshold: 0 → intraTurnFold never early-returns), but every per-result
 * preservation rule stays in force, so signal quality is unchanged:
 *   - tailBuffer keeps the most recent results per turn at full fidelity
 *     (your working set is always intact)
 *   - minTruncateSize is raised to 2_000 so only genuinely expensive results
 *     fold — fold the whales, keep the minnows. Small/medium results that are
 *     already cheap stay verbatim rather than churning into ~80-char markers.
 *   - atlas lookups < atlasLookupThreshold stay full; larger ones keep all
 *     metadata (Purpose/Hazards/Patterns) and fold only the raw source block
 *   - claimed paths and error results are never folded
 *   - every folded result keeps a `self-tap to recover` path (raw JSONL intact)
 *
 * Turns with <= tailBuffer substantial results still no-op naturally (the tail
 * buffer covers them), so short turns are unaffected — folding only bites once
 * consumed results accumulate, which is exactly when you want it.
 */
export declare const ALWAYS_ON_INTRA_FOLD_CONFIG: IntraTurnFoldConfig;
export interface IntraTurnFoldResult {
    messages: FoldMessage[];
    originalChars: number;
    foldedChars: number;
    savingsPercent: number;
    toolResultsFolded: number;
    toolResultsKept: number;
}
/**
 * Extract the set of normalized tool-arg paths referenced by tool_use blocks
 * (Anthropic-style content arrays), tool_calls (OpenAI-style), or functionCall
 * parts (Gemini-style) in the given messages. Mirrors buildToolInfoMap's extraction exactly — the fold's
 * claimed-path unfold rule keys off these paths (`isClaimedPath(info.path)`),
 * so a file claim can only change the fold's output when its normalized path
 * is in this set. Used by the fold freeze (foldFreeze.ts) to skip epochs for
 * claims on paths a session never touched.
 */
export declare function extractToolPathSet(messages: readonly FoldMessage[]): Set<string>;
/**
 * Compress tool results within individual turns.
 *
 * Keeps the tail buffer (most recent N tool results per turn) at full
 * fidelity. Truncates older results to one-line summaries. Never
 * mutates input — returns a new array.
 *
 * Recovery path: raw transcript persists in JSONL on disk; agents can
 * self-tap to recover any folded result.
 */
export declare function intraTurnFold(messages: FoldMessage[], config?: IntraTurnFoldConfig, syntheticContext?: SyntheticContextOptions): IntraTurnFoldResult;
export {};
