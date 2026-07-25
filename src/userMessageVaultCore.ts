/**
 * Canonical portable core for the User Message Vault.
 *
 * The core owns row typing, selection, chronology, provenance, rendering,
 * fingerprints, frontier handling, delta selection, and transient-view append
 * semantics. Hosts supply only their environment-key family, surface excerpt
 * renderer, optional visibility aliases, and header wording.
 *
 * Pure synchronous CPU; no filesystem, network, or persistence access.
 */
import type { MessageGlyphMode } from './foldEpisodes.ts';
import { renderEmbeddedContinuityArtifactProvenance } from './chronologicalProvenance.ts';
import {
  USER_MESSAGE_VAULT_END,
  USER_MESSAGE_VAULT_PREFIX,
  renderHistoricalPayloadRecord,
  stripUserMessageVaultBlocks,
} from './rollingFold.ts';

export {
  USER_MESSAGE_VAULT_END,
  USER_MESSAGE_VAULT_PREFIX,
  stripUserMessageVaultBlocks,
};

export interface UserMessageVaultEntry {
  text: string;
  createdAt?: string;
  /** Latest genuine operator turn that began the currently active task. */
  taskFrontier?: boolean;
}

export interface AssistantGlyphVaultEntry {
  text: string;
  createdAt?: string;
  glyph?: MessageGlyphMode;
}

export interface EditProvenanceVaultEntry {
  instanceId: string;
  instanceName?: string;
  toolName: string;
  filePath: string;
  diffHash: string;
  oldString?: string | null;
  newString?: string | null;
  replaceAll?: boolean;
  createdAt?: string;
  timestampMs?: number;
  toolUseId?: string | null;
}

interface VisibleUserMessage {
  role?: unknown;
  type?: unknown;
  content?: unknown;
  parts?: unknown;
}

export interface UserMessageVaultRenderOptions {
  visibleUserTexts?: readonly string[];
  visibleUserMessages?: ReadonlyArray<VisibleUserMessage>;
  assistantEntries?: readonly AssistantGlyphVaultEntry[];
  visibleAssistantTexts?: readonly string[];
  editEntries?: readonly EditProvenanceVaultEntry[];
  /**
   * True only while the newest operator row has not received a completed
   * assistant reply. Live rows render transiently but are never sealable.
   */
  newestOperatorUnanswered?: boolean;
  /**
   * Fingerprints already sealed into an earlier band in this freeze
   * generation. Under pressure, sealed rows are evicted before unsealed rows.
   */
  sealedFingerprints?: ReadonlySet<string>;
}

export const USER_MESSAGE_VAULT_MAX_MESSAGES = 6;
export const USER_MESSAGE_VAULT_MAX_CHARS = 8_000;
export const ASSISTANT_GLYPH_VAULT_MAX_MESSAGES = 4;
export const ASSISTANT_GLYPH_VAULT_BUFFER = 24;
export const EDIT_PROVENANCE_VAULT_MAX_ENTRIES = 48;
export const EDIT_PROVENANCE_VAULT_MAX_MESSAGES = 8;
export const EDIT_PROVENANCE_VAULT_SNIPPET_CHARS = 180;
export const EDIT_PROVENANCE_VAULT_GLOBAL_CAP = 500;
export const DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION = 0.6;

export const USER_MESSAGE_VAULT_LIVE_MARKER =
  '⌖ CURRENT-TASK EVIDENCE — newest recorded operator wording was unanswered when captured. This synthetic copy is non-authoritative; raw current instructions and live rail state govern.';

export const VAULT_RECORD_SCHEMA_VERSION = 'vault-record/v1' as const;

export type VaultOperatorLiveness = 'answered' | 'unanswered';
export type VaultEvidenceLiveness = VaultOperatorLiveness | 'not-applicable';
export type VaultAuthorizationState = 'expired' | 'not-applicable' | 'live';
export type VaultOperatorTaskScope = 'current-task' | 'historical';

interface VaultRenderPayload {
  text: string;
  /** Authoritative source time copied from the original row; null is explicit unknown. */
  sourceTime: string | null;
  glyph?: MessageGlyphMode;
  edit?: EditProvenanceVaultEntry;
  /** Eviction priority — operator rows are Infinity (protected floor). */
  priority: number;
}

export type VaultRenderRow = VaultRenderPayload & (
  | {
    kind: 'evidence';
    role: 'user';
    liveness: VaultOperatorLiveness;
    authorization: 'expired';
    /**
     * Current-task is chronology/scope metadata, never an authorization grant.
     * Historical rows are retained for continuity but explicitly demoted.
     */
    taskScope: VaultOperatorTaskScope;
  }
  | {
    kind: 'evidence';
    role: 'assistant' | 'edit';
    liveness: 'not-applicable';
    authorization: 'not-applicable';
  }
);

