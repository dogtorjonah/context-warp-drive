/**
 * Birth-fold hydration — pure conversion from relay transcript rows to a
 * provider-agnostic alternating seed history for FC sessions.
 *
 * Library resume ("resume-as") preserves an instance's id and transcript but
 * historically woke the new session blank, relying on lazy-rebirth to
 * synthesize a package on first message (a session swap). This module instead
 * pours the archived transcript into the reborn session's native
 * messageHistory as text-inlined turns at construction; the first
 * applyCompaction pass folds everything past the active window exactly like
 * live history (skeletons + recall index + episodic capture), giving
 * rebirth-grade continuity with no session swap mid-turn.
 *
 * Zero runtime imports by design (same residency rule as foldEpisodes.ts):
 * the resume path, FC engines, and tests consume this module without coupling
 * the persistence and engine type graphs. Source rows are a structural subset
 * of persistence/localMessages LocalMessage; seed messages are plain
 * role+string-content pairs that every FC provider shape can adopt via the
 * mappers at the bottom.
 */
export interface BirthFoldSeedMessage {
    role: 'user' | 'assistant';
    content: string;
}
/** Structural subset of persistence LocalMessage — deliberately no import. */
export interface BirthFoldSourceRow {
    /** Row type: user, assistant_text, tool_use, tool_result, system_reminder, reasoning. */
    ty: string;
    /** Text content. */
    tx?: string | null;
    /** Tool name (tool_use / tool_result rows). */
    tn?: string | null;
    /** Tool input (tool_use rows). */
    ti?: unknown;
    /** ISO timestamp. */
    ts?: string;
    /** Streaming-in-progress flag — such rows are transient duplicates. */
    sg?: boolean;
}
export interface BirthFoldConversionStats {
    sourceRows: number;
    /** Rows that contributed content to the seed (skips reasoning/system/streaming/empty). */
    usedRows: number;
    emittedMessages: number;
    totalChars: number;
    truncated: boolean;
    droppedOlderMessages: number;
    /** Rows excluded by the bounded pre-trim before block assembly. */
    preTrimmedRows: number;
    /** Rendered blocks clipped to the per-block ceiling (newest tail kept, elision note inlined). */
    clippedBlocks: number;
}
export interface BirthFoldConversionOptions {
    /** Newest-first retention budget over emitted content chars. */
    maxChars?: number;
    /** Per tool_use input JSON preview bound. */
    maxToolInputChars?: number;
    /** Per tool_result preview bound. */
    maxToolResultChars?: number;
    /** Defensive per-part bound against single pathological rows. */
    maxMessageChars?: number;
}
/**
 * Newest-first retention cap for the seeded history. Sized so the first fold
 * pass (which runs pre-request on the relay event loop, like every live fold)
 * stays in the measured clean/warn band — see the event-loop measurement note
 * in the Atlas changelog for this file before raising it.
 */
export declare const DEFAULT_BIRTH_FOLD_MAX_CHARS = 600000;
export declare const BIRTH_FOLD_TAG = "[birth-fold]";
/**
 * Strip a synthetic `[birth-fold]` note from inherited seed content so it is not
 * recorded as genuine operator prose (e.g. when seeding the User Message Vault).
 * A standalone synthetic note — no real body after the note's blank-line
 * separator (the truncation/begins-mid-conversation markers) — collapses to '';
 * a `[birth-fold] …\n\n<real message>` elision/truncation PREFIX is removed,
 * returning the genuine remainder. Untagged content is returned unchanged.
 */
export declare function stripBirthFoldSyntheticPrefix(content: string): string;
/**
 * Sanitize an inherited fold-seed user message for the User Message Vault.
 * Strips the synthetic `[birth-fold]` note (via stripBirthFoldSyntheticPrefix)
 * AND lifts the leading `[YYYY-MM-DD HH:MM] ` orientation stamp (added by
 * convertLocalMessagesToSeedHistory) out of the body into `createdAt`. The vault
 * then stores the same clean operator prose it records for live turns, so seeded
 * and live copies of the same message dedup by exact text instead of diverging
 * on the stamp, and the renderer shows the timestamp in the entry title (its
 * createdAt slot) rather than jammed inside the message body.
 */
