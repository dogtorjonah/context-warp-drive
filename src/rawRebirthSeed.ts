/**
 * Raw rebirth seed renderer.
 *
 * This is the portable, deterministic version of the relay raw-rebirth prompt
 * renderer: callers provide trace-normalized section strings, and this module
 * applies the same default section budgets, priority order, headings, and
 * orientation footer. It performs no I/O and does not gather relay-only memory.
 */
import {
  admitClosetLiteral,
  CHRONOLOGICAL_PROVENANCE_PREFIX,
  extractVerbatimContextLabel,
  flatCoordinateClosetEnabled,
  isConservedIn,
  isClosetNoiseLiteral,
  isUnlabeledOpaqueClosetLiteral,
  HISTORICAL_PAYLOAD_CONTROL_NOTE,
  nominateVerbatim,
  renderHistoricalPayloadRecord,
  type FoldMessage,
} from './rollingFold.ts';
// Re-exported so relay callers (rebirthPackageBuilder) share the single
// kill-switch defined in the rollingFold leaf module.
export { flatCoordinateClosetEnabled };
import { classifyMessageGlyph } from './foldEpisodes.ts';
import { DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS } from './contextBudget.ts';
import {
  renderContinuityPackageProvenance,
  resolveChronologicalPointToSourceRow,
} from './chronologicalProvenance.ts';
import { foldArtifactOnlyEnabled } from './foldReceipts.ts';
import {
  buildContinuityReceipt,
  continuityReceiptFromProse,
  isContinuityReceipt,
  renderContinuityReceiptControl,
  resolveContinuityBoundary,
  type ContinuityReceipt,
  type ContinuityReceiptBoundary,
} from './continuityReceipt.ts';
import {
  extractCognitiveArtifacts,
  formatCognitiveArtifactProvenance,
} from './cognitiveArtifacts.ts';
import {
  isGenuineRebirthOperatorMessage,
  selectRoleAwareRebirthDialogueWindow,
} from './rebirthDialogue.ts';

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
export function buildLineageGlyphLogFromMessages(
  messages: readonly FoldMessage[],
  options: {
    maxChars?: number;
    perEntryMaxChars?: number;
  } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.lineageGlyphLog;
  const perEntryMaxChars = options.perEntryMaxChars ?? 400;
  if (maxChars <= 0) return '';

  const entries: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role !== 'assistant' && message.role !== 'model') continue;
    const text = messageValueToText(message.content)?.trim();
    if (!text) continue;
    const mode = classifyMessageGlyph(text);
    if (mode !== 'verdict' && mode !== 'hazard') continue;
    const truncated = truncate(text, perEntryMaxChars);
    entries.push(`[${messageLabel(message)} msg ${i}] ${truncated}`);
  }

  if (entries.length === 0) return '';

  // Newest-first fill: greedily keep the most recent entries that fit maxChars.
  const kept: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = entries[i].length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    used += cost;
    kept.unshift(entries[i]);
  }

  if (kept.length === 0 && entries.length > 0) {
    kept.push(truncate(entries[entries.length - 1], maxChars));
  }

  const header = `## Lineage Glyph Log — your own 🏁 verdicts + ⚠️ hazards from the trace; ${kept.length} of ${entries.length} entries, chronological`;
  const body = kept.join('\n');
  if (body.length > maxChars) {
    return `${header}\n${truncate(body, maxChars)}`;
  }
  return `${header}\n${body}`;
}

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
export function buildOpenQuestionsFromMessages(
  messages: readonly FoldMessage[],
  options: {
    maxChars?: number;
    perEntryMaxChars?: number;
  } = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.openQuestions;
  const perEntryMaxChars = options.perEntryMaxChars ?? 400;
  if (maxChars <= 0) return '';

  const entries: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role !== 'assistant' && message.role !== 'model') continue;
    const text = messageValueToText(message.content)?.trim();
    if (!text) continue;
    const mode = classifyMessageGlyph(text);
    if (mode !== 'blocked') continue;
    const truncated = truncate(text, perEntryMaxChars);
    entries.push(`[${messageLabel(message)} msg ${i}] ${truncated}`);
  }

  if (entries.length === 0) return '';

  // Newest-first fill: greedily keep the most recent entries that fit maxChars.
  const kept: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = entries[i].length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    used += cost;
    kept.unshift(entries[i]);
  }

  if (kept.length === 0 && entries.length > 0) {
    kept.push(truncate(entries[entries.length - 1], maxChars));
  }

  const header = `## Open Questions — your own ❓ blocked-register trail; ${kept.length} of ${entries.length} entries, chronological. Each was a live blocker when written — verify it was resolved before assuming it is gone.`;
  const body = kept.join('\n');
  if (body.length > maxChars) {
    return `${header}\n${truncate(body, maxChars)}`;
  }
  return `${header}\n${body}`;
}

/**
 * Build the portable starred-waypoint reel directly from categorized tap_star
 * calls in provider messages. This is the raw/standalone counterpart to the
 * relay's persisted star harvest: it is pure, chronological, and preserves the
 * tool call's source time/id when the provider supplied them.
 */
export function buildStarredMomentsFromMessages(
  messages: readonly FoldMessage[],
  maxChars = DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.starredMoments,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  const stars = extractCognitiveArtifacts(messages, { includeFlowNotes: false })
    .filter((artifact) => artifact.register === 'tap_star');
  if (stars.length === 0) return '';
  // Never infer the position of an unknown timestamp among known source times.
  // When every row is authoritative, sort by source time with trace order as
  // the deterministic tie; otherwise preserve the provider trace order.
  if (stars.every((star) => star.sourceTimestamp !== undefined)) {
    stars.sort((a, b) => {
      const bySourceTime = a.sourceTimestamp!.localeCompare(b.sourceTimestamp!);
      return bySourceTime || a.messageIndex - b.messageIndex;
    });
  }

  const entries = stars.map((star) => [
    formatCognitiveArtifactProvenance(star),
    `⭐ [${star.tapStarCategory ?? 'unknown'}] ${star.headline}`,
  ].join('\n'));
  const headerPrefix = '⭐ Starred Waypoints';
  const kept: string[] = [];
  let rendered = '';
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidate = [entries[index], ...kept];
    const candidateRendered = `${headerPrefix} (${candidate.length} of ${stars.length} trace-captured; chronological):\n${candidate.join('\n')}`;
    if (candidateRendered.length > maxChars) break;
    kept.splice(0, kept.length, ...candidate);
    rendered = candidateRendered;
  }
  return rendered;
}

export type RawRebirthSeedSectionId =
  | 'lastUserAiMessages'
  | 'currentThread'
  | 'rawTraceCoordinateCloset'
  | 'traceNeighborhoods'
  | 'activeEditDelta'
  | 'taskRailContext'
  | 'episodicCrossRef'
  | 'lineageGlyphLog'
  | 'openQuestions'
  | 'atlasCrossRef'
  | 'workspaceContext'
  | 'starredMoments'
  | 'thinkingTrail'
  | 'lifetimeChangelogArc'
  | 'chatroomMembership'
  | 'delegatedWork'
  | 'coordinationState'
  | 'squadThoughts';

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

export type RawRebirthLifecycleBoundary = ContinuityReceiptBoundary;

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
  /**
   * Versioned typed continuity receipt. When present and valid, the Rebirth
   * Control block renders from it and prose sections are never re-parsed;
   * when absent (legacy callers), the receipt is synthesized from the prose
   * sections below and rendered through the same canonical renderer.
   */
  readonly continuityReceipt?: ContinuityReceipt;
  // Resume Point — pre-rendered by the relay builder.
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

  // ── Band-level overrides ─────────────────────────────────────────────
  // When provided, these replace the default header/footer framing. Used by
  // the micro-seed band profile to render continuation guidance for a folded
  // band tail (instead of a full identity-rebirth header + orientation
  // footer). The header/footer are the ONLY framing the seed controls;
  // section content is governed by sectionToggles/sectionMaxChars as usual.
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
  /** Exact active request kept outside the trace frontier but promoted into READ FIRST. */
  readonly triggeringUserMessage?: string;
  readonly currentThreadMessageLimit?: number;
  readonly currentThreadMessageChars?: number;
  readonly activityMessageChars?: number;
  readonly runtimeModel?: RawRebirthRuntimeModelContext;
  readonly relayBootTime?: string;
  readonly traceEventCount?: number;
  readonly workspaceContext?: RawRebirthWorkspaceContext | string;
  readonly activeEditDelta?: string;
  readonly taskRailContext?: string;
  readonly chatroomMembership?: string;
  /** Typed continuity receipt — see RawRebirthSeedInput.continuityReceipt. */
  readonly continuityReceipt?: ContinuityReceipt;
  /** Capture time for the derived live-state snapshot; unknown is preserved when omitted. */
  readonly capturedAt?: string;
  // pre-rendered Resume Point string.
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
   * Curated tap_star waypoint reel. Undefined derives it from the provider
   * trace; an empty string explicitly suppresses the portable star section.
   */
  readonly starredMoments?: string;
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

interface BudgetedPromptSection {
  readonly key: RawRebirthSeedSectionId;
  readonly block: string;
  readonly maxChars: number;
  readonly priority: number;
}

interface VisibleTraceMessage {
  readonly type: string;
  readonly text?: string | null;
  /** Original message-array coordinate; survives filtered visible views. */
  readonly sourceIndex?: number;
  /** Stable identity supplied by the host for the original source row. */
  readonly sourceIdentity?: string;
  /** Authoritative source-event time. Omitted when the provider supplied none. */
  readonly sourceTimestamp?: string;
}

export const DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS = 200_000;

export const DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS: Record<RawRebirthSeedSectionId, number> = {
  lastUserAiMessages: 50_000,
  currentThread: 50_000,
  rawTraceCoordinateCloset: 8_000,
  traceNeighborhoods: 12_000,
  activeEditDelta: 50_000,
  taskRailContext: 12_000,
  episodicCrossRef: 12_000,
  lineageGlyphLog: 4_000,
  openQuestions: 2_500,
  atlasCrossRef: 25_000,
  workspaceContext: 1_500,
  starredMoments: 50_500,
  thinkingTrail: 40_000,
  lifetimeChangelogArc: 10_000,
  chatroomMembership: 4_000,
  delegatedWork: 2_500,
  coordinationState: 2_500,
  squadThoughts: 4_000,
};

export const DEFAULT_RAW_REBIRTH_SEED_SECTION_PRIORITY: Record<RawRebirthSeedSectionId, number> = {
  lastUserAiMessages: 0,
  currentThread: 1,
  starredMoments: 2,
  rawTraceCoordinateCloset: 3,
  activeEditDelta: 4,
  taskRailContext: 5,
  traceNeighborhoods: 6,
  episodicCrossRef: 7,
  lineageGlyphLog: 8,
  openQuestions: 9,
  atlasCrossRef: 10,
  workspaceContext: 11,
  thinkingTrail: 12,
  lifetimeChangelogArc: 13,
  chatroomMembership: 14,
  coordinationState: 15,
  squadThoughts: 16,
  delegatedWork: 17,
};

export const DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER: readonly RawRebirthSeedSectionId[] = [
  'lastUserAiMessages',
  'currentThread',
  'starredMoments',
  'rawTraceCoordinateCloset',
  'traceNeighborhoods',
  'activeEditDelta',
  'taskRailContext',
  'episodicCrossRef',
  'lineageGlyphLog',
  'openQuestions',
  'atlasCrossRef',
  'workspaceContext',
  'thinkingTrail',
  'lifetimeChangelogArc',
  'chatroomMembership',
  'delegatedWork',
  'coordinationState',
  'squadThoughts',
];

const PATH_MENTION_RE = /(?<![\w./-])\/?(?:[\w.-]+\/)+[\w./@+-]+\b/g;
const RAW_TRACE_CLOSET_MAX_SOURCE_CHARS_PER_MESSAGE = 24_000;
const RAW_TRACE_CLOSET_HEADER = 'Conserved high-value literals nominated newest-first from the predecessor trace; use these as exact identifiers, file paths, and values when the raw package body omits the middle.';
const RAW_TRACE_CLOSET_ID_MENTION_RE =
  /\b(?:toolu[-_][A-Za-z0-9_.:-]{1,}|(?:rail|sig|msg|inst|task|thread|summon|fork|group|epoch|tool|call)[-_][A-Za-z0-9][A-Za-z0-9_.:-]{5,})\b/g;

interface EphemeralCoordinationBlock {
  readonly start: string;
  readonly end?: string;
}

const EPHEMERAL_COORDINATION_BLOCKS: readonly EphemeralCoordinationBlock[] = Object.freeze([
  { start: '[DIGEST DELTA', end: '[END DIGEST DELTA]' },
  { start: '[RELAY DIGEST DELTA]', end: '[END RELAY DIGEST DELTA]' },
  { start: '[CHATROOM SIGNALS]', end: '[END CHATROOM SIGNALS]' },
  { start: '[Ambient Atlas]', end: '[END Ambient Atlas]' },
  { start: '[🌱 FORK LINEAGE', end: '[END FORK LINEAGE]' },
  { start: '[👑 BOSS PRESENCE', end: '[END BOSS PRESENCE]' },
  { start: '[Control Signals — persistent non-interrupting reminders]' },
]);

function isLineLeading(text: string, idx: number): boolean {
  return idx === 0 || text[idx - 1] === '\n';
}