type VaultOperatorRenderRow = Extract<VaultRenderRow, { role: 'user' }>;

export interface VaultLiveDirectiveRecord {
  kind: 'live-directive';
  role: 'user';
  text: string;
  sourceTime: string | null;
  liveness: 'unanswered';
  authorization: 'live';
}

export type VaultSemanticRecord = VaultRenderRow | VaultLiveDirectiveRecord;

export type VaultSurface =
  | 'fold_vault_newest'
  | 'fold_vault_older'
  | 'fold_vault_assistant_newest'
  | 'fold_vault_assistant_older';

export interface UserMessageVaultCoreConfig {
  envKeys: {
    maxMessages: string;
    maxChars: string;
    assistantMaxMessages: string;
    minUtilization: string;
    editMaxMessages: string;
    editSnippetChars: string;
  };
  classifyMessageGlyph(text: string): MessageGlyphMode | null | undefined;
  renderSurfaceText(text: string, surface: VaultSurface): string;
  /**
   * Additional host renderings that can already contain the same semantic
   * entry. The raw entry is always included automatically.
   */
  visibleEntryCandidates?(entryText: string): readonly string[];
  headers: {
    operator: string;
    full: string;
    fullWithEdits?: string;
    delta: string;
    deltaWithEdits?: string;
    minimal: string;
  };
  /** Optional shorter trace coordinate used only below the compact-char threshold. */
  compactProvenanceTraceId?: string;
}

export interface UserMessageVaultCore {
  resolveUserMessageVaultMaxMessages(env: NodeJS.ProcessEnv): number;
  resolveUserMessageVaultMaxChars(env: NodeJS.ProcessEnv): number;
  resolveAssistantGlyphVaultMaxMessages(env: NodeJS.ProcessEnv): number;
  resolveEditProvenanceVaultMaxMessages(env: NodeJS.ProcessEnv): number;
  resolveEditProvenanceVaultSnippetChars(env: NodeJS.ProcessEnv): number;
  resolveUserMessageVaultMinUtilization(env: NodeJS.ProcessEnv): number;
  recordUserMessageVaultEntry(
    entries: UserMessageVaultEntry[],
    text: string,
    createdAt?: string,
    options?: { taskFrontier?: boolean },
  ): void;
  recordAssistantGlyphVaultEntry(
    entries: AssistantGlyphVaultEntry[],
    text: string,
    createdAt?: string,
  ): void;
  seedUserMessageVaultFromMessages(
    messages: ReadonlyArray<{ role?: unknown; content?: unknown }>,
    sanitize: (text: string) => string | { text: string; createdAt?: string },
  ): UserMessageVaultEntry[];
  selectCurrentTaskUserMessageVaultEntries(
    entries: readonly UserMessageVaultEntry[],
  ): UserMessageVaultEntry[];
  selectRenderedEditProvenanceVaultEntries(
    entries: readonly EditProvenanceVaultEntry[],
    env?: NodeJS.ProcessEnv,
  ): EditProvenanceVaultEntry[];
  renderUserMessageVault(
    entries: readonly UserMessageVaultEntry[],
    options?: UserMessageVaultRenderOptions,
  ): string;
  renderVaultRowsBlock(rows: readonly VaultRenderRow[], mode?: 'full' | 'delta'): string;
  selectVaultRows(
    userEntries: readonly UserMessageVaultEntry[],
    assistantEntries: readonly AssistantGlyphVaultEntry[],
    editEntries: readonly EditProvenanceVaultEntry[],
    options?: UserMessageVaultRenderOptions,
    env?: NodeJS.ProcessEnv,
  ): VaultRenderRow[];
}

function resolvePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

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
      return 2;
  }
}

function normalizeEntryText(text: string): string {
  return stripUserMessageVaultBlocks(text).trim();
}

