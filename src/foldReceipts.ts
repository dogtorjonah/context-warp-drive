/**
 * foldReceipts.ts — receipt-synthesis compiler for artifact-only folding
 * (VOXXO_FOLD_ARTIFACT_ONLY).
 *
 * The chronological skeleton's irreplaceable job is being the fallback record
 * for events the agent never narrated: edits, writes, bash outcomes, test
 * runs, typechecks, errors, rail ACKs, Atlas commits, spawns, chatroom posts.
 * An extractive artifact compiler (cognitiveArtifacts.ts) finds nothing in a
 * silent grinder window. This module closes that gap: every mutation/outcome
 * tool call in the fold window promotes itself to a typed one-line receipt
 * regardless of narration; read/search/navigation calls collapse into
 * aggregated investigation artifacts; bookkeeping drops with a count.
 *
 * Totality is auditable by arithmetic: the per-class counts in
 * {@link FoldReceiptCounts} sum to the number of extracted tool calls, so a
 * compiler that silently drops an event class is visibly broken in the
 * rendered header. Provenance follows God Rule 8: every receipt carries the
 * window message index of its outcome and the source timestamp when the
 * window provides one (`FoldMessage.tsMs`); missing source time renders as
 * explicit unknown, never fold time.
 *
 * Pure functions, zero I/O, byte-identical output for identical input (the
 * provider-cache invariant).
 */

import {
  beltVerbatim,
  extractPath,
  extractToolCalls,
  formatFoldTime,
  isMutatingBash,
  skeletonizeTool,
  type ExtractedToolCall,
  type FoldConfig,
  type FoldMessage,
} from './rollingFold.ts';
import {
  extractCognitiveArtifacts,
  renderCognitiveBlock,
} from './cognitiveArtifacts.ts';
import {
  renderEmbeddedContinuityArtifactProvenance,
} from './chronologicalProvenance.ts';

// ══════════════════════════════════════════════════════════════════════
// Relay-wide artifact-mode flag (VOXXO_FOLD_ARTIFACT_ONLY)
// ══════════════════════════════════════════════════════════════════════

/**
 * Relay-wide artifact-only fold switch. Default OFF (legacy skeleton folding
 * stays byte-identical): set VOXXO_FOLD_ARTIFACT_ONLY=1 to render fold-block
 * bodies as typed receipts + aggregates + cognitive artifacts + conserved
 * literals instead of chronological skeleton rows. Read lazily at render time
 * — the flatCoordinateClosetEnabled() house pattern — so toggling needs no
 * restart and no migration: already-frozen bands keep their bytes, newly
 * folded windows render in the current mode.
 */
