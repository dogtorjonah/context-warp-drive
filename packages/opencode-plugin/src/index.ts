/**
 * Context Warp Drive plugin for OpenCode.
 *
 * This plugin replaces OpenCode's default LLM-summarization compaction with
 * CWD's deterministic rolling-fold engine. The full hybrid mode is active —
 * tail epochs (append-only, cache-hot) AND hard epochs (full reseed with
 * continuity seed) — driven by measured provider token telemetry.
 *
 * ## How It Works
 *
 * 1. `experimental.chat.messages.transform` fires every turn, before messages
 *    go to the provider. The plugin converts OpenCode messages → CWD
 *    FoldMessages, runs FoldSession.prepare(), and maps the folded output
 *    back to OpenCode format. The transform mutates the output.messages array
 *    IN PLACE (splice), because OpenCode discards the hook's return value and
 *    keeps using its local array reference.
 *
 * 2. `event` captures measured input tokens from provider responses, feeding
 *    real telemetry into the fold engine's pressure-ceiling and tail-epoch
 *    decisions. Token counts mirror OpenCode's own overflow math (total or
 *    input + output + cache.read + cache.write).
 *
 * 3. Because CWD keeps the context under threshold every turn, OpenCode's own
 *    compaction trigger should never fire — zero LLM summarization calls.
 *
 * ## Installation
 *
 * Build the plugin with `tsup`, then reference it in your OpenCode config:
 *
 * ```json
 * {
 *   "plugin": ["./path/to/context-warp-drive/dist/index.js"]
 * }
 * ```
 *
 * Or with options:
 * ```json
 * {
 *   "plugin": [
 *     ["./path/to/context-warp-drive/dist/index.js", {
 *       "pressureCeiling": 150000,
 *       "runway": 45000,
 *       "minRunway": 30000,
 *       "freeze": true
 *     }]
 *   ]
 * }
 * ```
 */

import { FoldSession } from '../../../src/index.ts';
import type { FoldOutcome } from '../../../src/index.ts';

import {
  toFoldMessages,
  toOpenCodeMessages,
  extractInputTokens,
  extractSessionId,
  type OCMessage,
} from './adapter.ts';

// ── Plugin type shim ────────────────────────────────────────────────────
// We duck-type the OpenCode plugin interface rather than importing it, to keep
// the plugin standalone. OpenCode loads plugins as ESM modules with a default
// export matching the Plugin function signature.

interface PluginInput {
  client: unknown;
  project: unknown;
  directory: string;
  worktree: string;
  experimental_workspace: unknown;
  serverUrl: URL;
  $: unknown;
}

type PluginOptions = Record<string, unknown>;

