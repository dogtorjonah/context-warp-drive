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
 * regardless of narration; read, search, navigation, and orchestration calls
 * collapse into typed aggregate artifacts; bookkeeping drops with a count.
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
 * Relay-wide artifact-only fold switch. Default ON: fold-block bodies render
 * as typed receipts + aggregates + cognitive artifacts + conserved literals
 * instead of chronological skeleton rows. Set VOXXO_FOLD_ARTIFACT_ONLY to an
 * explicit negative value (0/false/off/no) to restore byte-identical legacy
 * skeleton folding. Read lazily at render time — the
 * flatCoordinateClosetEnabled() house pattern — so toggling needs no restart
 * and no migration: already-frozen bands keep their bytes, newly folded
 * windows render in the current mode.
 */
export function foldArtifactOnlyEnabled(): boolean {
  if (typeof process === 'undefined' || !process.env) return true;
  const raw = (process.env.VOXXO_FOLD_ARTIFACT_ONLY ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
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

  // Categorized tap_star decisions have historically entered the cognitive
  // lane as durable waypoints. Once the receipt compiler promotes the same
  // call to a typed decision row, keep exactly one representation: the typed
  // row carries outcome and lifecycle evidence that the prose waypoint cannot.
  const decisionSources = new Set(
    compile.receipts
      .filter((receipt): receipt is FoldDecisionRecord => receipt.recordType === 'decision')
      .flatMap((receipt) => [receipt.sourceIdentity, receipt.toolCallId])
      .filter((identity): identity is string => identity !== null && identity.length > 0),
  );
  const artifacts = extractCognitiveArtifacts(windowMessages)
    .filter((artifact) => artifact.tapStarCategory !== 'decision'
      || artifact.sourceIdentity === null
      || !decisionSources.has(artifact.sourceIdentity));
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
  | 'chatroom-post'
  | 'actuator'
  | 'claim-op'
  | 'decision';

/** The complete action-outcome vocabulary. Do not add an implicit fourth state. */
export const FOLD_ACTION_OUTCOMES = ['applied', 'failed', 'unknown'] as const;
export type FoldActionOutcome = typeof FOLD_ACTION_OUTCOMES[number];

export type FoldDurableActionKind = Exclude<
  FoldReceiptKind,
  'test-run' | 'typecheck' | 'tool-error' | 'claim-op' | 'decision'
>;

export const FOLD_CLAIM_LIFECYCLE_STATES = [
  'active', 'released', 'superseded', 'failed', 'unknown',
] as const;
export type FoldClaimLifecycleState = typeof FOLD_CLAIM_LIFECYCLE_STATES[number];

export const FOLD_DECISION_LIFECYCLE_STATES = [
  'current', 'superseded', 'failed', 'unknown',
] as const;
export type FoldDecisionLifecycleState = typeof FOLD_DECISION_LIFECYCLE_STATES[number];

/** Validation freshness is always explicit; absence of evidence is `unknown`. */
export const FOLD_VALIDATION_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type FoldValidationFreshness = typeof FOLD_VALIDATION_FRESHNESS[number];

export type FoldValidationFreshnessReason =
  | 'content-hash-mismatch'
  | 'validation-hash-missing'
  | 'current-hash-missing'
  | 'validated-artifact-path-missing'
  | 'content-changed-during-validation';

/** One artifact attested by a completed validation tool invocation. */
export interface FoldValidationArtifact {
  path: string;
  /** SHA-256 of the bytes that stayed stable for the duration of validation. */
  validatedContentHash: string | null;
  /** SHA-256 from the explicit current-view snapshot, never inferred. */
  currentContentHash: string | null;
  freshness: FoldValidationFreshness;
  freshnessReason: FoldValidationFreshnessReason | null;
}

interface FoldReceiptBase {
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
  /** Stable source-row/tool-call identity, or null when the host supplied none. */
  sourceIdentity: string | null;
  /** True when a newer receipt in the same window superseded this target. */
  superseded: boolean;
}

/** A non-mutating tool error receipt. */
export interface FoldOrdinaryReceipt extends FoldReceiptBase {
  recordType: 'receipt';
  kind: 'tool-error';
}

/**
 * A validation receipt bound to exact artifact bytes. A successful test/check
 * result is not a freshness claim: only matching validation-time and explicit
 * current-view hashes may produce `fresh`.
 */
export interface FoldValidationReceipt extends FoldReceiptBase {
  recordType: 'validation';
  kind: 'test-run' | 'typecheck';
  scope: string;
  artifacts: FoldValidationArtifact[];
  freshness: FoldValidationFreshness;
  freshnessReason: FoldValidationFreshnessReason | null;
}

/**
 * Queryable durable-mutation evidence. `unknown` is deliberately distinct from
 * failure: interruption may leave an effect applied, absent, or partial, so a
 * successor must reconcile live ground truth before retrying or relying on it.
 */
export interface FoldActionRecord extends FoldReceiptBase {
  recordType: 'action';
  kind: FoldDurableActionKind;
  /** Stable action identity; prefers the host's source-row identity. */
  actionId: string;
  toolCallId: string;
  outcome: FoldActionOutcome;
  reconciliationRequired: boolean;
}

/** One file-claim subject. Batch calls compile to one independently honest row per target. */
export interface FoldClaimRecord extends FoldReceiptBase {
  recordType: 'claim';
  kind: 'claim-op';
  claimId: string;
  toolCallId: string;
  operation: 'acquire' | 'release';
  subject: string;
  range: string | null;
  holder: string | null;
  outcome: FoldActionOutcome;
  reconciliationRequired: boolean;
  lifecycleState: FoldClaimLifecycleState;
  terminalizedByIdentity: string | null;
}

/** A recorded decision pointer. `current` describes lifecycle, not correctness. */
export interface FoldDecisionRecord extends FoldReceiptBase {
  recordType: 'decision';
  kind: 'decision';
  decisionId: string;
  toolCallId: string;
  subject: string;
  subjectIsExplicit: boolean;
  statement: string;
  range: string | null;
  holder: string | null;
  outcome: FoldActionOutcome;
  reconciliationRequired: boolean;
  lifecycleState: FoldDecisionLifecycleState;
  supersedesDecisionIds: string[];
  supersededByIdentity: string | null;
  authority: 'recorded-pointer';
}

/** Durable mutation rows eligible for live-ground-truth reconciliation. */
export type FoldReconciliationCandidate =
  | FoldActionRecord
  | FoldClaimRecord
  | FoldDecisionRecord;

/** Stable identity shared by reconciliation overlays and their source receipt. */
export function foldReconciliationRecordId(record: FoldReconciliationCandidate): string {
  if (record.recordType === 'claim') return record.claimId;
  if (record.recordType === 'decision') return record.decisionId;
  return record.actionId;
}

export type FoldReceipt =
  | FoldOrdinaryReceipt
  | FoldValidationReceipt
  | FoldActionRecord
  | FoldClaimRecord
  | FoldDecisionRecord;

export type FoldAggregateLane = 'read' | 'search' | 'navigation' | 'orchestration' | 'other';

export interface AggregateToolCount {
  name: string;
  count: number;
}

/** Aggregated tool artifact for a contiguous run in one semantic lane. */
export interface InvestigationAggregate {
  /** Number of tool calls collapsed. */
  eventCount: number;
  /** Deduped normalized path arguments (capped). */
  paths: string[];
  /** Distinct paths beyond the rendered cap, so truncation is never silent. */
  omittedPathCount: number;
  /** Deduped argument digests: queries, patterns, and shell commands (capped). */
  queries: string[];
  /** Distinct argument digests beyond the rendered cap. */
  omittedQueryCount: number;
  /** Window message index of the run's first call (ordering anchor). */
  messageIndex: number;
  /** Window message index of the run's final call outcome. */
  endMessageIndex: number;
  /** Which aggregate lane this run belongs to. */
  lane: FoldAggregateLane;
  /** Per-tool breakdown, preserving first-seen order within the run. */
  toolCounts: AggregateToolCount[];
  /** Earliest authoritative event time in the run, or null when all are unknown. */
  sourceStartTimeMs: number | null;
  /** Latest authoritative event time in the run, or null when all are unknown. */
  sourceEndTimeMs: number | null;
  /** Calls in the run whose source time was unavailable. */
  unknownSourceTimeCount: number;
  /** Calls in the run whose stable source identity was unavailable. */
  unknownSourceIdentityCount: number;
  /** Stable first/last source identities for the aggregate, or null when unknown. */
  sourceIdentity: string | null;
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
  /** External side-effect calls: send/publish/deploy/migrate/schedule/device. */
  actuators: number;
  /** partner_claim_file / partner_release_file action records (burst-counted). */
  claimEvents: number;
  claimBursts: number;
  /** Categorized tap_star decision records. */
  decisionEvents: number;
  /** Read calls folded into aggregate artifacts. */
  readEvents: number;
  /** Search/discovery calls folded into aggregate artifacts. */
  searchEvents: number;
  /** Navigation/bookkeeping calls (psychic_pov, tap_star, wave_*…). */
  navigationEvents: number;
  /** Tool-host orchestration calls (functions.exec, forge_call, sandbox helpers). */
  orchestrationEvents: number;
  /** Unclassified tools (aggregate-only; errors still promote). */
  otherEvents: number;
  /** Exact names behind otherEvents, prototype-safe and first-seen ordered. */
  otherToolCounts: AggregateToolCount[];
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

export interface FoldReceiptCompileOptions {
  literalCap?: number;
  /**
   * Explicit current-view SHA-256 snapshot keyed by the same artifact paths the
   * validator attested. The pure compiler never reads the filesystem or treats
   * a validation-time digest as current truth.
   */
  currentArtifactHashes?: Readonly<Record<string, string>>;
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

/**
 * Tool calls whose effect leaves this workspace: messages sent, rows written,
 * artifacts published, services deployed, jobs scheduled, devices driven. These
 * are the calls a successor most needs to know already happened — they are
 * typically irreversible and, unlike an edit, cannot be re-derived by reading
 * the repository. Without this class they fell into the anonymous `other`
 * aggregate and a sent email rendered as `🔧 tools: gmail_send ×1`.
 *
 * Browser interaction (`browser_click`, `browser_type_text`) deliberately stays
 * in the navigation aggregate: it is high-frequency and usually exploratory, so
 * per-call promotion would crowd the band budget. Its arguments now survive in
 * the aggregate detail instead.
 */
const ACTUATOR_TOOLS = new Set([
  // Messaging and signalling out of the swarm.
  'gmail_send', 'gmail_draft', 'gmail_trash', 'inbox_send', 'raw_signal',
  'signal_overseer', 'PushNotification', 'SendMessage', 'RemoteTrigger',
  // Database, schema, and project-state mutation.
  'execute_sql', 'apply_migration', 'deploy_edge_function', 'create_project',
  'pause_project', 'restore_project', 'create_branch', 'delete_branch',
  'merge_branch', 'rebase_branch', 'reset_branch',
  // Publishing, transfer, and tool-registry deployment. `push` is the
  // drive-push upload leaf once the mcp_forge_<server>__ prefix is stripped.
  'publish_apk', 'push', 'start_upload', 'start_copy_dirs', 'forge_create',
  'forge_edit', 'forge_deploy', 'forge_remove', 'build_enqueue',
  'app_restart_prod', 'app_build_and_restart',
  // Scheduling and deferred execution.
  'CronCreate', 'CronDelete', 'ScheduleWakeup', 'calendar_create_event',
  'calendar_update_event', 'calendar_delete_event',
  // Physical/remote device actuation.
  'phone_tap', 'phone_type', 'phone_key', 'phone_swipe', 'phone_long_press',
  'phone_launch_app', 'phone_open_url',
]);

const READ_TOOLS = new Set([
  'Read', 'WebFetch', 'read_file', 'web_fetch', 'atlas_snapshot', 'atlas_diff',
  'atlas_changelog_diff', 'atlas_worktree_status', 'atlas_worktree_diff',
  'atlas_clock', 'tap_instance_messages', 'read_attachment',
  'read_spooled_artifact', 'git_status', 'git_log', 'git_diff', 'git_stash',
  'browser_get_dom', 'browser_get_page_info', 'browser_get_console_logs',
  'browser_get_network_logs', 'browser_screenshot',
]);

const SEARCH_TOOLS = new Set([
  'Grep', 'Glob', 'ToolSearch', 'WebSearch', 'grep_search', 'glob_files',
  'web_search', 'tool_search', 'atlas_query', 'atlas_graph', 'forge_list',
  'forge_tools', 'list_mcp_resources', 'list_mcp_resource_templates',
]);

const NAVIGATION_TOOLS = new Set([
  'psychic_pov', 'partner_file_claims', 'tap_star', 'rename_self',
  'wave_advance', 'wave_complete', 'browser_navigate', 'browser_click',
  'browser_type_text', 'browser_scroll', 'browser_set_viewport',
  'browser_wait_for_element', 'browser_clear_console_logs',
]);

const ORCHESTRATION_TOOLS = new Set([
  'functions.exec', 'exec', 'forge_call', 'run_code', 'code_sandbox_manage',
  'wait', 'request_user_input',
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
const SHELL_SEARCH_COMMAND_RE = /\b(?:rg|grep|find|fd)\b/;

function shortToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '').replace(/^mcp_forge_.+?__/, '');
}

interface ReceiptToolCall extends ExtractedToolCall {
  /** Exact semantic target used when an unknown wrapper must remain auditable. */
  exactToolIdentity: string;
  /** Stable source-row/tool-call identity, never a window-relative coordinate. */
  sourceIdentity: string | null;
  /** Whether the fold window contains a matching outcome row. */
  completion: 'completed' | 'pending';
}

type ProvenancedFoldMessage = FoldMessage & { sourceIdentity?: unknown };

function sourceIdentityForCall(
  call: ExtractedToolCall,
  windowMessages: readonly FoldMessage[],
): string | null {
  const raw = (windowMessages[call.messageIndex] as ProvenancedFoldMessage | undefined)?.sourceIdentity;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return call.toolId.trim() ? `tool-call:${call.toolId.trim()}` : null;
}

/**
 * Extract unresolved call sites without changing the shared completed-call
 * extractor. Only durable mutations are promoted by the compiler; pending
 * reads remain ordinary live-tail work rather than receipts.
 */
function extractPendingToolCalls(windowMessages: readonly FoldMessage[]): ExtractedToolCall[] {
  const pending = new Map<string, { name: string; input: Record<string, unknown>; messageIndex: number }>();
  for (let messageIndex = 0; messageIndex < windowMessages.length; messageIndex += 1) {
    const msg = windowMessages[messageIndex];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
          const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
            ? block.input as Record<string, unknown>
            : {};
          pending.set(block.id, { name: block.name, input, messageIndex });
        }
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          pending.delete(block.tool_use_id);
        }
      }
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          pending.delete(block.tool_use_id);
        }
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const raw of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = raw.function as Record<string, unknown> | undefined;
        if (!fn || typeof fn.name !== 'string' || typeof raw.id !== 'string') continue;
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(typeof fn.arguments === 'string' ? fn.arguments : '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
        } catch { /* malformed arguments stay empty, but the attempt remains */ }
        pending.set(raw.id, { name: fn.name, input, messageIndex });
      }
    }
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') {
      pending.delete(msg.tool_call_id);
    }
    if (msg.role === 'model' && Array.isArray((msg as FoldMessage & { parts?: unknown }).parts)) {
      for (const raw of (msg as FoldMessage & { parts: Array<Record<string, unknown>> }).parts) {
        const call = raw.functionCall as Record<string, unknown> | undefined;
        if (!call || typeof call.name !== 'string') continue;
        const id = typeof call.id === 'string' ? call.id : '';
        const input = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
          ? call.args as Record<string, unknown>
          : {};
        pending.set(id, { name: call.name, input, messageIndex });
      }
    }
    if (msg.role === 'user' && Array.isArray((msg as FoldMessage & { parts?: unknown }).parts)) {
      for (const raw of (msg as FoldMessage & { parts: Array<Record<string, unknown>> }).parts) {
        const response = raw.functionResponse as Record<string, unknown> | undefined;
        if (!response) continue;
        pending.delete(typeof response.id === 'string' ? response.id : '');
      }
    }
  }
  return [...pending.entries()].map(([toolId, call]) => ({
    name: call.name,
    input: call.input,
    resultText: '',
    toolId,
    messageIndex: call.messageIndex,
  }));
}

