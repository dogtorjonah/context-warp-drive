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
import { classifyMessageGlyph } from './foldEpisodes.ts';
import { USER_MESSAGE_VAULT_PREFIX, USER_MESSAGE_VAULT_END, stripUserMessageVaultBlocks, nominateVerbatim, } from './rollingFold.ts';
import { renderEmbeddedContinuityArtifactProvenance } from './chronologicalProvenance.ts';
/** Default bounds — overridable via the WARP_USER_VAULT_* env family (defaults unchanged when unset). */
export const USER_MESSAGE_VAULT_MAX_MESSAGES = 6;
export const USER_MESSAGE_VAULT_MAX_CHARS = 8_000;
function resolvePositiveIntEnv(raw, fallback) {
    if (raw === undefined || raw === '')
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return parsed;
}
/** Max retained operator messages — WARP_USER_VAULT_MAX_MESSAGES (default 6). */
export function resolveUserMessageVaultMaxMessages(env) {
    return resolvePositiveIntEnv(env.WARP_USER_VAULT_MAX_MESSAGES, USER_MESSAGE_VAULT_MAX_MESSAGES);
}
/** Hard cap on the rendered vault block chars — WARP_USER_VAULT_MAX_CHARS (default 8000). */
export function resolveUserMessageVaultMaxChars(env) {
    return resolvePositiveIntEnv(env.WARP_USER_VAULT_MAX_CHARS, USER_MESSAGE_VAULT_MAX_CHARS);
}
/**
 * Max assistant glyph entries rendered into the interleaved vault slice —
 * WARP_ASSISTANT_VAULT_MAX_MESSAGES (default 4). The slice is bounded
 * independently of the operator floor so AI entries can never crowd operator
 * wording out of its retained count.
 */
export const ASSISTANT_GLYPH_VAULT_MAX_MESSAGES = 4;
/**
 * Raw recorded-buffer cap on the assistant entry list. Selection (by glyph
 * priority + recency) happens at render, so the session retains a slightly
 * larger window than it renders to keep durable 🏁/⚠️ entries available even
 * after a burst of transient 🔍/▶ chatter.
 */
export const ASSISTANT_GLYPH_VAULT_BUFFER = 24;
export function resolveAssistantGlyphVaultMaxMessages(env) {
    return resolvePositiveIntEnv(env.WARP_ASSISTANT_VAULT_MAX_MESSAGES, ASSISTANT_GLYPH_VAULT_MAX_MESSAGES);
}
/**
 * Scarce-slot priority for an assistant entry once it has crossed into the
 * folded region. Durable, final registers (🏁 verdict / ⚠️ hazard) are worth a
 * verbatim slot; ❓ blocked is mid; untagged is the fallback; transient 🔍/▶
 * working chatter ranks last because a fold skeleton already conveys it.
 */
export function assistantGlyphPriority(glyph) {
    switch (glyph) {
        case 'verdict':
        case 'hazard':
            return 4;
        case 'blocked':
            return 3;
        case 'working':
        case 'executing':
            return 1;
        default:
            return 2; // untagged fallback
    }
}
/**
 * Measured-utilization floor below which the vault is omitted as redundant (when
 * nothing has folded yet, all recent messages are still retained verbatim).
 * Tunable via WARP_USER_VAULT_MIN_UTILIZATION (fraction 0..1). A
 * fold-actually-folded-a-turn signal overrides this floor for continuity, so
 * this only governs how early (pre-fold) the vault starts riding.
 */
export const DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION = 0.6;
export function resolveUserMessageVaultMinUtilization(env) {
    const raw = env.WARP_USER_VAULT_MIN_UTILIZATION;
    if (raw === undefined || raw === '')
        return DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0)
        return DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION;
    return Math.min(parsed, 1);
}
const SURFACE_CHARS = {
    fold_vault_newest: 2_400,
    fold_vault_older: 900,
    fold_vault_assistant_newest: 2_400,
    fold_vault_assistant_older: 900,
};
const SURFACE_HEAD_RATIO = {
    fold_vault_newest: 0.72,
    fold_vault_older: 0.62,
    fold_vault_assistant_newest: 0.72,
    fold_vault_assistant_older: 0.62,
};
const SURFACE_ENV = {
    fold_vault_newest: 'WARP_USER_VAULT_NEWEST_CHARS',
    fold_vault_older: 'WARP_USER_VAULT_OLDER_CHARS',
    fold_vault_assistant_newest: 'WARP_ASSISTANT_VAULT_NEWEST_CHARS',
    fold_vault_assistant_older: 'WARP_ASSISTANT_VAULT_OLDER_CHARS',
};
function surfaceLimit(surface) {
    return resolvePositiveIntEnv(process.env[SURFACE_ENV[surface]], SURFACE_CHARS[surface]);
}
/**
 * Extract verbatim recall tokens from the omitted middle region of an oversized
 * vault excerpt. These tokens (file paths, hex hashes, changelog IDs, symbol
 * names) are the same shapes the fold recall engine's verbatim-token tier
 * matches against active window text. Injecting them into the [chars omitted]
 * marker makes the vault self-activating: when the agent writes any of these
 * tokens in its normal reasoning, verbatim recall fires and pages back the
 * full turn automatically. Cap: 8 tokens, 4–60 chars each.
 */
