/**
 * Raw rebirth seed renderer.
 *
 * This is the portable, deterministic version of the relay raw-rebirth prompt
 * renderer: callers provide trace-normalized section strings, and this module
 * applies the same default section budgets, priority order, headings, and
 * orientation footer. It performs no I/O and does not gather relay-only memory.
 */
import { type FoldMessage } from './rollingFold.ts';
/**
 * Build a portable lineage glyph log from the message trace: scan assistant
 * messages for declared verdict (🏁) and hazard (⚠️) register glyphs and render
 * them chronologically, newest-first capped at `maxChars`.
 *
 * This is the standalone counterpart to the relay's async `buildLineageGlyphLog`
 * — same glyph classification and selection logic, but reads from the in-memory
 * message array instead of loading from a transcript store. Synchronous, no I/O.
 *
 * Returns '' if no verdict/hazard entries are found.
 */
export declare function buildLineageGlyphLogFromMessages(messages: readonly FoldMessage[], options?: {
    maxChars?: number;
    perEntryMaxChars?: number;
}): string;
/**
 * Build a portable open-questions ledger from the message trace: scan assistant
 * messages for declared blocked (❓) register glyphs and render them
 * chronologically, newest-first capped at `maxChars`.
 *
 * This gives the ❓ register a downstream consumer: blockers tagged honestly at
 * write-time resurface at rebirth as an agenda of possibly-unresolved
 * questions. Entries are NOT filtered by later verdicts — resolution is the
 * successor's call to verify, so the header says so explicitly.
 *
 * Synchronous, no I/O. Returns '' if no blocked entries are found.
 */
