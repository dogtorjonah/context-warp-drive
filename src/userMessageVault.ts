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
import { classifyMessageGlyph, type MessageGlyphMode } from './foldEpisodes.ts';
import {
  USER_MESSAGE_VAULT_PREFIX,
  USER_MESSAGE_VAULT_END,
  stripUserMessageVaultBlocks,
  nominateVerbatim,
} from './rollingFold.ts';
import { renderEmbeddedContinuityArtifactProvenance } from './chronologicalProvenance.ts';

export interface UserMessageVaultEntry {
  text: string;
  createdAt?: string;
  /** Latest genuine operator turn that began the currently active task. */
  taskFrontier?: boolean;
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
export const USER_MESSAGE_VAULT_MAX_MESSAGES = 6;
export const USER_MESSAGE_VAULT_MAX_CHARS = 8_000;

function resolvePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Max retained operator messages — WARP_USER_VAULT_MAX_MESSAGES (default 6). */
export function resolveUserMessageVaultMaxMessages(env: NodeJS.ProcessEnv): number {
  return resolvePositiveIntEnv(env.WARP_USER_VAULT_MAX_MESSAGES, USER_MESSAGE_VAULT_MAX_MESSAGES);
}

/** Hard cap on the rendered vault block chars — WARP_USER_VAULT_MAX_CHARS (default 8000). */
export function resolveUserMessageVaultMaxChars(env: NodeJS.ProcessEnv): number {
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

export function resolveAssistantGlyphVaultMaxMessages(env: NodeJS.ProcessEnv): number {
  return resolvePositiveIntEnv(env.WARP_ASSISTANT_VAULT_MAX_MESSAGES, ASSISTANT_GLYPH_VAULT_MAX_MESSAGES);
}

/**
 * Scarce-slot priority for an assistant entry once it has crossed into the
 * folded region. Durable, final registers (🏁 verdict / ⚠️ hazard) are worth a
 * verbatim slot; ❓ blocked is mid; untagged is the fallback; transient 🔍/▶
 * working chatter ranks last because a fold skeleton already conveys it.
 */
export function assistantGlyphPriority(glyph: MessageGlyphMode | undefined): number {
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

export function resolveUserMessageVaultMinUtilization(env: NodeJS.ProcessEnv): number {
  const raw = env.WARP_USER_VAULT_MIN_UTILIZATION;
  if (raw === undefined || raw === '') return DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION;
  return Math.min(parsed, 1);
}

// ──────────────────────────────────────────────────────────────────────
// Surface-aware excerpting — bounded head/tail truncation per vault row.
// Deterministic; mirrors the fold-vault caps so a giant pasted message is
// excerpted (not dropped) while staying within the per-row budget.
// ──────────────────────────────────────────────────────────────────────

type VaultSurface =
  | 'fold_vault_newest'
  | 'fold_vault_older'
  | 'fold_vault_assistant_newest'
  | 'fold_vault_assistant_older';

const SURFACE_CHARS: Record<VaultSurface, number> = {
  fold_vault_newest: 2_400,
  fold_vault_older: 900,
  fold_vault_assistant_newest: 2_400,
  fold_vault_assistant_older: 900,
};

const SURFACE_HEAD_RATIO: Record<VaultSurface, number> = {
  fold_vault_newest: 0.72,
  fold_vault_older: 0.62,
  fold_vault_assistant_newest: 0.72,
  fold_vault_assistant_older: 0.62,
};

const SURFACE_ENV: Record<VaultSurface, string> = {
  fold_vault_newest: 'WARP_USER_VAULT_NEWEST_CHARS',
  fold_vault_older: 'WARP_USER_VAULT_OLDER_CHARS',
  fold_vault_assistant_newest: 'WARP_ASSISTANT_VAULT_NEWEST_CHARS',
  fold_vault_assistant_older: 'WARP_ASSISTANT_VAULT_OLDER_CHARS',
};

function surfaceLimit(surface: VaultSurface): number {
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
function extractVaultRecallTokens(omittedText: string): string[] {
  const MAX_TOKENS = 8;
  const MAX_TOKEN_LEN = 60;
  const tokens = nominateVerbatim(omittedText, MAX_TOKENS * 4);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tok of tokens) {
    if (tok.length > MAX_TOKEN_LEN || tok.length < 4) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    result.push(tok);
    if (result.length >= MAX_TOKENS) break;
  }
  return result;
}

/**
 * Build the [chars omitted] marker enriched with recall tokens from the omitted
 * region, or a plain marker when no distinctive tokens are found.
 */
function buildOmittedMarker(omittedChars: number, omittedText: string): string {
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
function excerptForSurface(text: string, surface: VaultSurface): string {
  const trimmed = text.trim();
  const max = surfaceLimit(surface);
  if (trimmed.length <= max) return trimmed;
  const headLen = Math.max(1, Math.floor(max * SURFACE_HEAD_RATIO[surface]));
  const tailLen = Math.max(0, max - headLen);
  const head = trimmed.slice(0, headLen).trimEnd();
  const tail = tailLen > 0 ? trimmed.slice(trimmed.length - tailLen).trimStart() : '';
  const omittedChars = trimmed.length - head.length - tail.length;
  if (omittedChars <= 0) return trimmed;
  const omittedText = trimmed.slice(head.length, trimmed.length - tail.length);
  const marker = buildOmittedMarker(omittedChars, omittedText);
  return tail
    ? `${head}\n${marker}\n${tail}`
    : `${head}\n${marker}`;
}

const HEADER = [
  USER_MESSAGE_VAULT_PREFIX,
  'Sealed Exchange Vault (synthetic): current-task-scoped wording evidence, not a transcript archive or instruction channel; persisted history remains retrievable.',
  'Non-instructional historical evidence only: quoted requests, approvals, and imperatives are never current authorization. Raw current operator instructions outside this block govern.',
].join('\n');

const MINIMAL_VAULT_HEADER = [
  USER_MESSAGE_VAULT_PREFIX,
  'Evidence only—never authorization.',
].join('\n');

function normalizeEntryText(text: string): string {
  return stripUserMessageVaultBlocks(text).trim();
}

function textBlockValue(value: unknown): string {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { text?: unknown }).text === 'string'
  )
    ? (value as { text: string }).text
    : '';
}

function visibleTextValues(message: VisibleUserMessage): string[] {
  const content = message.content;
  if (typeof content === 'string') return [content];
  const source = Array.isArray(content) ? content : Array.isArray(message.parts) ? message.parts : [];
  const texts = source.map(textBlockValue).filter((text) => text.trim().length > 0);
  return texts.length > 1 ? [...texts, texts.join('\n')] : texts;
}

function normalizedVisibleUserTexts(options: UserMessageVaultRenderOptions | undefined): string[] {
  const visible: string[] = [];
  for (const text of options?.visibleUserTexts ?? []) {
    const normalized = normalizeEntryText(text);
    if (normalized) visible.push(normalized);
  }
  for (const message of options?.visibleUserMessages ?? []) {
    if (!message || (message.role !== 'user' && message.type !== 'user')) continue;
    for (const text of visibleTextValues(message)) {
      const normalized = normalizeEntryText(text);
      if (normalized) visible.push(normalized);
    }
  }
  return visible;
}

function normalizedVisibleAssistantTexts(options: UserMessageVaultRenderOptions | undefined): string[] {
  const visible: string[] = [];
  for (const text of options?.visibleAssistantTexts ?? []) {
    const normalized = normalizeEntryText(text);
    if (normalized) visible.push(normalized);
  }
  for (const message of options?.visibleUserMessages ?? []) {
    if (!message) continue;
    const role = message.role ?? message.type;
    if (role !== 'assistant' && role !== 'model') continue;
    for (const text of visibleTextValues(message)) {
      const normalized = normalizeEntryText(text);
      if (normalized) visible.push(normalized);
    }
  }
  return visible;
}

function isAsciiWordChar(char: string): boolean {
  if (char.length === 0) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function containsEntryAtWordBoundary(visibleText: string, entryText: string): boolean {
  let index = visibleText.indexOf(entryText);
  while (index !== -1) {
    const before = index > 0 ? visibleText[index - 1] ?? '' : '';
    const afterIndex = index + entryText.length;
    const after = afterIndex < visibleText.length ? visibleText[afterIndex] ?? '' : '';
    if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) return true;
    index = visibleText.indexOf(entryText, index + 1);
  }
  return false;
}

function visibleUserTextContainsEntry(visibleText: string, entryText: string): boolean {
  const normalizedVisibleText = visibleText.toLowerCase();
  const normalizedEntryText = entryText.toLowerCase();
  return (
    normalizedVisibleText === normalizedEntryText ||
    containsEntryAtWordBoundary(normalizedVisibleText, normalizedEntryText)
  );
}

function isVisibleVaultEntry(entryText: string, visibleTexts: readonly string[]): boolean {
  return visibleTexts.some((visibleText) => visibleUserTextContainsEntry(visibleText, entryText));
}

function shortTimestamp(createdAt: string | undefined): string {
  if (!createdAt) return '';
  const trimmed = createdAt.trim();
  if (trimmed.length < 16) return trimmed;
  return trimmed.slice(0, 16).replace('T', ' ');
}

function renderEntry(entry: UserMessageVaultEntry, index: number, total: number): string {
  const isNewest = index === total - 1;
  const surface: VaultSurface = isNewest ? 'fold_vault_newest' : 'fold_vault_older';
  const timestamp = resolveUserMessageVaultMaxChars(process.env) >= 1_000
    ? shortTimestamp(entry.createdAt)
    : '';
  const title = timestamp
    ? `[operator evidence ${index + 1}/${total} @ ${timestamp}]`
    : `[operator evidence ${index + 1}/${total}]`;
  return `${title}\n${excerptForSurface(entry.text, surface)}`;
}

export function recordUserMessageVaultEntry(
  entries: UserMessageVaultEntry[],
  text: string,
  createdAt?: string,
  options: { taskFrontier?: boolean } = {},
): void {
  const normalized = normalizeEntryText(text);
  if (!normalized) return;
  entries.push({ text: normalized, createdAt, ...(options.taskFrontier ? { taskFrontier: true } : {}) });
  const maxMessages = resolveUserMessageVaultMaxMessages(process.env);
  if (entries.length > maxMessages) {
    entries.splice(0, entries.length - maxMessages);
  }
}

/** Keep only operator wording at or after the newest explicit task frontier. */
export function selectCurrentTaskUserMessageVaultEntries(
  entries: readonly UserMessageVaultEntry[],
): UserMessageVaultEntry[] {
  let frontier = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].taskFrontier !== true) continue;
    frontier = index;
    break;
  }
  return entries.slice(frontier >= 0 ? frontier : 0);
}