function extractVaultRecallTokens(omittedText) {
    const MAX_TOKENS = 8;
    const MAX_TOKEN_LEN = 60;
    const tokens = nominateVerbatim(omittedText, MAX_TOKENS * 4);
    const seen = new Set();
    const result = [];
    for (const tok of tokens) {
        if (tok.length > MAX_TOKEN_LEN || tok.length < 4)
            continue;
        if (seen.has(tok))
            continue;
        seen.add(tok);
        result.push(tok);
        if (result.length >= MAX_TOKENS)
            break;
    }
    return result;
}
/**
 * Build the [chars omitted] marker enriched with recall tokens from the omitted
 * region, or a plain marker when no distinctive tokens are found.
 */
function buildOmittedMarker(omittedChars, omittedText) {
    const tokens = extractVaultRecallTokens(omittedText);
    if (tokens.length === 0) {
        return `… [${omittedChars} chars omitted] …`;
    }
    return `… [${omittedChars} chars omitted — write any token to recall full text: ${tokens.join(', ')}] …`;
}
/**
 * Bound a vault row's text to its surface cap with a deterministic head/tail
 * excerpt (keeps the request opening AND its tail, where the operative ask
 * usually sits) instead of a front-only truncation. Under the cap, the text is
 * returned trimmed and unchanged.
 *
 * The [chars omitted] marker is enriched with verbatim recall tokens extracted
 * from the omitted region so the fold recall engine can self-activate recovery
 * of the full message when the agent touches those tokens in subsequent turns.
 */