/**
 * Forge's generic `forge_call` is transport, not semantics. Classify/render the
 * inner operation and its args while retaining the exact supplied target for
 * unknown-tool accounting. Supports canonical full_name, slash form, and the
 * server+tool pair; malformed target-less wrappers remain orchestration.
 */
function normalizeReceiptToolCall(
  call: ExtractedToolCall,
  windowMessages: readonly FoldMessage[],
  completion: ReceiptToolCall['completion'],
): ReceiptToolCall {
  const transportName = shortToolName(call.name);
  const sourceIdentity = sourceIdentityForCall(call, windowMessages);
  if (transportName !== 'forge_call') {
    return { ...call, exactToolIdentity: transportName, sourceIdentity, completion };
  }

  const fullName = typeof call.input.full_name === 'string' ? call.input.full_name.trim() : '';
  const server = typeof call.input.server === 'string' ? call.input.server.trim() : '';
  const tool = typeof call.input.tool === 'string' ? call.input.tool.trim() : '';
  const slashTool = fullName.includes('/') ? fullName.slice(fullName.lastIndexOf('/') + 1).trim() : '';
  const semanticName = fullName
    ? (slashTool || fullName)
    : tool;
  const wrappedArgs = call.input.args;
  const semanticInput = wrappedArgs !== null
    && typeof wrappedArgs === 'object'
    && !Array.isArray(wrappedArgs)
    ? wrappedArgs as Record<string, unknown>
    : call.input;
  const exactToolIdentity = fullName || (server && tool ? `${server}/${tool}` : tool) || transportName;
  return {
    ...call,
    name: semanticName || call.name,
    input: semanticInput,
    exactToolIdentity,
    sourceIdentity,
    completion,
  };
}