export declare function buildOpenQuestionsFromMessages(messages: readonly FoldMessage[], options?: {
    maxChars?: number;
    perEntryMaxChars?: number;
}): string;
export type RawRebirthSeedSectionId = 'lastUserAiMessages' | 'currentThread' | 'rawTraceCoordinateCloset' | 'traceNeighborhoods' | 'activeEditDelta' | 'taskRailContext' | 'episodicCrossRef' | 'lineageGlyphLog' | 'openQuestions' | 'atlasCrossRef' | 'workspaceContext' | 'starredMoments' | 'thinkingTrail' | 'lifetimeChangelogArc' | 'chatroomMembership' | 'delegatedWork' | 'coordinationState' | 'squadThoughts';
export type RawRebirthThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | string;
export interface RawRebirthRuntimeModelSnapshot {
    readonly engine: string;
    readonly model: string;
    readonly modelTier: string;
    readonly thinkingLevel?: RawRebirthThinkingLevel;
}
export interface RawRebirthRuntimeModelContext {
    readonly predecessor: RawRebirthRuntimeModelSnapshot;
    readonly successor: RawRebirthRuntimeModelSnapshot;
    readonly changed: boolean;
}
export interface RawRebirthForkContext {
    readonly groupId?: string | null;
    readonly index?: number | null;
    readonly count?: number | null;
    readonly pointMessageId?: string | null;
    readonly autoCleanup?: boolean;
    readonly isFreshFork?: boolean;
}
export type RawRebirthLifecycleBoundary = 'same_instance_hard_epoch' | 'continuation' | 'fresh_fork' | 'resurrection' | 'brain_merge';
export interface RawRebirthWorkspaceContext {
    readonly currentCwd: string;
    readonly currentWorkspace: string;
    readonly previousCwd?: string;
    readonly previousWorkspace?: string;
    readonly swappedAt?: string;
}
export interface RawRebirthDelegatedWorkRailSummary {
    readonly railId: string;
    readonly title: string;
    readonly locked: boolean;
    readonly state: string;
    readonly doneSteps: number;
    readonly totalSteps: number;
    readonly activeStepTitle?: string;
}
export interface RawRebirthDelegatedWorkRow {
    readonly name: string;
    readonly id: string;
    readonly engine: string;
    readonly model: string;
    readonly status: string;
    readonly rail?: RawRebirthDelegatedWorkRailSummary;
}
export interface RawRebirthMergedLineage {
    readonly instanceId: string;
    readonly instanceName: string;
    readonly source?: 'live' | 'archived';
    readonly essence?: string;
    readonly recentThread?: string;
    /** Donor's FIRST user ask — what it was FOR. Only set when not visible in recentThread. */
    readonly mission?: string;
    /** Persisted user+assistant row count at absorption — lifecycle size anchor. */
    readonly messageCount?: number;
    /** True when the donor had NO persisted conversation at absorption. Failed load leaves unset. */
    readonly emptyTranscript?: boolean;
}
export interface RawRebirthDurableMergedLineage {
    readonly instanceName: string;
    readonly mergedAt?: string;
}
export interface RawRebirthSummonVaultEntry {
    readonly summonId: string;
    readonly name: string;
    readonly role?: string;
    readonly status: string;
    readonly openedAt: string;
    readonly summary?: string;
    readonly filesTouched?: readonly string[];
}
export interface RawRebirthSeedInput {
    readonly predecessorName: string;
    readonly packageBudget?: number;
    readonly sectionMaxChars?: Partial<Record<RawRebirthSeedSectionId, number>>;
    readonly sectionPriority?: Partial<Record<RawRebirthSeedSectionId, number>>;
    readonly renderOrder?: readonly RawRebirthSeedSectionId[];
    readonly sectionToggles?: Partial<Record<RawRebirthSeedSectionId | 'runtimeModel' | 'rebirthHistory', boolean>>;
    readonly runtimeModel?: RawRebirthRuntimeModelContext;
    readonly runtimeModelBlock?: string;
    readonly relayBootTime?: string;
    readonly traceEventCount?: number;
    readonly forkContext?: RawRebirthForkContext;
    readonly lifecycleBoundary?: RawRebirthLifecycleBoundary;
    readonly mergedFromLineages?: readonly RawRebirthMergedLineage[];
    readonly durableMergedLineage?: readonly RawRebirthDurableMergedLineage[];
    readonly summonVault?: readonly RawRebirthSummonVaultEntry[];
    readonly lastUserAiMessages?: string;
    readonly currentThread?: string;
    readonly triggeringUserMessage?: string;
    readonly rawTraceCoordinateCloset?: string;
    readonly traceNeighborhoods?: string;
    readonly activeEditDelta?: string;
    readonly taskRailContext?: string;
    readonly resumePoint?: string;
    readonly episodicCrossRef?: string;
    readonly lineageGlyphLog?: string;
    readonly openQuestions?: string;
    readonly atlasCrossRef?: string;
    readonly workspaceContext?: RawRebirthWorkspaceContext | string;
    readonly starredMoments?: string;
    readonly thinkingTrail?: string;
    readonly lifetimeChangelogArc?: string;
    readonly chatroomMembership?: string;
    readonly delegatedWork?: readonly RawRebirthDelegatedWorkRow[] | string;
    readonly coordinationState?: string;
    readonly squadThoughts?: string;
    readonly predecessorStatus?: string;
    readonly userMessageTriggered?: boolean;
    readonly headerOverride?: string;
    readonly footerOverride?: string;
}
export interface RawRebirthSeedFromMessagesOptions {
    readonly predecessorName?: string;
    readonly packageBudget?: number;
    readonly sectionMaxChars?: Partial<Record<RawRebirthSeedSectionId, number>>;
    readonly sectionPriority?: Partial<Record<RawRebirthSeedSectionId, number>>;
    readonly renderOrder?: readonly RawRebirthSeedSectionId[];
    readonly sectionToggles?: Partial<Record<RawRebirthSeedSectionId | 'runtimeModel' | 'rebirthHistory', boolean>>;
    readonly rawTraceCoordinateClosetChars?: number;
    readonly traceNeighborhoodChars?: number;
    readonly includeTrailingUserTurn?: boolean;
    readonly currentThreadMessageLimit?: number;
    readonly currentThreadMessageChars?: number;
    readonly activityMessageChars?: number;
    readonly runtimeModel?: RawRebirthRuntimeModelContext;
    readonly relayBootTime?: string;
    readonly traceEventCount?: number;
    readonly workspaceContext?: RawRebirthWorkspaceContext | string;
    readonly activeEditDelta?: string;
    readonly taskRailContext?: string;
    readonly resumePoint?: string;
    readonly predecessorStatus?: string;
    readonly lifecycleBoundary?: RawRebirthLifecycleBoundary;
    readonly userMessageTriggered?: boolean;
    /** Trace-derived episodic recall text (portable-mode memory section). */
    readonly episodicCrossRef?: string;
    /**
     * Deterministic exact-match neighborhoods around Coordinate Closet literals.
     * Undefined auto-builds from the trace; an empty string suppresses the section.
     */
    readonly traceNeighborhoods?: string;
    /** Lineage glyph log text — chronological verdict/hazard register trail (portable-mode memory section). */
    readonly lineageGlyphLog?: string;
    /**
     * Open-questions ledger — chronological ❓ blocked-register trail. When
     * omitted, buildRawRebirthSeedFromMessages auto-builds it from the message
     * trace via buildOpenQuestionsFromMessages; pass '' to suppress.
     */
    readonly openQuestions?: string;
    /** Replace the default [CONTEXT REBIRTH] header (band micro-seed use). */
    readonly headerOverride?: string;
    /** Replace the default orientation footer (band micro-seed use). */
    readonly footerOverride?: string;
}
interface VisibleTraceMessage {
    readonly type: string;
    readonly text?: string | null;
}
export declare const DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS = 200000;
export declare const DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS: Record<RawRebirthSeedSectionId, number>;
export declare const DEFAULT_RAW_REBIRTH_SEED_SECTION_PRIORITY: Record<RawRebirthSeedSectionId, number>;
export declare const DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER: readonly RawRebirthSeedSectionId[];
export declare function renderRawRebirthSeed(input: RawRebirthSeedInput): string;
export declare function buildRawTraceCoordinateCloset(visibleMessages: readonly VisibleTraceMessage[], maxChars?: number): string;
export interface LiteralTraceNeighborhoodOptions {
    /** Character-only render cap. This is not token telemetry. */
    readonly maxChars?: number;
    /** Maximum non-overlapping neighborhoods to render. */
    readonly maxNeighborhoods?: number;
    /** Number of substantive messages to retain on each side of a hit. */
    readonly contextRadius?: number;
    /** Character cap for each compacted source-message excerpt. */
    readonly perMessageChars?: number;
    /** Sections already visible to the successor; matching coordinates are skipped. */
    readonly excludeTexts?: readonly string[];
}
/**
 * Deterministically expands emitted Coordinate Closet literals back into small
 * source-message neighborhoods. Selection is exact-match + heuristic ranking;
 * no LLM, embedding lookup, storage access, or other I/O participates.
 */