export function foldArtifactOnlyEnabled(): boolean {
  if (typeof process === 'undefined' || !process.env) return false;
  const raw = (process.env.VOXXO_FOLD_ARTIFACT_ONLY ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/**
 * Decorator form of the flag for orchestrators that hold a FoldConfig at the
 * fold seam (fcBaseSession, codexFold, geminiCliBandAppend, tmux, FoldSession).
 * Flag off → the SAME object (identity), preserving byte-identical folding and
 * any config caching semantics; flag on → a shallow copy carrying the default
 * artifact body builder. Read per call so a relay-wide env flip takes effect
 * at the next fold render without restart.
 */
export function withArtifactModeConfig(config: FoldConfig): FoldConfig {
  return foldArtifactOnlyEnabled()
    ? { ...config, artifactModeBody: buildArtifactModeBody }
    : config;
}

/**
 * Default artifact-mode body builder for FoldConfig.artifactModeBody.
 * Composes: Chronological Provenance header → cognitive artifacts (durable
 * waypoints with their own embedded provenance) → receipt/aggregate lines →
 * ⌖ literals line (inside renderFoldReceipts output). Pure and deterministic.
 */
export function buildArtifactModeBody(
  windowMessages: readonly FoldMessage[],
): { bodyLines: string[]; blockChars: number } {
  const compile = compileFoldReceipts(windowMessages);
  const receiptLines = renderFoldReceipts(compile);

  const bodyLines: string[] = [];
  const firstTs = windowMessages.find(m => typeof m.tsMs === 'number')?.tsMs;
  const lastTs = [...windowMessages].reverse().find(m => typeof m.tsMs === 'number')?.tsMs;
  const provenance = renderEmbeddedContinuityArtifactProvenance({
    artifact: 'fold-artifact-band',
    contentClass: 'synthesized-history',
    traceId: 'fold-window',
    unit: 'message',
    sourceStart: 0,
    sourceEndExclusive: windowMessages.length,
    ...(firstTs !== undefined ? { sourceFirstTimestamp: new Date(firstTs).toISOString() } : {}),
    ...(lastTs !== undefined ? { sourceLastTimestamp: new Date(lastTs).toISOString() } : {}),
    authority: 'historical-background',
    previous: 'raw-history',
  });
  if (provenance) bodyLines.push(provenance, '');

  const artifacts = extractCognitiveArtifacts(windowMessages);
  const cognitiveBlock = renderCognitiveBlock(artifacts);
  if (cognitiveBlock) bodyLines.push(...cognitiveBlock.split('\n'), '');

  bodyLines.push(...receiptLines);

  const blockChars = bodyLines.reduce((s, line) => s + line.length + 1, 0);
  return { bodyLines, blockChars };
}

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

/** Receipt classes that produce one rendered line per tool call. */
export type FoldReceiptKind =
  | 'edit'
  | 'write'
  | 'bash-mutation'
  | 'test-run'
  | 'typecheck'
  | 'git-op'
  | 'tool-error'
  | 'rail-op'
  | 'atlas-commit'
  | 'spawn'
  | 'lifecycle'
  | 'chatroom-post';

export interface FoldReceipt {
  kind: FoldReceiptKind;
  /** One-line rendered receipt text (no timestamp prefix — the renderer adds it). */
  text: string;
  /**
   * Identity of the mutation target for supersession: normalized path for
   * edits/writes/atlas-commits, room for chatroom posts, step id for rail
   * ACKs. Empty when the class doesn't supersede.
   */
  targetIdentity: string;
  /** Window message index of the outcome (source pointer for audit/recall). */
  messageIndex: number;
  /** Outcome source time in epoch ms, or null when the window carries none. */
  sourceTimeMs: number | null;
  /** True when a newer receipt in the same window superseded this target. */
  superseded: boolean;
}

/** Aggregated investigation artifact for a contiguous read/search run. */
export interface InvestigationAggregate {
  /** Number of read/search/navigation/other tool calls collapsed. */
  eventCount: number;
  /** Deduped normalized path arguments (capped). */
  paths: string[];
  /** Deduped query/pattern arguments (capped). */
  queries: string[];
  /** Window message index of the run's first call (ordering anchor). */
  messageIndex: number;
  /** Which aggregate lane this run belongs to. */
  lane: 'investigation' | 'navigation' | 'other';
}

export interface FoldReceiptCounts {
  edits: number;
  writes: number;
  bashMutations: number;
  testRuns: number;
  typechecks: number;
  gitOps: number;
  toolErrors: number;
  railOps: number;
  atlasCommits: number;
  spawns: number;
  lifecycleOps: number;
  chatroomPosts: number;
  /** partner_claim_file / partner_release_file events (burst-aggregated). */
  claimEvents: number;
  claimBursts: number;
  /** Read/search calls folded into investigation aggregates. */
  readSearchEvents: number;
  /** Navigation/bookkeeping calls (psychic_pov, tap_star, wave_*…). */
  navigationEvents: number;
  /** Unclassified tools (aggregate-only; errors still promote). */
  otherEvents: number;
  /** Assistant messages with prose text in the window (extraction lane). */
  proseTurns: number;
  /** Every extracted tool call — the totality denominator. */
  totalToolCalls: number;
}

export interface FoldReceiptCompile {
  receipts: FoldReceipt[];
  aggregates: InvestigationAggregate[];
  /** Deduped, order-preserving, relevance-capped literal pool. */
  conservedLiterals: string[];
  counts: FoldReceiptCounts;
}

// ══════════════════════════════════════════════════════════════════════
// Classification tables
// ══════════════════════════════════════════════════════════════════════

const EDIT_TOOLS = new Set(['Edit', 'NotebookEdit', 'edit_file']);
const WRITE_TOOLS = new Set(['Write', 'write_file']);
const BASH_TOOLS = new Set(['Bash', 'run_bash']);
const SPAWN_TOOLS = new Set(['spawn', 'spawn_instance', 'fork_sidequest']);
const LIFECYCLE_TOOLS = new Set(['kill_instance']);
const CLAIM_TOOLS = new Set(['partner_claim_file', 'partner_release_file']);
const ATLAS_COMMIT_TOOLS = new Set(['atlas_commit', 'atlas_commit_batch']);
const GIT_MUTATION_TOOLS = new Set(['git_add', 'git_commit']);
const TYPECHECK_TOOLS = new Set(['typecheck', 'typecheck_quick']);

const READ_SEARCH_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'ToolSearch', 'WebSearch', 'WebFetch',
  'read_file', 'grep_search', 'glob_files', 'web_search', 'web_fetch',
  'tool_search', 'atlas_query', 'atlas_graph', 'atlas_snapshot', 'atlas_diff',
  'atlas_changelog_diff', 'atlas_worktree_status', 'atlas_worktree_diff',
  'atlas_clock', 'tap_instance_messages', 'read_attachment',
  'read_spooled_artifact', 'git_status', 'git_log', 'git_diff', 'git_stash',
  'browser_get_dom', 'browser_get_page_info', 'browser_get_console_logs',
  'browser_get_network_logs', 'browser_screenshot',
]);

