/**
 * Pure Claude Code CLI rolling-fold parity core.
 *
 * WHY: FC API sessions (Claude/OpenAI Responses driven by the relay) get inline
 * rolling-fold compaction every turn — the relay rewrites the model-visible
 * history before each request. The headless Claude Code CLI (`claude --print
 * --input-format stream-json --resume <id>`) cannot: Claude Code owns its own
 * conversation history and persists it to disk at
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * as a `uuid`/`parentUuid` DAG anchored by a `last-prompt.leafUuid` pointer.
 * There is no inline compaction hook. So claude-cli has been hard-epoch-only
 * (session-swap rebirth at the pressure ceiling) with no mid-stream fold.
 *
 * This module gives claude-cli the SAME whole-transcript refold transport codex and
 * gemini use: reconstruct the folded context an FC session would have had — from
 * the canonical relay transcript — and serialize it into Claude Code's on-disk
 * JSONL turn lines. The caller (claudeCliSession wiring) reads the transcript
 * async (worker-backed), and at a fold epoch tears the process down, rewrites
 * the on-disk JSONL with this folded chain, and respawns `claude --resume`. The
 * resumed model then sees the relay's fold skeleton instead of carrying the full
 * raw history (or Claude Code's own lossy auto-compaction).
 *
 * TRANSPORT (Gemini-style, PROVEN against the live binary): claude --resume
 * reads a rewritten/synthetic JSONL chain. A minimal `[user, assistant,
 * last-prompt]` chain with a valid uuid/parentUuid linkage and an updated
 * `last-prompt.leafUuid` is reconstructed on resume (probe 2026-06-29, claude
 * v2.1.195, OAuth: planted a secret via a hand-written turn pair and the resumed
 * model recalled it). Folded turns are TEXT-only — never `thinking` blocks,
 * whose server `signature` cannot be forged.
 *
 * PURITY / RESIDENCY (mirrors codexFold.ts): the fold/chain builders are pure,
 * deterministic given `rows` + injected `makeUuid`/`baseTimeMs`, and have no
 * engine coupling. The optional JSONL writer at the bottom uses async
 * filesystem I/O only. Compute is bounded — the input is pre-trimmed by
 * `convertLocalMessagesToSeedHistory` via buildCodexFoldItems — so the pure
 * build path stays inside the same envelope as a live FC fold pass.
 *
 * Pipeline:
 *   rows (LocalMessage-shaped transcript)
 *     → buildCodexFoldItems (shared CLI fold brain: bounded seed → real rolling
 *        fold → FoldMessage[] folded model-visible view)
 *     → buildClaudeCliFoldChain  FoldMessage[] → linked Claude Code JSONL turn
 *        lines (user/assistant) + last-prompt leaf pointer
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  convertLocalMessagesToTraceMessages,
  DEFAULT_BIRTH_FOLD_MAX_CHARS,
  type BirthFoldSourceRow,
} from '../foldBirthHydration.ts';
import {
  buildHardEpochSeedView,
  buildRawHardEpochSeed,
  DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS,
} from '../foldFreeze.ts';
import type { FoldMessage, Turn } from '../rollingFold.ts';
import { resolveContextBudget, type ContextBudgetEnv } from '../contextBudget.ts';
import {
  buildCodexFoldItems,
  flattenFoldContent,
  resolveCodexFoldSeedMaxChars,
  shouldReconstructCodexEpoch,
  type BuildCodexFoldItemsOptions,
  type CodexEpochConfig,
  type CodexFoldStats,
} from './codexCli.ts';

// ════════════════════════════════════════════════════════════════════════
// Claude Code JSONL line shapes (subset, v2.1.195-observed)
//
// Claude Code persists one JSON object per line. Message lines (`user` /
// `assistant`) participate in the uuid/parentUuid chain; `last-prompt` is the
// out-of-band leaf pointer `--resume` walks back from. The probe proved the
// minimal envelope below is sufficient for resume reconstruction — auxiliary
// bookkeeping lines (ai-title, mode, permission-mode, file-history-snapshot,
// queue-operation) are NOT required and are preserved verbatim by the writer
// when present, never synthesized here.
// ════════════════════════════════════════════════════════════════════════

export interface ClaudeCliUserLine {
  parentUuid: string | null;
  isSidechain: false;
  type: 'user';
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch: string;
  userType: 'external';
  message: { role: 'user'; content: string };
}

export interface ClaudeCliAssistantLine {
  parentUuid: string | null;
  isSidechain: false;
  type: 'assistant';
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch: string;
  userType: 'external';
  message: {
    role: 'assistant';
    model: string;
    id: string;
    type: 'message';
    stop_reason: 'end_turn';
    stop_sequence: null;
    // TEXT-only: folded assistant turns never carry `thinking` blocks (their
    // server signature cannot be forged and a bad signature breaks resume).
    content: Array<{ type: 'text'; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };
}

export interface ClaudeCliLastPromptLine {
  type: 'last-prompt';
  lastPrompt: string;
  leafUuid: string;
  sessionId: string;
}

export type ClaudeCliMessageLine = ClaudeCliUserLine | ClaudeCliAssistantLine;
export type ClaudeCliJsonlLine = ClaudeCliMessageLine | ClaudeCliLastPromptLine;

// ════════════════════════════════════════════════════════════════════════
// Epoch predicate + trigger resolution
//
// claude-cli is a hard-epoch-only CLI transport (no append-only cache
// economics): it rewrites + respawns at the epoch. The trigger must sit BELOW
// the pressure ceiling with a reconstruct runway, so we rewrite+resume before
// occupancy would force a hard-epoch session swap. We resolve the live trigger
// through the shared Context Warp budget resolver (engine:'claude' → correct
// window for the claude model) and apply the same runway cap codex CLI uses,
// without editing the shared resolver's engine table.
// ════════════════════════════════════════════════════════════════════════

/**
 * Reconstruct runway: rewrite + respawn this many measured tokens before the
 * message ceiling, so a tail-epoch fold happens ahead of the pressure-ceiling
 * hard epoch. Mirrors DEFAULT_CONTEXT_BUDGET_CODEX_CLI_RECONSTRUCT_RUNWAY_TOKENS.
 */
