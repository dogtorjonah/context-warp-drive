/**
 * Context Warp Drive extension for Pi (earendil-works/pi).
 *
 * This extension replaces Pi's default LLM-summarization compaction with
 * CWD's deterministic rolling-fold engine. The full hybrid mode is active —
 * tail epochs (append-only, cache-hot) AND hard epochs (full reseed with
 * continuity seed) — driven by measured provider token telemetry.
 *
 * ## How It Works
 *
 * 1. The `context` event fires before each LLM call with the current message
 *    array. The extension converts Pi messages → CWD FoldMessages, runs
 *    FoldSession.prepare(), and returns the folded messages. Pi's extension
 *    API returns the modified array directly — no in-place mutation needed.
 *
 * 2. The `message_end` event captures measured token usage from each
 *    AssistantMessage, feeding real telemetry into the fold engine's
 *    pressure-ceiling and tail-epoch decisions. Pi's Usage type includes
 *    input, output, cacheRead, and cacheWrite — covering all major providers.
 *
 * 3. The `session_before_compact` event is a safety net: if Pi's native
 *    compaction somehow triggers, we cancel it. With CWD keeping context
 *    bounded every turn, native compaction should never fire — but this hook
 *    prevents double-compaction if it does.
 *
 * ## Installation
 *
 * Build the extension with `tsup`, then drop it into your extensions directory:
 *
 * ```bash
 * # Global extensions
 * cp dist/index.js ~/.pi/agent/extensions/context-warp-drive.js
 *
 * # Project-local extensions
 * cp dist/index.js .pi/extensions/context-warp-drive.js
 * ```
 *
 * Or install as an npm package:
 * ```bash
 * pi install npm:pi-plugin-context-warp-drive
 * ```
 *
 * ## Configuration
 *
 * Options can be configured by modifying the defaults at the top of this file
 * or by exporting a factory that accepts options.
 */

import { FoldSession } from '../../../src/index.ts';
import type { FoldOutcome } from '../../../src/index.ts';

import {
  toFoldMessages,
  toPiMessages,
  extractInputTokens,
  type PiMessage,
} from './adapter.ts';

// ── Extension API shim ──────────────────────────────────────────────────
// We duck-type Pi's ExtensionAPI rather than importing it, to keep the
// extension standalone. Pi loads extensions as ESM modules with a default
// export matching the factory function signature.

/** Duck-typed Pi ExtensionAPI — we only use `on()`. */
interface PiExtensionAPI {
  on(event: string, handler: (event: any, ctx: any) => any): void;
}

/** Duck-typed Pi ExtensionContext */
interface PiExtensionContext {
  cwd: string;
  mode: string;
  getSessionName?: () => string | undefined;
}

// ── Options ────────────────────────────────────────────────────────────

export interface ContextWarpDriveOptions {
  /**
   * Absolute pressure ceiling in measured input tokens. When the measured
   * input tokens reach this threshold, FoldSession forces a hard epoch
   * (full reseed with continuity seed). Default: 150,000.
   */
  pressureCeiling?: number;
  /**
   * Preferred runway in tokens after a tail-epoch append. Default: 45,000.
   */
  runway?: number;
  /**
   * Hard minimum runway required before a tail-epoch append. Default: 30,000.
   */
  minRunway?: number;
  /**
   * Enable provider-cache freeze (byte-identical prefix reuse). Default: true.
   */
  freeze?: boolean;
  /**
   * Enable a fold-state hint via before_agent_start system prompt injection.
   * Default: true.
   */
  recall?: boolean;
  /**
   * Enable verbose logging of fold decisions. Default: false.
   */
  debug?: boolean;
}

// ── Per-session state ──────────────────────────────────────────────────

interface SessionState {
  /** One FoldSession per conversation — maintains epoch state across folds */
  foldSession: FoldSession;
  /** Measured input tokens from the last assistant response for this session */
  measuredInputTokens: number | undefined;
}

const MAX_SESSIONS = 50; // LRU cap

const PI_FOLD_BLOCK_PREAMBLE =
  '(Context note: older turns were auto-folded into the skeletons below. The ⌖ COORDINATE CLOSET block conserves exact ids/paths/values from folded turns — trust it before re-reading files. In this Pi extension, folded details are not automatically paged back; use the preserved literals and visible active window as the source of continuity.)';

function makeFoldSession(opts: Required<ContextWarpDriveOptions>): FoldSession {
  return new FoldSession({
    freeze: opts.freeze,
    pressureCeiling: opts.pressureCeiling,
    foldBlockPreamble: PI_FOLD_BLOCK_PREAMBLE,
    tailEpochRunway: {
      runwayTokens: opts.runway,
      minRunwayTokens: opts.minRunway,
    },
  });
}