const NAVIGATION_TOOLS = new Set([
  'psychic_pov', 'partner_file_claims', 'tap_star', 'rename_self',
  'wave_advance', 'wave_complete', 'browser_navigate', 'browser_click',
  'browser_type_text', 'browser_scroll', 'browser_set_viewport',
  'browser_wait_for_element', 'browser_clear_console_logs',
]);

/** task_rail operations that mutate plan/execution state (rest are reads). */
const RAIL_MUTATING_OPS = new Set([
  'start', 'append', 'insert', 'update', 'batch_update', 'remove', 'move',
  'lock', 'unlock', 'complete_review', 'clear', 'switch', 'transfer',
  'create', 'merge', 'abandon', 'save', 'delete', 'ack', 'request',
  'approve', 'deny', 'revoke',
]);

/** chatroom actions that post/mutate (rest are reads). */
const CHATROOM_MUTATING_ACTIONS = new Set([
  'send', 'create', 'rename', 'pin', 'unpin', 'resolve', 'react', 'edit',
]);

const TEST_COMMAND_RE = /\b(vitest|jest|npm test|npm run test|pytest|go test|cargo test|run_tests)\b/;
const TSC_COMMAND_RE = /\b(tsc|vue-tsc)\b|focused-typecheck/;

function shortToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '').replace(/^mcp_forge_[^_]+__/, '');
}