export const DEFAULT_CLAUDE_CLI_RECONSTRUCT_RUNWAY_TOKENS = 20_000;
/** Hysteresis: minimum measured-token growth since the last fold before re-folding. */
export const DEFAULT_CLAUDE_CLI_RECONSTRUCT_INTERVAL = 20_000;
/** Version string written into synthesized lines when the live session has none yet. */
export const CLAUDE_CLI_JSONL_VERSION_FALLBACK = '2.1.195';
/** Model string written into synthesized assistant lines when none is supplied. */
export const CLAUDE_CLI_MODEL_FALLBACK = 'claude-opus-4-8';

/**
 * System note appended after a fold so the resumed model continues seamlessly
 * instead of re-greeting or repeating its last output. Mirrors the Gemini CLI
 * fold continuation prompt; the writer rides it onto the newest user turn of the
 * folded chain (a between-turns folder has no transient send view).
 */
export const CLAUDE_CLI_FOLD_CONTINUATION_PROMPT = [
  '[System Note: Your context crossed the fold trigger and was compressed for efficiency.',
  'Your full history, intent, and continuity are preserved (rolling-fold skeleton + Verbatim Keep + recall).',
  'Seamlessly continue your work from exactly where you left off — do not repeat your prior output;',
  'resume your sentence, tool call, or task directly. If you have genuinely finished everything and there',
  'is nothing left to do, you may stop here — that is your real idle.]',
].join('\n');

export interface ClaudeCliFoldTargetOptions {
  model?: string | null;
  contextWindowTokens?: number;
  env?: ContextBudgetEnv;
  /** Reconstruct runway below the message ceiling. Default DEFAULT_CLAUDE_CLI_RECONSTRUCT_RUNWAY_TOKENS. */
  reconstructRunwayTokens?: number;
}

