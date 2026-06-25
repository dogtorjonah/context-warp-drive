/**
 * context-warp-drive — the Infinite Context Warp Engine.
 *
 * Keep long function-calling agent sessions under the context ceiling WITHOUT
 * LLM summarization calls and WITHOUT ending the session, while keeping provider
 * prompt caches hot — and page folded content back in the moment the agent
 * touches it again. Provider-agnostic: Anthropic content blocks, OpenAI
 * tool_calls, and Gemini parts.
 *
 * Layers:
 *   - Rolling fold (`foldContext`) + Coordinate Closet — deterministic page-out.
 *   - Fold freeze (`evaluateFoldFreeze`) — byte-identical cache-hot reuse.
 *   - Fold recall (`buildFoldRecallContext`) — ambient page-in.
 *   - Episodic recall (`./episodes`) — durable cross-session blast-radius memory.
 *   - Glyph grammar (`./glyphs`) — register-tagged messages that power episodic
 *     narration harvesting.
 *   - Context budget (`./budget`) — model-aware fold and pressure ceilings.
 *   - Overwatch (`./overwatch`) — trace-only context geometry governor.
 *   - Task Rail (`./task-rail`) — portable long-horizon execution state.
 *   - FoldSession — the one-call orchestrator that wires it into any FC loop.
 *
 * Sub-path entry points are also published:
 *   `context-warp-drive/fold`, `context-warp-drive/budget`,
 *   `context-warp-drive/episodes`, `context-warp-drive/glyphs`,
 *   `context-warp-drive/overwatch`, `context-warp-drive/task-rail`,
 *   `context-warp-drive/raw-rebirth-seed`,
 *   `context-warp-drive/providers/anthropic`,
 *   `context-warp-drive/providers/gemini-cli`.
 *
 * Pure CPU, zero I/O, zero LLM calls (the episodic SQLite store is the only
 * optional native dependency). Byte-identical output for identical inputs is the
 * provider-cache invariant.
 */
export * from './fold.ts';
export * from './contextBudget.ts';
export * from './episodes.ts';
export * from './glyphs.ts';
export * from './overwatch.ts';
export * from './taskRail.ts';

// Provider adapters — re-exported under `providers/` sub-path for consumers
// who want turnkey cache-breakpoint injection (Anthropic, etc).
//
//   import { applyCacheBreakpoints } from 'context-warp-drive/providers/anthropic';
//   import { buildGeminiCliFoldView } from 'context-warp-drive/providers/gemini-cli';
