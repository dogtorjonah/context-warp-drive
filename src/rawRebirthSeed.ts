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
  isConservedIn,
  isClosetNoiseLiteral,
  isUnlabeledOpaqueClosetLiteral,
  nominateVerbatim,
  type FoldMessage,
} from './rollingFold.ts';
import { classifyMessageGlyph } from './foldEpisodes.ts';
import { DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS } from './contextBudget.ts';
import { renderContinuityPackageProvenance } from './chronologicalProvenance.ts';
import {
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
  readonly currentThreadMessageLimit?: number;
  readonly currentThreadMessageChars?: number;
  readonly activityMessageChars?: number;
  readonly runtimeModel?: RawRebirthRuntimeModelContext;
  readonly relayBootTime?: string;
  readonly traceEventCount?: number;
  readonly workspaceContext?: RawRebirthWorkspaceContext | string;
  readonly activeEditDelta?: string;
  readonly taskRailContext?: string;
  /** Typed continuity receipt — see RawRebirthSeedInput.continuityReceipt. */
  readonly continuityReceipt?: ContinuityReceipt;
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

function allocateSectionBlocks(
  sections: readonly BudgetedPromptSection[],
  availableChars: number,
): Map<RawRebirthSeedSectionId, string> {
  const allocations = new Map<RawRebirthSeedSectionId, string>();
  let remainingChars = Math.max(0, availableChars);

  for (const section of [...sections].sort((a, b) => a.priority - b.priority)) {
    if (!section.block.trim() || remainingChars <= 0) continue;
    const limit = Math.min(section.maxChars, remainingChars);
    if (limit < 48) continue;
    // The Coordinate Closet is a list of exact literals (paths/ids/values);
    // a mid-line cut corrupts the very identifier the closet exists to
    // conserve, so it truncates at whole-line boundaries. Other sections are
    // prose/log blocks where a mid-line char cut is acceptable.
    const rendered = section.key === 'rawTraceCoordinateCloset'
      ? truncateWholeLines(section.block, limit)
      : truncate(section.block, limit);
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
    '🌱 Fresh-fork provenance — the lifecycle identity contract is authoritative in Rebirth Control above.',
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

/**
 * Control-capsule active-request cap. Matches the relay's last_user_active
 * surface budget (6000 chars) so the portable seed preserves the same
 * operator requests byte-complete; the old 1500-char cap silently excerpted
 * mid-length requests while the label still claimed 'verbatim'.
 */
const CONTROL_ACTIVE_REQUEST_MAX_CHARS = 6_000;

function renderUserMessageForRebirth(
  text: string,
  options: { preserveBoundaryWhitespace?: boolean } = {},
): string {
  const normalized = options.preserveBoundaryWhitespace ? text : text.trim();
  if (!normalized.trim()) return '';
  return truncateMiddle(normalized, CONTROL_ACTIVE_REQUEST_MAX_CHARS);
}

/**
 * AI-only remainder of the combined Last User + AI block. When a bundled
 * trigger renders the user's message as the control capsule's authoritative
 * active request, re-rendering the combined block would duplicate it — but
 * dropping the whole block loses the freshest AI message, which can be the
 * ONLY copy of the predecessor's last words when Current Thread is empty.
 * Splits on the builder's optional `[timestamp] 🤖 LAST AI MESSAGE` line marker
 * and keeps everything from that line onward; returns '' when no AI half exists.
 */
function extractLastAiOnlyBlock(lastUserAiMessages: string | null | undefined): string {
  const text = lastUserAiMessages?.trim();
  if (!text) return '';
  const markers = [...text.matchAll(/^(?:\[[^\n\]]*\]\s*)?🤖 LAST AI MESSAGE(?:\s+⟦m\d+⟧)?:\s*$/gmu)];
  const errorMarkers = [...text.matchAll(/^(?:\[[^\n\]]*\]\s*)?⚠️ UNRESOLVED PROVIDER\/RUNTIME ERROR(?:\s+⟦m\d+⟧)?\s+\(not assistant speech\):\s*$/gmu)];
  const marker = markers.at(-1) ?? errorMarkers.at(-1);
  if (!marker) return '';
  return text.slice(marker.index).trim();
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
  if (boundary === 'same_instance_hard_epoch') {
    return `[CONTEXT REBIRTH] Lifecycle boundary: same_instance_hard_epoch for "${input.predecessorName}". Follow the authoritative Rebirth Control below. Continue silently; do not produce wake-up commentary.`;
  }
  if (boundary === 'fresh_fork') {
    return `[CONTEXT REBIRTH] Lifecycle boundary: fresh_fork from "${input.predecessorName}". Follow the authoritative Rebirth Control below.`;
  }
  if (boundary === 'resurrection') {
    return `[CONTEXT REBIRTH] Lifecycle boundary: resurrection for "${input.predecessorName}". Follow the authoritative Rebirth Control below.`;
  }
  if (boundary === 'brain_merge') {
    return `[CONTEXT REBIRTH] Lifecycle boundary: brain_merge for "${input.predecessorName}". Follow the authoritative Rebirth Control below.`;
  }
  return `[CONTEXT REBIRTH] Lifecycle boundary: continuation for "${input.predecessorName}". Follow the authoritative Rebirth Control below.`;
}

/**
 * Control-capsule active request with an honest label. Cap matches the
 * relay's last_user_active surface (6000 chars) so operator requests survive
 * byte-complete far past the old 1500-char cap. 'verbatim' appears ONLY when
 * the rendered body is byte-identical to the full request; an excerpt is
 * labeled as such with the true size and a tap pointer.
 */
function formatControlActiveRequest(activeRequest: string): string {
  const rendered = renderUserMessageForRebirth(activeRequest, {
    preserveBoundaryWhitespace: true,
  });
  if (rendered === activeRequest) {
    return `active request (verbatim; sole authoritative body):\n${rendered}`;
  }
  return `active request (EXCERPT — ${activeRequest.length} chars total, middle elided; full text via tap_instance_messages; sole authoritative body):\n${rendered}`;
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
  return renderContinuityReceiptControl(receipt, { formatActiveRequest: formatControlActiveRequest });
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
  const chronology = renderContinuityPackageProvenance({
    artifact: customHeader
      ? 'continuity-package#custom'
      : `rebirth-package#${lifecycleBoundary}`,
    traceId: input.predecessorName,
    sourceEventCount: input.traceEventCount,
    rawTailCount: input.userMessageTriggered === true && Boolean(input.triggeringUserMessage?.trim()) ? 1 : 0,
  }) ?? '';
  const headerBlocks = [
    customHeader ?? defaultHeader,
    chronology,
    customHeader ? '' : formatRebirthControl(input, lifecycleBoundary),
    formatMergedLineageProvenance(input),
    formatDurableMergedLineageBanner(input),
    formatSummonVaultLedger(input),
    formatForkContextBlock(input.forkContext),
    runtimeBlock,
  ].filter(Boolean);

  const budgetedSections: BudgetedPromptSection[] = [];
  pushSection(
    budgetedSections,
    input,
    'lastUserAiMessages',
    (() => {
      const combined = input.lastUserAiMessages?.trim();
      // append Resume Point to Last User + AI block.
      const resumeSuffix = input.resumePoint?.trim() ? `\n\n${input.resumePoint.trim()}` : '';
      if (combined && !input.triggeringUserMessage?.trim()) {
        return `\n── Last User + AI Messages (READ FIRST) ──\n***READ THIS FIRST. These are the freshest human and AI messages available at rebirth.***\n\n${combined}${resumeSuffix}`;
      }
      // Bundled trigger: keep only the AI half — the user half is the control
      // capsule's authoritative active request, and the AI half can be the
      // sole copy of the freshest assistant state when Current Thread is empty.
      const aiOnly = combined ? extractLastAiOnlyBlock(combined) : '';
      if (aiOnly) {
        const errorOnly = aiOnly.includes('⚠️ UNRESOLVED PROVIDER/RUNTIME ERROR')
          && !aiOnly.includes('🤖 LAST AI MESSAGE');
        return errorOnly
          ? `\n── Unresolved Provider/Runtime Error (READ FIRST) ──\n***READ THIS FIRST. No genuine assistant remainder followed the active request; this provider/runtime failure was unresolved at the package boundary.***\n\n${aiOnly}${resumeSuffix}`
          : `\n── Last AI Message (READ FIRST) ──\n***READ THIS FIRST. This is the freshest AI message available at rebirth; the freshest user message is the active request in Rebirth Control.***\n\n${aiOnly}${resumeSuffix}`;
      }
      return input.resumePoint?.trim() ? `\n${input.resumePoint.trim()}` : undefined;
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
      ? `\n── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──\n${input.rawTraceCoordinateCloset.trim()}`
      : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'traceNeighborhoods',
    input.traceNeighborhoods?.trim()
      ? `\n── Trace Neighborhoods (deterministic literal cross-reference; source excerpts, not LLM summaries) ──\n${input.traceNeighborhoods.trim()}`
      : undefined,
  );
  pushSection(budgetedSections, input, 'activeEditDelta', input.activeEditDelta ? `\n── Active Edit Delta ──\n${input.activeEditDelta}` : undefined);
  pushSection(
    budgetedSections,
    input,
    'taskRailContext',
    input.taskRailContext?.trim() ? `\n── Task Rail Context (process truth) ──\n${input.taskRailContext.trim()}` : undefined,
  );
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
  pushSection(
    budgetedSections,
    input,
    'chatroomMembership',
    input.chatroomMembership ? `\n── Chatroom Membership (rooms only; not squad membership) ──\n${input.chatroomMembership}` : undefined,
  );
  const delegatedBody = formatDelegatedWorkSection(input.delegatedWork);
  pushSection(budgetedSections, input, 'delegatedWork', delegatedBody ? `\n── Delegated Work ──\n${delegatedBody}` : undefined);
  pushSection(
    budgetedSections,
    input,
    'coordinationState',
    input.coordinationState ? `\n── Coordination State ──\n${input.coordinationState}` : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'squadThoughts',
    input.squadThoughts ? `\n── Squad Awareness ──\n${input.squadThoughts}` : undefined,
  );

  const footer = input.footerOverride !== undefined
    ? input.footerOverride
    : input.userMessageTriggered === true
      ? 'The active user message appears once in Rebirth Control as the authoritative request body — respond to it directly.'
      : input.predecessorStatus === 'idle'
        ? 'Predecessor was idle with no active task — default to waiting for the next request; do not invent work or re-investigate the codebase from scratch. But if Last User + AI Messages or Current Thread shows a user request that was never answered or was cut off mid-work, treat that as your active task and engage with it directly rather than sitting idle.'
        : 'Resume the active task. The Activity Log + Active Edit Delta are your primary context. Evaluate predecessor work on its merits before diverging — if the approach is flawed, refactor it rather than discarding (see Core Principle 15). Continue using atlas_query as your primary codebase investigation tool — the File Context above is a handoff snapshot, not a substitute for live Atlas queries when exploring new files or verifying current state. Self-tap only if the package is insufficient or contradictory.';
  const footerBlock = footer ? `\n── Orientation ──\n${footer}` : '';
  const fixedOverhead = headerBlocks.join('\n').length + footerBlock.length;
  const allocatedBlocks = allocateSectionBlocks(budgetedSections, packageBudget - fixedOverhead);
  const renderOrder = input.renderOrder ?? DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER;
  const promptBlocks = [
    ...headerBlocks,
    ...renderOrder.map((key) => allocatedBlocks.get(key)).filter((block): block is string => Boolean(block)),
    footerBlock,
  ];
  return truncate(promptBlocks.join('\n'), packageBudget);
}

interface PreparedTraceMessage {
  readonly sourceIndex: number;
  readonly role: string;
  readonly text: string;
  readonly sourceText: string;
}

interface RawTraceCoordinate {
  readonly literal: string;
  readonly labelled: string;
  readonly index: number;
  readonly sourceIndex: number | null;
  readonly sourceRole: string | null;
}

interface FittedRawTraceCoordinates {
  readonly coordinates: RawTraceCoordinate[];
  readonly lines: string[];
  readonly elided: number;
}

function rawTraceCoordinateOrigin(coordinate: RawTraceCoordinate): string {
  return coordinate.sourceIndex === null
    ? 'source=unknown'
    : `source=${coordinate.sourceRole ?? 'unknown-role'} message ${coordinate.sourceIndex + 1}`;
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
    let tail = `- …${elided} more coordinates elided — recover via fold recall or self-tap`;
    while (fitted.length > 1 && usedChars + countStringChars(tail) + 1 > maxChars) {
      const removed = fitted.pop();
      if (removed) {
        usedChars -= countStringChars(removed.line) + 1;
        elided += 1;
        tail = `- …${elided} more coordinates elided — recover via fold recall or self-tap`;
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
    return [{ sourceIndex, role, text: bounded, sourceText: `${role}:\n${bounded}` }];
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

  return admitted.flatMap((literal): RawTraceCoordinate[] => {
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
    }];
  });
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
    fittedLines.push(`- …${fitted.elided} more coordinates elided — recover via fold recall or self-tap`);
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

  const header = 'Deterministic exact-match neighborhoods around Coordinate Closet literals; source excerpts are whitespace-compacted, never LLM-summarized.';
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
  const start = Math.max(0, traceEnd - messageLimit);
  const parts: string[] = [];
  for (let i = start; i < traceEnd; i += 1) {
    if (excludedMessageIndexes.has(i)) continue;
    const message = messages[i];
    if (!message) continue;
    const body = truncateMiddle(providerMessageToTraceText(message), perMessageChars);
    parts.push(`[message ${i}] ${messageLabel(message)}:\n${body}`);
  }
  return parts.join('\n\n');
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
  if (trimmed.includes('[CONTEXT REBIRTH]')) return false;
  if (trimmed.includes(CHRONOLOGICAL_PROVENANCE_PREFIX)) return false;
  if (/^@\w+/.test(trimmed) && trimmed.length < 200) return false;
  if (trimmed.startsWith('[DIGEST DELTA') || trimmed.startsWith('[Digest Delta')) return false;
  if (trimmed.startsWith('[Control Signals]') || trimmed.startsWith('[System]')) return false;
  // Strip known ephemeral coordination markers
  const stripped = trimmed
    .replace(/\[DIGEST DELTA[^\]]*\][\s\S]*?\[END DIGEST DELTA\]/g, '')
    .replace(/\[Control Signals\][\s\S]*?\[\/Control Signals\]/g, '')
    .trim();
  if (stripped.length === 0) return false;
  return true;
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
): string {
  let lastUser = '';
  let lastUserIndex = -1;
  // glyph-aware ranking for AI messages.
  // Collect all assistant messages, score by glyph weight, pick the best.
  let bestAssistant = '';
  let bestAssistantWeight = 0;
  let bestAssistantIndex = -1;
  for (let i = 0; i < traceEnd; i++) {
    if (excludedMessageIndexes.has(i)) continue;
    const message = messages[i];
    if (!message) continue;
    // Genuine-operator filter: skip chatroom deliveries, mention pings,
    // digest deltas, and ephemeral-only turns. The newest genuine operator
    // message wins (iterate forward, overwrite — latest by index wins).
    if (message.role === 'user') {
      if (isPortableGenuineOperatorMessage(messageContentAndPartsToText(message))) {
        lastUser = providerMessageToTraceText(message);
        lastUserIndex = i;
      }
    }
    if (message.role === 'assistant' || message.role === 'model') {
      const text = providerMessageToTraceText(message);
      if (text) {
        const glyph = classifyMessageGlyph(text);
        const weight = glyph === 'verdict' ? 10
          : glyph === 'hazard' ? 8
          : glyph === 'blocked' ? 6
          : glyph === 'working' ? 2
          : 1;
        // Prefer higher weight; on tie, prefer more recent (higher index)
        if (weight > bestAssistantWeight || (weight === bestAssistantWeight && i > bestAssistantIndex)) {
          bestAssistant = text;
          bestAssistantWeight = weight;
          bestAssistantIndex = i;
        }
      }
    }
  }
  // Citation refs tie these highlight blocks to the same message's existing
  // [message N] row label in Current Thread / the Activity Log — the raw trace
  // index is the shared coordinate space, so no new numbering is introduced.
  // Flag-off (or index unknown) renders the historical marker-free output.
  const markersEnabled = typeof process !== 'undefined' && process.env?.VOXXO_REBIRTH_SEED_MSG_MARKERS !== '0';
  const userMarker = markersEnabled && lastUserIndex >= 0 ? ` [message ${lastUserIndex}]` : '';
  const aiMarker = markersEnabled && bestAssistantIndex >= 0 ? ` [message ${bestAssistantIndex}]` : '';
  const threadPointer = aiMarker
    ? `[Full text appears below in Current Thread at${aiMarker}.]`
    : '[Full text appears below in Current Thread.]';
  const renderedAssistant = bestAssistant
    ? bestAssistant.length > 360
      ? `${truncate(bestAssistant, 360)}\n${threadPointer}`
      : bestAssistant
    : '';
  return [
    lastUser ? `👤 LAST USER MESSAGE${userMarker}:\n${truncateMiddle(lastUser, 6_000)}` : '',
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
  const includeTrailingUserTurn = options.includeTrailingUserTurn !== false;
  const traceEnd = findRawRebirthSeedTraceEnd(messages, includeTrailingUserTurn);
  const excluded = excludedTrailingStringUserIndexes(messages, includeTrailingUserTurn);
  const currentThread = buildCurrentThreadFromMessages(
    messages,
    traceEnd,
    Math.max(1, Math.floor(options.currentThreadMessageLimit ?? 30)),
    Math.max(200, Math.floor(options.currentThreadMessageChars ?? 1_600)),
    excluded,
  );
  const lastUserAiMessages = buildLastUserAiMessagesFromMessages(messages, traceEnd, excluded);
  const visibleTraceMessages = visibleTraceMessagesFromFoldMessages(messages, includeTrailingUserTurn);
  const rawTraceCoordinateCloset = buildRawTraceCoordinateClosetFromMessages(messages, {
    includeTrailingUserTurn,
    rawTraceCoordinateClosetChars: options.rawTraceCoordinateClosetChars,
  });
  const traceNeighborhoods = options.traceNeighborhoods === undefined
    ? buildLiteralTraceNeighborhoods(visibleTraceMessages, {
        maxChars: options.traceNeighborhoodChars,
        excludeTexts: [
          currentThread,
          lastUserAiMessages,
          options.activeEditDelta ?? '',
          options.taskRailContext ?? '',
        ],
      })
    : options.traceNeighborhoods;
  return renderRawRebirthSeed({
    predecessorName: options.predecessorName ?? 'predecessor',
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
    rawTraceCoordinateCloset,
    traceNeighborhoods,
    activeEditDelta: options.activeEditDelta,
    taskRailContext: options.taskRailContext,
    continuityReceipt: options.continuityReceipt,
    resumePoint: options.resumePoint,
    workspaceContext: options.workspaceContext,
    episodicCrossRef: options.episodicCrossRef,
    lineageGlyphLog: options.lineageGlyphLog,
    starredMoments: options.starredMoments === undefined
      ? buildStarredMomentsFromMessages(
          messages,
          options.sectionMaxChars?.starredMoments
            ?? DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.starredMoments,
        )
      : options.starredMoments,
    openQuestions: options.openQuestions ?? buildOpenQuestionsFromMessages(messages),
    thinkingTrail: buildActivityLogFromMessages(
      messages,
      traceEnd,
      Math.max(200, Math.floor(options.activityMessageChars ?? 1_000)),
      excluded,
    ),
    predecessorStatus: options.predecessorStatus,
    lifecycleBoundary: options.lifecycleBoundary,
    userMessageTriggered: options.userMessageTriggered,
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