/**
 * Resolve the live claude-cli fold trigger (provider-measured prompt tokens at
 * which a rewrite+resume reconstruction fires). Returns foldTriggerTokens capped
 * by a reconstruct runway under the message ceiling — NOT the steady-state band
 * (returning the band latches the trigger and thrashes; see codexFold history).
 * Pure + deterministic given the same env/window.
 */
export function resolveClaudeCliFoldTargetTokens(options: ClaudeCliFoldTargetOptions = {}): number {
  const budget = resolveContextBudget({
    model: options.model ?? undefined,
    engine: 'claude',
    env: options.env,
    contextWindowTokens: options.contextWindowTokens,
  });
  const runway = options.reconstructRunwayTokens ?? DEFAULT_CLAUDE_CLI_RECONSTRUCT_RUNWAY_TOKENS;
  const runwayCappedTrigger = Math.max(1, budget.messageCeilingTokens - runway);
  return Math.min(budget.foldTriggerTokens, runwayCappedTrigger);
}

/**
 * Resolve the claude-cli hard-epoch pressure ceiling (provider-measured prompt
 * tokens at which the normal tail fold is replaced by a single hard-epoch seed
 * reconstruction that preserves the live user turn). Returns the budget's
 * pressureCeilingTokens (null when disabled). Same shared resolver as the trigger.
 */
export function resolveClaudeCliPressureCeilingTokens(options: ClaudeCliFoldTargetOptions = {}): number | null {
  return resolveContextBudget({
    model: options.model ?? undefined,
    engine: 'claude',
    env: options.env,
    contextWindowTokens: options.contextWindowTokens,
  }).pressureCeilingTokens;
}

/**
 * Resolve the claude-cli HARD-EPOCH ceiling — the measured prompt-token level at
 * which a normal tail fold can no longer recover headroom and the session must do a
 * single seeded hard epoch (portable_reset) that preserves the live user
 * turn. This is the PREFIX-SATURATION point, NOT the pressure ceiling: the pressure
 * ceiling is where tail folding becomes urgent, but tail folds keep the session
 * alive all the way up to prefix saturation. Separating the two gives big-window
 * models a real [foldTrigger, hardEpochCeiling) tail band instead of hard-resetting
 * the moment they cross the (window-independent) 180K pressure floor — the dogfood
 * bug where a 1M-window session hard-reset at ~18% utilization with ~820K of runway
 * still left. Mirrors the FC eviction policy:
 *   - 'hard-epoch-only' (survival tier): every fold is hard, so the ceiling
 *     collapses back to the pressure ceiling (no tail band — preserves the
 *     deliberate hard-only behavior for tiny/constrained windows).
 *   - 'hard-epoch-on-prefix-saturation' (default): hard only at/above prefix
 *     saturation; tail-fold below it.
 * Never returns below the pressure ceiling (a hard epoch must not fire before the
 * session is even under pressure). Returns null only when both saturation and
 * pressure are disabled, in which case the caller never hard-epochs (always tail).
 * Same shared resolver as the trigger/pressure ceiling — no char/byte estimation.
 */
export function resolveClaudeCliHardEpochCeilingTokens(options: ClaudeCliFoldTargetOptions = {}): number | null {
  const budget = resolveContextBudget({
    model: options.model ?? undefined,
    engine: 'claude',
    env: options.env,
    contextWindowTokens: options.contextWindowTokens,
  });
  // Survival-tier folds are hard-epoch-only: every fold is hard, so the
  // hard-epoch ceiling collapses to the pressure ceiling (no tail band).
  if (budget.evictionPolicy === 'hard-epoch-only') {
    return budget.pressureCeilingTokens;
  }
  // hard-epoch-on-prefix-saturation: tail-fold below prefix saturation, hard-epoch
  // at/above it. Floor at the pressure ceiling so a hard epoch never fires early.
  const saturation = budget.prefixSaturationTokens;
  const pressure = budget.pressureCeilingTokens;
  if (saturation == null) return pressure;
  if (pressure == null) return saturation;
  return Math.max(saturation, pressure);
}