/**
 * Record a completed assistant message into the glyph vault buffer. Classifies
 * the opening register so render-time selection can prioritize durable
 * verdicts/hazards. Synthetic/empty text is dropped. Bounded to
 * ASSISTANT_GLYPH_VAULT_BUFFER (selection narrows further at render).
 */
export function recordAssistantGlyphVaultEntry(
  entries: AssistantGlyphVaultEntry[],
  text: string,
  createdAt?: string,
): void {
  const normalized = normalizeEntryText(text);
  if (!normalized) return;
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
export function seedUserMessageVaultFromMessages(
  messages: ReadonlyArray<{ role?: unknown; content?: unknown }>,
  sanitize: (text: string) => string | { text: string; createdAt?: string },
): UserMessageVaultEntry[] {
  const entries: UserMessageVaultEntry[] = [];
  for (const message of messages) {
    if (!message || message.role !== 'user') continue;
    const content = message.content;
    if (typeof content !== 'string' || !content) continue;
    const sanitized = sanitize(content);
    const genuine = typeof sanitized === 'string' ? sanitized : sanitized.text;
    const createdAt = typeof sanitized === 'string' ? undefined : sanitized.createdAt;
    if (genuine) recordUserMessageVaultEntry(entries, genuine, createdAt);
  }
  if (entries.length > 0) {
    entries[entries.length - 1] = { ...entries[entries.length - 1], taskFrontier: true };
  }
  return entries;
}

export function renderUserMessageVault(
  entries: readonly UserMessageVaultEntry[],
  options?: UserMessageVaultRenderOptions,
): string {
  const assistantEntries = options?.assistantEntries ?? [];
  if (assistantEntries.length === 0) {
    return renderOperatorOnlyVault(entries, options);
  }
  return renderInterleavedGlyphVault(entries, assistantEntries, options);
}

function renderOperatorOnlyVault(
  entries: readonly UserMessageVaultEntry[],
  options?: UserMessageVaultRenderOptions,
): string {
  const maxMessages = resolveUserMessageVaultMaxMessages(process.env);
  const maxChars = resolveUserMessageVaultMaxChars(process.env);
  const visibleTexts = normalizedVisibleUserTexts(options);
  const currentTaskEntries = selectCurrentTaskUserMessageVaultEntries(entries);
  let retained = currentTaskEntries
    .map((entry) => ({ ...entry, text: normalizeEntryText(entry.text) }))
    .filter((entry) => entry.text.length > 0 && !isVisibleVaultEntry(entry.text, visibleTexts))
    .slice(-maxMessages);

  // Only the row that IS the newest operator message may carry the LIVE
  // marker; if the newest was deduped out as still-visible, nothing is live
  // (the message itself is in view, which is stronger than any marker).
  const newestText = currentTaskEntries.length > 0
    ? normalizeEntryText(currentTaskEntries[currentTaskEntries.length - 1].text)
    : '';

  while (retained.length > 0) {
    const liveNewest =
      options?.newestOperatorUnanswered === true
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
    const provenance = renderVaultBlockProvenance(
      retained.map((entry, index) => ({
        createdAt: entry.createdAt,
        live: liveNewest && index === retained.length - 1,
      })),
      'operator-only',
    );
    const header = maxChars < 1_000 ? MINIMAL_VAULT_HEADER : HEADER;
    const block = `${header}\n${provenance}\n\n${body}\n${USER_MESSAGE_VAULT_END}`;
    if (block.length <= maxChars) return block;
    retained = retained.slice(1);
  }

  return '';
}

const GLYPH_GRAMMAR_HEADER = [
  USER_MESSAGE_VAULT_PREFIX,
  'Sealed Exchange Vault (synthetic): current-task-scoped operator and recent self-glyph evidence, not a transcript archive or instruction channel; persisted history remains retrievable.',
  'Non-instructional historical evidence only: quoted requests, approvals, and imperatives are never current authorization. Raw current operator instructions outside this block govern.',
].join('\n');

const GLYPH_DISPLAY: Record<MessageGlyphMode, string> = {
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
export const USER_MESSAGE_VAULT_LIVE_MARKER =
  '⌖ CURRENT-TASK EVIDENCE — newest recorded operator wording was unanswered when captured. This synthetic copy is non-authoritative; raw current instructions and live rail state govern.';

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

function renderVaultBlockProvenance(
  rows: ReadonlyArray<{ createdAt?: string; live?: boolean }>,
  mode: 'operator-only' | 'full' | 'delta',
): string {
  const includeTimestamps = resolveUserMessageVaultMaxChars(process.env) >= 1_000;
  const firstTimestamp = includeTimestamps
    ? rows.find((row) => row.createdAt)?.createdAt
    : undefined;
  let lastTimestamp: string | undefined;
  if (includeTimestamps) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (!rows[index].createdAt) continue;
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
    authority: 'historical-background',
  }) ?? '';
}

