/**
 * User Message Vault + Glyph Grammar Vault.
 *
 * A bounded continuity block that preserves exact operator wording — and, when
 * supplied, the agent's own recent glyph-tagged turns — across fold boundaries.
 * When older turns skeletonize into the frozen fold prefix, both sides of the
 * salient recent dialogue would otherwise lose their verbatim wording; this
 * vault rides the transient send view (never the persisted history) so the
 * exact text survives folding.
 *
 * Pure CPU, zero I/O. The block markers + stripper live in `./rollingFold.ts`
 * (the fold engine strips any stale vault block before re-folding); this module
 * imports them rather than re-declaring so there is a single source of truth.
 */
import { type MessageGlyphMode } from './foldEpisodes.ts';
export interface UserMessageVaultEntry {
    text: string;
    createdAt?: string;
}
/**
 * An assistant-side vault entry — a recent glyph-opening (or untagged) assistant
 * message captured so the fold companion can preserve the agent's own verbatim
 * reasoning the way it preserves operator wording. `glyph` is the classified
 * register (undefined = untagged fallback) and drives scarce-slot priority.
 */
export interface AssistantGlyphVaultEntry {
    text: string;
    createdAt?: string;
    glyph?: MessageGlyphMode;
}
export interface UserMessageVaultRenderOptions {
    visibleUserTexts?: readonly string[];
    visibleUserMessages?: ReadonlyArray<VisibleUserMessage>;
    /**
     * Recent assistant glyph entries to interleave with the operator vault. When
     * empty/omitted the render is byte-identical to the operator-only vault — the
     * glyph-grammar path only engages when assistant entries are supplied.
     */
    assistantEntries?: readonly AssistantGlyphVaultEntry[];
    /** Visible assistant texts (in the send view) to dedupe against, like visibleUserTexts. */
    visibleAssistantTexts?: readonly string[];
    /**
     * When true, the newest surviving operator row is flagged live: it arrived
     * after the agent's last completed assistant turn and is still UNANSWERED, so
     * its render carries USER_MESSAGE_VAULT_LIVE_MARKER. Transient send-view
     * renders only — bake/seal paths must pass this too but then exclude live
     * rows via selectSealableVaultRows (cache safety: a LIVE marker must never
     * seal into a frozen band, where it would read as unanswered forever, and an
     * unmarked seal would make the row "visible" and dedupe the transient marker
     * away).
     */
    newestOperatorUnanswered?: boolean;
}
interface VisibleUserMessage {
    role?: unknown;
    type?: unknown;
    content?: unknown;
    parts?: unknown;
}
/** Default bounds — overridable via the WARP_USER_VAULT_* env family (defaults unchanged when unset). */
export declare const USER_MESSAGE_VAULT_MAX_MESSAGES = 6;
export declare const USER_MESSAGE_VAULT_MAX_CHARS = 8000;
/** Max retained operator messages — WARP_USER_VAULT_MAX_MESSAGES (default 6). */
export declare function resolveUserMessageVaultMaxMessages(env: NodeJS.ProcessEnv): number;
/** Hard cap on the rendered vault block chars — WARP_USER_VAULT_MAX_CHARS (default 8000). */
export declare function resolveUserMessageVaultMaxChars(env: NodeJS.ProcessEnv): number;
/**
 * Max assistant glyph entries rendered into the interleaved vault slice —
 * WARP_ASSISTANT_VAULT_MAX_MESSAGES (default 4). The slice is bounded
 * independently of the operator floor so AI entries can never crowd operator
 * wording out of its retained count.
 */
export declare const ASSISTANT_GLYPH_VAULT_MAX_MESSAGES = 4;
/**
 * Raw recorded-buffer cap on the assistant entry list. Selection (by glyph
 * priority + recency) happens at render, so the session retains a slightly
 * larger window than it renders to keep durable 🏁/⚠️ entries available even
 * after a burst of transient 🔍/▶ chatter.
 */
export declare const ASSISTANT_GLYPH_VAULT_BUFFER = 24;
export declare function resolveAssistantGlyphVaultMaxMessages(env: NodeJS.ProcessEnv): number;
/**
 * Scarce-slot priority for an assistant entry once it has crossed into the
 * folded region. Durable, final registers (🏁 verdict / ⚠️ hazard) are worth a
 * verbatim slot; ❓ blocked is mid; untagged is the fallback; transient 🔍/▶
 * working chatter ranks last because a fold skeleton already conveys it.
 */
export declare function assistantGlyphPriority(glyph: MessageGlyphMode | undefined): number;
/**
 * Measured-utilization floor below which the vault is omitted as redundant (when
 * nothing has folded yet, all recent messages are still retained verbatim).
 * Tunable via WARP_USER_VAULT_MIN_UTILIZATION (fraction 0..1). A
 * fold-actually-folded-a-turn signal overrides this floor for continuity, so
 * this only governs how early (pre-fold) the vault starts riding.
 */
export declare const DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION = 0.6;
export declare function resolveUserMessageVaultMinUtilization(env: NodeJS.ProcessEnv): number;
export declare function recordUserMessageVaultEntry(entries: UserMessageVaultEntry[], text: string, createdAt?: string): void;
/**
 * Record a completed assistant message into the glyph vault buffer. Classifies
 * the opening register so render-time selection can prioritize durable
 * verdicts/hazards. Synthetic/empty text is dropped. Bounded to
 * ASSISTANT_GLYPH_VAULT_BUFFER (selection narrows further at render).
 */