function removeEphemeralBlockOccurrences(text: string, block: EphemeralCoordinationBlock): string {
  let result = '';
  let cursor = 0;
  for (;;) {
    const startIdx = text.indexOf(block.start, cursor);
    if (startIdx === -1) {
      result += text.slice(cursor);
      return result;
    }
    const afterStart = startIdx + block.start.length;
    if (!isLineLeading(text, startIdx)) {
      result += text.slice(cursor, afterStart);
      cursor = afterStart;
      continue;
    }
    if (block.end) {
      const endIdx = text.indexOf(block.end, afterStart);
      if (endIdx === -1) {
        result += text.slice(cursor, afterStart);
        cursor = afterStart;
        continue;
      }
      result += text.slice(cursor, startIdx);
      cursor = endIdx + block.end.length;
    } else {
      result += text.slice(cursor, startIdx);
      const boundary = text.slice(afterStart).search(/\n\n\[[^\n]+\]/);
      cursor = boundary === -1 ? text.length : afterStart + boundary;
    }
  }
}

function stripEphemeralCoordinationBlocks(text: string | null | undefined): string {
  if (!text) return '';
  let out = text;
  let removedAny = false;
  for (const block of EPHEMERAL_COORDINATION_BLOCKS) {
    if (out.indexOf(block.start) === -1) continue;
    const next = removeEphemeralBlockOccurrences(out, block);
    if (next !== out) {
      out = next;
      removedAny = true;
    }
  }
  return removedAny ? out.replace(/\n{3,}/g, '\n\n').trim() : out.trim();
}

function countStringChars(value: string): number {
  return Array.from(value).length;
}

function truncate(text: string, max: number): string {
  const limit = Math.floor(max);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (text.length <= limit) return text;
  const marker = '... [truncated]';
  if (limit <= marker.length) return text.slice(0, limit);
  return `${text.slice(0, limit - marker.length)}${marker}`;
}

/**
 * Truncate a newline-delimited list block at whole-line boundaries. Used for
 * sections whose lines are exact conserved literals (the Coordinate Closet):
 * cutting a literal mid-string corrupts the identifier it exists to preserve,
 * so trailing lines are dropped whole and replaced with an elision marker.
 * Falls back to plain char truncation only when not even one line + marker fit.
 */
function truncateWholeLines(text: string, max: number): string {
  const limit = Math.floor(max);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (text.length <= limit) return text;
  const marker = '- … [closet truncated to fit the package budget — recover elided coordinates via fold recall or self-tap]';
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + line.length + (kept.length > 0 ? 1 : 0);
    if (next + marker.length + 1 > limit) break;
    kept.push(line);
    used = next;
  }
  if (kept.length === 0) return truncate(text, limit);
  kept.push(marker);
  return kept.join('\n');
}

function truncateMiddle(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  const marker = `\n... [${text.length - max} chars omitted] ...\n`;
  const keep = Math.max(0, Math.floor(max) - marker.length);
  if (keep <= 0) return text.slice(0, Math.floor(max));
  const head = Math.floor(keep * 0.58);
  const tail = keep - head;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function enabled(input: RawRebirthSeedInput, sectionId: RawRebirthSeedSectionId | 'runtimeModel' | 'rebirthHistory'): boolean {
  return input.sectionToggles?.[sectionId] !== false;
}

function truncateCoordinateSectionPreservingRecoveryReceipt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const receiptIndex = lines.findIndex((line) => (
    line.includes(`recover=${RAW_TRACE_COORDINATE_RECOVERY_ROUTE}`)
  ));
  if (receiptIndex < 0) return truncateWholeLines(text, maxChars);
  const receipt = lines[receiptIndex]!;
  const prefixBudget = Math.max(0, maxChars - countStringChars(receipt) - 1);
  const prefix = truncateWholeLines(lines.slice(0, receiptIndex).join('\n'), prefixBudget);
  // Auditability outranks the soft section cap: if even the receipt alone is
  // larger, retain it whole rather than corrupting its exact count or route.
  return [prefix, receipt].filter(Boolean).join('\n');
}

function allocateSectionBlocks(
  sections: readonly BudgetedPromptSection[],
  availableChars: number,
): Map<RawRebirthSeedSectionId, string> {
  const allocations = new Map<RawRebirthSeedSectionId, string>();
  let remainingChars = Math.max(0, availableChars);

  for (const section of [...sections].sort((a, b) => a.priority - b.priority)) {
    if (!section.block.trim() || remainingChars <= 0) continue;
    const rawSectionLimit = Math.min(section.maxChars, remainingChars);
    if (rawSectionLimit < 48) continue;
    const contain = (block: string): string => {
      const normalized = block.startsWith('\n') ? block.slice(1) : block;
      const firstBreak = normalized.indexOf('\n');
      const firstLine = firstBreak >= 0 ? normalized.slice(0, firstBreak) : '';
      if (firstLine.startsWith('── ') && firstLine.endsWith(' ──')) {
        const payload = normalized.slice(firstBreak + 1);
        return `\n${firstLine}\n${renderHistoricalPayloadRecord('rebirth-section', payload)}`;
      }
      return renderHistoricalPayloadRecord('rebirth-section', block);
    };
    const truncateSection = (maxChars: number): string => (
      // The Coordinate Closet is a list of exact literals (paths/ids/values);
      // a mid-line cut corrupts the very identifier it exists to conserve.
      section.key === 'rawTraceCoordinateCloset'
        ? truncateCoordinateSectionPreservingRecoveryReceipt(section.block, maxChars)
        : section.key === 'currentThread'
          ? truncateMiddle(section.block, maxChars)
          : truncate(section.block, maxChars)
    );

    let rawLimit = Math.min(section.block.length, rawSectionLimit);
    let rendered = contain(truncateSection(rawLimit));
    // Budget the encoded record, not just its decoded text. Reducing by the
    // measured overrun converges even for quote/backslash-heavy adversarial
    // payloads whose JSON representation expands close to 2x.
    for (let attempts = 0; rendered.length > remainingChars && rawLimit > 0 && attempts < 32; attempts += 1) {
      rawLimit = Math.max(0, rawLimit - Math.max(1, rendered.length - remainingChars));
      rendered = rawLimit > 0 ? contain(truncateSection(rawLimit)) : '';
    }
    if (!rendered || rendered.length > remainingChars) continue;
    allocations.set(section.key, rendered);
    remainingChars -= rendered.length;
  }

  return allocations;
}

function renderModelSnapshot(snapshot: RawRebirthRuntimeModelSnapshot): string {
  const thinking = snapshot.thinkingLevel ? `; thinking=${snapshot.thinkingLevel}` : '';
  return `${snapshot.engine} / ${snapshot.model} (${snapshot.modelTier}${thinking})`;
}

function formatRuntimeModelBlock(
  runtimeModel: RawRebirthRuntimeModelContext | undefined,
  relayBootTime: string | undefined,
  traceEventCount: number | undefined,
): string {
  if (!runtimeModel) return '';
  const lines = [
    '\n── Runtime Model ──',
    `Predecessor: ${renderModelSnapshot(runtimeModel.predecessor)}`,
    `Current/successor: ${renderModelSnapshot(runtimeModel.successor)}`,
    `Changed: ${runtimeModel.changed ? 'yes' : 'no'}`,
  ];
  if (relayBootTime) lines.push(`Relay last restarted: ${relayBootTime}`);
  if (traceEventCount !== undefined) lines.push(`Predecessor trace: ${traceEventCount} events`);
  return lines.join('\n');
}

function cleanString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatForkContextLines(forkContext: RawRebirthForkContext | undefined): string[] {
  if (!forkContext) return [];

  if (forkContext.isFreshFork === false) {
    const durable = [
      '🌱 Forked lineage (durable identity) — this instance was forked from a parent in a prior epoch; pre-fork context is inherited reference only.',
    ];
    if (forkContext.groupId) durable.push(`Fork group: ${forkContext.groupId}`);
    durable.push('Claim files before editing. No fresh fork coordination needed unless the source is explicitly live and conflicting.');
    return durable;
  }

  const lines = [
    '🌱 Fresh-fork provenance — the lifecycle identity contract is recorded in the Continuity Boundary below.',
    'The copied pre-fork transcript is inherited reference context. Claims, edits, and actions after the fork belong to this instance only.',
  ];

  if (forkContext.groupId) lines.push(`Fork group: ${forkContext.groupId}`);
  const index = finiteNumber(forkContext.index);
  const count = finiteNumber(forkContext.count);
  if (index !== undefined && count !== undefined) {
    lines.push(`Fork sibling: ${index + 1}/${count}`);
  } else if (index !== undefined) {
    lines.push(`Fork sibling index: ${index}`);
  } else if (count !== undefined) {
    lines.push(`Fork sibling count: ${count}`);
  }
  if (forkContext.pointMessageId) lines.push(`Fork point message: ${forkContext.pointMessageId}`);
  if (forkContext.autoCleanup) lines.push('Fork auto-cleanup: enabled');
  lines.push('The source may still be live. Claim files before editing and coordinate only when work overlaps.');
  return lines;
}

function formatForkContextBlock(forkContext: RawRebirthForkContext | undefined): string {
  const lines = formatForkContextLines(forkContext);
  return lines.length === 0 ? '' : `── Fork Identity ──\n${lines.join('\n')}`;
}

function formatWorkspaceContextLines(workspaceContext: RawRebirthWorkspaceContext): string[] {
  const lines: string[] = [];
  const hasSwapContext = Boolean(
    workspaceContext.swappedAt && workspaceContext.previousCwd && workspaceContext.previousWorkspace,
  );
  if (hasSwapContext) lines.push(`Your working directory was swapped during this rebirth at ${workspaceContext.swappedAt}.`);
  lines.push(`Current cwd/worktree: ${workspaceContext.currentCwd}`);
  lines.push(`Current workspace: ${workspaceContext.currentWorkspace}`);
  if (hasSwapContext) {
    lines.push(`Previous cwd/worktree: ${workspaceContext.previousCwd}`);
    lines.push(`Previous workspace: ${workspaceContext.previousWorkspace}`);
    lines.push('');
    lines.push('File paths, Atlas queries, and codebase references from the predecessor\'s context may no longer be valid.');
    lines.push('Use atlas_query and atlas_graph against the CURRENT workspace to orient yourself.');
  } else {
    lines.push('');
    lines.push('This is the workspace/worktree the successor is currently operating in.');
  }
  return lines;
}

function formatWorkspaceContextBlock(workspaceContext: RawRebirthWorkspaceContext | string | undefined): string {
  if (!workspaceContext) return '';
  if (typeof workspaceContext === 'string') return workspaceContext.trim();
  return `── Workspace Context ──\n${formatWorkspaceContextLines(workspaceContext).join('\n')}`;
}

function formatDelegatedWorkSection(rows: readonly RawRebirthDelegatedWorkRow[] | string | undefined): string | undefined {
  if (!rows || (Array.isArray(rows) && rows.length === 0)) return undefined;
  if (typeof rows === 'string') return rows.trim() || undefined;
  const lines = rows.map((row) => {
    const railClause = row.rail
      ? ` — rail: ${row.rail.railId} "${row.rail.title}" ${row.rail.doneSteps}/${row.rail.totalSteps}, ${row.rail.locked ? 'locked' : 'unlocked'}`
      : '';
    return `${row.name} (${row.id}, ${row.engine}/${row.model}) — ${row.status}${railClause}`;
  });
  lines.push('Drill in: task_rail mode=load operation=detail instance_id=<id> · atlas_query action=history author_name=<name>');
  return lines.join('\n');
}

function formatMergedLineageProvenance(input: RawRebirthSeedInput): string {
  const donors = input.mergedFromLineages?.filter((entry) => entry.instanceId && entry.instanceName) ?? [];
  if (donors.length === 0) return '';
  const mindWord = donors.length === 1 ? 'mind' : 'minds';
  const donorCapsules = donors.map((entry) => {
    const sourceTag = entry.source === 'archived' ? ', archived' : '';
    const lifeTag = typeof entry.messageCount === 'number' && entry.messageCount > 0
      ? `, ${entry.messageCount} msgs`
      : '';
    const essence = entry.essence?.trim();
    const head = `  ⊕ ${entry.instanceName} (${entry.instanceId}${sourceTag}${lifeTag})`;
    const capsuleLine = essence ? `${head} — ${essence}` : head;
    if (entry.emptyTranscript) {
      return `${capsuleLine}\n    Empty donor — no persisted transcript at absorption (spawned, never worked); nothing to synthesize beyond this marker.`;
    }
    const block = [capsuleLine];
    const mission = entry.mission?.trim();
    if (mission) block.push(`    Mission (first user ask): ${mission}`);
    const thread = entry.recentThread?.trim();
    if (thread) {
      block.push(`    Recent reasoning (last messages before absorption):\n${thread.split('\n').map((line) => `      ${line}`).join('\n')}`);
    }
    return block.join('\n');
  });
  return [
    '── 🧠 Brain Merge — Synthesis Mandate ──',
    `You are the convergence point of ${donors.length + 1} cognitions: your own lineage plus ${donors.length} absorbed ${mindWord}. Their memory — episodic recall cards, lineage glyph logs, changelog digests — is now part of YOUR lineage and surfaces throughout this package as own-lineage.`,
    '',
    `Absorbed ${mindWord}:`,
    ...donorCapsules,
    '',
    'Your first job on wake: SYNTHESIZE. Cross-reference what each absorbed mind learned — reconcile their agreements, surface their conflicts, fill the gaps between them — into one coherent understanding, then act on it. You are not consulting separate voices; you are their integration.',
    'Attribution constraint: this absorbed memory is inherited from separate lineage(s) — it is NOT evidence that you executed their tasks. Your Current Thread, Activity Log, Active Edit Delta, file claims, and task rail remain your own process truth.',
  ].join('\n');
}