function excerptForSurface(text, surface) {
    const trimmed = text.trim();
    const max = surfaceLimit(surface);
    if (trimmed.length <= max)
        return trimmed;
    const headLen = Math.max(1, Math.floor(max * SURFACE_HEAD_RATIO[surface]));
    const tailLen = Math.max(0, max - headLen);
    const head = trimmed.slice(0, headLen).trimEnd();
    const tail = tailLen > 0 ? trimmed.slice(trimmed.length - tailLen).trimStart() : '';
    const omittedChars = trimmed.length - head.length - tail.length;
    if (omittedChars <= 0)
        return trimmed;
    const omittedText = trimmed.slice(head.length, trimmed.length - tail.length);
    const marker = buildOmittedMarker(omittedChars, omittedText);
    return tail
        ? `${head}\n${marker}\n${tail}`
        : `${head}\n${marker}`;
}
const HEADER = [
    USER_MESSAGE_VAULT_PREFIX,
    'Sealed Exchange Vault (synthetic): bounded operator excerpts for wording continuity, not a transcript archive. Current user instructions outside this block remain authoritative.',
].join('\n');
function normalizeEntryText(text) {
    return stripUserMessageVaultBlocks(text).trim();
}
function textBlockValue(value) {
    return (!!value &&
        typeof value === 'object' &&
        typeof value.text === 'string')
        ? value.text
        : '';
}
function visibleTextValues(message) {
    const content = message.content;
    if (typeof content === 'string')
        return [content];
    const source = Array.isArray(content) ? content : Array.isArray(message.parts) ? message.parts : [];
    const texts = source.map(textBlockValue).filter((text) => text.trim().length > 0);
    return texts.length > 1 ? [...texts, texts.join('\n')] : texts;
}
function normalizedVisibleUserTexts(options) {
    const visible = [];
    for (const text of options?.visibleUserTexts ?? []) {
        const normalized = normalizeEntryText(text);
        if (normalized)
            visible.push(normalized);
    }
    for (const message of options?.visibleUserMessages ?? []) {
        if (!message || (message.role !== 'user' && message.type !== 'user'))
            continue;
        for (const text of visibleTextValues(message)) {
            const normalized = normalizeEntryText(text);
            if (normalized)
                visible.push(normalized);
        }
    }
    return visible;
}
function normalizedVisibleAssistantTexts(options) {
    const visible = [];
    for (const text of options?.visibleAssistantTexts ?? []) {
        const normalized = normalizeEntryText(text);
        if (normalized)
            visible.push(normalized);
    }
    for (const message of options?.visibleUserMessages ?? []) {
        if (!message)
            continue;
        const role = message.role ?? message.type;
        if (role !== 'assistant' && role !== 'model')
            continue;
        for (const text of visibleTextValues(message)) {
            const normalized = normalizeEntryText(text);
            if (normalized)
                visible.push(normalized);
        }
    }
    return visible;
}
function isAsciiWordChar(char) {
    if (char.length === 0)
        return false;
    const code = char.charCodeAt(0);
    return ((code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code === 95);
}
function containsEntryAtWordBoundary(visibleText, entryText) {
    let index = visibleText.indexOf(entryText);
    while (index !== -1) {
        const before = index > 0 ? visibleText[index - 1] ?? '' : '';
        const afterIndex = index + entryText.length;
        const after = afterIndex < visibleText.length ? visibleText[afterIndex] ?? '' : '';
        if (!isAsciiWordChar(before) && !isAsciiWordChar(after))
            return true;
        index = visibleText.indexOf(entryText, index + 1);
    }
    return false;
}
function visibleUserTextContainsEntry(visibleText, entryText) {
    const normalizedVisibleText = visibleText.toLowerCase();
    const normalizedEntryText = entryText.toLowerCase();
    return (normalizedVisibleText === normalizedEntryText ||
        containsEntryAtWordBoundary(normalizedVisibleText, normalizedEntryText));
}
function isVisibleVaultEntry(entryText, visibleTexts) {
    return visibleTexts.some((visibleText) => visibleUserTextContainsEntry(visibleText, entryText));
}
function shortTimestamp(createdAt) {
    if (!createdAt)
        return '';
    const trimmed = createdAt.trim();
    if (trimmed.length < 16)
        return trimmed;
    return trimmed.slice(0, 16).replace('T', ' ');
}
function renderEntry(entry, index, total) {
    const isNewest = index === total - 1;
    const surface = isNewest ? 'fold_vault_newest' : 'fold_vault_older';
    const timestamp = shortTimestamp(entry.createdAt);
    const title = timestamp
        ? `[operator message ${index + 1}/${total} @ ${timestamp}]`
        : `[operator message ${index + 1}/${total}]`;
    return `${title}\n${excerptForSurface(entry.text, surface)}`;
}
export function recordUserMessageVaultEntry(entries, text, createdAt) {
    const normalized = normalizeEntryText(text);
    if (!normalized)
        return;
    entries.push({ text: normalized, createdAt });
    const maxMessages = resolveUserMessageVaultMaxMessages(process.env);
    if (entries.length > maxMessages) {
        entries.splice(0, entries.length - maxMessages);
    }
}
/**
 * Record a completed assistant message into the glyph vault buffer. Classifies
 * the opening register so render-time selection can prioritize durable
 * verdicts/hazards. Synthetic/empty text is dropped. Bounded to
 * ASSISTANT_GLYPH_VAULT_BUFFER (selection narrows further at render).
 */
export function recordAssistantGlyphVaultEntry(entries, text, createdAt) {
    const normalized = normalizeEntryText(text);
    if (!normalized)
        return;
    const glyph = classifyMessageGlyph(normalized) ?? undefined;
    entries.push({ text: normalized, createdAt, glyph });
    if (entries.length > ASSISTANT_GLYPH_VAULT_BUFFER) {
        entries.splice(0, entries.length - ASSISTANT_GLYPH_VAULT_BUFFER);
    }
}
/**
 * Build a fresh, capped vault-entry list from a message history (e.g. a rebuilt
 * history during session resume). Keeps only genuine user-role prose: non-user
 * and non-string-content messages are skipped, each user message is passed
 * through `sanitize` and dropped when it sanitizes to empty. `sanitize` may
 * return a plain cleaned string or a `{ text, createdAt? }` pair (lifting an
 * inherited timestamp into createdAt). Order and the cap follow
 * recordUserMessageVaultEntry.
 */
export function seedUserMessageVaultFromMessages(messages, sanitize) {
    const entries = [];
    for (const message of messages) {
        if (!message || message.role !== 'user')
            continue;
        const content = message.content;
        if (typeof content !== 'string' || !content)
            continue;
        const sanitized = sanitize(content);
        const genuine = typeof sanitized === 'string' ? sanitized : sanitized.text;
        const createdAt = typeof sanitized === 'string' ? undefined : sanitized.createdAt;
        if (genuine)
            recordUserMessageVaultEntry(entries, genuine, createdAt);
    }
    return entries;
}
export function renderUserMessageVault(entries, options) {
    const assistantEntries = options?.assistantEntries ?? [];
    if (assistantEntries.length === 0) {
        return renderOperatorOnlyVault(entries, options);
    }
    return renderInterleavedGlyphVault(entries, assistantEntries, options);
}
function renderOperatorOnlyVault(entries, options) {
    const maxMessages = resolveUserMessageVaultMaxMessages(process.env);
    const maxChars = resolveUserMessageVaultMaxChars(process.env);
    const visibleTexts = normalizedVisibleUserTexts(options);
    let retained = entries
        .map((entry) => ({ ...entry, text: normalizeEntryText(entry.text) }))
        .filter((entry) => entry.text.length > 0 && !isVisibleVaultEntry(entry.text, visibleTexts))
        .slice(-maxMessages);
    // Only the row that IS the newest operator message may carry the LIVE
    // marker; if the newest was deduped out as still-visible, nothing is live
    // (the message itself is in view, which is stronger than any marker).
    const newestText = entries.length > 0 ? normalizeEntryText(entries[entries.length - 1].text) : '';
    while (retained.length > 0) {
        const liveNewest = options?.newestOperatorUnanswered === true
            && newestText.length > 0
            && retained[retained.length - 1].text === newestText;
        const body = retained
            .map((entry, index) => {
            const rendered = renderEntry(entry, index, retained.length);
            return liveNewest && index === retained.length - 1
                ? `${rendered}\n${USER_MESSAGE_VAULT_LIVE_MARKER}`
                : rendered;
        })
            .join('\n\n');
        const provenance = renderVaultBlockProvenance(retained.map((entry, index) => ({
            createdAt: entry.createdAt,
            live: liveNewest && index === retained.length - 1,
        })), 'operator-only');
        const header = maxChars < 1_000 ? USER_MESSAGE_VAULT_PREFIX : HEADER;
        const block = `${header}\n${provenance}\n\n${body}\n${USER_MESSAGE_VAULT_END}`;
        if (block.length <= maxChars)
            return block;
        retained = retained.slice(1);
    }
    return '';
}
const GLYPH_GRAMMAR_HEADER = [
    USER_MESSAGE_VAULT_PREFIX,
    'Sealed Exchange Vault (synthetic): bounded operator and recent self-glyph excerpts for wording continuity, not a transcript archive. Current instructions outside this block remain authoritative.',
].join('\n');
const GLYPH_DISPLAY = {
    working: '🔍',
    executing: '▶',
    verdict: '🏁',
    hazard: '⚠️',
    blocked: '❓',
};
/**
 * Rendered directly under the newest operator row when it is still unanswered
 * (arrived after the agent's last completed reply). Transient send views only:
 * live rows are deferred from band sealing via selectSealableVaultRows, so this
 * marker is never baked into a byte-frozen prefix where it would go stale.
 */
export const USER_MESSAGE_VAULT_LIVE_MARKER = '⌖ LIVE — this operator message arrived after your last completed reply and is UNANSWERED; your current work must resolve it or it remains open.';
function renderVaultBlockProvenance(rows, mode) {
    const includeTimestamps = resolveUserMessageVaultMaxChars(process.env) >= 1_000;
    const firstTimestamp = includeTimestamps
        ? rows.find((row) => row.createdAt)?.createdAt
        : undefined;
    let lastTimestamp;
    if (includeTimestamps) {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (!rows[index].createdAt)
                continue;
            lastTimestamp = rows[index].createdAt;
            break;
        }
    }
    return renderEmbeddedContinuityArtifactProvenance({
        artifact: `glyph-vault#${mode}`,
        contentClass: 'exact-excerpt',
        traceId: 'vault-buffer',
        unit: 'row',
        sourceStart: 0,
        sourceEndExclusive: rows.length,
        sourceFirstTimestamp: firstTimestamp,
        sourceLastTimestamp: lastTimestamp,
        authority: rows.some((row) => row.live) ? 'live' : 'historical-background',
    }) ?? '';
}
function entryMs(createdAt) {
    if (!createdAt)
        return 0;
    const ms = Date.parse(createdAt);
    return Number.isFinite(ms) ? ms : 0;
}
function renderVaultRow(row, isNewest) {
    const timestamp = shortTimestamp(row.createdAt);
    if (row.role === 'user') {
        const surface = isNewest ? 'fold_vault_newest' : 'fold_vault_older';
        const title = timestamp ? `[operator message @ ${timestamp}]` : '[operator message]';
        const rendered = `${title}\n${excerptForSurface(row.text, surface)}`;
        return row.live ? `${rendered}\n${USER_MESSAGE_VAULT_LIVE_MARKER}` : rendered;
    }
    const surface = isNewest ? 'fold_vault_assistant_newest' : 'fold_vault_assistant_older';
    const glyphTag = row.glyph ? `${GLYPH_DISPLAY[row.glyph]} ` : '';
    const title = timestamp ? `[your ${glyphTag}message @ ${timestamp}]` : `[your ${glyphTag}message]`;
    return `${title}\n${excerptForSurface(row.text, surface)}`;
}
const VAULT_DELTA_HEADER = [
    USER_MESSAGE_VAULT_PREFIX,
    'Sealed Exchange Vault delta (synthetic): bounded operator and self-glyph excerpts folded into THIS band and sealed once, not a transcript archive. Earlier bands and current instructions remain authoritative.',
].join('\n');
/**
 * Assemble a vault block from already-selected rows. mode='full' uses the
 * standing glyph-grammar header (byte-identical to the legacy interleaved
 * render); mode='delta' uses the per-band delta header. Both open with
 * USER_MESSAGE_VAULT_PREFIX so isSyntheticContextText recognizes and skips the
 * block during turn detection, eviction, and recall indexing.
 */