export function editProvenanceCreatedMs(
  entry: { createdAt?: string; timestampMs?: number },
): number {
  if (typeof entry.timestampMs === 'number' && Number.isFinite(entry.timestampMs)) {
    return entry.timestampMs;
  }
  if (!entry.createdAt) return 0;
  const ms = Date.parse(entry.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeCreatedAt(
  entry: { createdAt?: string; timestampMs?: number },
): string | undefined {
  if (entry.createdAt?.trim()) return entry.createdAt;
  const ms = editProvenanceCreatedMs(entry);
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

export function editProvenanceVaultKey(entry: EditProvenanceVaultEntry): string {
  if (entry.toolUseId) return `${entry.instanceId}\0tool:${entry.toolUseId}`;
  const ms = editProvenanceCreatedMs(entry);
  return `${entry.instanceId}\0hash:${entry.diffHash}\0path:${entry.filePath}\0ts:${ms}`;
}

export function normalizeEditProvenanceVaultEntry(
  entry: EditProvenanceVaultEntry,
): EditProvenanceVaultEntry | null {
  const instanceId = entry.instanceId.trim();
  const filePath = entry.filePath.trim();
  const toolName = entry.toolName.trim() || 'Edit';
  const diffHash = entry.diffHash.trim();
  if (!instanceId || !filePath || !diffHash) return null;
  const createdAt = normalizeCreatedAt(entry);
  return {
    instanceId,
    ...(entry.instanceName?.trim() ? { instanceName: entry.instanceName.trim() } : {}),
    toolName,
    filePath,
    diffHash,
    ...(entry.oldString !== undefined ? { oldString: entry.oldString } : {}),
    ...(entry.newString !== undefined ? { newString: entry.newString } : {}),
    ...(typeof entry.replaceAll === 'boolean' ? { replaceAll: entry.replaceAll } : {}),
    ...(createdAt ? { createdAt } : {}),
    timestampMs: editProvenanceCreatedMs(entry) || Date.now(),
    ...(entry.toolUseId !== undefined ? { toolUseId: entry.toolUseId } : {}),
  };
}

export function editProvenanceVaultFingerprint(
  entry: Pick<EditProvenanceVaultEntry, 'diffHash'>,
): string {
  return entry.diffHash.slice(0, 16);
}

export function editProvenanceVaultFingerprints(
  entries: readonly Pick<EditProvenanceVaultEntry, 'diffHash'>[],
): string[] {
  return [...new Set(entries.map(editProvenanceVaultFingerprint).filter(Boolean))];
}

export function compactEditSnippet(
  value: string | null | undefined,
  maxChars: number,
): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 15))} ... [clipped]`;
}

function newestTaskFrontierIndex(
  entries: readonly UserMessageVaultEntry[],
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].taskFrontier === true) return index;
  }
  return -1;
}

function operatorTaskScope(
  entries: readonly UserMessageVaultEntry[],
  index: number,
): VaultOperatorTaskScope {
  const entryMs = sourceTimeMs(entries[index]?.createdAt);
  // Unknown chronology can never silently qualify operator wording as current.
  if (entryMs === null) return 'historical';

  const frontierIndex = newestTaskFrontierIndex(entries);
  if (frontierIndex < 0) return 'current-task';
  const frontierMs = sourceTimeMs(entries[frontierIndex]?.createdAt);
  if (frontierMs === null) return 'historical';
  return index >= frontierIndex && entryMs >= frontierMs
    ? 'current-task'
    : 'historical';
}

/** Return only operator wording proven to be in the newest task scope. */
export function selectCurrentTaskUserMessageVaultEntries(
  entries: readonly UserMessageVaultEntry[],
): UserMessageVaultEntry[] {
  return entries.filter((_, index) => operatorTaskScope(entries, index) === 'current-task');
}

export function vaultRowFingerprint(
  row: Pick<VaultRenderRow, 'role' | 'text' | 'edit'>,
): string {
  if (row.role === 'edit' && row.edit) {
    return `edit:${editProvenanceVaultFingerprint(row.edit)}`;
  }
  const normalized = normalizeEntryText(row.text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${row.role}:${(hash >>> 0).toString(36)}`;
}

export function selectVaultDeltaRows(
  allRows: readonly VaultRenderRow[],
  sealedFingerprints: ReadonlySet<string>,
): VaultRenderRow[] {
  return allRows.filter((row) => !sealedFingerprints.has(vaultRowFingerprint(row)));
}

export function selectSealableVaultRows(
  rows: readonly VaultRenderRow[],
): VaultRenderRow[] {
  return rows.filter((row) => row.liveness !== 'unanswered');
}

function hasNonEmptyText(value: unknown): boolean {
  return !!value
    && typeof value === 'object'
    && typeof (value as { text?: unknown }).text === 'string'
    && (value as { text: string }).text.trim().length > 0;
}

function userMessageHasAppendableText(message: VisibleUserMessage): boolean {
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.some(hasNonEmptyText);
  if (Array.isArray(message.parts)) return message.parts.some(hasNonEmptyText);
  return false;
}

function messageWithVaultAppended<T extends VisibleUserMessage>(message: T, vault: string): T {
  if (typeof message.content === 'string') {
    return {
      ...message,
      content: message.content.length > 0 ? `${message.content}\n\n${vault}` : vault,
    };
  }
  if (Array.isArray(message.content)) {
    return { ...message, content: [...message.content, { type: 'text', text: vault }] };
  }
  if (Array.isArray(message.parts)) {
    return { ...message, parts: [...message.parts, { text: vault }] };
  }
  return message;
}