// ── Extension factory ──────────────────────────────────────────────────

/**
 * Create a Context Warp Drive extension for Pi.
 *
 * Returns an extension factory function compatible with Pi's extension system.
 * Drop the built module into ~/.pi/agent/extensions/ or .pi/extensions/ for
 * auto-discovery.
 *
 * @example
 * ```typescript
 * // ~/.pi/agent/extensions/context-warp-drive.ts
 * export { default } from 'pi-plugin-context-warp-drive';
 * ```
 *
 * Or with custom options:
 * ```typescript
 * import createPlugin from 'pi-plugin-context-warp-drive';
 * export default (pi) => createPlugin(pi, { pressureCeiling: 200_000 });
 * ```
 */
export function createPlugin(
  pi: PiExtensionAPI,
  options?: ContextWarpDriveOptions,
): void {
  const opts: Required<ContextWarpDriveOptions> = {
    pressureCeiling: options?.pressureCeiling ?? 150_000,
    runway: options?.runway ?? 45_000,
    minRunway: options?.minRunway ?? 30_000,
    freeze: options?.freeze === false ? false : options?.freeze ?? true,
    recall: options?.recall === false ? false : options?.recall ?? true,
    debug: options?.debug === true,
  };

  // Per-session state — Pi runs one session at a time, but the extension
  // may survive across session switches. Each session gets its own FoldSession.
  const sessions = new Map<string, SessionState>();
  const sessionLRU: string[] = [];

  function getSession(sessionID: string): SessionState {
    let state = sessions.get(sessionID);
    if (!state) {
      state = {
        foldSession: makeFoldSession(opts),
        measuredInputTokens: undefined,
      };
      sessions.set(sessionID, state);
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

  // ── CAPTURE real token counts from provider responses ────────────────
  pi.on('message_end', (event: any, ctx: any) => {
    const message = event?.message;
    if (!message || message.role !== 'assistant') return;

    const tokens = extractInputTokens(message);
    if (tokens !== undefined) {
      const sessionID = ctx?.getSessionName?.() ?? 'default';
      const state = getSession(sessionID);
      state.measuredInputTokens = tokens;
      debug(`measured input tokens: ${tokens}`);
    }
  });

  // ── FOLD messages before every provider call ─────────────────────────
  pi.on('context', (event: any, ctx: any) => {
    const piMessages: PiMessage[] = event?.messages;
    if (!piMessages || piMessages.length === 0) return;

    const sessionID = ctx?.getSessionName?.() ?? 'default';
    const state = getSession(sessionID);

    // Convert Pi messages → CWD FoldMessages
    const { messages: foldMessages, indexMap } = toFoldMessages(piMessages);
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

    // Convert folded messages back to Pi format
    const { messages: foldedPiMessages, foldBlockCount } = toPiMessages(
      outcome.messages,
      indexMap,
      piMessages,
    );

    if (foldedPiMessages.length > 0) {
      debug(
        `replaced ${piMessages.length} messages with ${foldedPiMessages.length} ` +
        `folded messages (${foldBlockCount} fold block${foldBlockCount !== 1 ? 's' : ''})`,
      );

      // Pi's context event handler returns ContextEventResult with messages
      // — the returned array replaces the provider-bound context.
      return { messages: foldedPiMessages };
    }
  });

  // ── INJECT fold-state hint into the system prompt ────────────────────
  pi.on('before_agent_start', (event: any, _ctx: any) => {
    if (!opts.recall) return;

    // A brief, honest hint — does NOT promise automatic recall.
    const hint =
      '\n\n[Context Warp Drive] Older conversation turns have been deterministically folded into a structured block. ' +
      'The Coordinate Closet in that block conserves exact literals (file paths, IDs, values) from folded turns. ' +
      'Trust the closet before re-reading files.';

    if (typeof event?.systemPrompt === 'string') {
      event.systemPrompt += hint;
    }
  });

  // ── SAFETY: cancel native compaction if it somehow triggers ──────────
  // With CWD keeping context under threshold every turn, Pi's native
  // compaction should never fire. But if it does (e.g., resumed overweight
  // session), we cancel it rather than letting Pi's LLM summarizer destroy
  // context. CWD's fold block already preserves structured continuity.
  pi.on('session_before_compact', (_event: any, _ctx: any) => {
    debug('native compaction cancelled — CWD fold manages context');
    return { cancel: true };
  });
}

// ── Default export — Pi's extension auto-discovery format ───────────────
// Pi loads extensions and calls the default export with the ExtensionAPI.
export default function contextWarpDriveExtension(pi: PiExtensionAPI): void {
  createPlugin(pi);
}