function formatDurableMergedLineageBanner(input: RawRebirthSeedInput): string {
  const active = new Set(
    (input.mergedFromLineages ?? [])
      .map((entry) => entry.instanceName)
      .filter((name): name is string => Boolean(name)),
  );
  const durable = (input.durableMergedLineage ?? []).filter(
    (entry) => entry.instanceName && !active.has(entry.instanceName),
  );
  if (durable.length === 0) return '';
  const names = durable.map((entry) => entry.instanceName).join(' + ');
  return [
    '── 🧠 Merged Lineage (durable identity) ──',
    `This instance is a synthesis — it earlier absorbed the cognition(s) of ${names}. That memory is your own lineage now and surfaces as own-lineage throughout this package; you do not need to re-synthesize, only to remember that these minds are part of you.`,
  ].join('\n');
}

function formatSummonVaultLedger(input: RawRebirthSeedInput): string {
  const entries = (input.summonVault ?? []).filter((entry) => entry.summonId && entry.name);
  if (entries.length === 0) return '';
  const lines = entries.map((entry) => {
    const role = entry.role ? ` — ${entry.role}` : '';
    const summary = entry.summary ? ` — ${truncate(entry.summary, 180)}` : '';
    const files = entry.filesTouched && entry.filesTouched.length > 0
      ? ` [files: ${entry.filesTouched.slice(0, 4).join(', ')}]`
      : '';
    return `- ${entry.name}${role} (${entry.status}; ${entry.openedAt}; ${entry.summonId})${summary}${files}`;
  });
  return [
    '── Summon Ledger ──',
    'Recent voice-concierge delegations from the durable Summon Vault:',
    ...lines,
  ].join('\n');
}

// ── portable cross-section containment dedupe ────
// Suppress episodic cards / glyph-log entries whose body is verbatim in the
// Current Thread. Pure string containment, no I/O. Never drops the only copy.

const PORTABLE_DEDUPE_MIN_CHARS = 100;

