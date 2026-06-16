/**
 * context-warp-drive/fold — the dependency-free rolling-fold engine.
 *
 * Rolling fold + Coordinate Closet, cache-hot fold freeze, ambient page-in recall,
 * provider context-window sizing, and distinctive-term primitives, plus the
 * FoldSession orchestrator. Zero runtime dependencies; pure CPU, zero I/O, zero
 * LLM calls, byte-identical output for identical inputs.
 */
export * from './rollingFold.ts';
export * from './foldFreeze.ts';
export * from './foldRecall.ts';
export * from './foldTerms.ts';
export * from './contextWindow.ts';

export { DEFAULT_FOLD_PRESSURE_CEILING_TOKENS, FoldSession } from './session/FoldSession.ts';
export type {
  FoldPrepareContext,
  FoldPressureCeilingConfig,
  FoldSessionOptions,
  FoldOutcome,
  FoldStats,
} from './session/FoldSession.ts';