export declare function recordAssistantGlyphVaultEntry(entries: AssistantGlyphVaultEntry[], text: string, createdAt?: string): void;
/**
 * Build a fresh, capped vault-entry list from a message history (e.g. a rebuilt
 * history during session resume). Keeps only genuine user-role prose: non-user
 * and non-string-content messages are skipped, each user message is passed
 * through `sanitize` and dropped when it sanitizes to empty. `sanitize` may
 * return a plain cleaned string or a `{ text, createdAt? }` pair (lifting an
 * inherited timestamp into createdAt). Order and the cap follow
 * recordUserMessageVaultEntry.
 */
export declare function seedUserMessageVaultFromMessages(messages: ReadonlyArray<{
    role?: unknown;
    content?: unknown;
}>, sanitize: (text: string) => string | {
    text: string;
    createdAt?: string;
}): UserMessageVaultEntry[];
export declare function renderUserMessageVault(entries: readonly UserMessageVaultEntry[], options?: UserMessageVaultRenderOptions): string;
/**
 * Rendered directly under the newest operator row when it is still unanswered
 * (arrived after the agent's last completed reply). Transient send views only:
 * live rows are deferred from band sealing via selectSealableVaultRows, so this
 * marker is never baked into a byte-frozen prefix where it would go stale.
 */
export declare const USER_MESSAGE_VAULT_LIVE_MARKER = "\u2316 LIVE \u2014 this operator message arrived after your last completed reply and is UNANSWERED; your current work must resolve it or it remains open.";
export interface VaultRenderRow {
    role: 'user' | 'assistant';
    text: string;
    createdAt?: string;
    glyph?: MessageGlyphMode;
    /** Eviction priority — operator rows are Infinity (protected floor). */
    priority: number;
    /**
     * Newest operator row still unanswered at render time. Rendered with
     * USER_MESSAGE_VAULT_LIVE_MARKER on transient views; excluded from band
     * sealing (selectSealableVaultRows) until answered. Never part of the row
     * fingerprint — once answered, the same row seals under the same identity.
     */
    live?: boolean;
}
/**
 * Assemble a vault block from already-selected rows. mode='full' uses the
 * standing glyph-grammar header (byte-identical to the legacy interleaved
 * render); mode='delta' uses the per-band delta header. Both open with
 * USER_MESSAGE_VAULT_PREFIX so isSyntheticContextText recognizes and skips the
 * block during turn detection, eviction, and recall indexing.
 */
export declare function renderVaultRowsBlock(rows: readonly VaultRenderRow[], mode?: 'full' | 'delta'): string;
/**
 * Stable per-row identity used by the per-band seal to dedupe a row across band
 * epochs (so each operator/glyph entry seals into exactly one band until the
 * next whole-view rebuild resets the sealed set). FNV-1a over the normalized text,
 * namespaced by role.
 */
export declare function vaultRowFingerprint(row: Pick<VaultRenderRow, 'role' | 'text'>): string;
/**
 * Shared selection for the interleaved vault: operator entries (protected floor,
 * last maxMessages) merged chronologically with a bounded slice of assistant
 * glyph entries (top assistantMax by glyph priority then recency), deduped
 * against visible text. When the rendered block exceeds the char cap, assistant
 * rows are evicted first — lowest glyph priority then oldest — so operator
 * wording is never dropped while any AI row remains; only when no assistant rows
 * are left does it shrink the operator floor. Returns the final rows so the full
 * render AND the per-band seal/delta path agree on exactly which rows exist.
 */
export declare function selectVaultRows(userEntries: readonly UserMessageVaultEntry[], assistantEntries: readonly AssistantGlyphVaultEntry[], options?: UserMessageVaultRenderOptions, env?: NodeJS.ProcessEnv): VaultRenderRow[];
/**
 * Rows newly eligible to seal into the current band: the selected rows whose
 * fingerprint has not already been sealed into an earlier band this freeze
 * generation. The caller adds these fingerprints to its sealed set after baking.
 */
export declare function selectVaultDeltaRows(allRows: readonly VaultRenderRow[], sealedFingerprints: ReadonlySet<string>): VaultRenderRow[];
/**
 * Rows eligible for band sealing: live (unanswered-newest) rows are deferred so
 * a frozen prefix never contains the LIVE marker (stale the moment the message
 * is answered) nor an unmarked copy of the unanswered row (whose visibility
 * would dedupe the transient live render away). Once answered the row loses its
 * live flag and seals normally under the unchanged fingerprint.
 */
export declare function selectSealableVaultRows(rows: readonly VaultRenderRow[]): VaultRenderRow[];
interface AppendableMessage extends VisibleUserMessage {
    role?: unknown;
    content?: unknown;
    parts?: unknown;
}
/**
 * Append the rendered vault block to the newest text-bearing user message in a
 * transient send view (the fold output), never the persisted history. Scans
 * newest→oldest, optionally bounded to the last `tailWindow` messages so the
 * append only ever lands in the cache-miss raw tail and never mutates the
 * byte-frozen fold prefix. Tool-result user turns (no top-level text) and
 * non-user messages are skipped. Returns the same array reference when there is
 * nothing to do; otherwise a new array whose single replaced message is a fresh
 * object — input messages are never mutated. Supports both `content`
 * (string | content-block array) and Gemini-style `parts` shapes.
 */
export declare function appendUserMessageVaultToView<T extends AppendableMessage>(view: T[], vault: string, tailWindow?: number): T[];
export {};