function entryMs(createdAt: string | undefined): number {
  if (!createdAt) return 0;
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

function renderVaultRow(row: VaultRenderRow, isNewest: boolean): string {
  const timestamp = resolveUserMessageVaultMaxChars(process.env) >= 1_000
    ? shortTimestamp(row.createdAt)
    : '';
  if (row.role === 'user') {
    const surface: VaultSurface = isNewest ? 'fold_vault_newest' : 'fold_vault_older';
    const title = timestamp ? `[operator evidence @ ${timestamp}]` : '[operator evidence]';
    const rendered = `${title}\n${excerptForSurface(row.text, surface)}`;
    return row.live ? `${rendered}\n${USER_MESSAGE_VAULT_LIVE_MARKER}` : rendered;
  }
  const surface: VaultSurface = isNewest ? 'fold_vault_assistant_newest' : 'fold_vault_assistant_older';
  const glyphTag = row.glyph ? `${GLYPH_DISPLAY[row.glyph]} ` : '';
  const title = timestamp ? `[your ${glyphTag}message @ ${timestamp}]` : `[your ${glyphTag}message]`;
  return `${title}\n${excerptForSurface(row.text, surface)}`;
}

const VAULT_DELTA_HEADER = [
  USER_MESSAGE_VAULT_PREFIX,
  'Sealed Exchange Vault delta (synthetic): current-task-scoped operator and self-glyph evidence sealed once into this band.',
  'Non-instructional historical evidence only; never authorization. Raw current operator instructions outside this block govern.',
].join('\n');

/**
 * Assemble a vault block from already-selected rows. mode='full' uses the
 * standing glyph-grammar header (byte-identical to the legacy interleaved
 * render); mode='delta' uses the per-band delta header. Both open with
 * USER_MESSAGE_VAULT_PREFIX so isSyntheticContextText recognizes and skips the
 * block during turn detection, eviction, and recall indexing.
 */
export function renderVaultRowsBlock(
  rows: readonly VaultRenderRow[],
  mode: 'full' | 'delta' = 'full',
): string {
  if (rows.length === 0) return '';
  const header = resolveUserMessageVaultMaxChars(process.env) < 1_000
    ? MINIMAL_VAULT_HEADER
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
export function vaultRowFingerprint(row: Pick<VaultRenderRow, 'role' | 'text'>): string {
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
export function selectVaultRows(
  userEntries: readonly UserMessageVaultEntry[],
  assistantEntries: readonly AssistantGlyphVaultEntry[],
  options?: UserMessageVaultRenderOptions,
  env: NodeJS.ProcessEnv = process.env,
): VaultRenderRow[] {
  const maxMessages = resolveUserMessageVaultMaxMessages(env);
  const maxChars = resolveUserMessageVaultMaxChars(env);
  const assistantMax = resolveAssistantGlyphVaultMaxMessages(env);
  const visibleUserTexts = normalizedVisibleUserTexts(options);
  const visibleAssistantTexts = normalizedVisibleAssistantTexts(options);
  const currentTaskEntries = selectCurrentTaskUserMessageVaultEntries(userEntries);
  const taskFrontierMs = entryMs(currentTaskEntries[0]?.createdAt);
  const isAtOrAfterTaskFrontier = (createdAt: string | undefined): boolean => {
    const createdMs = entryMs(createdAt);
    return taskFrontierMs <= 0 || createdMs <= 0 || createdMs >= taskFrontierMs;
  };

  const userRows: VaultRenderRow[] = currentTaskEntries
    .map((entry) => ({ ...entry, text: normalizeEntryText(entry.text) }))
    .filter((entry) => entry.text.length > 0 && !isVisibleVaultEntry(entry.text, visibleUserTexts))
    .slice(-maxMessages)
    .map((entry) => ({
      role: 'user' as const,
      text: entry.text,
      createdAt: entry.createdAt,
      priority: Number.POSITIVE_INFINITY,
    }));
  if (options?.newestOperatorUnanswered && userRows.length > 0 && currentTaskEntries.length > 0) {
    // Only flag the row that IS the newest operator message; if the newest was
    // deduped out as still-visible, no vault row is live (the message itself is
    // in view, which is stronger than any marker).
    const newestText = normalizeEntryText(currentTaskEntries[currentTaskEntries.length - 1].text);
    const last = userRows[userRows.length - 1];
    if (last.text === newestText) userRows[userRows.length - 1] = { ...last, live: true };
  }

  const normalizedAssistant = assistantEntries
    .map((entry) => ({ ...entry, text: normalizeEntryText(entry.text) }))
    .filter((entry) => entry.text.length > 0
      && isAtOrAfterTaskFrontier(entry.createdAt)
      && !isVisibleVaultEntry(entry.text, visibleAssistantTexts));
  const assistantRows: VaultRenderRow[] = normalizedAssistant
    .map((entry, idx) => ({ entry, idx }))
    .sort((a, b) =>
      assistantGlyphPriority(b.entry.glyph) - assistantGlyphPriority(a.entry.glyph)
      || b.idx - a.idx)
    .slice(0, assistantMax)
    .map(({ entry }) => ({
      role: 'assistant' as const,
      text: entry.text,
      createdAt: entry.createdAt,
      glyph: entry.glyph,
      priority: assistantGlyphPriority(entry.glyph),
    }));

  let rows: VaultRenderRow[] = [...userRows, ...assistantRows];
  if (rows.length === 0) return [];
  rows.sort((a, b) => entryMs(a.createdAt) - entryMs(b.createdAt));

  for (;;) {
    const block = renderVaultRowsBlock(rows, 'full');
    if (block.length <= maxChars) return rows;
    const assistantCandidates = rows
      .map((row, idx) => ({ row, idx }))
      .filter(({ row }) => row.role === 'assistant');
    if (assistantCandidates.length > 0) {
      assistantCandidates.sort((a, b) =>
        a.row.priority - b.row.priority
        || entryMs(a.row.createdAt) - entryMs(b.row.createdAt));
      const victimIdx = assistantCandidates[0].idx;
      rows = rows.filter((_, idx) => idx !== victimIdx);
      continue;
    }
    rows = rows.slice(1);
    if (rows.length === 0) return [];
  }
}

/**
 * Rows newly eligible to seal into the current band: the selected rows whose
 * fingerprint has not already been sealed into an earlier band this freeze
 * generation. The caller adds these fingerprints to its sealed set after baking.
 */
export function selectVaultDeltaRows(
  allRows: readonly VaultRenderRow[],
  sealedFingerprints: ReadonlySet<string>,
): VaultRenderRow[] {
  return allRows.filter((row) => !sealedFingerprints.has(vaultRowFingerprint(row)));
}

/**
 * Rows eligible for band sealing: live (unanswered-newest) rows are deferred so
 * a frozen prefix never contains the LIVE marker (stale the moment the message
 * is answered) nor an unmarked copy of the unanswered row (whose visibility
 * would dedupe the transient live render away). Once answered the row loses its
 * live flag and seals normally under the unchanged fingerprint.
 */
export function selectSealableVaultRows(rows: readonly VaultRenderRow[]): VaultRenderRow[] {
  return rows.filter((row) => row.live !== true);
}

function renderInterleavedGlyphVault(
  userEntries: readonly UserMessageVaultEntry[],
  assistantEntries: readonly AssistantGlyphVaultEntry[],
  options?: UserMessageVaultRenderOptions,
): string {
  return renderVaultRowsBlock(selectVaultRows(userEntries, assistantEntries, options), 'full');
}

interface AppendableMessage extends VisibleUserMessage {
  role?: unknown;
  content?: unknown;
  parts?: unknown;
}

function hasNonEmptyText(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { text?: unknown }).text === 'string' &&
    (value as { text: string }).text.trim().length > 0
  );
}

function userMessageHasAppendableText(message: AppendableMessage): boolean {
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.some(hasNonEmptyText);
  if (Array.isArray(message.parts)) return message.parts.some(hasNonEmptyText);
  return false;
}

function messageWithVaultAppended<T extends AppendableMessage>(message: T, vault: string): T {
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
export function appendUserMessageVaultToView<T extends AppendableMessage>(
  view: T[],
  vault: string,
  tailWindow?: number,
): T[] {
  if (!vault) return view;
  const start =
    typeof tailWindow === 'number' && Number.isFinite(tailWindow)
      ? Math.max(0, view.length - Math.max(0, Math.trunc(tailWindow)))
      : 0;
  for (let i = view.length - 1; i >= start; i -= 1) {
    const message = view[i];
    if (!message || (message as AppendableMessage).role !== 'user') continue;
    if (!userMessageHasAppendableText(message)) continue;
    const updated = messageWithVaultAppended(message, vault);
    if (updated === message) continue;
    const next = view.slice();
    next[i] = updated;
    return next;
  }
  return view;
}