/**
 * Decide whether a claude-cli session has crossed into the fold band and should
 * have its on-disk JSONL reconstructed (rewrite + `--resume` respawn) at the next
 * epoch boundary. Thin wrapper over the proven codex epoch predicate with the
 * claude-cli reconstruct interval as the default hysteresis. Pass the resolved
 * trigger from resolveClaudeCliFoldTargetTokens as `targetTokensBeforeFold`.
 */
export function shouldReconstructClaudeCliEpoch(
  cumulativeTokenUsage: number,
  contextWindowTokens: number,
  config: CodexEpochConfig = {},
): boolean {
  return shouldReconstructCodexEpoch(cumulativeTokenUsage, contextWindowTokens, {
    reconstructIntervalTokens: DEFAULT_CLAUDE_CLI_RECONSTRUCT_INTERVAL,
    ...config,
  });
}

/** Window-aware fold seed char cap. Re-exported from the shared CLI core (window-generic). */
export const resolveClaudeCliFoldSeedMaxChars = resolveCodexFoldSeedMaxChars;

// ════════════════════════════════════════════════════════════════════════
// Claude Code JSONL chain serialization (the claude-cli-specific transport)
//
// Unlike Gemini's flat `$set.messages` array, Claude Code's resume contract
// walks a `parentUuid` linked list from `last-prompt.leafUuid`. So each folded
// FoldMessage becomes a uuid-stamped line chained to its predecessor. uuids and
// timestamps have deterministic standalone defaults; callers can inject
// makeUuid/baseTimeMs when they need live-session metadata or custom replay ids.
// ════════════════════════════════════════════════════════════════════════

export interface BuildClaudeCliFoldChainOptions {
  /** Session id the resumed `claude --resume <id>` will load. */
  sessionId: string;
  /** Absolute cwd the session runs in (stamped into every line). */
  cwd: string;
  /** Git branch stamp (default 'main'). */
  gitBranch?: string;
  /** Claude Code version stamp (default CLAUDE_CLI_JSONL_VERSION_FALLBACK). */
  version?: string;
  /** Model id for synthesized assistant lines (default CLAUDE_CLI_MODEL_FALLBACK). */
  model?: string | null;
  /** Base epoch ms for deterministic per-line timestamps. Default 0. */
  baseTimeMs?: number;
  /** Injectable uuid generator. Default is a deterministic UUID-like sequence. */
  makeUuid?: () => string;
  /** Preview text stored in the trailing last-prompt line. Default derived from the leaf message. */
  lastPromptPreview?: string;
}

export interface ClaudeCliFoldChain {
  /** Ordered JSONL line objects: the message chain followed by one last-prompt line. */
  lines: ClaudeCliJsonlLine[];
  /** uuid of the last message line (the resume leaf). Null when no non-empty messages. */
  leafUuid: string | null;
}

function isAssistantRole(role: string): boolean {
  return role === 'assistant' || role === 'model';
}

function deterministicClaudeCliFoldUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

/**
 * Serialize a folded FoldMessage[] view into a linked Claude Code JSONL chain.
 * Empty-text messages are dropped (no signal; matches the codex serializer).
 * Returns the lines plus the leaf uuid; when every message is empty the chain is
 * empty and leafUuid is null (caller must not rewrite in that case). Pure and
 * byte-deterministic by default; injected generators intentionally control replay
 * metadata when callers need it.
 */