interface Hooks {
  dispose?: () => Promise<void>;
  event?: (input: { event: any }) => Promise<void>;
  config?: (input: any) => Promise<void>;
  'experimental.chat.messages.transform'?: (
    input: {},
    output: { messages: OCMessage[] },
  ) => Promise<void>;
  'experimental.chat.system.transform'?: (
    input: { sessionID?: string; model: any },
    output: { system: string[] },
  ) => Promise<void>;
  'experimental.session.compacting'?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>;
  'experimental.compaction.autocontinue'?: (
    input: any,
    output: { enabled: boolean },
  ) => Promise<void>;
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;

// ── Options ────────────────────────────────────────────────────────────

export interface ContextWarpDriveOptions {
  /**
   * Absolute pressure ceiling in measured input tokens. When the measured
   * input tokens reach this threshold, FoldSession forces a hard epoch
   * (full reseed with continuity seed). Default: 150,000.
   */
  pressureCeiling?: number;
  /**
   * Preferred runway in tokens after a tail-epoch append. If the remaining
   * runway after appending a fold band is ≥ this value, the tail epoch
   * continues (cache stays warm). Default: 45,000.
   */
  runway?: number;
  /**
   * Hard minimum runway required before a tail-epoch append can proceed.
   * If measured tokens leave less than this after an append, the engine
   * triggers a full recompute or hard epoch instead. Default: 30,000.
   */
  minRunway?: number;
  /**
   * Enable provider-cache freeze (byte-identical prefix reuse). When true,
   * the frozen prefix is reused across turns until an epoch forces a recompute,
   * keeping the provider prompt cache hot. Default: true.
   */
  freeze?: boolean;
  /**
   * Enable a fold-state hint in the system prompt. When true, a brief note is
   * added telling the model that older turns were deterministically folded and
   * where the preserved literals live. Default: true.
   */
  recall?: boolean;
  /**
   * Enable verbose logging of fold decisions. Useful for debugging. Default: false.
   */
  debug?: boolean;
}

// ── Per-session state ──────────────────────────────────────────────────

interface SessionState {
  /** One FoldSession per conversation — maintains epoch state across folds */
  foldSession: FoldSession;
  /** Measured input tokens from the last provider response for this session */
  measuredInputTokens: number | undefined;
}

const MAX_SESSIONS = 50; // LRU cap
const OPENCODE_FOLD_BLOCK_PREAMBLE =
  '(Context note: older turns were auto-folded into the skeletons below. The ⌖ COORDINATE CLOSET block conserves exact ids/paths/values from folded turns — trust it before re-reading files. In this OpenCode plugin, folded details are not automatically paged back; use the preserved literals and visible active window as the source of continuity.)';

function makeFoldSession(opts: Required<ContextWarpDriveOptions>): FoldSession {
  return new FoldSession({
    freeze: opts.freeze,
    pressureCeiling: opts.pressureCeiling,
    foldBlockPreamble: OPENCODE_FOLD_BLOCK_PREAMBLE,
    tailEpochRunway: {
      runwayTokens: opts.runway,
      minRunwayTokens: opts.minRunway,
    },
  });
}

// ── Plugin implementation ──────────────────────────────────────────────

const ContextWarpDrivePlugin: Plugin = async (_input, options) => {
  const opts: Required<ContextWarpDriveOptions> = {
    pressureCeiling: (options?.pressureCeiling as number) ?? 150_000,
    runway: (options?.runway as number) ?? 45_000,
    minRunway: (options?.minRunway as number) ?? 30_000,
    freeze: options?.freeze === false ? false : (options?.freeze as boolean | undefined) ?? true,
    recall: options?.recall === false ? false : (options?.recall as boolean | undefined) ?? true,
    debug: options?.debug === true,
  };

  // Per-session state — OpenCode runs main + subagent sessions through one
  // plugin instance. Each session gets its own FoldSession and token telemetry.
  const sessions = new Map<string, SessionState>();
  const sessionLRU: string[] = []; // most-recently-used at end

  function getSession(sessionID: string): SessionState {
    let state = sessions.get(sessionID);
    if (!state) {
      state = {
        foldSession: makeFoldSession(opts),
        measuredInputTokens: undefined,
      };
      sessions.set(sessionID, state);
      // LRU eviction
      sessionLRU.push(sessionID);
      while (sessionLRU.length > MAX_SESSIONS) {
        const evict = sessionLRU.shift();
        if (evict) sessions.delete(evict);
      }
    }
    // Move to end of LRU
    const idx = sessionLRU.indexOf(sessionID);
    if (idx >= 0) sessionLRU.splice(idx, 1);
    sessionLRU.push(sessionID);
    return state;
  }

  const debug = (msg: string) => {
    if (opts.debug) console.error(`[cwd] ${msg}`);
  };

  const hooks: Hooks = {
    // ── CAPTURE real token counts from provider responses ──────────────
    event: async ({ event }) => {
      const tokens = extractInputTokens(event);
      if (tokens !== undefined) {
        const sessionID = extractSessionId(event);
        if (sessionID) {
          const state = getSession(sessionID);
          state.measuredInputTokens = tokens;
        }
        debug(`measured input tokens: ${tokens}`);
      }
    },

    // ── FOLD messages before every provider call ───────────────────────
    'experimental.chat.messages.transform': async (_input, output) => {
      const ocMessages = output.messages;
      if (ocMessages.length === 0) return;

      // Derive session ID from the first message — OpenCode doesn't pass
      // it in the transform input (it's {})
      const sessionID = ocMessages[0]?.info.sessionID ?? 'default';
      const state = getSession(sessionID);

      // Convert OpenCode messages → CWD FoldMessages
      const { messages: foldMessages, indexMap } = toFoldMessages(ocMessages);
      if (foldMessages.length === 0) return;

      // Run the fold engine
      const outcome: FoldOutcome = state.foldSession.prepare(foldMessages, {
        measuredInputTokens: state.measuredInputTokens,
      });

      // Log fold decisions
      if (outcome.stats) {
        const s = outcome.stats;
        if (!s.cacheHot && s.epochReason) {
          debug(
            `epoch: ${s.epochReason} | turns: ${s.totalTurns} | ` +
            `folded: ${s.turnsFolded ?? 0} | savings: ${s.savingsPercent ?? 0}% | ` +
            `hot reuses: ${s.hotReuses} | total epochs: ${s.epochs}`,
          );
        } else if (s.cacheHot) {
          debug(`cache hot reuse #${s.hotReuses}`);
        }
        if (s.appendDecision === 'committed') {
          debug(
            `tail epoch committed | band: ${s.appendBandChars ?? 0} chars | ` +
            `raw tail: ${s.appendRawTailChars ?? 0} chars | saved: ${s.appendSavedChars ?? 0} chars`,
          );
        }
        if (s.pressureCeilingTriggered) {
          debug(`pressure ceiling triggered at ${s.pressureCeilingTokens} tokens`);
        }
      }

      // Always apply the prepared view. On cache-hot turns, outcome.messages
      // is the frozen prefix + raw tail — this is NOT identical to the raw
      // history OpenCode hands us, because the transform is ephemeral and
      // the folded view is never persisted in OpenCode's store. Skipping
      // hot turns would send unfolded raw history, growing context unbounded.
      const { messages: foldedOCMessages, foldBlockCount } = toOpenCodeMessages(
        outcome.messages,
        indexMap,
        ocMessages,
        sessionID,
      );

      if (foldedOCMessages.length > 0) {
        // MUTATE IN PLACE — OpenCode discards the hook's return value and
        // keeps using its local array reference (prompt.ts:1255).
        // Reassigning output.messages does nothing; we must splice the
        // existing array to replace its contents.
        ocMessages.splice(0, ocMessages.length, ...foldedOCMessages);
        debug(
          `replaced ${ocMessages.length} messages with ${foldedOCMessages.length} ` +
          `folded messages (${foldBlockCount} fold block${foldBlockCount !== 1 ? 's' : ''})`,
        );
      }
    },

    // ── INJECT fold-state hint into the system prompt ─────────────────
    'experimental.chat.system.transform': async (_input, output) => {
      if (!opts.recall) return;

      // A brief, honest hint — does NOT promise automatic recall (that
      // path is not wired in the OpenCode integration). Tells the model
      // what happened and where preserved literals live.
      const hint =
        '[Context Warp Drive] Older conversation turns have been deterministically folded into a structured block above. ' +
        'The Coordinate Closet in that block conserves exact literals (file paths, IDs, values) from folded turns. ' +
        'Trust the closet before re-reading files.';

      output.system.push(hint);
    },

    // ── SAFETY: do not destroy session history if native compaction fires ──
    // If OpenCode's native compaction somehow triggers (e.g., a resumed
    // overweight session), we do NOT replace the summarization prompt with
    // a no-op. Doing so would make the compaction summary literally "OK",
    // destroying all prior context. Instead, we push CWD's fold state as
    // additional context for the summarization call — the LLM summarizer
    // sees both the raw history AND CWD's deterministic fold block.
    'experimental.session.compacting': async (_input, output) => {
      // Push CWD fold context so the native summarizer has richer state.
      // Do NOT override output.prompt — let OpenCode use its real summarization prompt.
      output.context.push(
        'Context Warp Drive has been managing this session with deterministic folding. ' +
        'Older turns are preserved in a structured fold block. ' +
        'Summarize with awareness of the existing fold structure.',
      );
    },

    // ── Let auto-continue proceed normally ──────────────────────────────
    // Previously this disabled auto-continue, which would silently kill
    // the session if native compaction ever fired. Now we leave it enabled
    // so the session continues after a (hopefully rare) native compaction.
  };

  return hooks;
};

export default ContextWarpDrivePlugin;