export function appendUserMessageVaultToView<T extends VisibleUserMessage>(
  view: T[],
  vault: string,
  tailWindow?: number,
): T[] {
  if (!vault) return view;
  const start = typeof tailWindow === 'number' && Number.isFinite(tailWindow)
    ? Math.max(0, view.length - Math.max(0, Math.trunc(tailWindow)))
    : 0;
  for (let index = view.length - 1; index >= start; index -= 1) {
    const message = view[index];
    if (!message || message.role !== 'user' || !userMessageHasAppendableText(message)) continue;
    const updated = messageWithVaultAppended(message, vault);
    if (updated === message) continue;
    const next = view.slice();
    next[index] = updated;
    return next;
  }
  return view;
}

function textBlockValue(value: unknown): string {
  return !!value
    && typeof value === 'object'
    && typeof (value as { text?: unknown }).text === 'string'
    ? (value as { text: string }).text
    : '';
}

function visibleTextValues(message: VisibleUserMessage): string[] {
  if (typeof message.content === 'string') return [message.content];
  const source = Array.isArray(message.content)
    ? message.content
    : Array.isArray(message.parts) ? message.parts : [];
  const texts = source.map(textBlockValue).filter((text) => text.trim().length > 0);
  return texts.length > 1 ? [...texts, texts.join('\n')] : texts;
}

function normalizedVisibleTexts(
  options: UserMessageVaultRenderOptions | undefined,
  role: 'user' | 'assistant',
): string[] {
  const visible: string[] = [];
  const direct = role === 'user' ? options?.visibleUserTexts : options?.visibleAssistantTexts;
  for (const text of direct ?? []) {
    const normalized = normalizeEntryText(text);
    if (normalized) visible.push(normalized);
  }
  for (const message of options?.visibleUserMessages ?? []) {
    if (!message) continue;
    const messageRole = message.role ?? message.type;
    const matches = role === 'user'
      ? messageRole === 'user'
      : true;
    // Assistant continuity may be carried inside a relay-owned synthetic user
    // message (for example a folded cognitive waypoint). Any exact occurrence
    // in the send view is therefore stronger than a redundant assistant vault
    // copy, regardless of the provider role of its host message. Operator
    // evidence remains role-scoped so an assistant merely quoting a request
    // cannot suppress the canonical operator row.
    if (!matches) continue;
    for (const text of visibleTextValues(message)) {
      const normalized = normalizeEntryText(text);
      if (normalized) visible.push(normalized);
    }
  }
  return visible;
}

function isAsciiWordChar(char: string): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 95;
}

function containsEntryAtWordBoundary(visibleText: string, entryText: string): boolean {
  const requiresLeadingBoundary = isAsciiWordChar(entryText[0] ?? '');
  const requiresTrailingBoundary = isAsciiWordChar(entryText[entryText.length - 1] ?? '');
  let index = visibleText.indexOf(entryText);
  while (index !== -1) {
    const before = index > 0 ? visibleText[index - 1] ?? '' : '';
    const afterIndex = index + entryText.length;
    const after = afterIndex < visibleText.length ? visibleText[afterIndex] ?? '' : '';
    const leadingBoundary = !requiresLeadingBoundary || !isAsciiWordChar(before);
    const trailingBoundary = !requiresTrailingBoundary || !isAsciiWordChar(after);
    if (leadingBoundary && trailingBoundary) return true;
    index = visibleText.indexOf(entryText, index + 1);
  }
  return false;
}

function visibleTextContainsEntry(visibleText: string, entryText: string): boolean {
  const visible = visibleText.toLowerCase();
  const entry = entryText.toLowerCase();
  return visible === entry || containsEntryAtWordBoundary(visible, entry);
}

function sourceTimeMs(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null;
  const ms = Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}

function compareSourceTimeAsc(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const aMs = sourceTimeMs(a);
  const bMs = sourceTimeMs(b);
  if (aMs === null && bMs === null) return 0;
  if (aMs === null) return 1;
  if (bMs === null) return -1;
  return aMs - bMs;
}

function operatorEvidenceRow(
  text: string,
  createdAt: string | undefined,
  taskScope: VaultOperatorTaskScope,
  liveness: VaultOperatorLiveness = 'answered',
): VaultOperatorRenderRow {
  return {
    kind: 'evidence',
    role: 'user',
    text,
    sourceTime: createdAt ?? null,
    liveness,
    authorization: 'expired',
    taskScope,
    priority: Number.POSITIVE_INFINITY,
  };
}

function clipVaultRowBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  if (maxChars <= 1) return body.slice(0, Math.max(0, maxChars));
  const marker = '…';
  const payloadChars = maxChars - marker.length;
  const headChars = Math.ceil(payloadChars * 0.7);
  const tailChars = payloadChars - headChars;
  return `${body.slice(0, headChars)}${marker}${tailChars > 0 ? body.slice(-tailChars) : ''}`;
}