export declare function buildLiteralTraceNeighborhoods(visibleMessages: readonly VisibleTraceMessage[], options?: LiteralTraceNeighborhoodOptions): string;
export declare function findRawRebirthSeedTraceEnd(messages: readonly FoldMessage[], includeTrailingUserTurn?: boolean): number;
/**
 * Genuine-operator filter shared with band-enrichment modules: true when a
 * user-role message is an actual operator turn rather than a chatroom
 * delivery, mention ping, digest delta, or ephemeral-only coordination frame.
 */
export declare function isPortableGenuineOperatorMessage(text: string): boolean;
export declare function buildRawTraceCoordinateClosetFromMessages(messages: readonly FoldMessage[], options?: Pick<RawRebirthSeedFromMessagesOptions, 'includeTrailingUserTurn' | 'rawTraceCoordinateClosetChars'>): string;
export declare function buildRawRebirthSeedFromMessages(messages: readonly FoldMessage[], options?: RawRebirthSeedFromMessagesOptions): string;
/**
 * Token target for the append-only tail band geometry (A). Exported here so
 * tests and callers can assert the micro-seed profile is anchored to the real
 * runway constant, not a character-count substitute. The renderer below does
 * not tokenize or estimate; provider/relay measured tokens remain the only
 * source of token telemetry.
 */
export declare const BAND_MICRO_SEED_TARGET_TOKENS = 5000;
/**
 * Character-only render safety cap for a band-level micro-seed. This is not a
 * token budget and must not be used for pressure/runway math. It only bounds
 * deterministic text rendering inside rawRebirthSeed.ts because this portable
 * module has no provider tokenizer. Set above the 5K-token target so the v2
 * seed is not accidentally squeezed by the old 3K-character mistake; token
 * safety is enforced by measured-token gates around the whole band append.
 */
export declare const BAND_MICRO_SEED_RENDER_SAFETY_MAX_CHARS = 20000;
/**
 * Character-only section safety caps for the band profile. Only the two
 * trace-derived narrative sections are enabled; everything else is toggled
 * off. These caps bound deterministic rendering only — they are not token
 * estimates or token telemetry.
 */
export declare const BAND_MICRO_SEED_SECTION_MAX_CHARS: Partial<Record<RawRebirthSeedSectionId, number>>;
/**
 * Section toggles for the band profile. Only lastUserAiMessages and
 * currentThread are enabled; every other section (coordinate closet, edit
 * delta, rail, episodic, glyph log, open questions, atlas, workspace,
 * starred moments, thinking trail, changelog arc, chatroom, delegated work,
 * coordination state, squad thoughts) is suppressed because those live
 * outside the fold and survive the epoch intact.
 */
export declare const BAND_MICRO_SEED_SECTION_TOGGLES: Partial<Record<RawRebirthSeedSectionId | 'runtimeModel' | 'rebirthHistory', boolean>>;
/**
 * Build a compact band-level micro-seed from the fold window messages using
 * the actual rebirth seed machinery with a lean band profile. This is the v2
 * replacement for the bespoke 3-line extractor: same rebirth pipeline that
 * powers hard-epoch seeds, pointed at just the destroyed window, with band-
 * appropriate framing and a character-only render safety cap.
 *
 * Returns '' when the window has no extractable trajectory (empty messages
 * or no genuine operator / assistant turns). The band then carries no
 * [micro-seed] block, same as before.
 */
export declare function buildMicroSeedFromMessages(messages: readonly FoldMessage[], options?: RawRebirthSeedFromMessagesOptions): string;
export {};