function displayToolIdentity(call: ReceiptToolCall): string {
  return call.exactToolIdentity || shortToolName(call.name);
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

const ACTION_OUTCOME_UNKNOWN_RE =
  /\[Request interrupted by user|Context Warp automatically interrupted|\b(?:interrupted|cancelled|canceled|aborted)\b|\b(?:timed out|timeout)\b|Script running with cell ID|"status"\s*:\s*"(?:busy|infra_timeout|launch_error|max_buffer|run_error|crash)"/i;

function resolveActionOutcome(call: ReceiptToolCall, errorIds: Set<string>): FoldActionOutcome {
  if (call.completion === 'pending') return 'unknown';
  const result = call.resultText.trim();
  if (!result || ACTION_OUTCOME_UNKNOWN_RE.test(result)) return 'unknown';
  if (errorIds.has(call.toolId) || resultOpensWithError(result) || /"ok"\s*:\s*false\b/.test(result)) {
    return 'failed';
  }
  return 'applied';
}

/**
 * Claim tools have readable string results on several hosts, including batches
 * that intentionally keep a mixed grant/conflict result out of the error lane.
 * A mixed batch cannot honestly apply one outcome to every target, so preserve
 * it as unknown until the successor reconciles the live claim registry.
 */
function resolveClaimActionOutcome(call: ReceiptToolCall, errorIds: Set<string>): FoldActionOutcome {
  const generic = resolveActionOutcome(call, errorIds);
  if (generic !== 'applied') return generic;

  const result = call.resultText.trim();
  const batch = /^Claim batch:\s*(\d+)\/(\d+) granted(?:,\s*(\d+) waitlisted)?\./im.exec(result);
  if (batch) {
    const granted = Number(batch[1]);
    const total = Number(batch[2]);
    if (!Number.isSafeInteger(granted) || !Number.isSafeInteger(total) || total <= 0) return 'unknown';
    if (granted === total) return 'applied';
    if (granted === 0) return 'failed';
    return 'unknown';
  }

  if (/^(?:CONFLICT:|WAITLISTED:|WAITLIST UPDATED:|Cannot release\b|No claim on\b)/i.test(result)) {
    return 'failed';
  }
  return 'applied';
}

function resolveClaimTargetOutcome(
  call: ReceiptToolCall,
  errorIds: Set<string>,
  target: ParsedClaimTarget,
): FoldActionOutcome {
  const generic = resolveActionOutcome(call, errorIds);
  if (generic !== 'applied') return generic;
  const escapedTarget = target.targetIdentity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetPattern = new RegExp(`(^|[^A-Za-z0-9_./-])${escapedTarget}(?![A-Za-z0-9_./-])`);
  const matchingLines = call.resultText
    .split(/\r?\n/)
    .filter((line) => targetPattern.test(line));
  const hasFailure = matchingLines.some((line) =>
    /\[(?:not granted|conflict|failed|waitlisted)\]|\b(?:CONFLICT|WAITLISTED|not granted|failed)\b/i.test(line));
  const hasSuccess = matchingLines.some((line) =>
    !/\[not granted\]|\bnot granted\b/i.test(line)
    && (/\[granted\]/i.test(line) || /^\s*(?:Released|Claimed)\b/i.test(line)));
  if (hasFailure && hasSuccess) return 'unknown';
  if (hasFailure) return 'failed';
  if (hasSuccess) return 'applied';
  return resolveClaimActionOutcome(call, errorIds);
}

// ══════════════════════════════════════════════════════════════════════
// Class-specific receipt renderers
// ══════════════════════════════════════════════════════════════════════

/**
 * Forge runners report *why* a run could not complete. Surfacing that is the
 * difference between "the check passed" and "the check never ran" — outcomes
 * that are indistinguishable from output length alone, and which the fold sees
 * only after step compaction has already shrunk the tool result.
 */
const RUN_DID_NOT_COMPLETE_RE =
  /"status"\s*:\s*"(busy|infra_timeout|launch_error|input_error|max_buffer|run_error|crash)"/;

function runDidNotComplete(resultText: string): string | null {
  return RUN_DID_NOT_COMPLETE_RE.exec(resultText)?.[1] ?? null;
}

function renderTestRunReceipt(call: ReceiptToolCall): string {
  const cmd = BASH_TOOLS.has(call.name) || BASH_TOOLS.has(shortToolName(call.name))
    ? truncateReceipt(String(call.input.command ?? ''), 60)
    : `${shortToolName(call.name)}(${truncateReceipt(String(call.input.files ?? call.input.testNamePattern ?? ''), 40)})`;
  const out = call.resultText;
  const blocked = runDidNotComplete(out);
  if (blocked) return `🧪 ${cmd} → did not run (${blocked})`;
  const testFilesLine = out.match(/Test Files\s+[^\n]*/)?.[0]?.trim() ?? '';
  const testsLine = out.match(/^\s*Tests\s+[^\n]*/m)?.[0]?.trim() ?? '';
  const failing = Array.from(out.matchAll(/^\s*(?:✗|×|FAIL)\s+([^\n]{1,80})/gm)).map(m => m[1].trim());
  const counts = [testFilesLine, testsLine].filter(Boolean).join(' · ')
    || `${(out.match(/(\d+)\s+passed/) ?? [])[1] ?? '?'} passed`;
  const failSuffix = failing.length > 0 ? ` — failing: ${failing.slice(0, 3).join('; ')}` : '';
  return `🧪 ${cmd} → ${truncateReceipt(counts, 90)}${truncateReceipt(failSuffix, 120)}`;
}

function renderTypecheckReceipt(call: ReceiptToolCall): string {
  const out = call.resultText;
  const cmd = BASH_TOOLS.has(call.name) || BASH_TOOLS.has(shortToolName(call.name))
    ? truncateReceipt(String(call.input.command ?? ''), 60)
    : shortToolName(call.name);
  const blocked = runDidNotComplete(out);
  if (blocked) return `📐 ${cmd} → did not run (${blocked})`;

  const tsErrors = out.match(/error TS\d+/g)?.length ?? 0;
  const forgeCountMatch = out.match(/"error_count"\s*:\s*(\d+)/);
  const errors = Math.max(tsErrors, forgeCountMatch ? Number(forgeCountMatch[1]) : 0);
  if (errors > 0) return `📐 ${cmd} → ${errors} error(s)`;

  // Finding zero errors is not evidence that a check ran and passed: truncated,
  // compacted, empty, and never-launched output all yield zero too, and step
  // compaction shrinks tool results before the fold ever sees them. `clean`
  // therefore requires positive evidence; everything else stays explicitly
  // unknown, matching the sibling test-run receipt instead of asserting success.
  const ranClean = forgeCountMatch !== null
    || /\bFound 0 errors?\b/.test(out)
    || /"status"\s*:\s*"(?:clean|ok|passed|no_errors)"/.test(out)
    || /\bno (?:type )?errors?\b/i.test(out);
  return `📐 ${cmd} → ${ranClean ? 'clean' : 'result unknown'}`;
}

type ValidationResultRecord = Record<string, unknown>;

function parseValidationResult(resultText: string): ValidationResultRecord | null {
  const trimmed = resultText.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ValidationResultRecord
      : null;
  } catch {
    return null;
  }
}

function normalizeArtifactPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, '');
  return /^[a-f0-9]{64}$/.test(normalized) ? `sha256:${normalized}` : null;
}

function validationArtifactPaths(call: ReceiptToolCall, result: ValidationResultRecord | null): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    const path = normalizeArtifactPath(value);
    if (path && !paths.includes(path)) paths.push(path);
  };
  const pushList = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object' && !Array.isArray(item)) {
        push((item as ValidationResultRecord).path ?? (item as ValidationResultRecord).file);
      }
    }
  };

  pushList(result?.artifact_hashes);
  const hasAttestedPaths = paths.length > 0;
  // `files_checked` is the producer's authoritative validation scope. Keep
  // paths omitted from a partial attestation list so they force the receipt to
  // unknown instead of silently disappearing behind one matching hash.
  pushList(result?.files_checked);
  // A producer-supplied attestation list is authoritative and normally uses
  // absolute canonical paths. Mixing its paths with the caller's relative
  // `files` arguments would manufacture duplicate, unhashed artifacts.
  if (hasAttestedPaths) return paths;
  pushList(result?.files);
  push(result?.file);
  pushList(call.input.files);
  push(call.input.file);
  return paths;
}

function currentArtifactHash(
  path: string,
  snapshot: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!snapshot) return null;
  let match: string | null = null;
  for (const [rawPath, rawHash] of Object.entries(snapshot)) {
    if (normalizeArtifactPath(rawPath) !== path) continue;
    const normalizedHash = normalizeSha256(rawHash);
    if (normalizedHash === null) return null;
    if (match !== null && match !== normalizedHash) return null;
    match = normalizedHash;
  }
  return match;
}