export function createUserMessageVaultCore(
  config: UserMessageVaultCoreConfig,
): UserMessageVaultCore {
  const resolveUserMessageVaultMaxMessages = (env: NodeJS.ProcessEnv): number =>
    resolvePositiveIntEnv(env[config.envKeys.maxMessages], USER_MESSAGE_VAULT_MAX_MESSAGES);
  const resolveUserMessageVaultMaxChars = (env: NodeJS.ProcessEnv): number =>
    resolvePositiveIntEnv(env[config.envKeys.maxChars], USER_MESSAGE_VAULT_MAX_CHARS);
  const resolveAssistantGlyphVaultMaxMessages = (env: NodeJS.ProcessEnv): number =>
    resolvePositiveIntEnv(
      env[config.envKeys.assistantMaxMessages],
      ASSISTANT_GLYPH_VAULT_MAX_MESSAGES,
    );
  const resolveEditProvenanceVaultMaxMessages = (env: NodeJS.ProcessEnv): number =>
    resolvePositiveIntEnv(env[config.envKeys.editMaxMessages], EDIT_PROVENANCE_VAULT_MAX_MESSAGES);
  const resolveEditProvenanceVaultSnippetChars = (env: NodeJS.ProcessEnv): number =>
    resolvePositiveIntEnv(env[config.envKeys.editSnippetChars], EDIT_PROVENANCE_VAULT_SNIPPET_CHARS);
  const resolveUserMessageVaultMinUtilization = (env: NodeJS.ProcessEnv): number => {
    const raw = env[config.envKeys.minUtilization];
    if (raw === undefined || raw === '') return DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION;
    return Math.min(parsed, 1);
  };

  const entryCandidates = (entryText: string): string[] => {
    const candidates = [entryText, ...(config.visibleEntryCandidates?.(entryText) ?? [])];
    const seen = new Set<string>();
    return candidates
      .map(normalizeEntryText)
      .filter((candidate) => {
        if (!candidate || seen.has(candidate)) return false;
        seen.add(candidate);
        return true;
      });
  };

  const isVisibleVaultEntry = (entryText: string, visibleTexts: readonly string[]): boolean => {
    const candidates = entryCandidates(entryText);
    return visibleTexts.some((visibleText) =>
      candidates.some((candidate) => visibleTextContainsEntry(visibleText, candidate)));
  };

  const recordUserMessageVaultEntry = (
    entries: UserMessageVaultEntry[],
    text: string,
    createdAt?: string,
    options: { taskFrontier?: boolean } = {},
  ): void => {
    const normalized = normalizeEntryText(text);
    if (!normalized) return;
    entries.push({
      text: normalized,
      createdAt,
      ...(options.taskFrontier ? { taskFrontier: true } : {}),
    });
    const maxMessages = resolveUserMessageVaultMaxMessages(process.env);
    if (entries.length > maxMessages) entries.splice(0, entries.length - maxMessages);
  };

  const recordAssistantGlyphVaultEntry = (
    entries: AssistantGlyphVaultEntry[],
    text: string,
    createdAt?: string,
  ): void => {
    const normalized = normalizeEntryText(text);
    if (!normalized) return;
    const glyph = config.classifyMessageGlyph(normalized) ?? undefined;
    entries.push({ text: normalized, createdAt, glyph });
    if (entries.length > ASSISTANT_GLYPH_VAULT_BUFFER) {
      entries.splice(0, entries.length - ASSISTANT_GLYPH_VAULT_BUFFER);
    }
  };

  const seedUserMessageVaultFromMessages = (
    messages: ReadonlyArray<{ role?: unknown; content?: unknown }>,
    sanitize: (text: string) => string | { text: string; createdAt?: string },
  ): UserMessageVaultEntry[] => {
    const entries: UserMessageVaultEntry[] = [];
    for (const message of messages) {
      if (!message || message.role !== 'user' || typeof message.content !== 'string') continue;
      const sanitized = sanitize(message.content);
      const text = typeof sanitized === 'string' ? sanitized : sanitized.text;
      const createdAt = typeof sanitized === 'string' ? undefined : sanitized.createdAt;
      if (text) recordUserMessageVaultEntry(entries, text, createdAt);
    }
    if (entries.length > 0) {
      entries[entries.length - 1] = { ...entries[entries.length - 1], taskFrontier: true };
    }
    return entries;
  };

  const selectRenderedEditProvenanceVaultEntries = (
    entries: readonly EditProvenanceVaultEntry[],
    env: NodeJS.ProcessEnv = process.env,
  ): EditProvenanceVaultEntry[] =>
    entries
      .map(normalizeEditProvenanceVaultEntry)
      .filter((entry): entry is EditProvenanceVaultEntry => entry !== null)
      .sort((a, b) => editProvenanceCreatedMs(a) - editProvenanceCreatedMs(b))
      .slice(-resolveEditProvenanceVaultMaxMessages(env));

  const renderVaultRecordHeader = (
    row: VaultRenderRow,
    index: number,
    total: number,
  ): string => {
    const sourceTime = row.sourceTime === null ? 'unknown' : JSON.stringify(row.sourceTime);
    const glyph = row.role === 'assistant' ? ` glyph=${row.glyph ?? 'untagged'}` : '';
    const taskScope = row.role === 'user' ? ` task-scope=${row.taskScope}` : '';
    const historicalAuthority = row.role === 'user' && row.taskScope === 'historical'
      ? ' authority=historical-background'
      : '';
    if (resolveUserMessageVaultMaxChars(process.env) < 1_000) {
      const role = row.role === 'user' ? 'u' : row.role === 'assistant' ? 'a' : 'x';
      const compactTime = row.sourceTime === null
        ? '?'
        : /^[A-Za-z0-9_.:+-]+$/u.test(row.sourceTime) ? row.sourceTime : sourceTime;
      const liveness = row.liveness === 'answered' ? 'a'
        : row.liveness === 'unanswered' ? 'u' : 'n';
      const authorization = row.authorization === 'expired' ? 'x' : 'n';
      // Preserve the established one-operator 520-char floor byte-for-byte.
      // Current-task scope is the compact default; only demoted history needs
      // an extra discriminator under the authorization-denying minimal header.
      const compactScope = row.role === 'user' && row.taskScope === 'historical'
        ? ' s=h'
        : '';
      return `[VR1:${role} t=${compactTime} l=${liveness} a=${authorization}${compactScope}]`;
    }
    return `[Vault Record] schema=${VAULT_RECORD_SCHEMA_VERSION} kind=${row.kind} role=${row.role}`
      + ` source-time=${sourceTime} liveness=${row.liveness} authorization=${row.authorization}`
      + `${taskScope}${historicalAuthority}${glyph} ordinal=${index + 1}/${total}`;
  };

  const renderVaultBlockProvenance = (
    rows: ReadonlyArray<{ sourceTime: string | null }>,
    mode: 'operator-only' | 'full' | 'delta',
  ): string => {
    const compact = resolveUserMessageVaultMaxChars(process.env) < 1_000;
    const firstTimestamp = compact
      ? undefined
      : rows.find((row) => row.sourceTime !== null)?.sourceTime ?? undefined;
    let lastTimestamp: string | undefined;
    if (!compact) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].sourceTime === null) continue;
        lastTimestamp = rows[index].sourceTime ?? undefined;
        break;
      }
    }
    return renderEmbeddedContinuityArtifactProvenance({
      artifact: `glyph-vault#${mode}`,
      contentClass: 'exact-excerpt',
      traceId: compact && config.compactProvenanceTraceId
        ? config.compactProvenanceTraceId
        : 'vault-buffer',
      unit: 'row',
      sourceStart: 0,
      sourceEndExclusive: rows.length,
      sourceFirstTimestamp: firstTimestamp,
      sourceLastTimestamp: lastTimestamp,
      authority: 'historical-background',
    }) ?? '';
  };

  const renderEditVaultText = (entry: EditProvenanceVaultEntry): string => {
    const maxSnippet = resolveEditProvenanceVaultSnippetChars(process.env);
    const lines = [
      `Edit(${entry.filePath}) via ${entry.toolName}${entry.replaceAll ? ' replaceAll' : ''}`
        + ` hash=${editProvenanceVaultFingerprint(entry)}`,
    ];
    const oldSnippet = compactEditSnippet(entry.oldString, maxSnippet);
    const newSnippet = compactEditSnippet(entry.newString, maxSnippet);
    if (oldSnippet) lines.push(`old: ${oldSnippet}`);
    if (newSnippet) lines.push(`new: ${newSnippet}`);
    return lines.join('\n');
  };

  const renderVaultRowBody = (row: VaultRenderRow, isNewest: boolean): string => {
    if (row.role === 'edit') return row.text;
    const surface: VaultSurface = row.role === 'user'
      ? isNewest ? 'fold_vault_newest' : 'fold_vault_older'
      : isNewest ? 'fold_vault_assistant_newest' : 'fold_vault_assistant_older';
    return config.renderSurfaceText(row.text, surface);
  };

  const renderVaultRow = (
    row: VaultRenderRow,
    index: number,
    total: number,
    body = renderVaultRowBody(row, index === total - 1),
  ): string => {
    const header = renderVaultRecordHeader(row, index, total);
    const payload = renderHistoricalPayloadRecord('vault-row', body);
    if (row.role !== 'user') return `${header}\n${payload}`;
    const rendered = `${header}\n${payload}`;
    return row.liveness === 'unanswered'
      ? `${rendered}\n${USER_MESSAGE_VAULT_LIVE_MARKER}`
      : rendered;
  };

  const renderVaultRowsBlock = (
    rows: readonly VaultRenderRow[],
    mode: 'full' | 'delta' = 'full',
  ): string => {
    if (rows.length === 0) return '';
    const compact = resolveUserMessageVaultMaxChars(process.env) < 1_000;
    const hasEdits = rows.some((row) => row.role === 'edit');
    const header = compact
      ? config.headers.minimal
      : mode === 'delta'
        ? hasEdits ? config.headers.deltaWithEdits ?? config.headers.delta : config.headers.delta
        : hasEdits ? config.headers.fullWithEdits ?? config.headers.full : config.headers.full;
    const provenance = renderVaultBlockProvenance(rows, mode);
    const bodies = rows.map((row, index) => renderVaultRowBody(row, index === rows.length - 1));
    const assemble = (rowBodies: readonly string[]): string => {
      const body = rows
        .map((row, index) => renderVaultRow(row, index, rows.length, rowBodies[index] ?? ''))
        .join('\n\n');
      return `${header}\n${provenance}\n\n${body}\n${USER_MESSAGE_VAULT_END}`;
    };
    const full = assemble(bodies);
    const maxChars = resolveUserMessageVaultMaxChars(process.env);
    if (maxChars >= 1_000 || full.length <= maxChars) return full;

    const fixedChars = assemble(bodies.map(() => '')).length;
    const bodyBudget = maxChars - fixedChars;
    const minimums = bodies.map((body) => Math.min(body.length, 48));
    if (bodyBudget < minimums.reduce((sum, chars) => sum + chars, 0)) return full;

    const allocations = [...minimums];
    let remaining = bodyBudget - allocations.reduce((sum, chars) => sum + chars, 0);
    const priorityOrder = rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => b.row.priority - a.row.priority || b.index - a.index);
    for (const { index } of priorityOrder) {
      if (remaining <= 0) break;
      const extra = Math.min(remaining, bodies[index].length - allocations[index]);
      allocations[index] += extra;
      remaining -= extra;
    }
    return assemble(bodies.map((body, index) => clipVaultRowBody(body, allocations[index])));
  };

  const selectVaultRows = (
    userEntries: readonly UserMessageVaultEntry[],
    assistantEntries: readonly AssistantGlyphVaultEntry[],
    editEntries: readonly EditProvenanceVaultEntry[],
    options?: UserMessageVaultRenderOptions,
    env: NodeJS.ProcessEnv = process.env,
  ): VaultRenderRow[] => {
    const maxMessages = resolveUserMessageVaultMaxMessages(env);
    const maxChars = resolveUserMessageVaultMaxChars(env);
    const assistantMax = resolveAssistantGlyphVaultMaxMessages(env);
    const visibleUserTexts = normalizedVisibleTexts(options, 'user');
    const visibleAssistantTexts = normalizedVisibleTexts(options, 'assistant');
    const indexedUserEntries = userEntries
      .map((entry, index) => ({
        entry: { ...entry, text: normalizeEntryText(entry.text) },
        index,
      }));
    const retainedUserEntries = indexedUserEntries
      .filter(({ entry }) => entry.text.length > 0
        && !isVisibleVaultEntry(entry.text, visibleUserTexts))
      .slice(-maxMessages)
    const newestUserIndex = userEntries.length - 1;
    const userRows: VaultOperatorRenderRow[] = retainedUserEntries
      .map(({ entry, index }) => {
        const taskScope = operatorTaskScope(userEntries, index);
        const liveness = options?.newestOperatorUnanswered === true
          && index === newestUserIndex
          && taskScope === 'current-task'
          ? 'unanswered'
          : 'answered';
        return operatorEvidenceRow(entry.text, entry.createdAt, taskScope, liveness);
      });

    const assistantRows: VaultRenderRow[] = assistantEntries
      .map((entry) => ({ ...entry, text: normalizeEntryText(entry.text) }))
      .filter((entry) => entry.text.length > 0
        && !isVisibleVaultEntry(entry.text, visibleAssistantTexts))
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) =>
        assistantGlyphPriority(b.entry.glyph) - assistantGlyphPriority(a.entry.glyph)
        || b.index - a.index)
      .slice(0, assistantMax)
      .map(({ entry }) => ({
        kind: 'evidence' as const,
        role: 'assistant' as const,
        text: entry.text,
        sourceTime: entry.createdAt ?? null,
        liveness: 'not-applicable' as const,
        authorization: 'not-applicable' as const,
        glyph: entry.glyph,
        priority: assistantGlyphPriority(entry.glyph),
      }));

    const editRows: VaultRenderRow[] = selectRenderedEditProvenanceVaultEntries(editEntries, env)
      .map((entry) => ({
        kind: 'evidence' as const,
        role: 'edit' as const,
        text: renderEditVaultText(entry),
        sourceTime: entry.createdAt ?? null,
        liveness: 'not-applicable' as const,
        authorization: 'not-applicable' as const,
        edit: entry,
        priority: 3.25,
      }));

    let rows: VaultRenderRow[] = [...userRows, ...assistantRows, ...editRows]
      .map((row, index) => ({ row, index }))
      .sort((a, b) =>
        compareSourceTimeAsc(a.row.sourceTime, b.row.sourceTime) || a.index - b.index)
      .map(({ row }) => row);
    if (rows.length === 0) return [];

    const sealed = options?.sealedFingerprints;
    const isSealed = sealed && sealed.size > 0
      ? (row: VaultRenderRow): boolean => sealed.has(vaultRowFingerprint(row))
      : (): boolean => false;

    for (;;) {
      if (renderVaultRowsBlock(rows, 'full').length <= maxChars) return rows;
      const evidenceCandidates = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.role === 'assistant' || row.role === 'edit')
        .sort((a, b) =>
          Number(isSealed(b.row)) - Number(isSealed(a.row))
          || a.row.priority - b.row.priority
          || compareSourceTimeAsc(a.row.sourceTime, b.row.sourceTime)
          || a.index - b.index);
      if (evidenceCandidates.length > 0) {
        const victim = evidenceCandidates[0].index;
        rows = rows.filter((_, index) => index !== victim);
        continue;
      }
      const sealedIndex = rows.findIndex((row) => isSealed(row));
      if (sealedIndex >= 0) {
        rows = rows.filter((_, index) => index !== sealedIndex);
      } else {
        const operatorVictim = rows
          .map((row, index) => ({ row, index }))
          .filter(({ row }) => row.role === 'user')
          .sort((a, b) => {
            if (a.row.role !== 'user' || b.row.role !== 'user') return 0;
            const scopeOrder = Number(a.row.taskScope === 'current-task')
              - Number(b.row.taskScope === 'current-task');
            return scopeOrder
              || compareSourceTimeAsc(a.row.sourceTime, b.row.sourceTime)
              || a.index - b.index;
          })[0];
        rows = operatorVictim
          ? rows.filter((_, index) => index !== operatorVictim.index)
          : rows.slice(1);
      }
      if (rows.length === 0) return [];
    }
  };

  const renderOperatorOnlyVault = (
    entries: readonly UserMessageVaultEntry[],
    options?: UserMessageVaultRenderOptions,
  ): string => {
    const maxMessages = resolveUserMessageVaultMaxMessages(process.env);
    const maxChars = resolveUserMessageVaultMaxChars(process.env);
    const visibleTexts = normalizedVisibleTexts(options, 'user');
    let retained = entries
      .map((entry, index) => ({
        entry: { ...entry, text: normalizeEntryText(entry.text) },
        index,
      }))
      .filter(({ entry }) => entry.text.length > 0
        && !isVisibleVaultEntry(entry.text, visibleTexts))
      .slice(-maxMessages);
    const newestUserIndex = entries.length - 1;

    while (retained.length > 0) {
      const rows = retained.map(({ entry, index }) => {
        const taskScope = operatorTaskScope(entries, index);
        const liveness = options?.newestOperatorUnanswered === true
          && index === newestUserIndex
          && taskScope === 'current-task'
          ? 'unanswered'
          : 'answered';
        return operatorEvidenceRow(entry.text, entry.createdAt, taskScope, liveness);
      });
      const body = rows
        .map((row, index) => renderVaultRow(row, index, rows.length))
        .join('\n\n');
      const provenance = renderVaultBlockProvenance(rows, 'operator-only');
      const header = maxChars < 1_000 ? config.headers.minimal : config.headers.operator;
      const block = `${header}\n${provenance}\n\n${body}\n${USER_MESSAGE_VAULT_END}`;
      if (block.length <= maxChars) return block;
      retained = retained.slice(1);
    }
    return '';
  };

  const renderUserMessageVault = (
    entries: readonly UserMessageVaultEntry[],
    options?: UserMessageVaultRenderOptions,
  ): string => {
    const assistantEntries = options?.assistantEntries ?? [];
    const editEntries = options?.editEntries ?? [];
    if (assistantEntries.length === 0 && editEntries.length === 0) {
      return renderOperatorOnlyVault(entries, options);
    }
    return renderVaultRowsBlock(
      selectVaultRows(entries, assistantEntries, editEntries, options),
      'full',
    );
  };

  return {
    resolveUserMessageVaultMaxMessages,
    resolveUserMessageVaultMaxChars,
    resolveAssistantGlyphVaultMaxMessages,
    resolveEditProvenanceVaultMaxMessages,
    resolveEditProvenanceVaultSnippetChars,
    resolveUserMessageVaultMinUtilization,
    recordUserMessageVaultEntry,
    recordAssistantGlyphVaultEntry,
    seedUserMessageVaultFromMessages,
    selectCurrentTaskUserMessageVaultEntries,
    selectRenderedEditProvenanceVaultEntries,
    renderUserMessageVault,
    renderVaultRowsBlock,
    selectVaultRows,
  };
}