export function buildClaudeCliFoldChain(
  foldedMessages: readonly FoldMessage[],
  options: BuildClaudeCliFoldChainOptions,
): ClaudeCliFoldChain {
  let fallbackUuidIndex = 0;
  const makeUuid = options.makeUuid ?? (() => deterministicClaudeCliFoldUuid(fallbackUuidIndex++));
  const baseTimeMs = options.baseTimeMs ?? 0;
  const version = options.version ?? CLAUDE_CLI_JSONL_VERSION_FALLBACK;
  const gitBranch = options.gitBranch ?? 'main';
  const model = options.model ?? CLAUDE_CLI_MODEL_FALLBACK;
  const { sessionId, cwd } = options;

  const lines: ClaudeCliJsonlLine[] = [];
  let parentUuid: string | null = null;
  let leafUuid: string | null = null;
  let lastText = '';
  let index = 0;

  for (const msg of foldedMessages) {
    const text = flattenFoldContent(msg.content);
    if (text.length === 0) continue;
    const uuid = makeUuid();
    const timestamp = new Date(baseTimeMs + index * 1000).toISOString();
    if (isAssistantRole(msg.role)) {
      lines.push({
        parentUuid,
        isSidechain: false,
        type: 'assistant',
        uuid,
        timestamp,
        sessionId,
        cwd,
        version,
        gitBranch,
        userType: 'external',
        message: {
          role: 'assistant',
          model,
          id: `msg_fold_${index}`,
          type: 'message',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    } else {
      lines.push({
        parentUuid,
        isSidechain: false,
        type: 'user',
        uuid,
        timestamp,
        sessionId,
        cwd,
        version,
        gitBranch,
        userType: 'external',
        message: { role: 'user', content: text },
      });
    }
    parentUuid = uuid;
    leafUuid = uuid;
    lastText = text;
    index += 1;
  }

  if (leafUuid != null) {
    const preview = options.lastPromptPreview ?? lastText.slice(0, 200);
    lines.push({ type: 'last-prompt', lastPrompt: preview, leafUuid, sessionId });
  }

  return { lines, leafUuid };
}

// ════════════════════════════════════════════════════════════════════════
// Top-level pure pipeline
// ════════════════════════════════════════════════════════════════════════

export interface BuildClaudeCliFoldResult {
  /** The reconstructed Claude Code JSONL chain (message lines + last-prompt leaf). */
  chain: ClaudeCliFoldChain;
  /** Fold stats from the shared CLI fold brain. */
  stats: CodexFoldStats;
  /** Bounded raw fold input (pre-fold seed) — for recall/episode capture in the caller. */
  rawMessages: FoldMessage[];
  /** Folded model-visible view that was serialized into the chain. */
  foldedMessages: FoldMessage[];
  /** Step-segment tiling when an oversized active turn was step-folded (recall addressing). */
  recallTurns?: Turn[];
}

export type BuildClaudeCliFoldOptions = BuildClaudeCliFoldChainOptions & BuildCodexFoldItemsOptions;

/**
 * Pure, deterministic transform: canonical transcript rows → folded Claude Code
 * JSONL chain ready for an on-disk rewrite + `--resume` respawn. Reuses the
 * shared CLI fold brain (buildCodexFoldItems) for the bounded seed + real rolling
 * fold, then maps the folded model-visible view into Claude Code's uuid-chained
 * turn lines. No I/O. Calling twice on identical rows + injected generators
 * yields identical lines.
 */
export function buildClaudeCliFold(
  rows: readonly BirthFoldSourceRow[],
  options: BuildClaudeCliFoldOptions,
): BuildClaudeCliFoldResult {
  const built = buildCodexFoldItems(rows, {
    maxChars: options.maxChars,
    foldConfig: options.foldConfig,
    syntheticContext: options.syntheticContext,
  });
  const chain = buildClaudeCliFoldChain(built.foldedMessages, options);
  return {
    chain,
    stats: built.stats,
    rawMessages: built.rawMessages,
    foldedMessages: built.foldedMessages,
    recallTurns: built.recallTurns,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Hard epoch (pressure-ceiling) — single-seed reconstruction
//
// When measured occupancy crosses the pressure ceiling (above the normal fold
// trigger), the tail fold is replaced by a single hard-epoch seed that MERGES
// the trailing live user turn so it is never silently trimmed. Uses the FULL
// rows converted at the event-loop-safe residency ceiling (not the smaller
// ~15% tail seed cap) so the live turn survives, then buildHardEpochSeedView
// (shared foldFreeze helper) collapses them to one seed message.
//
// v1 supplied a minimal continuity directive as the seed prompt. That proved
// insufficient: autonomous tool-only transcripts collapsed into a stale
// same-role block, and hard epochs woke with no useful recency. The default now
// builds the rich raw rebirth package from a per-row trace; the static prompt is
// retained only for explicit compatibility/test overrides.
// ════════════════════════════════════════════════════════════════════════

/** Minimal continuity directive used as the hard-epoch seed when no canonical rebirth preamble is wired. */
export const DEFAULT_CLAUDE_CLI_HARD_EPOCH_SEED_PROMPT =
  'Your context reached the pressure ceiling and was hard-compacted for continuity. '
  + 'Your prior history is summarized above; resume seamlessly from the live turn below — do not repeat earlier output.';

export interface ClaudeCliHardEpochResult {
  chain: ClaudeCliFoldChain;
  /** Full (residency-ceiling-capped) seed messages the hard view was built from. */
  rawMessages: FoldMessage[];
  /** Single-message hard-epoch seed view serialized into the chain. */
  foldedMessages: FoldMessage[];
  /** Raw rebirth-style seed body before buildHardEpochSeedView merges the live turn. */
  seedBodyText: string;
  /** Exact provider-visible hard-epoch seed text delivered as the single folded user message. */
  seedText: string;
}

export interface BuildClaudeCliHardEpochOptions extends BuildClaudeCliFoldChainOptions {
  /** Continuity seed prompt override (tests / host callbacks). Default: buildRawHardEpochSeed package. */
  seedPrompt?: string;
  /** Newest-first trace conversion cap. Default DEFAULT_BIRTH_FOLD_MAX_CHARS (residency ceiling). */
  maxChars?: number;
  /** Package budget for the default buildRawHardEpochSeed body. Default DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS (FC parity). */
  packageBudget?: number;
}

/**
 * Pure hard-epoch reconstruction: canonical transcript rows → a single
 * live-turn-preserving seed chain. Converts FULL rows at the residency ceiling
 * (preserving the live turn that the tail seed cap might trim), collapses them
 * via buildHardEpochSeedView, and serializes to a Claude Code JSONL chain.
 * Deterministic given makeUuid/baseTimeMs.
 */
export function buildClaudeCliHardEpochChain(
  rows: readonly BirthFoldSourceRow[],
  options: BuildClaudeCliHardEpochOptions,
): ClaudeCliHardEpochResult {
  const maxChars = options.maxChars ?? DEFAULT_BIRTH_FOLD_MAX_CHARS;

  // Per-row trace granularity (rail-2dcc0c4f). The block-merged birth-hydration
  // view can collapse autonomous tool-only traces into one giant assistant
  // block; buildRawHardEpochSeed truncates each message from the front, which
  // pins hard-epoch seeds to birth-era content while new work appends invisibly
  // to the tail. Per-row conversion keeps chronology addressable so the
  // newest-first seed sections advance with the trace.
  const { messages: trace } = convertLocalMessagesToTraceMessages(rows, { maxChars });
  const fullMessages: FoldMessage[] = trace.map((m) => ({ role: m.role, content: m.content }));

  const seedBody = options.seedPrompt
    ?? buildRawHardEpochSeed(fullMessages, {
      maxChars: options.packageBudget ?? DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS,
      predecessorName: 'predecessor',
    });
  const hardView = buildHardEpochSeedView(
    [...fullMessages],
    seedBody,
  );
  const chain = buildClaudeCliFoldChain(hardView, options);
  const seedText = typeof hardView[0]?.content === 'string' ? hardView[0].content : '';
  return { chain, rawMessages: fullMessages, foldedMessages: hardView, seedBodyText: seedBody, seedText };
}

// ════════════════════════════════════════════════════════════════════════
// Claude Code JSONL writer helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Encode an absolute cwd into Claude Code's project-dir naming convention.
 * Claude Code replaces every non-alphanumeric path character with `-`.
 */
export function encodeCwdForClaudeCode(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Resolve a Claude Code session's on-disk JSONL path:
 *   <root>/<encoded-cwd>/<session-id>.jsonl
 * where <root> defaults to ~/.claude/projects and <encoded-cwd> replaces every
 * non-alphanumeric cwd character with `-`. Pass `root` (the projects-base dir)
 * in tests to target a tmp dir.
 */
export function resolveClaudeCliSessionJsonlPath(
  sessionId: string,
  cwd: string,
  root?: string,
): string {
  const base = root ?? join(homedir(), '.claude', 'projects');
  return join(base, encodeCwdForClaudeCode(cwd), `${sessionId}.jsonl`);
}

/** Index of the first `user`/`assistant` message line, or rawLines.length if none. */
function firstMessageLineIndex(rawLines: readonly string[]): number {
  for (let i = 0; i < rawLines.length; i += 1) {
    let type: unknown;
    try {
      type = (JSON.parse(rawLines[i]) as { type?: unknown }).type;
    } catch {
      continue;
    }
    if (type === 'user' || type === 'assistant') return i;
  }
  return rawLines.length;
}

export interface WriteFoldedClaudeCliJsonlIoOptions {
  /** When true, write a `<path>.dryrun` sidecar and never touch the live file. */
  dryRun?: boolean;
  /** Projects-base dir override (tests). Default ~/.claude/projects. */
  root?: string;
}

export interface WriteFoldedClaudeCliJsonlResult {
  /** Path actually written (live file, or the .dryrun sidecar). */
  path: string;
  /** Resume leaf uuid stamped into the last-prompt line; null when nothing was foldable. */
  leafUuid: string | null;
  /** Total lines written (preserved head + folded chain + last-prompt). */
  lineCount: number;
  /** False when the fold produced no non-empty messages — the live file is left untouched. */
  written: boolean;
}

/**
 * Atomically rewrite a Claude Code session's JSONL with the folded chain built
 * from `foldedMessages`. Throws on unreadable/missing files so callers can fall
 * back to fresh-session reseed; returns `written:false` for an empty fold.
 */
export async function writeFoldedClaudeCliJsonl(
  foldedMessages: readonly FoldMessage[],
  chainOptions: BuildClaudeCliFoldChainOptions,
  ioOptions: WriteFoldedClaudeCliJsonlIoOptions = {},
): Promise<WriteFoldedClaudeCliJsonlResult> {
  const filePath = resolveClaudeCliSessionJsonlPath(
    chainOptions.sessionId,
    chainOptions.cwd,
    ioOptions.root,
  );

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Claude Code session JSONL not readable for fold rewrite ` +
        `(sessionId=${chainOptions.sessionId}, path=${filePath}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rawLines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (rawLines.length === 0) {
    throw new Error(`Claude Code session JSONL is empty: ${filePath}`);
  }

  const head = rawLines.slice(0, firstMessageLineIndex(rawLines));
  const chain = buildClaudeCliFoldChain(foldedMessages, chainOptions);
  if (chain.leafUuid == null) {
    return { path: filePath, leafUuid: null, lineCount: 0, written: false };
  }

  const outLines = [...head, ...chain.lines.map((line) => JSON.stringify(line))];
  const output = `${outLines.join('\n')}\n`;

  if (ioOptions.dryRun) {
    const dryRunPath = `${filePath}.dryrun`;
    await fs.writeFile(dryRunPath, output, 'utf8');
    return { path: dryRunPath, leafUuid: chain.leafUuid, lineCount: outLines.length, written: true };
  }

  const tempPath = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
  await fs.writeFile(tempPath, output, 'utf8');
  await fs.rename(tempPath, filePath);

  return { path: filePath, leafUuid: chain.leafUuid, lineCount: outLines.length, written: true };
}