function compileValidationReceipt(
  kind: FoldValidationReceipt['kind'],
  call: ReceiptToolCall,
  base: Omit<FoldReceiptBase, 'kind'>,
  currentHashes: Readonly<Record<string, string>> | undefined,
): FoldValidationReceipt {
  const result = parseValidationResult(call.resultText);
  const paths = validationArtifactPaths(call, result);
  const attestations = new Map<string, ValidationResultRecord>();
  if (Array.isArray(result?.artifact_hashes)) {
    for (const raw of result.artifact_hashes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const attestation = raw as ValidationResultRecord;
      const path = normalizeArtifactPath(attestation.path ?? attestation.file);
      if (path && !attestations.has(path)) attestations.set(path, attestation);
    }
  }

  const artifacts: FoldValidationArtifact[] = paths.map((path) => {
    const attestation = attestations.get(path);
    const contentUnavailable = attestation?.reason === 'content-unavailable';
    const changedDuringValidation = attestation?.stable_during_validation === false
      && !contentUnavailable;
    const hasStableAttestation = attestation?.stable_during_validation === true
      && !contentUnavailable;
    const validatedContentHash = hasStableAttestation
      ? normalizeSha256(attestation?.content_hash ?? attestation?.validated_content_hash)
      : null;
    const currentContentHash = currentArtifactHash(path, currentHashes);
    if (changedDuringValidation) {
      return {
        path,
        validatedContentHash,
        currentContentHash,
        freshness: 'unknown',
        freshnessReason: 'content-changed-during-validation',
      };
    }
    if (validatedContentHash === null) {
      return {
        path,
        validatedContentHash,
        currentContentHash,
        freshness: 'unknown',
        freshnessReason: 'validation-hash-missing',
      };
    }
    if (currentContentHash === null) {
      return {
        path,
        validatedContentHash,
        currentContentHash,
        freshness: 'unknown',
        freshnessReason: 'current-hash-missing',
      };
    }
    if (validatedContentHash !== currentContentHash) {
      return {
        path,
        validatedContentHash,
        currentContentHash,
        freshness: 'stale',
        freshnessReason: 'content-hash-mismatch',
      };
    }
    return {
      path,
      validatedContentHash,
      currentContentHash,
      freshness: 'fresh',
      freshnessReason: null,
    };
  });

  const stale = artifacts.find((artifact) => artifact.freshness === 'stale');
  const unknown = artifacts.find((artifact) => artifact.freshness === 'unknown');
  const freshness: FoldValidationFreshness = stale ? 'stale'
    : artifacts.length === 0 || unknown ? 'unknown'
      : 'fresh';
  const freshnessReason: FoldValidationFreshnessReason | null = stale?.freshnessReason
    ?? unknown?.freshnessReason
    ?? (artifacts.length === 0 ? 'validated-artifact-path-missing' : null);
  const explicitScope = typeof result?.scope === 'string' ? result.scope.trim() : '';
  const scope = explicitScope || `${kind}:${paths.join(',') || 'unknown'}`;

  return {
    ...base,
    recordType: 'validation',
    kind,
    scope,
    artifacts,
    freshness,
    freshnessReason,
  };
}

function renderToolErrorReceipt(call: ReceiptToolCall): string {
  const head = truncateReceipt(call.resultText.trim().split('\n')[0] ?? '', 110);
  return `⚠️ ${displayToolIdentity(call)} → ${head || 'error (no message)'}`;
}

function renderRailReceipt(call: ReceiptToolCall): string {
  const mode = String(call.input.mode ?? '');
  const op = String(call.input.operation ?? '');
  const step = String(call.input.step_id ?? call.input.ack_step_id ?? '');
  const status = String(call.input.ack_status ?? call.input.status ?? '');
  const acks = Array.isArray(call.input.acks) ? call.input.acks.length : 0;
  const detail = step ? ` ${step}${status ? `=${status}` : ''}` : acks > 0 ? ` ${acks} ack(s)` : '';
  return `📋 task_rail ${mode}${op ? `/${op}` : ''}${detail}`.trim();
}

function renderChatroomReceipt(call: ReceiptToolCall): string {
  const action = String(call.input.action ?? 'send');
  const room = String(call.input.room ?? call.input.name ?? '');
  const excerpt = action === 'send'
    ? ` — "${truncateReceipt(String(call.input.message ?? '').replace(/\s+/g, ' '), 60)}"`
    : '';
  return `💬 chatroom ${action} ${room}${excerpt}`.trim();
}

function renderSpawnReceipt(call: ReceiptToolCall): string {
  const name = String(call.input.name ?? call.input.fork_name ?? '');
  const target = String(call.input.target ?? '');
  const engine = String(call.input.engine ?? '');
  return `🌱 spawn ${target}${name ? ` ${name}` : ''}${engine ? ` (${engine})` : ''}`.trim();
}

function renderGitReceipt(call: ReceiptToolCall): string {
  const tool = shortToolName(call.name);
  const msg = truncateReceipt(String(call.input.message ?? ''), 50);
  const files = Array.isArray(call.input.files) ? `${call.input.files.length} file(s)` : '';
  return `📦 ${tool}${msg ? ` "${msg}"` : ''}${files ? ` ${files}` : ''}`;
}

/**
 * Actuator receipts name the tool and its most identifying target, because the
 * target is what makes an external effect auditable — which address, which
 * table, which device, which artifact. Falls back to the bare tool identity
 * when no known target field is present rather than inventing one.
 */
function renderActuatorReceipt(call: ReceiptToolCall): string {
  const input = call.input;
  const target = input.to ?? input.recipient ?? input.target ?? input.url
    ?? input.sql ?? input.query ?? input.file_path ?? input.path
    ?? input.name ?? input.subject ?? input.instance_id ?? input.message ?? '';
  const detail = truncateReceipt(String(target).replace(/\s+/g, ' ').trim(), 70);
  return `📡 ${displayToolIdentity(call)}${detail ? ` → ${detail}` : ''}`;
}

interface ParsedClaimTarget {
  subject: string;
  range: string | null;
  holder: string | null;
  targetIdentity: string;
}

function normalizedRange(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^:/, '');
  return /^\d+(?:-\d+)?$/.test(raw) ? raw : null;
}

function explicitHolder(input: Record<string, unknown>): string | null {
  const value = input.holder ?? input.holder_id ?? input.owner
    ?? input.owner_instance_id ?? input.instance_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseClaimTarget(
  claim: Record<string, unknown>,
  inheritedHolder: string | null,
): ParsedClaimTarget | null {
  const path = extractPath(claim);
  if (!path) return null;
  const inline = /^(.*):(\d+(?:-\d+)?)$/.exec(path);
  const subject = inline?.[1] || path;
  const range = inline?.[2] ?? normalizedRange(claim.range);
  const targetIdentity = range ? `${subject}:${range}` : subject;
  return {
    subject,
    range,
    holder: explicitHolder(claim) ?? inheritedHolder,
    targetIdentity,
  };
}

function claimTargets(input: Record<string, unknown>): ParsedClaimTarget[] {
  const targets: ParsedClaimTarget[] = [];
  const holder = explicitHolder(input);
  const push = (claim: Record<string, unknown>): void => {
    const target = parseClaimTarget(claim, holder);
    if (target && !targets.some((existing) => existing.targetIdentity === target.targetIdentity)) {
      targets.push(target);
    }
  };
  push(input);
  if (Array.isArray(input.claims)) {
    for (const raw of input.claims) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        push(raw as Record<string, unknown>);
      }
    }
  }
  return targets;
}

function renderClaimAction(call: ReceiptToolCall): string {
  const tool = shortToolName(call.name);
  const operation = tool === 'partner_release_file' ? 'release' : 'acquire';
  const target = claimTargets(call.input).map((item) => item.targetIdentity).join(', ') || 'unknown';
  return `🔐 claim ${operation} ${truncateReceipt(target, 90)}`;
}

interface ParsedDecision {
  subject: string;
  subjectIsExplicit: boolean;
  statement: string;
  range: string | null;
  holder: string | null;
  supersedesDecisionIds: string[];
}

/** Shared fold/rebirth gate for categorized decision pins. */
export function isFoldDecisionToolInput(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): boolean {
  if (shortToolName(toolName) !== 'tap_star') return false;
  const action = String(input.action ?? 'pin').trim().toLowerCase();
  return String(input.category ?? '').trim().toLowerCase() === 'decision'
    && input.harvest !== true
    && action === 'pin';
}

function isDecisionCall(call: ReceiptToolCall): boolean {
  return isFoldDecisionToolInput(call.name, call.input);
}