export function renderVaultRowsBlock(rows, mode = 'full') {
    if (rows.length === 0)
        return '';
    const header = resolveUserMessageVaultMaxChars(process.env) < 1_000
        ? USER_MESSAGE_VAULT_PREFIX
        : mode === 'delta' ? VAULT_DELTA_HEADER : GLYPH_GRAMMAR_HEADER;
    const body = rows
        .map((row, index) => renderVaultRow(row, index === rows.length - 1))
        .join('\n\n');
    const provenance = renderVaultBlockProvenance(rows, mode);
    return `${header}\n${provenance}\n\n${body}\n${USER_MESSAGE_VAULT_END}`;
}
/**
 * Stable per-row identity used by the per-band seal to dedupe a row across band
 * epochs (so each operator/glyph entry seals into exactly one band until the
 * next whole-view rebuild resets the sealed set). FNV-1a over the normalized text,
 * namespaced by role.
 */
export function vaultRowFingerprint(row) {
    const normalized = normalizeEntryText(row.text);
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i += 1) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${row.role}:${(hash >>> 0).toString(36)}`;
}
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
export function selectVaultRows(userEntries, assistantEntries, options, env = process.env) {
    const maxMessages = resolveUserMessageVaultMaxMessages(env);
    const maxChars = resolveUserMessageVaultMaxChars(env);
    const assistantMax = resolveAssistantGlyphVaultMaxMessages(env);
    const visibleUserTexts = normalizedVisibleUserTexts(options);
    const visibleAssistantTexts = normalizedVisibleAssistantTexts(options);
    const userRows = userEntries
        .map((entry) => ({ ...entry, text: normalizeEntryText(entry.text) }))
        .filter((entry) => entry.text.length > 0 && !isVisibleVaultEntry(entry.text, visibleUserTexts))
        .slice(-maxMessages)
        .map((entry) => ({
        role: 'user',
        text: entry.text,
        createdAt: entry.createdAt,
        priority: Number.POSITIVE_INFINITY,
    }));
    if (options?.newestOperatorUnanswered && userRows.length > 0 && userEntries.length > 0) {
        // Only flag the row that IS the newest operator message; if the newest was
        // deduped out as still-visible, no vault row is live (the message itself is
        // in view, which is stronger than any marker).
        const newestText = normalizeEntryText(userEntries[userEntries.length - 1].text);
        const last = userRows[userRows.length - 1];
        if (last.text === newestText)
            userRows[userRows.length - 1] = { ...last, live: true };
    }
    const normalizedAssistant = assistantEntries
        .map((entry) => ({ ...entry, text: normalizeEntryText(entry.text) }))
        .filter((entry) => entry.text.length > 0 && !isVisibleVaultEntry(entry.text, visibleAssistantTexts));
    const assistantRows = normalizedAssistant
        .map((entry, idx) => ({ entry, idx }))
        .sort((a, b) => assistantGlyphPriority(b.entry.glyph) - assistantGlyphPriority(a.entry.glyph)
        || b.idx - a.idx)
        .slice(0, assistantMax)
        .map(({ entry }) => ({
        role: 'assistant',
        text: entry.text,
        createdAt: entry.createdAt,
        glyph: entry.glyph,
        priority: assistantGlyphPriority(entry.glyph),
    }));
    let rows = [...userRows, ...assistantRows];
    if (rows.length === 0)
        return [];
    rows.sort((a, b) => entryMs(a.createdAt) - entryMs(b.createdAt));
    for (;;) {
        const block = renderVaultRowsBlock(rows, 'full');
        if (block.length <= maxChars)
            return rows;
        const assistantCandidates = rows
            .map((row, idx) => ({ row, idx }))
            .filter(({ row }) => row.role === 'assistant');
        if (assistantCandidates.length > 0) {
            assistantCandidates.sort((a, b) => a.row.priority - b.row.priority
                || entryMs(a.row.createdAt) - entryMs(b.row.createdAt));
            const victimIdx = assistantCandidates[0].idx;
            rows = rows.filter((_, idx) => idx !== victimIdx);
            continue;
        }
        rows = rows.slice(1);
        if (rows.length === 0)
            return [];
    }
}
/**
 * Rows newly eligible to seal into the current band: the selected rows whose
 * fingerprint has not already been sealed into an earlier band this freeze
 * generation. The caller adds these fingerprints to its sealed set after baking.
 */
export function selectVaultDeltaRows(allRows, sealedFingerprints) {
    return allRows.filter((row) => !sealedFingerprints.has(vaultRowFingerprint(row)));
}
/**
 * Rows eligible for band sealing: live (unanswered-newest) rows are deferred so
 * a frozen prefix never contains the LIVE marker (stale the moment the message
 * is answered) nor an unmarked copy of the unanswered row (whose visibility
 * would dedupe the transient live render away). Once answered the row loses its
 * live flag and seals normally under the unchanged fingerprint.
 */
export function selectSealableVaultRows(rows) {
    return rows.filter((row) => row.live !== true);
}
function renderInterleavedGlyphVault(userEntries, assistantEntries, options) {
    return renderVaultRowsBlock(selectVaultRows(userEntries, assistantEntries, options), 'full');
}
function hasNonEmptyText(value) {
    return (!!value &&
        typeof value === 'object' &&
        typeof value.text === 'string' &&
        value.text.trim().length > 0);
}
function userMessageHasAppendableText(message) {
    const content = message.content;
    if (typeof content === 'string')
        return content.trim().length > 0;
    if (Array.isArray(content))
        return content.some(hasNonEmptyText);
    if (Array.isArray(message.parts))
        return message.parts.some(hasNonEmptyText);
    return false;
}
function messageWithVaultAppended(message, vault) {
    const content = message.content;
    if (typeof content === 'string') {
        return { ...message, content: content.length > 0 ? `${content}\n\n${vault}` : vault };
    }
    if (Array.isArray(content)) {
        return { ...message, content: [...content, { type: 'text', text: vault }] };
    }
    if (Array.isArray(message.parts)) {
        return { ...message, parts: [...message.parts, { text: vault }] };
    }
    return message;
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
export function appendUserMessageVaultToView(view, vault, tailWindow) {
    if (!vault)
        return view;
    const start = typeof tailWindow === 'number' && Number.isFinite(tailWindow)
        ? Math.max(0, view.length - Math.max(0, Math.trunc(tailWindow)))
        : 0;
    for (let i = view.length - 1; i >= start; i -= 1) {
        const message = view[i];
        if (!message || message.role !== 'user')
            continue;
        if (!userMessageHasAppendableText(message))
            continue;
        const updated = messageWithVaultAppended(message, vault);
        if (updated === message)
            continue;
        const next = view.slice();
        next[i] = updated;
        return next;
    }
    return view;
}
//# sourceMappingURL=userMessageVault.js.map