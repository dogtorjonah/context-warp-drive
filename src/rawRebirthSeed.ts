/**
 * Raw rebirth seed renderer.
 *
 * This is the portable, deterministic version of the relay raw-rebirth prompt
 * renderer: callers provide trace-normalized section strings, and this module
 * applies the same default section budgets, priority order, headings, and
 * orientation footer. It performs no I/O and does not gather relay-only memory.
 */
import {
  extractVerbatimContextLabel,
  isConservedIn,
  nominateVerbatim,
  type FoldMessage,
} from './rollingFold.ts';
import { classifyMessageGlyph } from './foldEpisodes.ts';

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

export type RawRebirthSeedSectionId =
  | 'lastUserAiMessages'
  | 'currentThread'
  | 'rawTraceCoordinateCloset'
  | 'activeEditDelta'
  | 'taskRailContext'
  | 'episodicCrossRef'
  | 'lineageGlyphLog'
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
  readonly mergedFromLineages?: readonly RawRebirthMergedLineage[];
  readonly durableMergedLineage?: readonly RawRebirthDurableMergedLineage[];
  readonly summonVault?: readonly RawRebirthSummonVaultEntry[];

  readonly lastUserAiMessages?: string;
  readonly currentThread?: string;
  readonly triggeringUserMessage?: string;
  readonly rawTraceCoordinateCloset?: string;
  readonly activeEditDelta?: string;
  readonly taskRailContext?: string;
  readonly episodicCrossRef?: string;
  readonly lineageGlyphLog?: string;
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
}

export interface RawRebirthSeedFromMessagesOptions {
  readonly predecessorName?: string;
  readonly packageBudget?: number;
  readonly sectionMaxChars?: Partial<Record<RawRebirthSeedSectionId, number>>;
  readonly rawTraceCoordinateClosetChars?: number;
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
  readonly predecessorStatus?: string;
  readonly userMessageTriggered?: boolean;
  /** Trace-derived episodic recall text (portable-mode memory section). */
  readonly episodicCrossRef?: string;
  /** Lineage glyph log text — chronological verdict/hazard register trail (portable-mode memory section). */
  readonly lineageGlyphLog?: string;
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
  activeEditDelta: 50_000,
  taskRailContext: 12_000,
  episodicCrossRef: 12_000,
  lineageGlyphLog: 4_000,
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
  rawTraceCoordinateCloset: 2,
  activeEditDelta: 3,
  taskRailContext: 4,
  episodicCrossRef: 5,
  lineageGlyphLog: 6,
  atlasCrossRef: 7,
  workspaceContext: 8,
  starredMoments: 10,
  thinkingTrail: 11,
  lifetimeChangelogArc: 12,
  chatroomMembership: 13,
  coordinationState: 14,
  squadThoughts: 15,
  delegatedWork: 16,
};

export const DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER: readonly RawRebirthSeedSectionId[] = [
  'lastUserAiMessages',
  'currentThread',
  'rawTraceCoordinateCloset',
  'activeEditDelta',
  'taskRailContext',
  'episodicCrossRef',
  'lineageGlyphLog',
  'atlasCrossRef',
  'workspaceContext',
  'starredMoments',
  'thinkingTrail',
  'lifetimeChangelogArc',
  'chatroomMembership',
  'delegatedWork',
  'coordinationState',
  'squadThoughts',
];

const PATH_MENTION_RE = /\b(?:[\w.-]+\/)+[\w./@+-]+\b/g;
const RAW_TRACE_CLOSET_USER_BUDGET_RATIO = 0.25;
const RAW_TRACE_CLOSET_MAX_SOURCE_CHARS_PER_MESSAGE = 24_000;
const RAW_TRACE_CLOSET_ID_MENTION_RE =
  /\b(?:toolu[-_][A-Za-z0-9_.:-]{1,}|(?:rail|sig|msg|inst|task|thread|summon|fork|group|epoch|tool|call)[-_][A-Za-z0-9][A-Za-z0-9_.:-]{5,})\b/g;

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
    const rendered = truncate(section.block, limit);
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
    '🌱 YOU ARE A FORK — not the original instance.',
    'Your transcript was copied from the source at the fork point. Everything before this is inherited reference context, not your own actions. Your work diverges from here.',
    '',
    'Important: You have your own instance id, your own file claims, and your own edits. The source may still be live and working in parallel. Coordinate via chatroom if needed — do not assume you share the source\'s squad or claims.',
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
  lines.push('Treat inherited pre-fork context as reference. Claim files before editing. Move forward with your own divergent work.');
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
    const essence = entry.essence?.trim();
    const head = `  ⊕ ${entry.instanceName} (${entry.instanceId}${sourceTag})`;
    const capsuleLine = essence ? `${head} — ${essence}` : head;
    const thread = entry.recentThread?.trim();
    return thread
      ? `${capsuleLine}\n    Recent reasoning (last messages before absorption):\n${thread.split('\n').map((line) => `      ${line}`).join('\n')}`
      : capsuleLine;
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