export declare function parseInheritedUserMessageForVault(content: string): {
    text: string;
    createdAt?: string;
};
/**
 * Convert deduped transcript rows (oldest → newest) into a strictly
 * alternating user/assistant seed history:
 *
 * - `user` rows open/extend user blocks, timestamp-prefixed for orientation.
 * - `assistant_text` rows extend assistant blocks at full (bounded) fidelity.
 * - `tool_use` / `tool_result` rows inline as compact ⟨tool …⟩ trace lines in
 *   the assistant block — turn boundaries stay aligned with real user turns,
 *   so detectTurns sees the same turn structure the original session had.
 * - reasoning / system_reminder / streaming rows are dropped: model-internal
 *   or injected content must not masquerade as conversation.
 *
 * Retention is newest-first under `maxChars`; a truncation note is merged
 * into the first kept user block. Alternation is repaired at both ends so
 * the seed is valid for providers that require user-first alternating
 * history and the next live user message never lands user-on-user.
 */
export declare function convertLocalMessagesToSeedHistory(rows: readonly BirthFoldSourceRow[], options?: BirthFoldConversionOptions): {
    messages: BirthFoldSeedMessage[];
    stats: BirthFoldConversionStats;
};
/** Stats for convertLocalMessagesToTraceMessages. */
export interface BirthFoldTraceConversionStats {
    sourceRows: number;
    /** Rendered per-row messages before newest-first retention. */
    renderedMessages: number;
    droppedOlderMessages: number;
    /** Rows excluded by the bounded pre-trim before rendering. */
    preTrimmedRows: number;
    totalChars: number;
    truncated: boolean;
}
/**
 * Per-row trace conversion for hard-epoch seed bodies (rail-2dcc0c4f).
 *
 * Renders the SAME per-row parts as convertLocalMessagesToSeedHistory but
 * WITHOUT consecutive-role block merging, alternation repair, or synthetic
 * trailers. Why: the block converter collapses tool-only stretches into one
 * giant assistant block (a transcript with no real user rows becomes a single
 * mega-block). Downstream newest-first section builders (buildRawHardEpochSeed)
 * truncate each MESSAGE from the front, so a seed built over merged blocks
 * pins to the oldest content of the mega-block and never advances as the
 * trace grows — the byte-identical hard-epoch seed bug. Per-row granularity
 * restores a real chronological message list so newest-first fills see the
 * newest work and the seed advances with the trace.
 *
 * ⚠ NOT provider-history-safe: output does NOT alternate roles and must never
 * be fed to a provider as message history. Consumers are text-section builders
 * (buildRawHardEpochSeed) only. Birth hydration keeps using
 * convertLocalMessagesToSeedHistory, whose alternation contract is untouched.
 *
 * Newest-first retention under maxChars drops the OLDEST messages first; the
 * newest message is never dropped (tail-clipped if singly oversized). A
 * compact truncation marker is prepended when anything was dropped.
 */
export declare function convertLocalMessagesToTraceMessages(rows: readonly BirthFoldSourceRow[], options?: BirthFoldConversionOptions): {
    messages: BirthFoldSeedMessage[];
    stats: BirthFoldTraceConversionStats;
};
export declare function resolveBirthFoldMaxChars(raw: string | undefined): number;
export interface BirthFoldSeedMaxOptions {
    /** Optional hard ceiling layered above the env/default ceiling. */
    ceilingChars?: number;
}
/**
 * Window-aware seed cap for provider-visible birth-fold hydration.
 *
 * `effectiveWindowTokens` is a config token ceiling, not a live text estimate:
 * FC call sites pass the resolved pressure ceiling when enabled, while CLI
 * reconstruction paths may pass the model window. The optional `ceilingChars`
 * lets callers mirror stricter package envelopes without changing the pure
 * converter's historical default.
 */
export declare function resolveBirthFoldSeedMaxChars(effectiveWindowTokens: number | null | undefined, rawMaxChars?: string, options?: BirthFoldSeedMaxOptions): number;
/** Anthropic-family history (claude-api, grok, glm, minimax, mistral): content is a text block array. */
export declare function seedToAnthropicMessage(m: BirthFoldSeedMessage): {
    role: 'user';
    content: Array<{
        type: 'text';
        text: string;
    }>;
} | {
    role: 'assistant';
    content: Array<{
        type: 'text';
        text: string;
    }>;
};
/** OpenAI Chat Completions history: plain string content. */
export declare function seedToOpenAIChatMessage(m: BirthFoldSeedMessage): {
    role: 'user' | 'assistant';
    content: string;
};
/** Gemini history: model role + parts array. */
export declare function seedToGeminiContent(m: BirthFoldSeedMessage): {
    role: 'user' | 'model';
    parts: Array<{
        text: string;
    }>;
};