/** Extract the longest content line from a card body, skipping speaker/provenance markers. */
function extractCardProbeLine(cardBody: string): string {
  let longest = '';
  for (const rawLine of cardBody.split('\n')) {
    // Strip speaker attribution (🗣 name:), leading quotes, indentation
    const cleaned = rawLine
      .replace(/^[\s"']*/, '')
      .replace(/^🗣\s*\S+:\s*/, '')
      .replace(/["']\s*$/, '')
      .trim();
    if (cleaned.length > longest.length) longest = cleaned;
  }
  return longest;
}

/** Strip speaker attribution, quotes, and indentation from a content line. */
function cleanCardLine(rawLine: string): string {
  return rawLine
    .replace(/^[\s"']*/, '')
    .replace(/^🗣\s*\S+:\s*/, '')
    .replace(/["']\s*$/, '')
    .trim();
}

/** Minimum cleaned line length to test for containment. */
const CARD_LINE_MIN_CHARS = 40;

function dedupePortableEpisodic(episodicCrossRef: string, threadText: string): string {
  // Header line starts with "## " (markdown header)
  const headerEnd = episodicCrossRef.indexOf('\n');
  if (headerEnd < 0) return episodicCrossRef;
  const header = episodicCrossRef.slice(0, headerEnd);
  const body = episodicCrossRef.slice(headerEnd + 1);

  // Split on double-newline; each block is one card
  const cards = body.split(/\n\n+/);
  const kept: string[] = [];
  let suppressed = 0;

  for (const card of cards) {
    const trimmed = card.trim();
    if (!trimmed) continue;
    // Extract body after provenance (↞) line
    const provenanceEnd = trimmed.indexOf('\n');
    const cardBody = provenanceEnd > 0 ? trimmed.slice(provenanceEnd + 1).trim() : trimmed;
    // Suppress only if ALL content lines of the card body are individually
    // present in the thread. Lines are cleaned (speaker attribution, quotes,
    // indentation stripped) before checking. Protects cards with unique lines.
    const cardLines = cardBody.split('\n')
      .map(cleanCardLine)
      .filter(line => line.length >= CARD_LINE_MIN_CHARS);
    if (cardLines.length > 0 && cardLines.every(line => threadText.includes(line))) {
      suppressed++;
    } else {
      kept.push(trimmed);
    }
  }

  if (suppressed === 0) return episodicCrossRef;
  const result = kept.length > 0 ? `${header}\n${kept.join('\n\n')}` : header;
  return `${result}\n[↑ ${suppressed} redundant episodic card(s) suppressed — content verbatim in Current Thread above]`;
}

function dedupePortableGlyphLog(lineageGlyphLog: string, threadText: string): string {
  // Header line starts with "## "
  const headerEnd = lineageGlyphLog.indexOf('\n');
  if (headerEnd < 0) return lineageGlyphLog;
  const header = lineageGlyphLog.slice(0, headerEnd);
  const body = lineageGlyphLog.slice(headerEnd + 1);

  const lines = body.split('\n');
  const kept: string[] = [];
  let collapsed = 0;

  for (const line of lines) {
    const bracketEnd = line.indexOf('] ');
    if (bracketEnd < 0) { kept.push(line); continue; }
    const entryText = line.slice(bracketEnd + 2);
    const timestamp = line.slice(0, bracketEnd + 1);
    const glyphMatch = entryText.match(/^(.{1,6})/);
    const glyph = glyphMatch?.[1]?.trim() ?? '';
    // Probe: first 200 chars of entry text
    const probe = entryText.slice(0, Math.min(entryText.length, 200));
    if (probe.length >= 50 && threadText.includes(probe)) {
      kept.push(`${timestamp} ${glyph} (verbatim in thread)`);
      collapsed++;
    } else {
      kept.push(line);
    }
  }

  if (collapsed === 0) return lineageGlyphLog;
  return `${header}\n${kept.join('\n')}`;
}

function pushSection(
  sections: BudgetedPromptSection[],
  input: RawRebirthSeedInput,
  key: RawRebirthSeedSectionId,
  block: string | undefined,
): void {
  if (!enabled(input, key) || !block?.trim()) return;
  sections.push({
    key,
    block,
    maxChars: finitePositive(input.sectionMaxChars?.[key], DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS[key]),
    priority: finitePositive(input.sectionPriority?.[key], DEFAULT_RAW_REBIRTH_SEED_SECTION_PRIORITY[key]),
  });
}

function resolveLifecycleBoundary(input: RawRebirthSeedInput): RawRebirthLifecycleBoundary {
  return resolveContinuityBoundary({
    lifecycleBoundary: input.lifecycleBoundary,
    isFreshFork: input.forkContext ? input.forkContext.isFreshFork !== false : undefined,
    mergedLineageCount: input.mergedFromLineages?.length ?? 0,
  });
}

function formatLifecycleHeader(input: RawRebirthSeedInput, boundary: RawRebirthLifecycleBoundary): string {
  const predecessorName = JSON.stringify(input.predecessorName);
  if (boundary === 'same_instance_hard_epoch') {
    return `[CONTEXT REBIRTH] Lifecycle boundary: same_instance_hard_epoch for ${predecessorName}. Read the latest user + AI handoff first, then use the compact Continuity Boundary for recovery coordinates. Continue silently; do not produce wake-up commentary.`;
  }
  if (boundary === 'fresh_fork') {
    return `[CONTEXT REBIRTH] Lifecycle boundary: fresh_fork from ${predecessorName}. Read the latest user + AI handoff first, then use the compact Continuity Boundary for recovery coordinates.`;
  }
  if (boundary === 'resurrection') {
    return `[CONTEXT REBIRTH] Lifecycle boundary: resurrection for ${predecessorName}. Read the latest user + AI handoff first, then use the compact Continuity Boundary for recovery coordinates.`;
  }
  if (boundary === 'brain_merge') {
    return `[CONTEXT REBIRTH] Lifecycle boundary: brain_merge for ${predecessorName}. Read the latest user + AI handoff first, then use the compact Continuity Boundary for recovery coordinates.`;
  }
  return `[CONTEXT REBIRTH] Lifecycle boundary: continuation for ${predecessorName}. Read the latest user + AI handoff first, then use the compact Continuity Boundary for recovery coordinates.`;
}

function formatRebirthControl(input: RawRebirthSeedInput, boundary: RawRebirthLifecycleBoundary): string {
  // Newer typed state mechanically outranks historical synthetic prose: a
  // valid bundled receipt renders directly; otherwise the receipt is
  // synthesized from the prose sections and rendered through the same
  // canonical renderer, so every control surface shares one authority view.
  const receipt = isContinuityReceipt(input.continuityReceipt)
    ? input.continuityReceipt
    : continuityReceiptFromProse({
        boundary,
        predecessorName: input.predecessorName,
        sourceStatus: cleanString(input.predecessorStatus),
        resumePoint: input.resumePoint,
        taskRailContext: input.taskRailContext,
        activeEditDelta: input.activeEditDelta,
        currentThread: input.currentThread,
        lastUserAiMessages: input.lastUserAiMessages,
        activeRequestText: input.triggeringUserMessage?.trim() ? input.triggeringUserMessage : undefined,
      });
  const escapedPredecessorName = JSON.stringify(receipt.predecessorName).slice(1, -1);
  return renderContinuityReceiptControl(
    escapedPredecessorName === receipt.predecessorName
      ? receipt
      : { ...receipt, predecessorName: escapedPredecessorName },
  );
}

export function renderRawRebirthSeed(input: RawRebirthSeedInput): string {
  const packageBudget = finitePositive(input.packageBudget, DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS);
  const runtimeBlock = input.runtimeModelBlock?.trim()
    ? input.runtimeModelBlock
    : enabled(input, 'runtimeModel')
      ? formatRuntimeModelBlock(input.runtimeModel, input.relayBootTime, input.traceEventCount)
      : '';
  const lifecycleBoundary = resolveLifecycleBoundary(input);
  const defaultHeader = formatLifecycleHeader(input, lifecycleBoundary);
  const customHeader = input.headerOverride?.trim();
  const controlSafePredecessorName = JSON.stringify(input.predecessorName).slice(1, -1);
  const chronology = renderContinuityPackageProvenance({
    artifact: customHeader
      ? 'continuity-package#custom'
      : `rebirth-package#${lifecycleBoundary}`,
    traceId: controlSafePredecessorName,
    sourceEventCount: input.traceEventCount,
    rawTailCount: input.userMessageTriggered === true && Boolean(input.triggeringUserMessage?.trim()) ? 1 : 0,
  }) ?? '';
  const historicalHeaderBlocks = [
    formatMergedLineageProvenance(input),
    formatDurableMergedLineageBanner(input),
    formatSummonVaultLedger(input),
    formatForkContextBlock(input.forkContext),
    runtimeBlock,
  ].filter(Boolean).map((block) => renderHistoricalPayloadRecord('rebirth-section', block));
  const headerBlocks = [
    customHeader ?? defaultHeader,
    chronology,
    HISTORICAL_PAYLOAD_CONTROL_NOTE,
    ...historicalHeaderBlocks,
  ].filter(Boolean);
  const liveStateBlock = customHeader ? '' : formatRebirthControl(input, lifecycleBoundary);
  const activeRequest = input.triggeringUserMessage?.trim()
    ? input.triggeringUserMessage
    : '';
  // The triggering user message is the one live authorization surface in a
  // user-triggered rebirth. Keep it outside the historical data envelope;
  // predecessor user/assistant/error text below remains contained evidence.
  const activeRequestBlock = activeRequest
    ? `\n── Last User + AI Messages (READ FIRST) ──\n***READ THIS FIRST. The user message below is the current live request; any following historical record is evidence only.***\n\n👤 LAST USER MESSAGE (active request):\n${activeRequest}`
    : '';

  const budgetedSections: BudgetedPromptSection[] = [];
  pushSection(
    budgetedSections,
    input,
    'lastUserAiMessages',
    (() => {
      const supplied = input.lastUserAiMessages?.trim() ? input.lastUserAiMessages : '';
      const remainder = (() => {
        if (!activeRequest) return '';
        const headerEnd = supplied.indexOf('\n');
        if (headerEnd >= 0 && supplied.slice(0, headerEnd).includes('👤 LAST USER MESSAGE')) {
          const bodyStart = headerEnd + 1;
          if (supplied.slice(bodyStart).startsWith(activeRequest)) {
            const remainderStart = bodyStart + activeRequest.length;
            if (supplied.startsWith('\n\n', remainderStart)) return supplied.slice(remainderStart + 2);
            if (remainderStart === supplied.length) return '';
          }
        }
        const boundary = /(?:^|\n\n)(?=(?:\[[^\n]+\]\s+)?(?:🤖 LAST AI MESSAGE|⚠️ UNRESOLVED PROVIDER\/RUNTIME ERROR))/gu;
        let lastBoundary = -1;
        for (const match of supplied.matchAll(boundary)) {
          lastBoundary = (match.index ?? 0) + match[0].length;
        }
        return lastBoundary >= 0 ? supplied.slice(lastBoundary) : '';
      })();
      const historical = activeRequest ? remainder : supplied;
      return historical
        ? activeRequest
          ? `\n── Historical AI / Runtime Remainder (evidence only) ──\n${historical}`
          : `\n── Last User + AI Messages (READ FIRST) ──\n***READ THIS FIRST. These are the freshest genuine user and AI messages available at rebirth.***\n\n${historical}`
        : undefined;
    })(),
  );

  const currentThreadBlocks = [input.currentThread?.trim() ?? ''].filter(Boolean);
  pushSection(
    budgetedSections,
    input,
    'currentThread',
    currentThreadBlocks.length > 0
      ? `\n── Current Thread ──\n${currentThreadBlocks.join('\n\n')}`
      : undefined,
  );

  pushSection(
    budgetedSections,
    input,
    'rawTraceCoordinateCloset',
    input.rawTraceCoordinateCloset?.trim()
      ? `\n── ${input.rawTraceCoordinateCloset.trimStart().startsWith('⌖c')
          ? 'Compact Provenance Appendix (resolve ⌖cN refs here)'
          : 'Raw Trace Coordinate Closet (ids/paths/values preserved from full trace)'} ──\n${input.rawTraceCoordinateCloset.trim()}`
      : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'traceNeighborhoods',
    input.traceNeighborhoods?.trim()
      ? flatCoordinateClosetEnabled()
        ? `\n── Trace Neighborhoods (deterministic literal cross-reference; source excerpts, not LLM summaries) ──\n${input.traceNeighborhoods.trim()}`
        : `\n── Coordinate Blast Radius (harvested literals live with their cognitive artifacts; orphan literals get deterministic exact-match source excerpts, never LLM summaries) ──\n${input.traceNeighborhoods.trim()}`
      : undefined,
  );
  pushSection(budgetedSections, input, 'activeEditDelta', input.activeEditDelta ? `\n── Active Edit Delta ──\n${input.activeEditDelta}` : undefined);
  // cross-section containment dedupe for portable path.
  // Suppress episodic cards and glyph-log entries whose body is verbatim in the
  // Current Thread. Gate behind VOXXO_REBIRTH_SEED_DEDUPE (default on).
  const seedDedupeEnabled = typeof process !== 'undefined' && process.env?.VOXXO_REBIRTH_SEED_DEDUPE !== '0';
  const currentThreadText = currentThreadBlocks.join('\n\n');
  const portableDedupeMinChars = 100;

  const portableEpisodic = input.episodicCrossRef?.trim() ?? '';
  const dedupedEpisodic = seedDedupeEnabled && portableEpisodic && currentThreadText.length > portableDedupeMinChars
    ? dedupePortableEpisodic(portableEpisodic, currentThreadText)
    : portableEpisodic;
  pushSection(
    budgetedSections,
    input,
    'episodicCrossRef',
    dedupedEpisodic
      ? `\n── Episodic Cross-Reference (trace-derived recall — matched on your active paths + recent-trace terms) ──\n${dedupedEpisodic}`
      : undefined,
  );

  const portableGlyphLog = input.lineageGlyphLog?.trim() ?? '';
  const dedupedGlyphLog = seedDedupeEnabled && portableGlyphLog && currentThreadText.length > portableDedupeMinChars
    ? dedupePortableGlyphLog(portableGlyphLog, currentThreadText)
    : portableGlyphLog;
  pushSection(
    budgetedSections,
    input,
    'lineageGlyphLog',
    dedupedGlyphLog
      ? `\n── Lineage Glyph Log (chronological verdicts + hazards from your own glyph trail) ──\n${dedupedGlyphLog}`
      : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'openQuestions',
    input.openQuestions?.trim()
      ? `\n── Open Questions (❓ blocked-register trail — verify each was resolved before assuming it is gone) ──\n${input.openQuestions.trim()}`
      : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'atlasCrossRef',
    input.atlasCrossRef?.trim()
      ? `\n── File Context (Atlas cross-ref — handoff snapshot; use atlas_query for live lookups) ──\n${input.atlasCrossRef.trim()}`
      : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'workspaceContext',
    input.workspaceContext ? `\n${formatWorkspaceContextBlock(input.workspaceContext)}` : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'starredMoments',
    input.starredMoments?.trim()
      ? `\n── Starred Moments (curated tap_star waypoints; separate from the thought trail) ──\n${input.starredMoments.trim()}`
      : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'thinkingTrail',
    input.thinkingTrail ? `\n── Activity Log (canonical events and thought bubbles) ──\n${input.thinkingTrail}` : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'lifetimeChangelogArc',
    input.lifetimeChangelogArc ? `\n── Lifetime Changelog Arc ──\n${input.lifetimeChangelogArc}` : undefined,
  );
  const footer = input.footerOverride !== undefined
    ? input.footerOverride
    : input.userMessageTriggered === true
      ? 'The active user message appears in Last User + AI Messages (READ FIRST) — respond to it directly.'
      : input.predecessorStatus === 'idle'
        ? 'Predecessor was idle with no active task — default to waiting for the next request; do not invent work or re-investigate the codebase from scratch. But if Last User + AI Messages or Current Thread shows a user request that was never answered or was cut off mid-work, treat that as your active task and engage with it directly rather than sitting idle.'
        : 'Resume the active task. The Activity Log + Active Edit Delta are your primary context. Evaluate predecessor work on its merits before diverging — if the approach is flawed, refactor it rather than discarding (see Core Principle 15). Continue using atlas_query as your primary codebase investigation tool — the File Context above is a handoff snapshot, not a substitute for live Atlas queries when exploring new files or verifying current state. Self-tap only if the package is insufficient or contradictory.';
  const footerBlock = footer ? `\n── Orientation ──\n${footer}` : '';
  const fixedOverhead = headerBlocks.join('\n').length
    + activeRequestBlock.length
    + liveStateBlock.length
    + footerBlock.length;
  // Reserve the newlines that join fixed and historical blocks; an outer hard
  // truncation must never cut a JSON evidence record into executable-looking
  // prompt text.
  const joinReserve = budgetedSections.length + 3;
  const allocatedBlocks = allocateSectionBlocks(
    budgetedSections,
    packageBudget - fixedOverhead - joinReserve,
  );
  const renderOrder = input.renderOrder ?? DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER;
  const historicalBlocks = renderOrder
    .map((key) => allocatedBlocks.get(key))
    .filter((block): block is string => Boolean(block));
  const promptBlocks = [
    ...headerBlocks,
    activeRequestBlock,
    ...historicalBlocks,
    liveStateBlock,
    footerBlock,
  ].filter(Boolean);
  const rendered = promptBlocks.join('\n');
  if (rendered.length <= packageBudget) return rendered;
  const hasTypedLiveState = isContinuityReceipt(input.continuityReceipt)
    && input.continuityReceipt.liveState !== undefined;
  if (!hasTypedLiveState) return truncate(rendered, packageBudget);
  const protectedTail = [activeRequestBlock, liveStateBlock, footerBlock].filter(Boolean).join('\n');
  const head = [...headerBlocks, ...historicalBlocks].join('\n');
  const headBudget = Math.max(0, packageBudget - protectedTail.length - 1);
  return [headBudget > 0 ? truncate(head, headBudget) : '', protectedTail].filter(Boolean).join('\n');
}

interface PreparedTraceMessage {
  readonly sourceIndex: number;
  readonly sourceIdentity?: string;
  readonly role: string;
  readonly text: string;
  readonly sourceText: string;
  readonly sourceTimestamp?: string;
}

export interface RawTraceCoordinate {
  readonly literal: string;
  readonly labelled: string;
  readonly index: number;
  readonly sourceIndex: number | null;
  readonly sourceRole: string | null;
  /** Stable identity of the real source row; absent when the host supplied none. */
  readonly sourceIdentity?: string;
  /** Authoritative source-event time, never ingestion or render time. */
  readonly sourceTimestamp?: string;
}

/** Machine-checkable route named by every compact appendix elision receipt. */
export const RAW_TRACE_COORDINATE_RECOVERY_ROUTE = 'raw-trace-coordinate-replay/v1' as const;

export interface RecoveredRawTraceCoordinate {
  readonly route: typeof RAW_TRACE_COORDINATE_RECOVERY_ROUTE;
  readonly coordinate: RawTraceCoordinate;
  readonly sourceRow: FoldMessage;
  readonly sourceIndex: number;
  readonly sourceIdentity: string | null;
  readonly sourceTimestamp: string | null;
}

export interface RawTraceCoordinateRecoveryReport {
  readonly route: typeof RAW_TRACE_COORDINATE_RECOVERY_ROUTE;
  readonly totalCoordinates: number;
  readonly recovered: RecoveredRawTraceCoordinate[];
}

export type RawTraceCoordinatePlacementReason =
  | 'structural'
  | 'exact-containment'
  | 'temporal-nearest'
  | 'unknown-time-fallback';

/**
 * A cognitive artifact that can receive harvested trace coordinates.
 * `id` is the durable placement identity; callers must keep it stable across
 * rebuilds. Source indexes and timestamps describe source events, never the
 * time this derived artifact was built.
 */
export interface RawTraceCoordinateArtifact {
  readonly id: string;
  readonly text: string;
  readonly sourceIndexes?: readonly number[];
  readonly sourceTimestamp?: string;
  /** Lower values win deterministic ties. Defaults to zero. */
  readonly placementPriority?: number;
}

export interface RawTraceCoordinatePlacement {
  readonly coordinate: RawTraceCoordinate;
  readonly artifactId: string;
  readonly artifactSourceTimestamp?: string;
  readonly reason: RawTraceCoordinatePlacementReason;
}

export interface InlineRawTraceCoordinatePlacementResult {
  readonly artifacts: RawTraceCoordinateArtifact[];
  readonly placements: RawTraceCoordinatePlacement[];
  /** Bounded full provenance for the compact refs attached to artifacts. */
  readonly appendix: string;
  readonly totalCoordinates: number;
  readonly renderedCoordinates: number;
  readonly elidedCoordinates: number;
  readonly recoveryRoute: typeof RAW_TRACE_COORDINATE_RECOVERY_ROUTE;
}

interface FittedRawTraceCoordinates {
  readonly coordinates: RawTraceCoordinate[];
  readonly lines: string[];
  readonly elided: number;
}

function rawTraceCoordinateOrigin(coordinate: RawTraceCoordinate): string {
  const source = coordinate.sourceIndex === null
    ? 'source=unknown'
    : `source=${coordinate.sourceRole ?? 'unknown-role'} message ${coordinate.sourceIndex + 1}`;
  return `${source}; source-id=${coordinate.sourceIdentity?.trim() || 'unknown'}`;
}

function rawTraceCoordinateElisionLine(
  elided: number,
  total: number,
  rendered: number,
): string {
  return `…${elided} more provenance coordinate(s) elided (total=${total}; rendered=${rendered}); recover=${RAW_TRACE_COORDINATE_RECOVERY_ROUTE}`;
}

function fitRawTraceCoordinates(
  coordinates: readonly RawTraceCoordinate[],
  maxChars: number,
): FittedRawTraceCoordinates {
  const entries = coordinates.map((coordinate) => ({
    coordinate,
    line: `- ${coordinate.labelled} @ ${rawTraceCoordinateOrigin(coordinate)}`,
  }));
  const fitted: typeof entries = [];
  let usedChars = countStringChars(RAW_TRACE_CLOSET_HEADER);
  for (const entry of entries) {
    const nextChars = usedChars + countStringChars(entry.line) + 1;
    if (fitted.length === 0 || nextChars <= maxChars) {
      fitted.push(entry);
      usedChars = nextChars;
    }
  }

  let elided = entries.length - fitted.length;
  if (elided > 0) {
    let tail = `- ${rawTraceCoordinateElisionLine(elided, entries.length, fitted.length)}`;
    while (fitted.length > 1 && usedChars + countStringChars(tail) + 1 > maxChars) {
      const removed = fitted.pop();
      if (removed) {
        usedChars -= countStringChars(removed.line) + 1;
        elided += 1;
        tail = `- ${rawTraceCoordinateElisionLine(elided, entries.length, fitted.length)}`;
      }
    }
  }

  return {
    coordinates: fitted.map((entry) => entry.coordinate),
    lines: fitted.map((entry) => entry.line),
    elided,
  };
}

function prepareVisibleTraceMessages(
  visibleMessages: readonly VisibleTraceMessage[],
): PreparedTraceMessage[] {
  return visibleMessages.flatMap((message, sourceIndex) => {
    const text = message.text?.trim();
    if (!text) return [];
    // Prior rebirth seeds contain old Closet and neighborhood sections. Mining
    // them would recursively amplify synthetic coordinates across boundaries.
    if (text.includes('[CONTEXT REBIRTH]')
      || text.includes('[INSTANCE RESURRECTED]')
      || text.includes(CHRONOLOGICAL_PROVENANCE_PREFIX)) return [];
    const scrubbed = stripEphemeralCoordinationBlocks(text).trim();
    if (!scrubbed) return [];
    const role = message.type === 'user' ? 'user' : message.type === 'assistant_text' ? 'assistant' : message.type;
    const bounded = scrubbed.length > RAW_TRACE_CLOSET_MAX_SOURCE_CHARS_PER_MESSAGE
      ? `${scrubbed.slice(0, RAW_TRACE_CLOSET_MAX_SOURCE_CHARS_PER_MESSAGE)}\n... [message source truncated for closet nomination]`
      : scrubbed;
    return [{
      sourceIndex: Number.isInteger(message.sourceIndex) && message.sourceIndex! >= 0
        ? message.sourceIndex!
        : sourceIndex,
      sourceIdentity: message.sourceIdentity?.trim() || undefined,
      role,
      text: bounded,
      sourceText: `${role}:\n${bounded}`,
      sourceTimestamp: message.sourceTimestamp,
    }];
  });
}

function collectRawTraceCoordinates(
  prepared: readonly PreparedTraceMessage[],
): RawTraceCoordinate[] {
  if (prepared.length === 0) return [];

  const fullText = prepared.map((message) => message.sourceText).join('\n\n');
  const candidates = [
    ...nominateVerbatim(fullText, 40).map((literal) => ({ // cap = max entries, not chars
      literal,
      index: Math.max(0, fullText.lastIndexOf(literal)),
    })),
    ...Array.from(fullText.matchAll(PATH_MENTION_RE), (match) => ({
      literal: match[0],
      index: match.index ?? 0,
    })),
    ...Array.from(fullText.matchAll(RAW_TRACE_CLOSET_ID_MENTION_RE), (match) => ({
      literal: match[0],
      index: match.index ?? 0,
    })),
  ].sort((left, right) => right.index - left.index);

  const admitted: string[] = [];
  for (const candidate of candidates) {
    const rawLiteral = candidate.literal.trim();
    const literal = rawLiteral.includes('/') ? rawLiteral.replace(/[.,;]+$/u, '') : rawLiteral;
    if (!literal || isClosetNoiseLiteral(literal)) continue;
    if (/(?:codex-|forge-)?tool-result-spool|rebirth-spool|\/spool\//iu.test(literal)) continue;
    if (/^call_[A-Za-z0-9_-]{16,}(?:\.txt)?$/u.test(literal)) continue;
    if (!admitClosetLiteral(admitted, literal)) continue;
  }

  const coordinates = admitted.flatMap((literal): RawTraceCoordinate[] => {
    const label = extractVerbatimContextLabel(fullText, literal);
    if (label === 'bare' && /^[0-9a-f]{6,}$/i.test(literal)) return [];
    const labelled = label ? `${literal} (${label})` : literal;
    if (isUnlabeledOpaqueClosetLiteral(labelled)) return [];
    let origin: PreparedTraceMessage | undefined;
    for (let index = prepared.length - 1; index >= 0; index--) {
      if (prepared[index]!.text.includes(literal)) {
        origin = prepared[index];
        break;
      }
    }
    return [{
      literal,
      labelled,
      index: Math.max(0, fullText.lastIndexOf(literal)),
      sourceIndex: origin?.sourceIndex ?? null,
      sourceRole: origin?.role ?? null,
      sourceIdentity: origin?.sourceIdentity,
      sourceTimestamp: origin?.sourceTimestamp,
    }];
  });
  return foldArtifactOnlyEnabled()
    ? rankRawArtifactCoordinates(coordinates)
    : coordinates;
}

function foldMessageSourceTimestamp(message: FoldMessage): string | undefined {
  if (typeof message.tsMs !== 'number' || !Number.isFinite(message.tsMs)) return undefined;
  const timestamp = new Date(message.tsMs);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

/** Resolve one emitted coordinate to the exact source row it names. */
export function resolveRawTraceCoordinateSource(
  coordinate: RawTraceCoordinate,
  messages: readonly FoldMessage[],
): RecoveredRawTraceCoordinate | null {
  const resolved = resolveChronologicalPointToSourceRow({
    unit: 'message',
    index: coordinate.sourceIndex ?? undefined,
    id: coordinate.sourceIdentity,
    timestamp: coordinate.sourceTimestamp,
  }, messages.map((message) => ({
    row: message,
    sourceIdentity: message.sourceIdentity?.trim() || undefined,
    sourceTimestamp: foldMessageSourceTimestamp(message),
  })));
  if (!resolved) return null;
  return {
    route: RAW_TRACE_COORDINATE_RECOVERY_ROUTE,
    coordinate,
    sourceRow: resolved.row,
    sourceIndex: resolved.rowIndex,
    sourceIdentity: resolved.sourceIdentity,
    sourceTimestamp: resolved.sourceTimestamp,
  };
}

/**
 * Replay the exact coordinate harvester over raw source rows. This is the
 * executable recovery route named by appendix elision receipts.
 */
export function replayRawTraceCoordinateRecovery(
  messages: readonly FoldMessage[],
  includeTrailingUserTurn = true,
): RawTraceCoordinateRecoveryReport {
  const visibleMessages = withoutTaskRailProviderMessages(messages).messages;
  const coordinates = collectRawTraceCoordinates(prepareVisibleTraceMessages(
    visibleTraceMessagesFromFoldMessages(visibleMessages, includeTrailingUserTurn),
  ));
  const recovered = coordinates.map((coordinate) => {
    const resolution = resolveRawTraceCoordinateSource(coordinate, messages);
    if (!resolution) {
      throw new Error(`unresolvable raw trace coordinate: ${coordinate.literal}`);
    }
    return resolution;
  });
  return {
    route: RAW_TRACE_COORDINATE_RECOVERY_ROUTE,
    totalCoordinates: coordinates.length,
    recovered,
  };
}

/**
 * Parse only timestamps that identify an absolute instant. Timestamp-less or
 * malformed source rows remain unknown; the router never fabricates order.
 */
function authoritativeTimestampMs(sourceTimestamp: string | undefined): number | null {
  if (!sourceTimestamp
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(sourceTimestamp)) return null;
  const parsed = Date.parse(sourceTimestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function comparePlacementArtifacts(
  left: RawTraceCoordinateArtifact,
  right: RawTraceCoordinateArtifact,
): number {
  const leftPriority = Number.isFinite(left.placementPriority) ? left.placementPriority! : 0;
  const rightPriority = Number.isFinite(right.placementPriority) ? right.placementPriority! : 0;
  return leftPriority - rightPriority || left.id.localeCompare(right.id);
}

/**
 * Pure provenance-aware placement router for harvested coordinates.
 *
 * Precedence is structural source membership, exact textual containment, then
 * authoritative temporal proximity. Ties use placementPriority and stable
 * artifact id. When either side lacks an absolute source time, chronology is
 * not guessed: the deterministic priority/id fallback is explicit in the
 * returned reason. Every input coordinate produces exactly one placement.
 */
export function routeRawTraceCoordinates(
  coordinates: readonly RawTraceCoordinate[],
  artifacts: readonly RawTraceCoordinateArtifact[],
): RawTraceCoordinatePlacement[] {
  if (coordinates.length === 0) return [];
  if (artifacts.length === 0) {
    throw new TypeError('routeRawTraceCoordinates requires at least one artifact for non-empty coordinates');
  }
  const seenIds = new Set<string>();
  for (const artifact of artifacts) {
    if (!artifact.id.trim()) throw new TypeError('coordinate artifact id must be non-empty');
    if (seenIds.has(artifact.id)) throw new TypeError(`duplicate coordinate artifact id: ${artifact.id}`);
    seenIds.add(artifact.id);
  }
  const orderedArtifacts = [...artifacts].sort(comparePlacementArtifacts);

  const selectFirst = (candidates: readonly RawTraceCoordinateArtifact[]): RawTraceCoordinateArtifact => (
    [...candidates].sort(comparePlacementArtifacts)[0]!
  );

  const placements: RawTraceCoordinatePlacement[] = [];
  for (const coordinate of coordinates) {
    const structural = orderedArtifacts.filter((artifact) => (
      coordinate.sourceIndex !== null && artifact.sourceIndexes?.includes(coordinate.sourceIndex)
    ));
    if (structural.length > 0) {
      const artifact = selectFirst(structural);
      placements.push({
        coordinate,
        artifactId: artifact.id,
        artifactSourceTimestamp: artifact.sourceTimestamp,
        reason: 'structural',
      });
      continue;
    }

    const containing = orderedArtifacts.filter((artifact) => isConservedIn(artifact.text, coordinate.literal));
    if (containing.length > 0) {
      const artifact = selectFirst(containing);
      placements.push({
        coordinate,
        artifactId: artifact.id,
        artifactSourceTimestamp: artifact.sourceTimestamp,
        reason: 'exact-containment',
      });
      continue;
    }

    const coordinateTime = authoritativeTimestampMs(coordinate.sourceTimestamp);
    const temporal = coordinateTime === null
      ? []
      : orderedArtifacts.flatMap((artifact) => {
          const artifactTime = authoritativeTimestampMs(artifact.sourceTimestamp);
          return artifactTime === null ? [] : [{ artifact, distance: Math.abs(artifactTime - coordinateTime) }];
        });
    if (temporal.length > 0) {
      temporal.sort((left, right) => (
        left.distance - right.distance
        || comparePlacementArtifacts(left.artifact, right.artifact)
      ));
      const artifact = temporal[0]!.artifact;
      placements.push({
        coordinate,
        artifactId: artifact.id,
        artifactSourceTimestamp: artifact.sourceTimestamp,
        reason: 'temporal-nearest',
      });
      continue;
    }

    const artifact = orderedArtifacts[0]!;
    placements.push({
      coordinate,
      artifactId: artifact.id,
      artifactSourceTimestamp: artifact.sourceTimestamp,
      reason: 'unknown-time-fallback',
    });
  }
  return placements;
}

/**
 * Artifact mode (VOXXO_FOLD_ARTIFACT_ONLY): maximum provenance references
 * associated with any one artifact. Rows beyond the cap collapse into one
 * appendix elision note and remain recoverable through exact trace tools.
 */
export const RAW_ARTIFACT_MODE_ANCHOR_CAP = 36;

/**
 * Artifact-mode anchor worthiness: a ⌖ placement row earns its bytes only when
 * the literal is dereferenceable by the successor. Kept: file paths, verbatim
 * recall keys, spool artifact ids, rail ids, UUIDs. Dropped: bare sha256
 * digests (they already live inside their spool digest blocks on disk),
 * timestamps, generic words, member-list fragments, and other prose literals
 * with no retrieval value.
 */
export function rawAnchorWorthyForArtifactMode(literal: string): boolean {
  const t = literal.trim();
  if (!t) return false;
  if (t.includes('/')) return true;
  if (t.startsWith('verbatim:')) return true;
  if (/^spool:/i.test(t) || /-spool\b/i.test(t)) return true;
  if (/^rail-[0-9a-f]{6,}/i.test(t)) return true;
  if (/^(?:sig|msg|inst|task|thread|summon|fork|group|epoch|tool|call)[-_][A-Za-z0-9][A-Za-z0-9_.:-]{5,}$/i.test(t)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
  if (/^[A-Za-z_][\w.-]{0,40}[=:][^\s]{2,}$/u.test(t)) return true;
  return false;
}

/** Semantic value score used before artifact anchor caps are applied. */
export function rawArtifactAnchorValueScore(literal: string, artifactId?: string): number {
  const t = literal.trim();
  const activeArtifact = artifactId === 'active-edit-delta' || artifactId === 'task-rail-context';
  if (t.includes('/')) return 600 + (activeArtifact ? 200 : 0);
  if (/^rail-[0-9a-f]{6,}/i.test(t)) return 580 + (activeArtifact ? 100 : 0);
  if (t.startsWith('verbatim:')) return 560;
  if (/^spool:/i.test(t) || /(?:tool-result-spool|rebirth-spool|-spool\b)/i.test(t)) return 540;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return 520;
  if (/^(?:sig|msg|inst|task|thread|summon|fork|group|epoch|tool|call)[-_]/i.test(t)) return 500;
  if (/^[A-Za-z_][\w.-]{0,40}[=:][^\s]{2,}$/u.test(t)) return 440;
  return 0;
}

function compareRawArtifactCoordinates(left: RawTraceCoordinate, right: RawTraceCoordinate): number {
  const valueDifference = rawArtifactAnchorValueScore(right.literal) - rawArtifactAnchorValueScore(left.literal);
  if (valueDifference !== 0) return valueDifference;
  const leftTime = authoritativeTimestampMs(left.sourceTimestamp);
  const rightTime = authoritativeTimestampMs(right.sourceTimestamp);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
  if (left.sourceIndex !== null && right.sourceIndex !== null && left.sourceIndex !== right.sourceIndex) {
    return right.sourceIndex - left.sourceIndex;
  }
  return right.index - left.index || left.literal.localeCompare(right.literal);
}

export function rankRawArtifactCoordinates(
  coordinates: readonly RawTraceCoordinate[],
): RawTraceCoordinate[] {
  return [...coordinates].sort(compareRawArtifactCoordinates);
}

export function placeRawTraceCoordinatesInline(
  coordinates: readonly RawTraceCoordinate[],
  artifacts: readonly RawTraceCoordinateArtifact[],
  options: { readonly maxAppendixChars?: number } = {},
): InlineRawTraceCoordinatePlacementResult {
  const placements = routeRawTraceCoordinates(coordinates, artifacts);
  const artifactOnly = foldArtifactOnlyEnabled();
  const renderPlacements = artifactOnly
    ? [...placements].sort((left, right) => (
        rawArtifactAnchorValueScore(right.coordinate.literal, right.artifactId)
        - rawArtifactAnchorValueScore(left.coordinate.literal, left.artifactId)
        || compareRawArtifactCoordinates(left.coordinate, right.coordinate)
        || left.artifactId.localeCompare(right.artifactId)
      ))
    : [...placements];
  const perArtifactCounts = new Map<string, number>();
  const candidates: RawTraceCoordinatePlacement[] = [];
  let elided = 0;
  for (const placement of renderPlacements) {
    if (artifactOnly && !rawAnchorWorthyForArtifactMode(placement.coordinate.literal)) {
      elided += 1;
      continue;
    }
    const artifactCount = perArtifactCounts.get(placement.artifactId) ?? 0;
    if (artifactOnly && artifactCount >= RAW_ARTIFACT_MODE_ANCHOR_CAP) {
      elided += 1;
      continue;
    }
    perArtifactCounts.set(placement.artifactId, artifactCount + 1);
    candidates.push(placement);
  }

  const maxAppendixChars = Math.max(
    0,
    Math.floor(options.maxAppendixChars
      ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset),
  );
  const kept = candidates.map((placement, index) => {
    const ref = `⌖c${index + 1}`;
    const sourceTime = placement.coordinate.sourceTimestamp ?? 'unknown';
    return {
      placement,
      ref,
      row: `${ref} ${placement.coordinate.labelled} @ ${rawTraceCoordinateOrigin(placement.coordinate)}; source-time=${sourceTime}; route=${placement.reason}; artifact=${placement.artifactId}`,
    };
  });
  const renderAppendix = (): string => [
    ...kept.map((entry) => entry.row),
    ...(elided > 0
      ? [rawTraceCoordinateElisionLine(elided, placements.length, kept.length)]
      : []),
  ].join('\n');
  let appendix = renderAppendix();
  while (appendix.length > maxAppendixChars && kept.length > 0) {
    kept.pop();
    elided += 1;
    appendix = renderAppendix();
  }
  // The exact count and recovery route are an audit receipt. If the caller's
  // cap is smaller than that one line, preserve the receipt rather than
  // silently clipping the very proof needed to recover omitted coordinates.

  const refsByArtifact = new Map<string, string[]>();
  for (const entry of kept) {
    const refs = refsByArtifact.get(entry.placement.artifactId) ?? [];
    refs.push(entry.ref);
    refsByArtifact.set(entry.placement.artifactId, refs);
  }
  // Conversation stays byte-for-byte immutable. Other sections receive one
  // compact suffix line; filenames, notes, and prose are never rewritten.
  const immutableArtifacts = new Set(['current-thread', 'last-user-ai']);
  const renderedArtifacts = artifacts.map((artifact) => {
    const refs = refsByArtifact.get(artifact.id);
    if (!refs?.length || immutableArtifacts.has(artifact.id)) return { ...artifact };
    const suffix = `Provenance: ${refs.join(' ')}`;
    return { ...artifact, text: [artifact.text, suffix].filter(Boolean).join('\n') };
  });
  return {
    artifacts: renderedArtifacts,
    placements,
    appendix,
    totalCoordinates: placements.length,
    renderedCoordinates: kept.length,
    elidedCoordinates: elided,
    recoveryRoute: RAW_TRACE_COORDINATE_RECOVERY_ROUTE,
  };
}

export function buildRawTraceCoordinateCloset(
  visibleMessages: readonly VisibleTraceMessage[],
  maxChars = DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  const coordinates = collectRawTraceCoordinates(prepareVisibleTraceMessages(visibleMessages));
  if (coordinates.length === 0) return '';

  const fitted = fitRawTraceCoordinates(coordinates, maxChars);
  const fittedLines = [...fitted.lines];
  if (fitted.elided > 0) {
    fittedLines.push(`- ${rawTraceCoordinateElisionLine(
      fitted.elided,
      fitted.coordinates.length + fitted.elided,
      fitted.coordinates.length,
    )}`);
  }

  if (fittedLines.length === 0) return '';
  return [RAW_TRACE_CLOSET_HEADER, ...fittedLines].join('\n');
}

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
  /** Candidate budget shared with the Coordinate Closet; elided literals are not scored. */
  readonly coordinateClosetMaxChars?: number;
}

function traceLiteralKind(literal: string): { label: string; score: number } {
  if (/^(?:toolu[-_]|(?:rail|sig|msg|inst|task|thread|summon|fork|group|epoch|tool|call)[-_])/i.test(literal)) {
    return { label: 'operational id', score: 50 };
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(literal) || /^(?=.*[a-f])(?=.*\d)[0-9a-f]{8,64}$/i.test(literal)) {
    return { label: 'uuid/hex id', score: 45 };
  }
  if (literal.includes('/')) return { label: 'path', score: 40 };
  if (/^[A-Za-z_][\w.-]{0,40}[=:]/.test(literal)) return { label: 'key/value', score: 30 };
  if (/^#\d+$/.test(literal)) return { label: 'issue reference', score: 25 };
  return { label: 'exact coordinate', score: 15 };
}

function compactTraceExcerpt(text: string, maxChars: number): string {
  return truncate(text.replace(/\s+/gu, ' ').trim(), maxChars);
}

function eventAwareNeighborhoodRange(
  messages: readonly PreparedTraceMessage[],
  hitIndex: number,
  contextRadius: number,
): { start: number; end: number } {
  let start = Math.max(0, hitIndex - contextRadius);
  let end = Math.min(messages.length - 1, hitIndex + contextRadius);

  // A literal inside a tool event is often unintelligible without the user
  // intent that launched the local chain. Search only a small bounded prefix.
  for (let index = hitIndex; index >= Math.max(0, hitIndex - 4); index -= 1) {
    if (messages[index]?.role === 'user') {
      start = Math.min(start, index);
      break;
    }
  }

  // When a local chain contains tool evidence, retain the first assistant turn
  // after it—the usual conclusion/decision boundary—without opening an
  // unbounded transcript window.
  let sawToolEvidence = false;
  for (let index = hitIndex; index <= Math.min(messages.length - 1, hitIndex + 4); index += 1) {
    const role = messages[index]?.role ?? '';
    if (role.startsWith('tool')) {
      sawToolEvidence = true;
      end = Math.max(end, index);
      continue;
    }
    if (sawToolEvidence && index > hitIndex && role === 'assistant') {
      end = Math.max(end, index);
      break;
    }
  }

  return { start, end };
}

function scoreTraceOccurrence(
  messages: readonly PreparedTraceMessage[],
  hitIndex: number,
  contextRadius: number,
): { index: number; start: number; end: number; causalScore: number } {
  const { start, end } = eventAwareNeighborhoodRange(messages, hitIndex, contextRadius);
  let intentIndex = -1;
  let evidenceIndex = -1;
  let conclusionIndex = -1;

  for (let index = start; index <= hitIndex; index += 1) {
    if (messages[index]?.role === 'user') intentIndex = index;
  }
  if (intentIndex >= 0) {
    for (let index = intentIndex + 1; index <= end; index += 1) {
      if (messages[index]?.role.startsWith('tool')) {
        evidenceIndex = index;
        break;
      }
    }
  }
  if (evidenceIndex >= 0) {
    for (let index = evidenceIndex + 1; index <= end; index += 1) {
      if (messages[index]?.role === 'assistant') {
        conclusionIndex = index;
        break;
      }
    }
  }

  const hasIntent = intentIndex >= 0;
  const hasEvidence = evidenceIndex >= 0;
  const hasConclusion = conclusionIndex >= 0;
  const causalScore = (hasIntent ? 20 : 0)
    + (hasEvidence ? 30 : 0)
    + (hasConclusion ? 30 : 0)
    + (hasIntent && hasEvidence && hasConclusion ? 60 : 0)
    + (messages[hitIndex]?.role.startsWith('tool') ? 10 : 0);
  return { index: hitIndex, start, end, causalScore };
}

/**
 * Deterministically expands emitted Coordinate Closet literals back into small
 * source-message neighborhoods. Selection is exact-match + heuristic ranking;
 * no LLM, embedding lookup, storage access, or other I/O participates.
 */
export function buildLiteralTraceNeighborhoods(
  visibleMessages: readonly VisibleTraceMessage[],
  options: LiteralTraceNeighborhoodOptions = {},
): string {
  const maxChars = Math.floor(options.maxChars ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.traceNeighborhoods);
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  const requestedNeighborhoods = options.maxNeighborhoods ?? 6;
  if (!Number.isFinite(requestedNeighborhoods) || requestedNeighborhoods <= 0) return '';
  const maxNeighborhoods = Math.min(12, Math.floor(requestedNeighborhoods));
  const requestedRadius = options.contextRadius ?? 1;
  const contextRadius = Number.isFinite(requestedRadius)
    ? Math.max(0, Math.min(3, Math.floor(requestedRadius)))
    : 1;
  const requestedMessageChars = options.perMessageChars ?? 650;
  const perMessageChars = Number.isFinite(requestedMessageChars)
    ? Math.max(120, Math.min(2_000, Math.floor(requestedMessageChars)))
    : 650;
  const excluded = (options.excludeTexts ?? []).filter((text) => text.trim().length > 0);
  const prepared = prepareVisibleTraceMessages(visibleMessages);
  const requestedCoordinateChars = options.coordinateClosetMaxChars
    ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset;
  const coordinateClosetMaxChars = Number.isFinite(requestedCoordinateChars)
    ? Math.floor(requestedCoordinateChars)
    : DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset;
  if (coordinateClosetMaxChars <= 0) return '';
  const coordinates = fitRawTraceCoordinates(
    collectRawTraceCoordinates(prepared),
    coordinateClosetMaxChars,
  ).coordinates;
  if (prepared.length === 0 || coordinates.length === 0) return '';

  const ranked = coordinates.flatMap((coordinate) => {
    if (excluded.some((text) => isConservedIn(text, coordinate.literal))) return [];
    const occurrences = prepared.flatMap((message, preparedIndex) => (
      message.text.includes(coordinate.literal) ? [preparedIndex] : []
    ));
    const selected = occurrences
      .map((index) => scoreTraceOccurrence(prepared, index, contextRadius))
      .sort((left, right) => right.causalScore - left.causalScore || right.index - left.index)[0];
    if (!selected) return [];
    const kind = traceLiteralKind(coordinate.literal);
    const rarityScore = Math.max(0, 24 - ((occurrences.length - 1) * 4));
    const recencyScore = prepared.length <= 1
      ? 20
      : Math.round((selected.index / (prepared.length - 1)) * 20);
    return [{ coordinate, occurrences, selected, kind, score: kind.score + rarityScore + recencyScore }];
  }).sort((left, right) => (
    right.score - left.score
    || right.selected.causalScore - left.selected.causalScore
    || right.selected.index - left.selected.index
    || right.coordinate.index - left.coordinate.index
    || left.coordinate.literal.localeCompare(right.coordinate.literal)
  ));

  const header = flatCoordinateClosetEnabled()
    ? 'Deterministic exact-match neighborhoods around Coordinate Closet literals; source excerpts are whitespace-compacted, never LLM-summarized.'
    : 'Deterministic exact-match blast radius around harvested coordinate literals not already conserved inline by an artifact section; source excerpts are whitespace-compacted, never LLM-summarized.';
  const selectedRanges: Array<{ start: number; end: number }> = [];
  const blocks: string[] = [];
  let usedChars = countStringChars(header);

  for (const candidate of ranked) {
    if (blocks.length >= maxNeighborhoods) break;
    const { start, end } = candidate.selected;
    if (selectedRanges.some((range) => start <= range.end && end >= range.start)) continue;

    const windowMessages = prepared.slice(start, end + 1);
    const firstSourceIndex = windowMessages[0]?.sourceIndex ?? 0;
    const lastSourceIndex = windowMessages.at(-1)?.sourceIndex ?? firstSourceIndex;
    const occurrenceWord = candidate.occurrences.length === 1 ? 'occurrence' : 'occurrences';
    const rows = windowMessages.map((message) => (
      `  [${message.sourceIndex + 1}] ${message.role}: ${compactTraceExcerpt(message.text, perMessageChars)}`
    ));
    const block = [
      `⌖ literal: ${candidate.coordinate.labelled}`,
      `↞ selected: exact ${candidate.kind.label}; ${candidate.occurrences.length} ${occurrenceWord}; causal=message ${prepared[candidate.selected.index]!.sourceIndex + 1}; chain-score=${candidate.selected.causalScore}`,
      `[trace messages ${firstSourceIndex + 1}–${lastSourceIndex + 1} of ${visibleMessages.length}]`,
      ...rows,
    ].join('\n');
    const nextChars = usedChars + countStringChars(block) + 2;
    if (nextChars > maxChars) continue;
    blocks.push(block);
    selectedRanges.push({ start, end });
    usedChars = nextChars;
  }

  return blocks.length > 0 ? [header, ...blocks].join('\n\n') : '';
}

function messageValueToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function messagePartsToText(message: FoldMessage): string {
  return messageValueToText((message as FoldMessage & { parts?: unknown }).parts);
}

function messageContentAndPartsToText(message: FoldMessage): string {
  return [
    messageValueToText(message.content),
    messagePartsToText(message),
  ].filter((part) => part.trim().length > 0).join('\n');
}

function providerMessageToTraceText(message: FoldMessage | undefined): string {
  if (!message) return '';
  const lines = [`role:${message.role}`];
  const content = messageValueToText(message.content);
  if (content) lines.push(`content:\n${content}`);
  const parts = messagePartsToText(message);
  if (parts) lines.push(`parts:\n${parts}`);
  if (message.name !== undefined) lines.push(`name: ${messageValueToText(message.name)}`);
  if (message.tool_call_id !== undefined) lines.push(`tool_call_id: ${messageValueToText(message.tool_call_id)}`);
  if (message.tool_calls !== undefined) lines.push(`tool_calls:\n${messageValueToText(message.tool_calls)}`);
  if (message.reasoning_content !== undefined) lines.push(`reasoning_content:\n${messageValueToText(message.reasoning_content)}`);
  return lines.join('\n');
}

function isTaskRailProviderName(value: unknown): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'task_rail'
    || normalized.endsWith('__task_rail')
    || normalized.endsWith('/task_rail')
    || normalized.endsWith('.task_rail');
}

function recordContainsTaskRailName(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(recordContainsTaskRailName);
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if ([record.name, record.tool_name, record.canonicalToolName, record.rawToolName]
    .some(isTaskRailProviderName)) return true;
  return Object.values(record).some(recordContainsTaskRailName);
}

function collectTaskRailProviderIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectTaskRailProviderIds(entry, ids));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (recordContainsTaskRailName(record)) {
    for (const key of ['id', 'tool_call_id', 'toolCallId', 'tool_use_id']) {
      const id = typeof record[key] === 'string' ? record[key].trim() : '';
      if (id) ids.add(id);
    }
  }
  Object.values(record).forEach((entry) => collectTaskRailProviderIds(entry, ids));
}

function referencesTaskRailProviderId(value: unknown, ids: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((entry) => referencesTaskRailProviderId(entry, ids));
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  for (const key of ['tool_call_id', 'toolCallId', 'tool_use_id']) {
    const id = typeof record[key] === 'string' ? record[key].trim() : '';
    if (id && ids.has(id)) return true;
  }
  return Object.values(record).some((entry) => referencesTaskRailProviderId(entry, ids));
}

function stripTaskRailProviderValue(value: unknown, ids: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripTaskRailProviderValue(entry, ids))
      .filter((entry) => entry !== undefined);
  }
  if (value === null || typeof value !== 'object') return value;
  if (recordContainsTaskRailName(value) || referencesTaskRailProviderId(value, ids)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, stripTaskRailProviderValue(entry, ids)] as const)
      .filter(([, entry]) => entry !== undefined),
  );
}

function withoutTaskRailProviderMessages(messages: readonly FoldMessage[]): {
  messages: FoldMessage[];
  excludedIndexes: Set<number>;
} {
  const ids = new Set<string>();
  messages.forEach((message) => collectTaskRailProviderIds(message, ids));
  const excludedIndexes = new Set<number>();
  const sanitized = messages.map((message, index) => {
    if (isTaskRailProviderName(message.name)
      || referencesTaskRailProviderId({
        tool_call_id: message.tool_call_id,
        content: message.content,
        parts: (message as FoldMessage & { parts?: unknown }).parts,
      }, ids)) {
      excludedIndexes.add(index);
      return {
        ...message,
        content: '',
        name: undefined,
        tool_call_id: undefined,
        tool_calls: undefined,
        ...(Object.prototype.hasOwnProperty.call(message, 'parts') ? { parts: undefined } : {}),
      } as FoldMessage;
    }
    const next = {
      ...message,
      content: stripTaskRailProviderValue(message.content, ids),
      tool_calls: stripTaskRailProviderValue(message.tool_calls, ids),
      ...(Object.prototype.hasOwnProperty.call(message, 'parts')
        ? { parts: stripTaskRailProviderValue((message as FoldMessage & { parts?: unknown }).parts, ids) }
        : {}),
    } as FoldMessage;
    const hasPayload = [
      messageValueToText(next.content),
      messagePartsToText(next),
      messageValueToText(next.tool_calls),
      messageValueToText(next.reasoning_content),
    ].some((part) => part.trim().length > 0);
    if (!hasPayload) excludedIndexes.add(index);
    return next;
  });
  return { messages: sanitized, excludedIndexes };
}

function messageLabel(message: FoldMessage): string {
  if (message.role === 'user') return '👤 USER';
  if (message.role === 'assistant') return '🤖 YOU';
  if (message.role === 'tool') return '🔧 TOOL';
  if (message.role === 'model') return '🤖 MODEL';
  return message.role.toUpperCase();
}

function trailingUserRunStartIndex(messages: readonly FoldMessage[]): number {
  let i = messages.length;
  while (i > 0 && messages[i - 1]?.role === 'user') i -= 1;
  return i;
}

function trailingUserRunIsStringOnly(messages: readonly FoldMessage[], startIndex: number): boolean {
  for (let i = startIndex; i < messages.length; i += 1) {
    if (typeof messages[i]?.content !== 'string') return false;
  }
  return true;
}

function excludedTrailingStringUserIndexes(
  messages: readonly FoldMessage[],
  includeTrailingUserTurn: boolean,
): ReadonlySet<number> {
  if (includeTrailingUserTurn) return new Set<number>();
  const trailingStart = trailingUserRunStartIndex(messages);
  if (trailingStart >= messages.length) return new Set<number>();
  const excluded = new Set<number>();
  for (let i = trailingStart; i < messages.length; i += 1) {
    if (typeof messages[i]?.content === 'string') excluded.add(i);
  }
  return excluded;
}

export function findRawRebirthSeedTraceEnd(
  messages: readonly FoldMessage[],
  includeTrailingUserTurn = true,
): number {
  if (includeTrailingUserTurn) return messages.length;
  const trailingStart = trailingUserRunStartIndex(messages);
  const canMergeTrailingUserText = trailingStart < messages.length
    && trailingUserRunIsStringOnly(messages, trailingStart);
  return canMergeTrailingUserText ? trailingStart : messages.length;
}

function buildCurrentThreadFromMessages(
  messages: readonly FoldMessage[],
  traceEnd: number,
  messageLimit: number,
  perMessageChars: number,
  excludedMessageIndexes: ReadonlySet<number>,
): string {
  const roleLimit = Math.max(1, Math.floor(messageLimit / 2));
  const candidates = messages.slice(0, traceEnd).flatMap((message, sourceIndex) => {
    if (excludedMessageIndexes.has(sourceIndex)) return [];
    const text = providerMessageToTraceText(message);
    const userIsGenuine = message.role === 'user' && isPortableGenuineOperatorFoldMessage(message);
    const type = message.role === 'user'
      ? userIsGenuine ? 'user' : 'system_reminder'
      : message.role === 'assistant' || message.role === 'model'
        ? 'assistant_text'
        : message.role;
    return [{
      id: `message-${sourceIndex}`,
      type,
      text,
      sourceIndex,
      message,
      ...(typeof message.tsMs === 'number' && Number.isFinite(message.tsMs)
        ? { created_at: new Date(message.tsMs).toISOString() }
        : {}),
    }];
  });
  const selected = selectRoleAwareRebirthDialogueWindow(candidates, {
    recentUserMessages: roleLimit,
    recentAssistantMessages: roleLimit,
    recentAmbientMessages: 0,
  }).messages;
  return selected.map(({ message, sourceIndex, text }) => (
    `[message ${sourceIndex}] ${messageLabel(message)}:\n${truncateMiddle(text, perMessageChars)}`
  )).join('\n\n');
}

function buildActivityLogFromMessages(
  messages: readonly FoldMessage[],
  traceEnd: number,
  perMessageChars: number,
  excludedMessageIndexes: ReadonlySet<number>,
): string {
  const rows: string[] = ['Chronology: oldest → newest'];
  for (let i = 0; i < traceEnd; i += 1) {
    if (excludedMessageIndexes.has(i)) continue;
    const message = messages[i];
    if (!message) continue;
    rows.push(`[message ${i}] ${messageLabel(message)}\n${truncateMiddle(providerMessageToTraceText(message), perMessageChars)}`);
  }
  return rows.join('\n\n');
}

// portable genuine-operator filter.
// Skip system-generated user messages (chatroom deliveries, mention pings,
// digest deltas, rebirth seeds, ephemeral-only turns).
/**
 * Genuine-operator filter shared with band-enrichment modules: true when a
 * user-role message is an actual operator turn rather than a chatroom
 * delivery, mention ping, digest delta, or ephemeral-only coordination frame.
 */
export function isPortableGenuineOperatorMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!isGenuineRebirthOperatorMessage(trimmed)) return false;
  // Strip known ephemeral coordination markers
  const stripped = trimmed
    .replace(/\[DIGEST DELTA[^\]]*\][\s\S]*?\[END DIGEST DELTA\]/g, '')
    .replace(/\[Control Signals\][\s\S]*?\[\/Control Signals\]/g, '')
    .trim();
  if (stripped.length === 0) return false;
  return true;
}

function isPortableGenuineOperatorFoldMessage(message: FoldMessage): boolean {
  if (message.role !== 'user') return false;
  if (Array.isArray(message.content) && message.content.some((block) => (
    block !== null
    && typeof block === 'object'
    && 'type' in block
    && block.type === 'tool_result'
  ))) return false;
  return isPortableGenuineOperatorMessage(messageContentAndPartsToText(message));
}

function hasMicroSeedTrajectory(messages: readonly FoldMessage[]): boolean {
  for (const message of messages) {
    if (message.role === 'user') {
      if (isPortableGenuineOperatorMessage(messageContentAndPartsToText(message))) return true;
      continue;
    }
    if (message.role !== 'assistant' && message.role !== 'model') continue;
    const assistantPayload = [
      messageContentAndPartsToText(message),
      messageValueToText(message.tool_calls),
      messageValueToText(message.reasoning_content),
    ].some((part) => part.trim().length > 0);
    if (assistantPayload) return true;
  }
  return false;
}

function buildLastUserAiMessagesFromMessages(
  messages: readonly FoldMessage[],
  traceEnd: number,
  excludedMessageIndexes: ReadonlySet<number>,
  triggeringUserMessage?: string,
): string {
  let lastUser = '';
  let lastUserIndex = -1;
  let lastAssistant = '';
  let lastAssistantIndex = -1;
  for (let i = 0; i < traceEnd; i++) {
    if (excludedMessageIndexes.has(i)) continue;
    const message = messages[i];
    if (!message) continue;
    // Genuine-operator filter: skip chatroom deliveries, mention pings,
    // digest deltas, and ephemeral-only turns. The newest genuine operator
    // message wins (iterate forward, overwrite — latest by index wins).
    if (message.role === 'user') {
      if (isPortableGenuineOperatorFoldMessage(message)) {
        lastUser = providerMessageToTraceText(message);
        lastUserIndex = i;
      }
    }
    if (message.role === 'assistant' || message.role === 'model') {
      const text = providerMessageToTraceText(message);
      if (text) {
        lastAssistant = text;
        lastAssistantIndex = i;
      }
    }
  }
  // Citation refs tie these highlight blocks to the same message's existing
  // [message N] row label in Current Thread / the Activity Log — the raw trace
  // index is the shared coordinate space, so no new numbering is introduced.
  // Flag-off (or index unknown) renders the historical marker-free output.
  const markersEnabled = typeof process !== 'undefined' && process.env?.VOXXO_REBIRTH_SEED_MSG_MARKERS !== '0';
  const activeRequest = triggeringUserMessage?.trim() || '';
  if (activeRequest) {
    lastUser = activeRequest;
    lastUserIndex = -1;
  }
  const userMarker = activeRequest
    ? ' (active request)'
    : markersEnabled && lastUserIndex >= 0 ? ` [message ${lastUserIndex}]` : '';
  const aiMarker = markersEnabled && lastAssistantIndex >= 0 ? ` [message ${lastAssistantIndex}]` : '';
  const renderedAssistant = lastAssistant;
  return [
    lastUser ? `👤 LAST USER MESSAGE${userMarker}:\n${lastUser}` : '',
    renderedAssistant ? `🤖 LAST AI MESSAGE${aiMarker}:\n${renderedAssistant}` : '',
  ].filter(Boolean).join('\n\n');
}

function visibleTraceMessagesFromFoldMessages(
  messages: readonly FoldMessage[],
  includeTrailingUserTurn: boolean,
): VisibleTraceMessage[] {
  const traceEnd = findRawRebirthSeedTraceEnd(messages, includeTrailingUserTurn);
  const excluded = excludedTrailingStringUserIndexes(messages, includeTrailingUserTurn);
  return messages.slice(0, traceEnd).flatMap((message, offset): VisibleTraceMessage[] => {
    if (excluded.has(offset)) return [];
    return [{
      type: message.role === 'assistant' ? 'assistant_text' : message.role,
      text: providerMessageToTraceText(message),
      sourceIndex: offset,
      sourceIdentity: message.sourceIdentity?.trim() || undefined,
      sourceTimestamp: foldMessageSourceTimestamp(message),
    }];
  });
}

export function buildRawTraceCoordinateClosetFromMessages(
  messages: readonly FoldMessage[],
  options: Pick<RawRebirthSeedFromMessagesOptions, 'includeTrailingUserTurn' | 'rawTraceCoordinateClosetChars'> = {},
): string {
  const includeTrailingUserTurn = options.includeTrailingUserTurn !== false;
  return buildRawTraceCoordinateCloset(
    visibleTraceMessagesFromFoldMessages(messages, includeTrailingUserTurn),
    options.rawTraceCoordinateClosetChars ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset,
  );
}

export function buildRawRebirthSeedFromMessages(
  messages: readonly FoldMessage[],
  options: RawRebirthSeedFromMessagesOptions = {},
): string {
  const predecessorName = options.predecessorName ?? 'predecessor';
  const includeTrailingUserTurn = options.includeTrailingUserTurn !== false;
  const traceEnd = findRawRebirthSeedTraceEnd(messages, includeTrailingUserTurn);
  const taskRailSanitized = withoutTaskRailProviderMessages(messages);
  const visibleMessages = taskRailSanitized.messages;
  const excluded = new Set([
    ...excludedTrailingStringUserIndexes(messages, includeTrailingUserTurn),
    ...taskRailSanitized.excludedIndexes,
  ]);
  let currentThread = buildCurrentThreadFromMessages(
    visibleMessages,
    traceEnd,
    Math.max(1, Math.floor(options.currentThreadMessageLimit ?? 30)),
    Math.max(200, Math.floor(options.currentThreadMessageChars ?? 1_600)),
    excluded,
  );
  let lastUserAiMessages = buildLastUserAiMessagesFromMessages(
    visibleMessages,
    traceEnd,
    excluded,
    options.triggeringUserMessage,
  );
  const visibleTraceMessages = visibleTraceMessagesFromFoldMessages(visibleMessages, includeTrailingUserTurn);
  // Coordinate placement: build the artifact sections FIRST so every harvested
  // literal can be checked against the corpus it would live in. Conserved
  // literals stay inline with their artifact; only orphans spend neighborhood
  // budget on an attributed expansion. The flat closet renders only behind
  // the VOXXO_REBIRTH_FLAT_CLOSET kill-switch.
  let starredMoments = options.starredMoments === undefined
    ? buildStarredMomentsFromMessages(
        visibleMessages,
        options.sectionMaxChars?.starredMoments
          ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.starredMoments,
      )
    : options.starredMoments;
  let openQuestions = options.openQuestions ?? buildOpenQuestionsFromMessages(visibleMessages);
  let thinkingTrail = buildActivityLogFromMessages(
    visibleMessages,
    traceEnd,
    Math.max(200, Math.floor(options.activityMessageChars ?? 1_000)),
    excluded,
  );
  let activeEditDelta = options.activeEditDelta ?? '';
  let taskRailContext = options.taskRailContext ?? '';
  let episodicCrossRef = options.episodicCrossRef ?? '';
  let lineageGlyphLog = options.lineageGlyphLog ?? '';
  let resumePoint = options.resumePoint ?? '';
  const legacyLayout = flatCoordinateClosetEnabled();
  let rawTraceCoordinateCloset = legacyLayout
    ? buildRawTraceCoordinateClosetFromMessages(visibleMessages, {
        includeTrailingUserTurn,
        rawTraceCoordinateClosetChars: options.rawTraceCoordinateClosetChars,
      })
    : '';
  let traceNeighborhoods = legacyLayout && options.traceNeighborhoods === undefined
    ? buildLiteralTraceNeighborhoods(visibleTraceMessages, {
        maxChars: options.traceNeighborhoodChars,
        excludeTexts: [
          currentThread,
          lastUserAiMessages,
          activeEditDelta,
        ],
      })
    : options.traceNeighborhoods ?? '';

  if (!legacyLayout) {
    const prepared = prepareVisibleTraceMessages(visibleTraceMessages);
    // The appendix owns its own bounded rendering and exact elision receipt.
    // Passing the full set prevents an earlier fit from hiding coordinates
    // before the appendix can count and name their recovery route.
    const coordinates = collectRawTraceCoordinates(prepared);
    const newestSourceTimestamp = [...prepared].reverse()
      .find((message) => message.sourceTimestamp)?.sourceTimestamp;
    const artifacts: RawTraceCoordinateArtifact[] = [
      { id: 'active-edit-delta', text: activeEditDelta, placementPriority: 1 },
      { id: 'starred-moments', text: starredMoments, placementPriority: 2 },
      { id: 'lineage-glyph-log', text: lineageGlyphLog, placementPriority: 3 },
      { id: 'episodic-cross-ref', text: episodicCrossRef, placementPriority: 4 },
      { id: 'current-thread', text: currentThread, sourceTimestamp: newestSourceTimestamp, placementPriority: 6 },
      { id: 'last-user-ai', text: lastUserAiMessages, sourceTimestamp: newestSourceTimestamp, placementPriority: 7 },
      { id: 'open-questions', text: openQuestions, placementPriority: 8 },
      { id: 'activity-log', text: thinkingTrail, sourceTimestamp: newestSourceTimestamp, placementPriority: 9 },
    ].filter((artifact) => artifact.text.trim().length > 0);
    if (coordinates.length > 0 && artifacts.length > 0) {
      const placed = placeRawTraceCoordinatesInline(coordinates, artifacts, {
        maxAppendixChars: options.rawTraceCoordinateClosetChars
          ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset,
      });
      rawTraceCoordinateCloset = placed.appendix;
      const placedById = new Map(placed.artifacts.map((artifact) => [artifact.id, artifact.text]));
      currentThread = placedById.get('current-thread') ?? currentThread;
      lastUserAiMessages = placedById.get('last-user-ai') ?? lastUserAiMessages;
      activeEditDelta = placedById.get('active-edit-delta') ?? activeEditDelta;
      episodicCrossRef = placedById.get('episodic-cross-ref') ?? episodicCrossRef;
      lineageGlyphLog = placedById.get('lineage-glyph-log') ?? lineageGlyphLog;
      starredMoments = placedById.get('starred-moments') ?? starredMoments;
      openQuestions = placedById.get('open-questions') ?? openQuestions;
      thinkingTrail = placedById.get('activity-log') ?? thinkingTrail;
    }
    traceNeighborhoods = '';
  }
  let continuityReceipt = options.continuityReceipt;
  if (options.lifecycleBoundary === 'same_instance_hard_epoch'
    && !isContinuityReceipt(continuityReceipt)) {
    const trailingStart = trailingUserRunStartIndex(messages);
    const activeRequestMessages = messages.slice(trailingStart)
      .filter((message) => message.role === 'user' && typeof message.content === 'string');
    const activeRequestText = activeRequestMessages
      .map((message) => message.content as string)
      .filter((text) => text.trim().length > 0)
      .join('\n\n') || undefined;
    const activeRequestSourceTimestamp = [...activeRequestMessages].reverse()
      .find((message) => typeof message.tsMs === 'number' && Number.isFinite(message.tsMs))?.tsMs;
    const legacyReceipt = continuityReceiptFromProse({
      boundary: 'same_instance_hard_epoch',
      predecessorName,
      sourceStatus: options.predecessorStatus,
      resumePoint,
      taskRailContext,
      activeEditDelta,
      currentThread,
      lastUserAiMessages,
      activeRequestText,
    });
    const lastSourceTimestampMs = [...messages.slice(0, traceEnd)].reverse()
      .find((message) => typeof message.tsMs === 'number' && Number.isFinite(message.tsMs))?.tsMs;
    continuityReceipt = buildContinuityReceipt({
      boundary: 'same_instance_hard_epoch',
      predecessorName,
      sourceStatus: options.predecessorStatus,
      capturedAt: options.capturedAt ?? 'unknown',
      captureSourceId: `raw-hard-epoch:${predecessorName}:message#${traceEnd}`,
      instance: {
        instanceId: 'unknown',
        instanceName: predecessorName,
        runtimeStatus: options.predecessorStatus ?? 'unknown',
      },
      rail: legacyReceipt.rail,
      nextAction: legacyReceipt.nextAction,
      activeRequestText,
      activeRequestSourceId: 'unknown',
      activeRequestSourceCoordinate: activeRequestText
        ? `message#${trailingStart}..message#${messages.length - 1}`
        : undefined,
      activeRequestSourceTimestamp: activeRequestSourceTimestamp !== undefined
        ? new Date(activeRequestSourceTimestamp).toISOString()
        : undefined,
      claims: legacyReceipt.editClaim.claims,
      editEvidenceFiles: legacyReceipt.editClaim.editEvidenceFiles,
      claimsAreLive: false,
      hasActiveEditDelta: legacyReceipt.editClaim.supplied,
      validationFact: legacyReceipt.validation.fact,
      hazards: legacyReceipt.hazards,
      chatroomMembership: options.chatroomMembership,
      rawTailFrontier: {
        traceId: predecessorName,
        unit: 'message',
        index: traceEnd,
        exactCount: Math.max(0, messages.length - traceEnd),
        ...(lastSourceTimestampMs !== undefined
          ? { sourceTimestamp: new Date(lastSourceTimestampMs).toISOString() }
          : {}),
      },
      extraDisagreements: legacyReceipt.disagreements,
    });
  }
  return renderRawRebirthSeed({
    predecessorName,
    packageBudget: options.packageBudget,
    runtimeModel: options.runtimeModel,
    relayBootTime: options.relayBootTime,
    traceEventCount: options.traceEventCount ?? traceEnd,
    sectionMaxChars: options.sectionMaxChars,
    sectionPriority: options.sectionPriority,
    renderOrder: options.renderOrder,
    sectionToggles: options.sectionToggles,
    lastUserAiMessages,
    currentThread,
    triggeringUserMessage: options.triggeringUserMessage,
    rawTraceCoordinateCloset,
    traceNeighborhoods,
    activeEditDelta,
    taskRailContext,
    continuityReceipt,
    resumePoint,
    workspaceContext: options.workspaceContext,
    episodicCrossRef,
    lineageGlyphLog,
    starredMoments,
    openQuestions,
    thinkingTrail,
    predecessorStatus: options.predecessorStatus,
    lifecycleBoundary: options.lifecycleBoundary,
    userMessageTriggered: options.userMessageTriggered ?? Boolean(options.triggeringUserMessage?.trim()),
    headerOverride: options.headerOverride,
    footerOverride: options.footerOverride,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Band-level micro-seed profile
// ══════════════════════════════════════════════════════════════════════════
// A tail-epoch fold band skeletonizes the freshest window of trace — exactly
// the material that gives the successor direction (what was asked, what was
// in flight, which files were mid-edit). Instead of a bespoke 3-line
// approximation, this profile points the ACTUAL rebirth seed machinery at the
// fold window, producing a compact "you are here" block that rides inside the
// band body alongside the [cognitive] block.
//
// The profile is lean: only trace-derived sections (last-user-AI + current
// thread) survive, all external-state sections (rail, chatroom, squad,
// workspace, episodic, etc.) are disabled since they live outside the fold
// and survive it anyway. The append band target is a TOKEN budget owned by
// contextBudget/runway gates; this renderer remains character-budgeted and
// must not pretend its character safety caps are token accounting.

/**
 * Token target for the append-only tail band geometry (A). Exported here so
 * tests and callers can assert the micro-seed profile is anchored to the real
 * runway constant, not a character-count substitute. The renderer below does
 * not tokenize or estimate; provider/relay measured tokens remain the only
 * source of token telemetry.
 */
export const BAND_MICRO_SEED_TARGET_TOKENS = DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS;

/**
 * Character-only render safety cap for a band-level micro-seed. This is not a
 * token budget and must not be used for pressure/runway math. It only bounds
 * deterministic text rendering inside rawRebirthSeed.ts because this portable
 * module has no provider tokenizer. Set above the 5K-token target so the v2
 * seed is not accidentally squeezed by the old 3K-character mistake; token
 * safety is enforced by measured-token gates around the whole band append.
 */
export const BAND_MICRO_SEED_RENDER_SAFETY_MAX_CHARS = 20_000;

/**
 * Character-only section safety caps for the band profile. Only the two
 * trace-derived narrative sections are enabled; everything else is toggled
 * off. These caps bound deterministic rendering only — they are not token
 * estimates or token telemetry.
 */
export const BAND_MICRO_SEED_SECTION_MAX_CHARS: Partial<Record<RawRebirthSeedSectionId, number>> = {
  lastUserAiMessages: 6_000,
  currentThread: 12_000,
};

/**
 * Section toggles for the band profile. Only lastUserAiMessages and
 * currentThread are enabled; every other section (coordinate closet, edit
 * delta, rail, episodic, glyph log, open questions, atlas, workspace,
 * starred moments, thinking trail, changelog arc, chatroom, delegated work,
 * coordination state, squad thoughts) is suppressed because those live
 * outside the fold and survive the epoch intact.
 */
export const BAND_MICRO_SEED_SECTION_TOGGLES: Partial<Record<RawRebirthSeedSectionId | 'runtimeModel' | 'rebirthHistory', boolean>> = {
  lastUserAiMessages: true,
  currentThread: true,
  rawTraceCoordinateCloset: false,
  traceNeighborhoods: false,
  activeEditDelta: false,
  taskRailContext: false,
  episodicCrossRef: false,
  lineageGlyphLog: false,
  openQuestions: false,
  atlasCrossRef: false,
  workspaceContext: false,
  starredMoments: false,
  thinkingTrail: false,
  lifetimeChangelogArc: false,
  chatroomMembership: false,
  delegatedWork: false,
  coordinationState: false,
  squadThoughts: false,
  runtimeModel: false,
};

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
export function buildMicroSeedFromMessages(
  messages: readonly FoldMessage[],
  options: RawRebirthSeedFromMessagesOptions = {},
): string {
  if (!messages || messages.length === 0) return '';
  if (!hasMicroSeedTrajectory(messages)) return '';
  return buildRawRebirthSeedFromMessages(messages, {
    ...options,
    packageBudget: options.packageBudget ?? BAND_MICRO_SEED_RENDER_SAFETY_MAX_CHARS,
    sectionMaxChars: { ...BAND_MICRO_SEED_SECTION_MAX_CHARS, ...options.sectionMaxChars },
    sectionToggles: { ...BAND_MICRO_SEED_SECTION_TOGGLES, ...options.sectionToggles },
    currentThreadMessageLimit: options.currentThreadMessageLimit ?? 6,
    currentThreadMessageChars: options.currentThreadMessageChars ?? 400,
    headerOverride: options.headerOverride ?? BAND_MICRO_SEED_HEADER,
    footerOverride: options.footerOverride ?? '',
  });
}

/** Band-level framing header (replaces [CONTEXT REBIRTH] for micro-seeds). */
const BAND_MICRO_SEED_HEADER = '[micro-seed] Fold-window continuation — the trace below was skeletonized into this band; use it to recover direction (what was asked, what was in flight, which files were touched).';