function truncateReceipt(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ══════════════════════════════════════════════════════════════════════
// Error detection
// ══════════════════════════════════════════════════════════════════════

/**
 * Tool-error detection. Two lanes: (1) Anthropic-style `is_error` content
 * blocks scanned from the raw window (exact), (2) a strict flattened-text
 * heuristic for engines that inline errors — the outcome text must *open*
 * with an error marker, so a grep hit containing "error:" mid-body is not
 * misclassified.
 */
function collectErrorToolIds(windowMessages: readonly FoldMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of windowMessages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_result' && block.is_error === true && typeof block.tool_use_id === 'string') {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

function resultOpensWithError(resultText: string): boolean {
  const head = resultText.trimStart().slice(0, 200);
  return /^(error\b|Error\b|ERROR\b|✗|✖|failed\b)/.test(head)
    || /\bCommand failed\b|\bexit code [1-9]/.test(head);
}

// ══════════════════════════════════════════════════════════════════════
// Class-specific receipt renderers
// ══════════════════════════════════════════════════════════════════════

function renderTestRunReceipt(call: ExtractedToolCall): string {
  const cmd = BASH_TOOLS.has(call.name)
    ? truncateReceipt(String(call.input.command ?? ''), 60)
    : `${shortToolName(call.name)}(${truncateReceipt(String(call.input.files ?? call.input.testNamePattern ?? ''), 40)})`;
  const out = call.resultText;
  const testFilesLine = out.match(/Test Files\s+[^\n]*/)?.[0]?.trim() ?? '';
  const testsLine = out.match(/^\s*Tests\s+[^\n]*/m)?.[0]?.trim() ?? '';
  const failing = Array.from(out.matchAll(/^\s*(?:✗|×|FAIL)\s+([^\n]{1,80})/gm)).map(m => m[1].trim());
  const counts = [testFilesLine, testsLine].filter(Boolean).join(' · ')
    || `${(out.match(/(\d+)\s+passed/) ?? [])[1] ?? '?'} passed`;
  const failSuffix = failing.length > 0 ? ` — failing: ${failing.slice(0, 3).join('; ')}` : '';
  return `🧪 ${cmd} → ${truncateReceipt(counts, 90)}${truncateReceipt(failSuffix, 120)}`;
}

function renderTypecheckReceipt(call: ExtractedToolCall): string {
  const out = call.resultText;
  const tsErrors = out.match(/error TS\d+/g)?.length ?? 0;
  const forgeCount = Number(out.match(/"error_count"\s*:\s*(\d+)/)?.[1] ?? 0);
  const errors = Math.max(tsErrors, forgeCount);
  const cmd = BASH_TOOLS.has(call.name)
    ? truncateReceipt(String(call.input.command ?? ''), 60)
    : shortToolName(call.name);
  return `📐 ${cmd} → ${errors === 0 ? 'clean' : `${errors} error(s)`}`;
}

function renderToolErrorReceipt(call: ExtractedToolCall): string {
  const head = truncateReceipt(call.resultText.trim().split('\n')[0] ?? '', 110);
  return `⚠️ ${shortToolName(call.name)} → ${head || 'error (no message)'}`;
}

function renderRailReceipt(call: ExtractedToolCall): string {
  const mode = String(call.input.mode ?? '');
  const op = String(call.input.operation ?? '');
  const step = String(call.input.step_id ?? call.input.ack_step_id ?? '');
  const status = String(call.input.ack_status ?? call.input.status ?? '');
  const acks = Array.isArray(call.input.acks) ? call.input.acks.length : 0;
  const detail = step ? ` ${step}${status ? `=${status}` : ''}` : acks > 0 ? ` ${acks} ack(s)` : '';
  return `📋 task_rail ${mode}${op ? `/${op}` : ''}${detail}`.trim();
}

function renderChatroomReceipt(call: ExtractedToolCall): string {
  const action = String(call.input.action ?? 'send');
  const room = String(call.input.room ?? call.input.name ?? '');
  const excerpt = action === 'send'
    ? ` — "${truncateReceipt(String(call.input.message ?? '').replace(/\s+/g, ' '), 60)}"`
    : '';
  return `💬 chatroom ${action} ${room}${excerpt}`.trim();
}

function renderSpawnReceipt(call: ExtractedToolCall): string {
  const name = String(call.input.name ?? call.input.fork_name ?? '');
  const target = String(call.input.target ?? '');
  const engine = String(call.input.engine ?? '');
  return `🌱 spawn ${target}${name ? ` ${name}` : ''}${engine ? ` (${engine})` : ''}`.trim();
}

function renderGitReceipt(call: ExtractedToolCall): string {
  const tool = shortToolName(call.name);
  const msg = truncateReceipt(String(call.input.message ?? ''), 50);
  const files = Array.isArray(call.input.files) ? `${call.input.files.length} file(s)` : '';
  return `📦 ${tool}${msg ? ` "${msg}"` : ''}${files ? ` ${files}` : ''}`;
}

// ══════════════════════════════════════════════════════════════════════
// Classification
// ══════════════════════════════════════════════════════════════════════

type CallLane =
  | { lane: 'receipt'; kind: FoldReceiptKind }
  | { lane: 'claim' }
  | { lane: 'investigation' }
  | { lane: 'navigation' }
  | { lane: 'other' };

function classifyCall(call: ExtractedToolCall, errorIds: Set<string>): CallLane {
  const short = shortToolName(call.name);
  const isError = errorIds.has(call.toolId) || resultOpensWithError(call.resultText);

  // Errors always promote — a failed call is semantically load-bearing even
  // when the call itself was read-only.
  if (isError) return { lane: 'receipt', kind: 'tool-error' };

  if (EDIT_TOOLS.has(call.name) || EDIT_TOOLS.has(short)) return { lane: 'receipt', kind: 'edit' };
  if (WRITE_TOOLS.has(call.name) || WRITE_TOOLS.has(short)) return { lane: 'receipt', kind: 'write' };

  if (BASH_TOOLS.has(call.name)) {
    const cmd = String(call.input.command ?? '');
    if (TEST_COMMAND_RE.test(cmd)) return { lane: 'receipt', kind: 'test-run' };
    if (TSC_COMMAND_RE.test(cmd)) return { lane: 'receipt', kind: 'typecheck' };
    if (isMutatingBash(call.input)) return { lane: 'receipt', kind: 'bash-mutation' };
    return { lane: 'investigation' };
  }

  if (short === 'run_tests') return { lane: 'receipt', kind: 'test-run' };
  if (TYPECHECK_TOOLS.has(short)) return { lane: 'receipt', kind: 'typecheck' };
  if (GIT_MUTATION_TOOLS.has(short)) return { lane: 'receipt', kind: 'git-op' };
  if (ATLAS_COMMIT_TOOLS.has(short)) return { lane: 'receipt', kind: 'atlas-commit' };
  if (SPAWN_TOOLS.has(short)) return { lane: 'receipt', kind: 'spawn' };
  if (LIFECYCLE_TOOLS.has(short)) return { lane: 'receipt', kind: 'lifecycle' };
  if (CLAIM_TOOLS.has(short)) return { lane: 'claim' };

  if (short === 'task_rail') {
    const mode = String(call.input.mode ?? '');
    const op = String(call.input.operation ?? '');
    if (mode === 'shoot' || mode === 'sprint') return { lane: 'receipt', kind: 'rail-op' };
    if ((mode === 'load' || mode === 'draft' || mode === 'template' || mode === 'role')
      && RAIL_MUTATING_OPS.has(op)) return { lane: 'receipt', kind: 'rail-op' };
    return { lane: 'navigation' };
  }

  if (short === 'chatroom') {
    const action = String(call.input.action ?? 'send');
    return CHATROOM_MUTATING_ACTIONS.has(action)
      ? { lane: 'receipt', kind: 'chatroom-post' }
      : { lane: 'navigation' };
  }

  if (READ_SEARCH_TOOLS.has(call.name) || READ_SEARCH_TOOLS.has(short)) return { lane: 'investigation' };
  if (NAVIGATION_TOOLS.has(call.name) || NAVIGATION_TOOLS.has(short)) return { lane: 'navigation' };

  return { lane: 'other' };
}

function receiptText(kind: FoldReceiptKind, call: ExtractedToolCall): string {
  switch (kind) {
    case 'test-run': return renderTestRunReceipt(call);
    case 'typecheck': return renderTypecheckReceipt(call);
    case 'tool-error': return renderToolErrorReceipt(call);
    case 'rail-op': return renderRailReceipt(call);
    case 'chatroom-post': return renderChatroomReceipt(call);
    case 'spawn': return renderSpawnReceipt(call);
    case 'lifecycle': return `💀 ${shortToolName(call.name)} ${truncateReceipt(String(call.input.target ?? call.input.instance ?? ''), 30)}`.trim();
    case 'git-op': return renderGitReceipt(call);
    // edit / write / bash-mutation / atlas-commit: skeletonizeTool already
    // renders the canonical one-liner for these — byte-parity with what the
    // skeleton showed keeps the consumer's learned grammar stable.
    default: return skeletonizeTool(call);
  }
}

function targetIdentity(kind: FoldReceiptKind, call: ExtractedToolCall): string {
  switch (kind) {
    case 'edit':
    case 'write': return extractPath(call.input);
    case 'atlas-commit': return extractPath(call.input);
    case 'chatroom-post': return String(call.input.room ?? call.input.name ?? '');
    case 'rail-op': return String(call.input.step_id ?? call.input.ack_step_id ?? '');
    default: return '';
  }
}

// ══════════════════════════════════════════════════════════════════════
// Compiler
// ══════════════════════════════════════════════════════════════════════

const MAX_AGGREGATE_PATHS = 6;
const MAX_AGGREGATE_QUERIES = 4;
const DEFAULT_LITERAL_CAP = 24;

function queryOf(call: ExtractedToolCall): string {
  const q = call.input.pattern ?? call.input.query ?? call.input.search ?? call.input.command ?? '';
  return truncateReceipt(String(q).replace(/\s+/g, ' '), 40);
}

export function compileFoldReceipts(
  windowMessages: readonly FoldMessage[],
  options: { literalCap?: number } = {},
): FoldReceiptCompile {
  const calls = extractToolCalls(windowMessages as FoldMessage[]);
  const errorIds = collectErrorToolIds(windowMessages);
  const literalCap = options.literalCap ?? DEFAULT_LITERAL_CAP;

  const receipts: FoldReceipt[] = [];
  const aggregates: InvestigationAggregate[] = [];
  const counts: FoldReceiptCounts = {
    edits: 0, writes: 0, bashMutations: 0, testRuns: 0, typechecks: 0,
    gitOps: 0, toolErrors: 0, railOps: 0, atlasCommits: 0, spawns: 0,
    lifecycleOps: 0, chatroomPosts: 0, claimEvents: 0, claimBursts: 0,
    readSearchEvents: 0, navigationEvents: 0, otherEvents: 0,
    proseTurns: 0, totalToolCalls: calls.length,
  };

  const literalPool: string[] = [];
  const pushLiterals = (text: string, max = 1): void => {
    for (const lit of beltVerbatim(text, max + 2).split(', ').filter(Boolean)) {
      if (literalPool.length >= literalCap) return;
      if (!literalPool.some(existing => existing.includes(lit) || lit.includes(existing))) {
        literalPool.push(lit);
      }
    }
  };

  let run: { lane: 'investigation' | 'navigation' | 'other'; calls: ExtractedToolCall[] } | null = null;
  const flushRun = (): void => {
    if (!run || run.calls.length === 0) { run = null; return; }
    const paths: string[] = [];
    const queries: string[] = [];
    for (const c of run.calls) {
      const p = extractPath(c.input);
      if (p && paths.length < MAX_AGGREGATE_PATHS && !paths.includes(p)) paths.push(p);
      const q = queryOf(c);
      if (q && queries.length < MAX_AGGREGATE_QUERIES && !queries.includes(q)) queries.push(q);
      pushLiterals(c.resultText);
    }
    aggregates.push({
      eventCount: run.calls.length,
      paths,
      queries: run.lane === 'investigation' ? queries : [],
      messageIndex: run.calls[0].messageIndex,
      lane: run.lane,
    });
    run = null;
  };

  let claimBurst = 0;
  const flushClaimBurst = (): void => {
    if (claimBurst > 0) counts.claimBursts += 1;
    claimBurst = 0;
  };

  for (const call of calls) {
    const lane = classifyCall(call, errorIds);
    if (lane.lane === 'receipt') {
      flushRun();
      flushClaimBurst();
      const kind = lane.kind;
      receipts.push({
        kind,
        text: receiptText(kind, call),
        targetIdentity: targetIdentity(kind, call),
        messageIndex: call.messageIndex,
        sourceTimeMs: typeof call.tsMs === 'number' ? call.tsMs : null,
        superseded: false,
      });
      if (kind === 'edit') counts.edits += 1;
      else if (kind === 'write') counts.writes += 1;
      else if (kind === 'bash-mutation') counts.bashMutations += 1;
      else if (kind === 'test-run') counts.testRuns += 1;
      else if (kind === 'typecheck') counts.typechecks += 1;
      else if (kind === 'git-op') counts.gitOps += 1;
      else if (kind === 'tool-error') counts.toolErrors += 1;
      else if (kind === 'rail-op') counts.railOps += 1;
      else if (kind === 'atlas-commit') counts.atlasCommits += 1;
      else if (kind === 'spawn') counts.spawns += 1;
      else if (kind === 'lifecycle') counts.lifecycleOps += 1;
      else if (kind === 'chatroom-post') counts.chatroomPosts += 1;
      pushLiterals(call.resultText);
    } else if (lane.lane === 'claim') {
      flushRun();
      counts.claimEvents += 1;
      claimBurst += 1;
    } else {
      flushClaimBurst();
      if (!run || run.lane !== lane.lane) {
        flushRun();
        run = { lane: lane.lane, calls: [] };
      }
      run.calls.push(call);
      if (lane.lane === 'investigation') counts.readSearchEvents += 1;
      else if (lane.lane === 'navigation') counts.navigationEvents += 1;
      else counts.otherEvents += 1;
    }
  }
  flushRun();
  flushClaimBurst();

  // Supersession: within superseding classes, a newer receipt for the same
  // target outranks elders. Elders stay rendered (chronological receipts are
  // evidence) but carry the flag so budgeted renderers may elide them first.
  const newestByTarget = new Map<string, number>();
  receipts.forEach((r, i) => {
    if (!r.targetIdentity) return;
    if (r.kind !== 'edit' && r.kind !== 'write' && r.kind !== 'atlas-commit') return;
    newestByTarget.set(`${r.kind}:${r.targetIdentity}`, i);
  });
  receipts.forEach((r, i) => {
    if (!r.targetIdentity) return;
    const newest = newestByTarget.get(`${r.kind}:${r.targetIdentity}`);
    if (newest !== undefined && newest !== i) r.superseded = true;
  });

  counts.proseTurns = windowMessages.filter(m =>
    (m.role === 'assistant' || m.role === 'model')
    && typeof m.content === 'string' && m.content.trim().length > 0,
  ).length;

  return { receipts, aggregates, conservedLiterals: literalPool, counts };
}

// ══════════════════════════════════════════════════════════════════════
// Renderer
// ══════════════════════════════════════════════════════════════════════

/**
 * Render the artifact-mode band body lines: totality header, then
 * chronological receipts interleaved with investigation aggregates, then the
 * conserved-literal pool. Deterministic for identical input.
 *
 * Timestamp policy: when the window carries any source time, timestampless
 * receipts render `[time unknown]` explicitly; when the whole window is
 * timestampless (legacy hosts), prefixes omit entirely — matching skeleton
 * behavior rather than spraying unknowns.
 */
export function renderFoldReceipts(compile: FoldReceiptCompile): string[] {
  const { receipts, aggregates, conservedLiterals, counts } = compile;
  const lines: string[] = [];

  const receiptParts: string[] = [];
  if (counts.edits) receiptParts.push(`${counts.edits} edit(s)`);
  if (counts.writes) receiptParts.push(`${counts.writes} write(s)`);
  if (counts.bashMutations) receiptParts.push(`${counts.bashMutations} bash`);
  if (counts.testRuns) receiptParts.push(`${counts.testRuns} test run(s)`);
  if (counts.typechecks) receiptParts.push(`${counts.typechecks} typecheck(s)`);
  if (counts.gitOps) receiptParts.push(`${counts.gitOps} git`);
  if (counts.toolErrors) receiptParts.push(`${counts.toolErrors} error(s)`);
  if (counts.railOps) receiptParts.push(`${counts.railOps} rail`);
  if (counts.atlasCommits) receiptParts.push(`${counts.atlasCommits} atlas`);
  if (counts.spawns) receiptParts.push(`${counts.spawns} spawn(s)`);
  if (counts.lifecycleOps) receiptParts.push(`${counts.lifecycleOps} lifecycle`);
  if (counts.chatroomPosts) receiptParts.push(`${counts.chatroomPosts} chat`);
  const aggParts: string[] = [];
  if (counts.readSearchEvents) aggParts.push(`${counts.readSearchEvents} read/search`);
  if (counts.claimEvents) aggParts.push(`${counts.claimEvents} claim event(s) in ${counts.claimBursts} burst(s)`);
  if (counts.navigationEvents) aggParts.push(`${counts.navigationEvents} navigation`);
  if (counts.otherEvents) aggParts.push(`${counts.otherEvents} other`);

  lines.push(
    `[Fold receipts — ${counts.totalToolCalls} tool call(s): ${receiptParts.join(' · ') || 'none'}`
    + `${aggParts.length ? ` | aggregated: ${aggParts.join(' · ')}` : ''}`
    + ` | dropped: bookkeeping rows ride counts only; raw history recoverable via recall]`,
  );

  type RenderItem =
    | { sortKey: number; seq: number; receipt: FoldReceipt }
    | { sortKey: number; seq: number; aggregate: InvestigationAggregate };
  const items: RenderItem[] = [
    ...receipts.map((receipt, seq) => ({ sortKey: receipt.messageIndex, seq, receipt })),
    ...aggregates.map((aggregate, seq) => ({ sortKey: aggregate.messageIndex, seq: seq + receipts.length, aggregate })),
  ].sort((a, b) => a.sortKey - b.sortKey || a.seq - b.seq);

  const anyTimestamp = receipts.some(r => r.sourceTimeMs !== null);
  for (const item of items) {
    if ('receipt' in item) {
      const r = item.receipt;
      const ts = r.sourceTimeMs !== null ? formatFoldTime(r.sourceTimeMs) : (anyTimestamp ? '[time unknown]' : '');
      const supersededMark = r.superseded ? ' (superseded)' : '';
      lines.push(`${ts ? `${ts} ` : ''}${r.text}${supersededMark}`);
    } else {
      const a = item.aggregate;
      const icon = a.lane === 'investigation' ? '🔍' : a.lane === 'navigation' ? '🧭' : '🔧';
      const detail = a.paths.length || a.queries.length
        ? ` — ${[a.paths.length ? `paths: ${a.paths.join(', ')}` : '', a.queries.length ? `queries: ${a.queries.map(q => `"${q}"`).join(', ')}` : ''].filter(Boolean).join('; ')}`
        : '';
      lines.push(`${icon} ${a.lane} ×${a.eventCount}${detail}`);
    }
  }

  if (conservedLiterals.length > 0) {
    lines.push(`⌖ literals: ${conservedLiterals.join(' · ')}`);
  }
  return lines;
}