function renderUserMessageForRebirth(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return truncateMiddle(trimmed, 1_500);
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

export function renderRawRebirthSeed(input: RawRebirthSeedInput): string {
  const packageBudget = finitePositive(input.packageBudget, DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS);
  const runtimeBlock = input.runtimeModelBlock?.trim()
    ? input.runtimeModelBlock
    : enabled(input, 'runtimeModel')
      ? formatRuntimeModelBlock(input.runtimeModel, input.relayBootTime, input.traceEventCount)
      : '';
  const headerBlocks = [
    `[CONTEXT REBIRTH] You are the continuation of "${input.predecessorName}". Same identity, coordination context, tools — pick up where it left off. Read Last User + AI Messages first, then Current Thread; Active Edit Delta is authoritative for in-flight files.`,
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
    input.lastUserAiMessages?.trim()
      ? `\n── Last User + AI Messages (READ FIRST) ──\n***READ THIS FIRST. These are the freshest human and AI messages available at rebirth.***\n\n${input.lastUserAiMessages.trim()}`
      : undefined,
  );

  const currentThreadBlocks = [
    input.currentThread?.trim() ?? '',
    input.triggeringUserMessage?.trim()
      ? `👤 USER (active request):\n${renderUserMessageForRebirth(input.triggeringUserMessage)}`
      : '',
  ].filter(Boolean);
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
  pushSection(budgetedSections, input, 'activeEditDelta', input.activeEditDelta ? `\n── Active Edit Delta ──\n${input.activeEditDelta}` : undefined);
  pushSection(
    budgetedSections,
    input,
    'taskRailContext',
    input.taskRailContext?.trim() ? `\n── Task Rail Context (process truth) ──\n${input.taskRailContext.trim()}` : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'episodicCrossRef',
    input.episodicCrossRef?.trim()
      ? `\n── Episodic Cross-Reference (trace-derived recall — matched on your active paths + recent-trace terms) ──\n${input.episodicCrossRef.trim()}`
      : undefined,
  );
  pushSection(
    budgetedSections,
    input,
    'lineageGlyphLog',
    input.lineageGlyphLog?.trim()
      ? `\n── Lineage Glyph Log (chronological verdicts + hazards from your own glyph trail) ──\n${input.lineageGlyphLog.trim()}`
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

  const footer = input.userMessageTriggered === true
    ? 'The active user message is included in Last User + AI Messages and Current Thread — respond to it directly. Engage with its actual content; do not reduce a substantive message to a generic prompt.'
    : input.predecessorStatus === 'idle'
      ? 'Predecessor was idle with no active task — default to waiting for the next request; do not invent work or re-investigate the codebase from scratch. But if Last User + AI Messages or Current Thread shows a user request that was never answered or was cut off mid-work, treat that as your active task and engage with it directly rather than sitting idle.'
      : 'Resume the active task. The Activity Log + Active Edit Delta are your primary context. Evaluate predecessor work on its merits before diverging — if the approach is flawed, refactor it rather than discarding (see Core Principle 15). Continue using atlas_query as your primary codebase investigation tool — the File Context above is a handoff snapshot, not a substitute for live Atlas queries when exploring new files or verifying current state. Self-tap only if the package is insufficient or contradictory.';
  const footerBlock = `\n── Orientation ──\n${footer}`;
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

export function buildRawTraceCoordinateCloset(
  visibleMessages: readonly VisibleTraceMessage[],
  maxChars = DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset,
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  const sourceTexts = visibleMessages.flatMap((message) => {
    const text = message.text?.trim();
    if (!text) return [];
    const role = message.type === 'user' ? 'user' : message.type === 'assistant_text' ? 'assistant' : message.type;
    const bounded = text.length > RAW_TRACE_CLOSET_MAX_SOURCE_CHARS_PER_MESSAGE
      ? `${text.slice(0, RAW_TRACE_CLOSET_MAX_SOURCE_CHARS_PER_MESSAGE)}\n... [message source truncated for closet nomination]`
      : text;
    return [`${role}:\n${bounded}`];
  });
  if (sourceTexts.length === 0) return '';

  const fullText = sourceTexts.join('\n\n');
  const nominationBudget = Math.max(0, Math.floor(maxChars * RAW_TRACE_CLOSET_USER_BUDGET_RATIO));
  const candidates = [
    ...nominateVerbatim(fullText, nominationBudget).map((literal) => ({
      literal,
      index: Math.max(0, fullText.lastIndexOf(literal)),
    })),
    ...Array.from(fullText.matchAll(PATH_MENTION_RE), (match) => {
      const index = match.index ?? 0;
      const hasLeadingSlash = index > 0 && fullText[index - 1] === '/';
      return {
        literal: hasLeadingSlash ? `/${match[0]}` : match[0],
        index: hasLeadingSlash ? index - 1 : index,
      };
    }),
    ...Array.from(fullText.matchAll(RAW_TRACE_CLOSET_ID_MENTION_RE), (match) => ({
      literal: match[0],
      index: match.index ?? 0,
    })),
  ].sort((left, right) => right.index - left.index);

  const header = 'Conserved high-value literals nominated newest-first from the predecessor trace; use these as exact ids/paths/values when the raw package body omits the middle.';
  const lines: string[] = [];
  let usedChars = countStringChars(header);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const literal = candidate.literal.trim();
    const seenKey = literal.startsWith('/') ? literal.slice(1) : literal;
    if (!literal || seen.has(seenKey)) continue;
    const closetSoFar = lines.join('\n');
    if (closetSoFar && isConservedIn(closetSoFar, literal)) continue;
    const label = extractVerbatimContextLabel(fullText, literal);
    const line = label ? `- ${literal} (${label})` : `- ${literal}`;
    const nextChars = usedChars + countStringChars(line) + 1;
    if (nextChars > maxChars) break;
    seen.add(seenKey);
    lines.push(line);
    usedChars = nextChars;
  }

  if (lines.length === 0) return '';
  return [header, ...lines].join('\n');
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

function providerMessageToTraceText(message: FoldMessage | undefined): string {
  if (!message) return '';
  const lines = [`role:${message.role}`];
  const content = messageValueToText(message.content);
  if (content) lines.push(`content:\n${content}`);
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

function buildLastUserAiMessagesFromMessages(
  messages: readonly FoldMessage[],
  traceEnd: number,
  excludedMessageIndexes: ReadonlySet<number>,
): string {
  let lastUser = '';
  let lastAssistant = '';
  for (let i = traceEnd - 1; i >= 0 && (!lastUser || !lastAssistant); i -= 1) {
    if (excludedMessageIndexes.has(i)) continue;
    const message = messages[i];
    if (!message) continue;
    if (!lastUser && message.role === 'user') lastUser = providerMessageToTraceText(message);
    if (!lastAssistant && (message.role === 'assistant' || message.role === 'model')) {
      lastAssistant = providerMessageToTraceText(message);
    }
  }
  const renderedAssistant = lastAssistant
    ? lastAssistant.length > 360
      ? `${truncate(lastAssistant, 360)}\n[Full text appears below in Current Thread.]`
      : lastAssistant
    : '';
  return [
    lastUser ? `👤 LAST USER MESSAGE:\n${truncateMiddle(lastUser, 6_000)}` : '',
    renderedAssistant ? `🤖 LAST AI MESSAGE:\n${renderedAssistant}` : '',
  ].filter(Boolean).join('\n\n');
}

export function buildRawTraceCoordinateClosetFromMessages(
  messages: readonly FoldMessage[],
  options: Pick<RawRebirthSeedFromMessagesOptions, 'includeTrailingUserTurn' | 'rawTraceCoordinateClosetChars'> = {},
): string {
  const includeTrailingUserTurn = options.includeTrailingUserTurn !== false;
  const traceEnd = findRawRebirthSeedTraceEnd(messages, includeTrailingUserTurn);
  const excluded = excludedTrailingStringUserIndexes(messages, includeTrailingUserTurn);
  const visible = messages.slice(0, traceEnd).flatMap((message, offset): VisibleTraceMessage[] => {
    if (excluded.has(offset)) return [];
    return [{
      type: message.role === 'assistant' ? 'assistant_text' : message.role,
      text: providerMessageToTraceText(message),
    }];
  });
  return buildRawTraceCoordinateCloset(
    visible,
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
  const rawTraceCoordinateCloset = buildRawTraceCoordinateClosetFromMessages(messages, {
    includeTrailingUserTurn,
    rawTraceCoordinateClosetChars: options.rawTraceCoordinateClosetChars,
  });
  return renderRawRebirthSeed({
    predecessorName: options.predecessorName ?? 'predecessor',
    packageBudget: options.packageBudget,
    runtimeModel: options.runtimeModel,
    relayBootTime: options.relayBootTime,
    traceEventCount: options.traceEventCount ?? traceEnd,
    sectionMaxChars: options.sectionMaxChars,
    lastUserAiMessages: buildLastUserAiMessagesFromMessages(messages, traceEnd, excluded),
    currentThread,
    rawTraceCoordinateCloset,
    activeEditDelta: options.activeEditDelta,
    taskRailContext: options.taskRailContext,
    workspaceContext: options.workspaceContext,
    episodicCrossRef: options.episodicCrossRef,
    lineageGlyphLog: options.lineageGlyphLog,
    thinkingTrail: buildActivityLogFromMessages(
      messages,
      traceEnd,
      Math.max(200, Math.floor(options.activityMessageChars ?? 1_000)),
      excluded,
    ),
    predecessorStatus: options.predecessorStatus,
    userMessageTriggered: options.userMessageTriggered,
  });
}
