export declare const REGISTER_GLYPHS: {
    readonly in_progress: "🔍";
    readonly executing: "▶";
    readonly verdict: "🏁";
    readonly hazard: "⚠️";
    readonly blocked: "❓";
};
export declare const ASCII_REGISTER_ALIASES: {
    readonly '[progress]': "in_progress";
    readonly '[in_progress]': "in_progress";
    readonly '[executing]': "executing";
    readonly '[execute]': "executing";
    readonly '[verdict]': "verdict";
    readonly '[hazard]': "hazard";
    readonly '[blocked]': "blocked";
    readonly '[question]': "blocked";
};
export type AssistantRegister = keyof typeof REGISTER_GLYPHS;
export type AssistantRegisterGlyph = (typeof REGISTER_GLYPHS)[AssistantRegister];
export type AssistantRegisterTrust = 'transient' | 'durable' | 'blocked' | 'low_trust';
export type AssistantRegisterParseFailureReason = 'empty' | 'leading_whitespace' | 'markdown_container' | 'missing_register' | 'duplicate_register';
export interface AssistantRegisterClassification {
    readonly register: AssistantRegister | null;
    readonly trust: AssistantRegisterTrust;
    readonly durable: boolean;
    readonly final: boolean;
}
export interface AssistantRegisterParseOptions {
    /**
     * ASCII aliases are intentionally opt-in so the runtime contract stays
     * glyph-first. Passing true enables the default bracketed aliases.
     */
    readonly asciiAliases?: boolean | Readonly<Record<string, AssistantRegister>>;
}
export type AssistantRegisterParseResult = {
    readonly ok: true;
    readonly register: AssistantRegister;
    readonly glyph: AssistantRegisterGlyph;
    readonly source: 'glyph' | 'ascii_alias';
    readonly rawPrefix: string;
    readonly body: string;
    readonly classification: AssistantRegisterClassification;
} | {
    readonly ok: false;
    readonly reason: AssistantRegisterParseFailureReason;
    readonly body: string;
    readonly classification: AssistantRegisterClassification;
};
export declare function parseRegisterGlyph(input: string, options?: AssistantRegisterParseOptions): AssistantRegisterParseResult;
export declare function classifyAssistantRegister(register: AssistantRegister | null): AssistantRegisterClassification;
export declare function stripRegisterGlyph(input: string, options?: AssistantRegisterParseOptions): string;
/** One-line meaning per register, keyed to the same registers as REGISTER_GLYPHS. */
export declare const REGISTER_DESCRIPTIONS: Readonly<Record<AssistantRegister, string>>;
/**
 * Card glyphs mark QUOTED folded memory (recall cards, starred moments,
 * coordinate-closet rows). They must never open fresh assistant speech:
 * a card-opened message would let replayed memory masquerade as a new
 * verdict and re-enter the episodic harvest (echo contamination).
 */
export declare const CARD_GLYPHS: readonly ["✎", "⭐", "💬", "🗣", "⌖", "Δ", "↞", "↠"];
/**
 * Build the canonical emit instruction from the parse-side constants.
 * Hosts may pass a replacement description table (same keys) to localize
 * wording, but the glyph set itself always comes from REGISTER_GLYPHS.
 */
export declare function buildRegisterGlyphPromptSnippet(descriptions?: Readonly<Record<AssistantRegister, string>>): string;
/**
 * Canonical host-injectable emit instruction. Keep SOP / system-prompt
 * wording aligned with this constant (sop/master.md P23 in the relay).
 */
export declare const REGISTER_GLYPH_PROMPT_SNIPPET: string;