function parseDecision(call: ReceiptToolCall): ParsedDecision {
  const note = typeof call.input.note === 'string' ? call.input.note.trim() : '';
  const lines = note.split(/\r?\n/);
  const subjectLine = lines.find((line) => /^\s*(?:subject|topic)\s*[:=]/i.test(line));
  const explicitSubject = typeof call.input.subject === 'string' && call.input.subject.trim()
    ? call.input.subject.trim()
    : subjectLine?.replace(/^\s*(?:subject|topic)\s*[:=]\s*/i, '').trim() || '';
  const supersedes: string[] = [];
  const pushSupersedes = (value: unknown): void => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== 'string') continue;
      for (const identity of item.split(/\s*,\s*/).map((entry) => entry.trim()).filter(Boolean)) {
        if (!supersedes.includes(identity)) supersedes.push(identity);
      }
    }
  };
  pushSupersedes(call.input.supersedes ?? call.input.supersedes_decision);
  for (const line of lines) {
    const match = /^\s*supersedes(?:-decision)?\s*[:=]\s*(.+)$/i.exec(line);
    if (match) pushSupersedes(match[1]);
  }
  const statement = lines
    .filter((line) => !/^\s*(?:subject|topic|supersedes(?:-decision)?)\s*[:=]/i.test(line))
    .join('\n')
    .trim() || note || 'decision statement unavailable';
  const fallbackSubject = statement.split(/\r?\n/, 1)[0]?.trim() || 'unknown';
  return {
    subject: explicitSubject || fallbackSubject,
    subjectIsExplicit: explicitSubject.length > 0,
    statement,
    range: normalizedRange(call.input.range),
    holder: explicitHolder(call.input),
    supersedesDecisionIds: supersedes,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Classification
// ══════════════════════════════════════════════════════════════════════

type CallLane =
  | { lane: 'receipt'; kind: FoldReceiptKind }
  | { lane: 'read' }
  | { lane: 'search' }
  | { lane: 'navigation' }
  | { lane: 'orchestration' }
  | { lane: 'other' };

function classifyDurableActionKind(call: ReceiptToolCall): FoldDurableActionKind | null {
  const short = shortToolName(call.name);
  if (EDIT_TOOLS.has(call.name) || EDIT_TOOLS.has(short)) return 'edit';
  if (WRITE_TOOLS.has(call.name) || WRITE_TOOLS.has(short)) return 'write';
  if (BASH_TOOLS.has(call.name) || BASH_TOOLS.has(short)) {
    const cmd = String(call.input.command ?? '');
    if (TEST_COMMAND_RE.test(cmd) || TSC_COMMAND_RE.test(cmd)) return null;
    return isMutatingBash(call.input) ? 'bash-mutation' : null;
  }
  if (GIT_MUTATION_TOOLS.has(short)) return 'git-op';
  if (ATLAS_COMMIT_TOOLS.has(short)) return 'atlas-commit';
  if (SPAWN_TOOLS.has(short)) return 'spawn';
  if (LIFECYCLE_TOOLS.has(short)) return 'lifecycle';
  if (ACTUATOR_TOOLS.has(call.name) || ACTUATOR_TOOLS.has(short)) return 'actuator';
  if (short === 'task_rail') {
    const mode = String(call.input.mode ?? '');
    const op = String(call.input.operation ?? '');
    if (mode === 'shoot' || mode === 'sprint') return 'rail-op';
    if ((mode === 'load' || mode === 'draft' || mode === 'template' || mode === 'role')
      && RAIL_MUTATING_OPS.has(op)) return 'rail-op';
  }
  if (short === 'chatroom') {
    const action = String(call.input.action ?? 'send');
    if (CHATROOM_MUTATING_ACTIONS.has(action)) return 'chatroom-post';
  }
  return null;
}

function classifyCall(call: ReceiptToolCall, errorIds: Set<string>): CallLane {
  const short = shortToolName(call.name);
  const isError = errorIds.has(call.toolId) || resultOpensWithError(call.resultText);

  if (isDecisionCall(call)) return { lane: 'receipt', kind: 'decision' };
  if (CLAIM_TOOLS.has(short)) return { lane: 'receipt', kind: 'claim-op' };

  const actionKind = classifyDurableActionKind(call);
  if (actionKind) return { lane: 'receipt', kind: actionKind };

  // Errors always promote — a failed call is semantically load-bearing even
  // when the call itself was read-only. Durable actions were classified first
  // so their typed record can retain both the attempted action and failure.
  if (isError) return { lane: 'receipt', kind: 'tool-error' };

  if (BASH_TOOLS.has(call.name) || BASH_TOOLS.has(short)) {
    const cmd = String(call.input.command ?? '');
    if (TEST_COMMAND_RE.test(cmd)) return { lane: 'receipt', kind: 'test-run' };
    if (TSC_COMMAND_RE.test(cmd)) return { lane: 'receipt', kind: 'typecheck' };
    return SHELL_SEARCH_COMMAND_RE.test(cmd) ? { lane: 'search' } : { lane: 'read' };
  }

  if (short === 'run_tests') return { lane: 'receipt', kind: 'test-run' };
  if (TYPECHECK_TOOLS.has(short)) return { lane: 'receipt', kind: 'typecheck' };
  if (short === 'task_rail') {
    return { lane: 'navigation' };
  }

  if (short === 'chatroom') {
    return { lane: 'navigation' };
  }

  if (READ_TOOLS.has(call.name) || READ_TOOLS.has(short)) return { lane: 'read' };
  if (SEARCH_TOOLS.has(call.name) || SEARCH_TOOLS.has(short)) return { lane: 'search' };
  if (NAVIGATION_TOOLS.has(call.name) || NAVIGATION_TOOLS.has(short)) return { lane: 'navigation' };
  if (ORCHESTRATION_TOOLS.has(call.name) || ORCHESTRATION_TOOLS.has(short)) return { lane: 'orchestration' };

  return { lane: 'other' };
}

function receiptText(kind: FoldReceiptKind, call: ReceiptToolCall): string {
  switch (kind) {
    case 'test-run': return renderTestRunReceipt(call);
    case 'typecheck': return renderTypecheckReceipt(call);
    case 'tool-error': return renderToolErrorReceipt(call);
    case 'rail-op': return renderRailReceipt(call);
    case 'chatroom-post': return renderChatroomReceipt(call);
    case 'actuator': return renderActuatorReceipt(call);
    case 'claim-op': return renderClaimAction(call);
    case 'decision': return `⭐ decision ${truncateReceipt(parseDecision(call).statement, 110)}`;
    case 'spawn': return renderSpawnReceipt(call);
    case 'lifecycle': return `💀 ${shortToolName(call.name)} ${truncateReceipt(String(call.input.target ?? call.input.instance ?? ''), 30)}`.trim();
    case 'git-op': return renderGitReceipt(call);
    // edit / write / bash-mutation / atlas-commit: skeletonizeTool already
    // renders the canonical one-liner for these — byte-parity with what the
    // skeleton showed keeps the consumer's learned grammar stable.
    default: return skeletonizeTool(call);
  }
}

function targetIdentity(kind: FoldReceiptKind, call: ReceiptToolCall): string {
  switch (kind) {
    case 'edit':
    case 'write': return extractPath(call.input);
    case 'atlas-commit': return extractPath(call.input);
    case 'chatroom-post': return String(call.input.room ?? call.input.name ?? '');
    case 'rail-op': return String(call.input.step_id ?? call.input.ack_step_id ?? '');
    case 'claim-op': return claimTargets(call.input).map((target) => target.targetIdentity).join('|');
    case 'decision': return parseDecision(call).subject;
    default: return '';
  }
}

// ══════════════════════════════════════════════════════════════════════
// Compiler
// ══════════════════════════════════════════════════════════════════════

const MAX_AGGREGATE_PATHS = 6;
const MAX_AGGREGATE_QUERIES = 4;
const DEFAULT_LITERAL_CAP = 36;

function queryOf(call: ReceiptToolCall): string {
  const q = call.input.pattern ?? call.input.query ?? call.input.search ?? call.input.command ?? '';
  return truncateReceipt(String(q).replace(/\s+/g, ' '), 40);
}

type ProseShapedMessage = FoldMessage & { parts?: unknown };

/**
 * Whether a turn carries prose a successor would actually read. Fold windows
 * arrive in engine-native shapes: a bare string from some hosts, Anthropic
 * content blocks from others, Gemini `parts` from a third. Testing only the
 * string shape reported zero narrated turns for every production window,
 * because the block shapes *are* the production shapes. Reasoning/thinking
 * blocks are excluded — they are not delivered prose.
 */
function hasAssistantProse(message: FoldMessage): boolean {
  if (message.role !== 'assistant' && message.role !== 'model') return false;
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  const parts = (message as ProseShapedMessage).parts;
  const blocks: unknown[] = Array.isArray(content)
    ? content
    : Array.isArray(parts) ? parts : [];
  return blocks.some((block) => {
    if (!block || typeof block !== 'object') return false;
    const rec = block as Record<string, unknown>;
    if ('type' in rec && rec.type !== 'text' && rec.type !== 'output_text') return false;
    return typeof rec.text === 'string' && rec.text.trim().length > 0;
  });
}

export function compileFoldReceipts(
  windowMessages: readonly FoldMessage[],
  options: FoldReceiptCompileOptions = {},
): FoldReceiptCompile {
  const completedCalls = extractToolCalls(windowMessages as FoldMessage[])
    .map((call) => normalizeReceiptToolCall(call, windowMessages, 'completed'));
  const pendingActions = extractPendingToolCalls(windowMessages)
    .map((call) => normalizeReceiptToolCall(call, windowMessages, 'pending'))
    .filter((call) => classifyDurableActionKind(call) !== null
      || CLAIM_TOOLS.has(shortToolName(call.name))
      || isDecisionCall(call));
  const calls = [...completedCalls, ...pendingActions]
    .sort((left, right) => left.messageIndex - right.messageIndex);
  const errorIds = collectErrorToolIds(windowMessages);
  const literalCap = options.literalCap ?? DEFAULT_LITERAL_CAP;

  const receipts: FoldReceipt[] = [];
  const aggregates: InvestigationAggregate[] = [];
  const counts: FoldReceiptCounts = {
    edits: 0, writes: 0, bashMutations: 0, testRuns: 0, typechecks: 0,
    gitOps: 0, toolErrors: 0, railOps: 0, atlasCommits: 0, spawns: 0,
    lifecycleOps: 0, chatroomPosts: 0, actuators: 0, claimEvents: 0, claimBursts: 0,
    decisionEvents: 0,
    readEvents: 0, searchEvents: 0, navigationEvents: 0, orchestrationEvents: 0,
    otherEvents: 0, otherToolCounts: [],
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

  let run: { lane: FoldAggregateLane; calls: ReceiptToolCall[] } | null = null;
  const flushRun = (): void => {
    if (!run || run.calls.length === 0) { run = null; return; }
    // Collect every distinct value first, then cap. Capping during collection
    // discarded the overflow without recording that it existed, so a 40-read
    // run rendered six paths and read as though those six were all of them.
    const distinctPaths: string[] = [];
    const distinctQueries: string[] = [];
    for (const c of run.calls) {
      const p = extractPath(c.input);
      if (p && !distinctPaths.includes(p)) distinctPaths.push(p);
      const q = queryOf(c);
      if (q && !distinctQueries.includes(q)) distinctQueries.push(q);
      pushLiterals(c.resultText);
    }
    const paths = distinctPaths.slice(0, MAX_AGGREGATE_PATHS);
    const queries = distinctQueries.slice(0, MAX_AGGREGATE_QUERIES);
    const toolCountMap = new Map<string, number>();
    for (const c of run.calls) {
      const name = c.exactToolIdentity;
      toolCountMap.set(name, (toolCountMap.get(name) ?? 0) + 1);
    }
    const messageIndexes = run.calls.map((call) => call.messageIndex);
    const firstMessageIndex = Math.min(...messageIndexes);
    const lastMessageIndex = Math.max(...messageIndexes);
    const sourceOrderedCalls = [...run.calls].sort((left, right) => {
      const leftTime = typeof left.tsMs === 'number' && Number.isFinite(left.tsMs) ? left.tsMs : null;
      const rightTime = typeof right.tsMs === 'number' && Number.isFinite(right.tsMs) ? right.tsMs : null;
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
      if (leftTime !== null && rightTime === null) return -1;
      if (leftTime === null && rightTime !== null) return 1;
      const leftKey = left.sourceIdentity
        ?? `unknown:${left.exactToolIdentity}:${JSON.stringify(left.input)}:${left.resultText}`;
      const rightKey = right.sourceIdentity
        ?? `unknown:${right.exactToolIdentity}:${JSON.stringify(right.input)}:${right.resultText}`;
      return leftKey.localeCompare(rightKey);
    });
    const sourceTimes = sourceOrderedCalls
      .map((call) => call.tsMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const sourceIdentities = sourceOrderedCalls
      .map((call) => call.sourceIdentity)
      .filter((value): value is string => value !== null);
    const sourceIdentity = sourceIdentities.length === 0
      ? null
      : sourceIdentities.length === 1
        ? sourceIdentities[0]
        : `${sourceIdentities[0]}..${sourceIdentities[sourceIdentities.length - 1]}`;
    aggregates.push({
      eventCount: run.calls.length,
      paths,
      omittedPathCount: distinctPaths.length - paths.length,
      // Every lane keeps its argument digest. Restricting this to the search
      // lane is what produced contentless `reads ×N` lines: a shell-shaped run
      // whose extractPath finds no path had no surviving content whatsoever.
      queries,
      omittedQueryCount: distinctQueries.length - queries.length,
      messageIndex: firstMessageIndex,
      endMessageIndex: lastMessageIndex,
      lane: run.lane,
      toolCounts: [...toolCountMap].map(([name, count]) => ({ name, count })),
      sourceStartTimeMs: sourceTimes.length > 0 ? Math.min(...sourceTimes) : null,
      sourceEndTimeMs: sourceTimes.length > 0 ? Math.max(...sourceTimes) : null,
      unknownSourceTimeCount: run.calls.length - sourceTimes.length,
      unknownSourceIdentityCount: run.calls.length - sourceIdentities.length,
      sourceIdentity,
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
      const kind = lane.kind;
      if (kind === 'claim-op') {
        counts.claimEvents += 1;
        claimBurst += 1;
      } else {
        flushClaimBurst();
      }
      const sourceTimeMs = typeof call.tsMs === 'number' ? call.tsMs : null;
      const actionIdentity = call.sourceIdentity ?? `tool-call:${call.toolId || 'unknown'}`;
      if (kind === 'claim-op') {
        const operation = shortToolName(call.name) === 'partner_release_file' ? 'release' : 'acquire';
        const parsedTargets = claimTargets(call.input);
        const targets = parsedTargets.length > 0 ? parsedTargets : [{
          subject: 'unknown', range: null, holder: explicitHolder(call.input), targetIdentity: 'unknown',
        }];
        for (const target of targets) {
          const outcome = resolveClaimTargetOutcome(call, errorIds, target);
          const claimId = targets.length === 1
            ? actionIdentity
            : `${actionIdentity}#target:${encodeURIComponent(target.targetIdentity)}`;
          receipts.push({
            recordType: 'claim',
            kind: 'claim-op',
            text: `🔐 claim ${operation} ${truncateReceipt(target.targetIdentity, 90)}`,
            targetIdentity: target.targetIdentity,
            messageIndex: call.messageIndex,
            sourceTimeMs,
            sourceIdentity: call.sourceIdentity,
            superseded: false,
            claimId,
            toolCallId: call.toolId,
            operation,
            subject: target.subject,
            range: target.range,
            holder: target.holder,
            outcome,
            reconciliationRequired: outcome === 'unknown',
            lifecycleState: outcome === 'unknown' ? 'unknown'
              : outcome === 'failed' ? 'failed'
                : operation === 'release' ? 'released' : 'active',
            terminalizedByIdentity: null,
          });
        }
        pushLiterals(call.resultText);
        continue;
      }
      if (kind === 'decision') {
        counts.decisionEvents += 1;
        const decision = parseDecision(call);
        const outcome = resolveActionOutcome(call, errorIds);
        receipts.push({
          recordType: 'decision',
          kind: 'decision',
          text: `⭐ decision ${truncateReceipt(decision.statement, 110)}`,
          targetIdentity: decision.range
            ? `${decision.subject}:${decision.range}`
            : decision.subject,
          messageIndex: call.messageIndex,
          sourceTimeMs,
          sourceIdentity: call.sourceIdentity,
          superseded: false,
          decisionId: actionIdentity,
          toolCallId: call.toolId,
          subject: decision.subject,
          subjectIsExplicit: decision.subjectIsExplicit,
          statement: decision.statement,
          range: decision.range,
          holder: decision.holder,
          outcome,
          reconciliationRequired: outcome === 'unknown',
          lifecycleState: outcome === 'unknown' ? 'unknown'
            : outcome === 'failed' ? 'failed' : 'current',
          supersedesDecisionIds: decision.supersedesDecisionIds,
          supersededByIdentity: null,
          authority: 'recorded-pointer',
        });
        pushLiterals(call.resultText);
        continue;
      }
      const base = {
        text: receiptText(kind, call),
        targetIdentity: targetIdentity(kind, call),
        messageIndex: call.messageIndex,
        sourceTimeMs,
        sourceIdentity: call.sourceIdentity,
        superseded: false,
      };
      const actionKind = classifyDurableActionKind(call);
      if (actionKind) {
        const outcome = resolveActionOutcome(call, errorIds);
        receipts.push({
          ...base,
          recordType: 'action',
          kind: actionKind,
          actionId: actionIdentity,
          toolCallId: call.toolId,
          outcome,
          reconciliationRequired: outcome === 'unknown',
        });
      } else if (kind === 'test-run' || kind === 'typecheck') {
        receipts.push(compileValidationReceipt(kind, call, base, options.currentArtifactHashes));
      } else {
        receipts.push({ ...base, recordType: 'receipt', kind: 'tool-error' });
      }
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
      else if (kind === 'actuator') counts.actuators += 1;
      pushLiterals(call.resultText);
    } else {
      flushClaimBurst();
      if (!run || run.lane !== lane.lane) {
        flushRun();
        run = { lane: lane.lane, calls: [] };
      }
      run.calls.push(call);
      if (lane.lane === 'read') counts.readEvents += 1;
      else if (lane.lane === 'search') counts.searchEvents += 1;
      else if (lane.lane === 'navigation') counts.navigationEvents += 1;
      else if (lane.lane === 'orchestration') counts.orchestrationEvents += 1;
      else {
        counts.otherEvents += 1;
        const name = call.exactToolIdentity;
        const existing = counts.otherToolCounts.find((entry) => entry.name === name);
        if (existing) existing.count += 1;
        else counts.otherToolCounts.push({ name, count: 1 });
      }
    }
  }
  flushRun();
  flushClaimBurst();

  // Lifecycle is derived only from typed, applied evidence in this window.
  // A later unknown/failed mutation cannot retire an elder active state. A
  // release in a later frozen band remains a new terminal overlay row; this
  // pass never reaches back to mutate bytes from an earlier band.
  const activeClaims: FoldClaimRecord[] = [];
  for (const receipt of receipts) {
    if (receipt.recordType !== 'claim' || receipt.outcome !== 'applied'
      || receipt.subject === 'unknown') continue;
    if (receipt.operation === 'release') {
      for (let index = activeClaims.length - 1; index >= 0; index -= 1) {
        const active = activeClaims[index];
        const sameSubject = active.subject === receipt.subject;
        const matchingRange = receipt.range === null || active.range === receipt.range;
        if (!sameSubject || !matchingRange) continue;
        active.lifecycleState = 'released';
        active.terminalizedByIdentity = receipt.claimId;
        activeClaims.splice(index, 1);
      }
      continue;
    }
    for (let index = activeClaims.length - 1; index >= 0; index -= 1) {
      const active = activeClaims[index];
      if (active.targetIdentity !== receipt.targetIdentity) continue;
      active.lifecycleState = 'superseded';
      active.terminalizedByIdentity = receipt.claimId;
      active.superseded = true;
      activeClaims.splice(index, 1);
    }
    activeClaims.push(receipt);
  }

  const decisionByIdentity = new Map<string, FoldDecisionRecord>();
  const currentDecisionBySubject = new Map<string, FoldDecisionRecord>();
  for (const receipt of receipts) {
    if (receipt.recordType !== 'decision') continue;
    const registerIdentity = (identity: string | null): void => {
      if (identity) decisionByIdentity.set(identity, receipt);
    };
    if (receipt.lifecycleState === 'current') {
      const predecessors = new Set<FoldDecisionRecord>();
      for (const identity of receipt.supersedesDecisionIds) {
        const predecessor = decisionByIdentity.get(identity);
        if (predecessor) predecessors.add(predecessor);
      }
      const subjectKey = `${receipt.subject}\u0000${receipt.range ?? ''}`;
      if (receipt.subjectIsExplicit) {
        const predecessor = currentDecisionBySubject.get(subjectKey);
        if (predecessor) predecessors.add(predecessor);
      }
      for (const predecessor of predecessors) {
        if (predecessor === receipt || predecessor.lifecycleState !== 'current') continue;
        predecessor.lifecycleState = 'superseded';
        predecessor.supersededByIdentity = receipt.decisionId;
        predecessor.superseded = true;
      }
      if (receipt.subjectIsExplicit) currentDecisionBySubject.set(subjectKey, receipt);
    }
    registerIdentity(receipt.decisionId);
    registerIdentity(receipt.toolCallId);
    registerIdentity(receipt.sourceIdentity);
  }

  // Supersession: within superseding classes, a newer receipt for the same
  // target outranks elders. Elders stay rendered (chronological receipts are
  // evidence) but carry the flag so budgeted renderers may elide them first.
  const newestByTarget = new Map<string, { receiptIndex: number; messageIndex: number }>();
  receipts.forEach((r, i) => {
    if (!r.targetIdentity) return;
    if (r.kind !== 'edit' && r.kind !== 'write' && r.kind !== 'atlas-commit') return;
    if (r.recordType === 'action' && r.outcome !== 'applied') return;
    const key = `${r.kind}:${r.targetIdentity}`;
    const newest = newestByTarget.get(key);
    if (!newest || r.messageIndex > newest.messageIndex
      || (r.messageIndex === newest.messageIndex && i > newest.receiptIndex)) {
      newestByTarget.set(key, { receiptIndex: i, messageIndex: r.messageIndex });
    }
  });
  receipts.forEach((r, i) => {
    if (!r.targetIdentity) return;
    const newest = newestByTarget.get(`${r.kind}:${r.targetIdentity}`);
    if (newest && (r.messageIndex < newest.messageIndex
      || (r.messageIndex === newest.messageIndex && i < newest.receiptIndex))) {
      r.superseded = true;
    }
  });

  counts.proseTurns = windowMessages.filter(hasAssistantProse).length;

  return { receipts, aggregates, conservedLiterals: literalPool, counts };
}

// ══════════════════════════════════════════════════════════════════════
// Renderer
// ══════════════════════════════════════════════════════════════════════

export type FoldReceiptTimelineItem =
  | { sourceTimeMs: number | null; sourceIdentity: string | null; stableKey: string; receipt: FoldReceipt }
  | { sourceTimeMs: number | null; sourceIdentity: string | null; stableKey: string; aggregate: InvestigationAggregate };

/**
 * Produce one deterministic temporal stream for receipts and aggregates.
 * Authoritative times win; stable provenance identities break equal-time ties.
 * Unknown-time artifacts are quarantined after known chronology and ordered by
 * stable identity (or deterministic content when the host supplied no identity).
 */
export function chronologicalFoldReceiptItems(
  compile: Pick<FoldReceiptCompile, 'receipts' | 'aggregates'>,
): FoldReceiptTimelineItem[] {
  const items: FoldReceiptTimelineItem[] = [
    ...compile.receipts.map((receipt) => ({
      sourceTimeMs: receipt.sourceTimeMs,
      sourceIdentity: receipt.sourceIdentity,
      stableKey: receipt.recordType === 'claim' ? receipt.claimId
        : receipt.recordType === 'decision' ? receipt.decisionId
          : receipt.sourceIdentity ?? `unknown-receipt:${receipt.kind}:${receipt.targetIdentity}:${receipt.text}`,
      receipt,
    })),
    ...compile.aggregates.map((aggregate) => ({
      sourceTimeMs: aggregate.sourceStartTimeMs,
      sourceIdentity: aggregate.sourceIdentity,
      stableKey: aggregate.sourceIdentity
        ?? `unknown-aggregate:${aggregate.lane}:${aggregate.paths.join('|')}:${aggregate.queries.join('|')}`,
      aggregate,
    })),
  ];
  return items.sort((left, right) => {
    const leftReconciliation = 'receipt' in left
      && 'reconciliationRequired' in left.receipt
      && left.receipt.reconciliationRequired;
    const rightReconciliation = 'receipt' in right
      && 'reconciliationRequired' in right.receipt
      && right.receipt.reconciliationRequired;
    if (leftReconciliation !== rightReconciliation) return leftReconciliation ? -1 : 1;
    const leftKnown = left.sourceTimeMs !== null;
    const rightKnown = right.sourceTimeMs !== null;
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown && left.sourceTimeMs !== right.sourceTimeMs) {
      return (left.sourceTimeMs as number) - (right.sourceTimeMs as number);
    }
    return left.stableKey.localeCompare(right.stableKey);
  });
}

function aggregateTimePrefix(aggregate: InvestigationAggregate): string {
  if (aggregate.sourceStartTimeMs === null || aggregate.sourceEndTimeMs === null) {
    return '[time unknown]';
  }
  const start = formatFoldTime(aggregate.sourceStartTimeMs).slice(1, -1);
  const end = formatFoldTime(aggregate.sourceEndTimeMs).slice(1, -1);
  const span = start === end ? start : `${start}..${end}`;
  const partial = aggregate.unknownSourceTimeCount > 0
    ? `; ${aggregate.unknownSourceTimeCount} time unknown`
    : '';
  return `[${span}${partial}]`;
}

/** Render one aggregate with time span and stable source identity intact. */
export function renderFoldAggregateLine(aggregate: InvestigationAggregate): string {
  const icon = aggregate.lane === 'read' ? '📖'
    : aggregate.lane === 'search' ? '🔍'
      : aggregate.lane === 'navigation' ? '🧭'
        : aggregate.lane === 'orchestration' ? '⚙️'
          : '🔧';
  const pathDetail = aggregate.paths.length
    ? `paths: ${aggregate.paths.join(', ')}`
      + (aggregate.omittedPathCount > 0 ? ` (+${aggregate.omittedPathCount} more)` : '')
    : '';
  // Non-search lanes carry commands and arguments too; labelling them "args"
  // keeps a shell or orchestration run from rendering as a bare count.
  const argLabel = aggregate.lane === 'search' ? 'queries' : 'args';
  const queryDetail = aggregate.queries.length
    ? `${argLabel}: ${aggregate.queries.map((query) => `"${query}"`).join(', ')}`
      + (aggregate.omittedQueryCount > 0 ? ` (+${aggregate.omittedQueryCount} more)` : '')
    : '';
  const detailParts = [pathDetail, queryDetail].filter(Boolean);
  const detail = detailParts.length ? ` — ${detailParts.join('; ')}` : '';
  const label = aggregate.lane === 'read' ? 'reads'
    : aggregate.lane === 'search' ? 'searches'
      : aggregate.lane === 'other'
        ? `tools: ${aggregate.toolCounts.map(({ name, count }) => `${name} ×${count}`).join(' · ')}`
        : aggregate.lane;
  const unknownIdentity = aggregate.unknownSourceIdentityCount > 0
    ? `; ${aggregate.unknownSourceIdentityCount} source unknown`
    : '';
  return `${aggregateTimePrefix(aggregate)} ${icon} ${label}`
    + `${aggregate.lane === 'other' ? '' : ` ×${aggregate.eventCount}`}${detail}`
    + ` ↞ source=${aggregate.sourceIdentity ?? 'unknown'}${unknownIdentity}`;
}

/** Render one typed claim lifecycle row, including terminal and unknown state. */
export function renderFoldClaimRecord(receipt: FoldClaimRecord): string {
  const time = receipt.sourceTimeMs !== null ? formatFoldTime(receipt.sourceTimeMs) : '[time unknown]';
  const reconciliation = receipt.reconciliationRequired ? '⚠️ RECONCILIATION REQUIRED · ' : '';
  const terminalizedBy = receipt.terminalizedByIdentity
    ? ` terminalized-by=${JSON.stringify(receipt.terminalizedByIdentity)}`
    : '';
  return `${time} ${reconciliation}CLAIM operation=${receipt.operation}`
    + ` state=${receipt.lifecycleState} outcome=${receipt.outcome}`
    + ` reconciliation-required=${receipt.reconciliationRequired}`
    + ` subject=${JSON.stringify(receipt.subject)}`
    + ` range=${JSON.stringify(receipt.range ?? 'whole-file')}`
    + ` holder=${JSON.stringify(receipt.holder ?? 'unknown')}`
    + ` claim-id=${JSON.stringify(receipt.claimId)}${terminalizedBy}`
    + ` ↞ source=${receipt.sourceIdentity ?? 'unknown'}`;
}

/** Render one decision pointer. Lifecycle does not elevate it into proof. */
export function renderFoldDecisionRecord(receipt: FoldDecisionRecord): string {
  const time = receipt.sourceTimeMs !== null ? formatFoldTime(receipt.sourceTimeMs) : '[time unknown]';
  const reconciliation = receipt.reconciliationRequired ? '⚠️ RECONCILIATION REQUIRED · ' : '';
  const supersedes = receipt.supersedesDecisionIds.length > 0
    ? ` supersedes=${JSON.stringify(receipt.supersedesDecisionIds)}`
    : '';
  const supersededBy = receipt.supersededByIdentity
    ? ` superseded-by=${JSON.stringify(receipt.supersededByIdentity)}`
    : '';
  return `${time} ${reconciliation}DECISION state=${receipt.lifecycleState}`
    + ` outcome=${receipt.outcome} reconciliation-required=${receipt.reconciliationRequired}`
    + ` authority=${receipt.authority} subject=${JSON.stringify(receipt.subject)}`
    + ` subject-explicit=${receipt.subjectIsExplicit}`
    + ` range=${JSON.stringify(receipt.range ?? 'unspecified')}`
    + ` holder=${JSON.stringify(receipt.holder ?? 'unknown')}`
    + ` decision-id=${JSON.stringify(receipt.decisionId)}${supersedes}${supersededBy}`
    + ` statement=${JSON.stringify(truncateReceipt(receipt.statement, 180))}`
    + ` ↞ source=${receipt.sourceIdentity ?? 'unknown'}`;
}

/** Render the shared chronological receipt/aggregate stream without a header. */
export function renderFoldReceiptTimeline(
  compile: Pick<FoldReceiptCompile, 'receipts' | 'aggregates'>,
): string[] {
  return chronologicalFoldReceiptItems(compile).map((item) => {
    if ('receipt' in item) {
      const receipt = item.receipt;
      if (receipt.recordType === 'claim') return renderFoldClaimRecord(receipt);
      if (receipt.recordType === 'decision') return renderFoldDecisionRecord(receipt);
      const time = receipt.sourceTimeMs !== null
        ? formatFoldTime(receipt.sourceTimeMs)
        : '[time unknown]';
      const supersededMark = receipt.superseded ? ' (superseded)' : '';
      if (receipt.recordType === 'action') {
        const reconciliation = receipt.reconciliationRequired ? '⚠️ RECONCILIATION REQUIRED · ' : '';
        const target = receipt.targetIdentity || 'unknown';
        return `${time} ${reconciliation}ACTION kind=${receipt.kind} outcome=${receipt.outcome}`
          + ` reconciliation-required=${receipt.reconciliationRequired} target=${JSON.stringify(target)}`
          + ` action-id=${JSON.stringify(receipt.actionId)} — ${receipt.text}${supersededMark}`
          + ` ↞ source=${receipt.sourceIdentity ?? 'unknown'}`;
      }
      if (receipt.recordType === 'validation') {
        const icon = receipt.freshness === 'fresh' ? '✅'
          : receipt.freshness === 'stale' ? '⚠️'
            : '❔';
        const reason = receipt.freshnessReason ? ` reason=${receipt.freshnessReason}` : '';
        const artifacts = receipt.artifacts.length > 0
          ? receipt.artifacts.map((artifact) => {
              const validated = artifact.validatedContentHash ?? 'hash-unknown';
              const current = artifact.currentContentHash === null
                ? 'current-unknown'
                : artifact.currentContentHash === artifact.validatedContentHash
                  ? 'current-match'
                  : `current=${artifact.currentContentHash}`;
              return `${JSON.stringify(artifact.path)}@${validated}[${current}]`;
            }).join(',')
          : 'none';
        return `${time} ${icon} VALIDATION freshness=${receipt.freshness}${reason}`
          + ` scope=${JSON.stringify(receipt.scope)} artifacts=${artifacts}`
          + ` — ${receipt.text}${supersededMark}`
          + ` ↞ source=${receipt.sourceIdentity ?? 'unknown'}`;
      }
      return `${time} ${receipt.text}${supersededMark} ↞ source=${receipt.sourceIdentity ?? 'unknown'}`;
    }
    return renderFoldAggregateLine(item.aggregate);
  });
}

/**
 * Render the artifact-mode band body lines: totality header, then
 * chronological receipts interleaved with investigation aggregates, then the
 * conserved-literal pool. Deterministic for identical input.
 *
 * Timestamp policy: a missing source time always renders `[time unknown]`.
 * Unknown rows are never allowed to masquerade as ordinary chronology.
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
  if (counts.claimEvents) receiptParts.push(`${counts.claimEvents} claim event(s) in ${counts.claimBursts} burst(s)`);
  if (counts.decisionEvents) receiptParts.push(`${counts.decisionEvents} decision record(s)`);
  if (counts.spawns) receiptParts.push(`${counts.spawns} spawn(s)`);
  if (counts.lifecycleOps) receiptParts.push(`${counts.lifecycleOps} lifecycle`);
  if (counts.chatroomPosts) receiptParts.push(`${counts.chatroomPosts} chat`);
  if (counts.actuators) receiptParts.push(`${counts.actuators} actuator(s)`);
  const aggParts: string[] = [];
  if (counts.readEvents) aggParts.push(`${counts.readEvents} read${counts.readEvents === 1 ? '' : 's'}`);
  if (counts.searchEvents) aggParts.push(`${counts.searchEvents} search${counts.searchEvents === 1 ? '' : 'es'}`);
  if (counts.navigationEvents) aggParts.push(`${counts.navigationEvents} navigation`);
  if (counts.orchestrationEvents) aggParts.push(`${counts.orchestrationEvents} orchestration`);
  if (counts.otherEvents) {
    const named = counts.otherToolCounts
      .map(({ name, count }) => `${name} ×${count}`)
      .join(' · ');
    aggParts.push(`${counts.otherEvents} named tool call(s)${named ? ` (${named})` : ''}`);
  }

  lines.push(
    `[Fold receipts — ${counts.totalToolCalls} tool call(s): ${receiptParts.join(' · ') || 'none'}`
    + `${aggParts.length ? ` | aggregated: ${aggParts.join(' · ')}` : ''}`
    // Prose is the other half of what artifact mode replaces. A header that
    // accounts only for tool calls reads as though narration was preserved.
    + ` | ${counts.proseTurns} narrated turn(s) folded`
    + ` | dropped: bookkeeping rows ride counts only; raw history recoverable via recall]`,
  );

  lines.push(...renderFoldReceiptTimeline(compile));

  if (conservedLiterals.length > 0) {
    lines.push(`⌖ literals: ${conservedLiterals.join(' · ')}`);
  }
  return lines;
}
