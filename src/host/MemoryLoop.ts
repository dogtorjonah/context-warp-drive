/**
 * MemoryLoop — the turnkey standalone host adapter that wires the full
 * context-warp memory stack together.
 *
 * This is the missing piece: one class that runs FoldSession + fold recall +
 * episodic capture + episodic persistence + boundary recall injection in the
 * correct order, at the correct moments — the same orchestration the relay's
 * `fcBaseSession.applyCompaction` performs, but provider-neutral and
 * dependency-free.
 *
 * Usage:
 *
 * ```typescript
 * const loop = new MemoryLoop({
 *   session: new FoldSession({ ... }),
 *   recallConfig: DEFAULT_FOLD_RECALL_CONFIG,
 *   episodeStore: await createEpisodeStore({ path: 'episodes.db' }),
 *   liveSource: true,       // enable live-source delta tracking
 *   affinity: true,          // enable behavioral affinity tracking
 * });
 *
 * // Each turn:
 * const { messages, recallContext, episodeCards } = loop.prepare(history, {
 *   toolInput: lastToolCall?.input,
 *   claimedPaths: activeClaims,
 *   measuredInputTokens: providerTokenCount,
 *   contextWindow: modelContextWindow,
 * });
 * // Send `messages` to your provider. Inject `recallContext` and `episodeCards`
 * // as system context or prepend to the latest user message.
 * ```
 *
 * The adapter:
 *   1. Calls FoldSession.prepare() to get the compacted view.
 *   2. On an epoch boundary: rebuilds the fold index, derives + persists
 *      episodes, populates liveSource/affinity/fileMeta enrichment carriers.
 *   3. At each tool boundary: derives recall signals, builds fold recall
 *      context, recalls episodic cards, and returns everything for injection.
 */
import {
  buildFoldIndex,
  buildFoldRecallContext,
  createFoldRecallState,
  deriveBoundaryRecallSignals,
  DEFAULT_FOLD_RECALL_CONFIG,
  type FoldRecallConfig,
  type FoldRecallState,
  type RecallSignals,
} from '../foldRecall.ts';
import {
  getUtilizationLevel,
  type ContextUtilizationLevel,
} from '../contextWindow.ts';
import { type FoldMessage, type SyntheticContextOptions } from '../rollingFold.ts';
import { FoldSession, type FoldOutcome, type FoldPrepareContext } from '../session/FoldSession.ts';
import { EpisodeRuntime } from '../episodes/runtime.ts';
import type { EpisodeDatabase, EpisodeRecallCard } from '../episodes/episodeStore.ts';
import { buildLiveSourceDeltas, type BuildLiveSourceDeltasResult } from './liveSource.ts';
import { buildPathAffinity, touchSetsFromToolInputs } from './affinity.ts';
import type { FileMetaProvider } from './fileMetaProvider.ts';
import { populateFoldRecallMeta } from './fileMetaProvider.ts';
import {
  buildLineageGlyphLogFromMessages,
} from '../rawRebirthSeed.ts';
import { buildRawHardEpochSeed, DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS } from '../foldFreeze.ts';

export interface MemoryLoopOptions {
  /** A configured FoldSession (fold + freeze orchestrator). */
  readonly session: FoldSession;
  /** Fold recall configuration (default: DEFAULT_FOLD_RECALL_CONFIG). */
  readonly recallConfig?: FoldRecallConfig;
  /** Optional episode store for durable cross-session memory. */
  readonly episodeStore?: EpisodeDatabase;
  /** Session ID for episode scoping (default: 'default'). */
  readonly sessionId?: string;
  /** Enable live-source delta tracking (default: false; requires file system). */
  readonly enableLiveSource?: boolean;
  /** Enable behavioral affinity tracking (default: false). */
  readonly enableAffinity?: boolean;
  /** Optional file metadata provider for radar enrichment. */
  readonly fileMetaProvider?: FileMetaProvider;
  /** Optional synthetic context markers (same as FoldSession). */
  readonly syntheticContext?: SyntheticContextOptions;
  /** Root directory for live-source resolution (default: process.cwd()). */
  readonly rootDir?: string;
}

export interface MemoryLoopPrepareContext extends Partial<FoldPrepareContext> {
  /** The last tool call's input (for extracting touched paths). */
  readonly toolInput?: Record<string, unknown> | null;
  /** Currently-claimed paths (for claim-triggered recall). */
  readonly claimedPaths?: ReadonlySet<string>;
  /** The model's measured context window size (tokens). Required for utilization level. */
  readonly contextWindow?: number;
  /**
   * Paths that should be snapshotted for live-source delta on the next epoch.
   * Typically derived from the folded history; can be passed explicitly.
   */
  readonly epochPaths?: readonly string[];
}

export interface MemoryLoopOutcome {
  /** The compacted message array to send to the provider (FoldSession result). */
  readonly messages: FoldMessage[];
  /** The FoldSession outcome (with stats, sealedBoundary, etc.). */
  readonly fold: FoldOutcome;
  /** Fold recall context block (ambient page-in cards). Inject into the outgoing view. */
  readonly recallContext: string;
  /** Episodic recall cards (durable cross-session memory). Inject into the outgoing view. */
  readonly episodeCards: readonly EpisodeRecallCard[];
  /** True if this prepare call triggered a fold epoch (index rebuild + episode capture). */
  readonly epochTriggered: boolean;
  /** Fold recall telemetry counters after this call. */
  readonly recallStats: {
    readonly cardsInjected: number;
    readonly hintsInjected: number;
    readonly recallChars: number;
    readonly suppressed: number;
  };
  /** Live-source delta result (when enabled and epoch triggered). */
  readonly liveSourceDelta?: BuildLiveSourceDeltasResult;
}

/**
 * The turnkey memory loop adapter.
 *
 * One instance per agent session. Call `prepare()` every turn with the latest
 * full raw history and context.
 */
export class MemoryLoop {
  private readonly session: FoldSession;
  private readonly recallConfig: FoldRecallConfig;
  private readonly recallState: FoldRecallState;
  private readonly episodeRuntime: EpisodeRuntime | null;
  private readonly enableLiveSource: boolean;
  private readonly enableAffinity: boolean;
  private readonly fileMetaProvider: FileMetaProvider | null;
  private readonly syntheticContext: SyntheticContextOptions;
  private readonly rootDir: string;

  // Touch-set accumulator for affinity (one entry per tool boundary).
  private readonly touchHistory: Array<ReadonlySet<string>> = [];
  // Last live-source hashes for stableSincePrior comparison.
  private priorSourceHashes: Map<string, string> = new Map();
  // Tracked paths from the last epoch (for live-source snapshotting).
  private lastEpochPaths: readonly string[] = [];
  // The folded view from the last epoch (for index rebuild detection).
  private lastFoldedView: readonly FoldMessage[] = [];
  private lastFoldedRawCount: number = 0;
  // Last live-source delta result (surfaces in the outcome).
  private lastLiveSourceDelta: BuildLiveSourceDeltasResult | undefined;

  constructor(options: MemoryLoopOptions) {
    this.session = options.session;
    this.recallConfig = options.recallConfig ?? DEFAULT_FOLD_RECALL_CONFIG;
    this.recallState = createFoldRecallState();
    this.episodeRuntime = options.episodeStore
      ? new EpisodeRuntime(options.episodeStore, { sessionId: options.sessionId })
      : null;
    this.enableLiveSource = options.enableLiveSource ?? false;
    this.enableAffinity = options.enableAffinity ?? false;
    this.fileMetaProvider = options.fileMetaProvider ?? null;
    this.syntheticContext = options.syntheticContext ?? {};
    this.rootDir = options.rootDir ?? process.cwd();
  }

  /**
   * Prepare the outgoing message view for the provider, with fold recall and
   * episodic recall injected.
   *
   * @param rawHistory Full provider-shaped message history (append-only).
   * @param context Tool input, claims, measured tokens, and epoch paths.
   * @returns Compacted messages + recall context + episode cards.
   */
  async prepare(
    rawHistory: FoldMessage[],
    context: MemoryLoopPrepareContext = {},
  ): Promise<MemoryLoopOutcome> {
    const { session, recallConfig, recallState, syntheticContext } = this;

    // ── Step 1: FoldSession.prepare ──
    // Build a portable hard-epoch seed with episodic sections only when a hard
    // epoch is possible (an explicit reset or pressure-ceiling handling). In
    // single-ceiling mode a pressure hit may append instead, but the prepared
    // seed must still be available if the append gate falls back to a reset.
    // Building it on every turn would scan the full history and episode store.
    const needsPortableSeed = context.hardEpochSeed == null
      && (context.hardEpoch === true
        || session.willTriggerPressureCeiling(context.measuredInputTokens));

    const foldOutcome = session.prepare(rawHistory, {
      measuredInputTokens: context.measuredInputTokens,
      fidelity: context.fidelity,
      durableCursorIndex: context.durableCursorIndex,
      // Host-forced hard epochs (manual compact/reset, process handoff) and the
      // freeze layer's pin-aware context ride through here — previously these
      // were silently dropped, so `hardEpoch: true` never reached FoldSession
      // and claimed paths never protected frozen turns from eviction.
      hardEpoch: context.hardEpoch,
      thinningMode: context.thinningMode,
      claimedPaths: context.claimedPaths,
      hardEpochSeed: needsPortableSeed
        ? this.buildPortableHardEpochSeed(rawHistory, this.episodeRuntime, this.recallState.index, context)
        : context.hardEpochSeed,
    });

    const isEpoch = !foldOutcome.cacheHot;

    // ── Step 2: Epoch post-processing ──
    if (isEpoch) {
      // Rebuild the fold recall index from the new view.
      const foldedView = foldOutcome.messages;

      // Hard epochs replace the view with a markerless rebirth-package seed —
      // no "[Conversation Context — N turns folded]" block exists, so the
      // marker-gated index would come back empty and fold recall would go
      // dormant across the reset. seedFoldsEntireRaw derives the folded-turn
      // count from the detected raw turns instead, making every pre-reset turn
      // recall-addressable against the retained raw backing store. Parity with
      // the relay portable-reset commit (fcBaseSession) and the CLI engines'
      // isHardEpoch branches.
      // Runway/yield fallbacks carry the gate in a compound reason, while a
      // restored-state integrity failure has its own structural reason. Both
      // replace the provider view with the same markerless hard-epoch seed.
      const epochReason = foldOutcome.stats.epochReason;
      const isHardEpoch = epochReason === 'restore-integrity-failed'
        || (epochReason?.endsWith('hard-epoch') ?? false);
      recallState.index = buildFoldIndex(
        rawHistory,
        foldedView,
        undefined,
        syntheticContext,
        isHardEpoch ? { seedFoldsEntireRaw: true } : {},
      );
      this.lastFoldedView = foldedView;
      this.lastFoldedRawCount = recallState.index?.rawCount ?? rawHistory.length;

      // Derive and persist episodes from the folded portion of history.
      if (this.episodeRuntime) {
        const foldedRawCount = recallState.index?.rawCount ?? rawHistory.length;
        const episodeMessages = rawHistory.slice(0, foldedRawCount);
        this.episodeRuntime.captureAndPersist(episodeMessages as readonly import('../episodes/episodeStore.ts').PortableMessage[], {
          closeOpenBurst: true,
          now: new Date().toISOString(),
        });
      }

      // Populate enrichment carriers.
      const epochPaths = context.epochPaths ?? this.extractEpochPaths(recallState.index);
      this.lastEpochPaths = epochPaths;

      await this.populateEnrichment(epochPaths);
    }

    // ── Step 3: Tool-boundary recall ──
    const claimedPaths = context.claimedPaths ?? new Set<string>();
    const toolInput = context.toolInput ?? null;

    // Accumulate touch sets for affinity.
    if (this.enableAffinity && toolInput) {
      const touches = touchSetsFromToolInputs([toolInput])[0];
      if (touches.size > 0) this.touchHistory.push(touches);
    }

    // Derive recall signals.
    const utilization = this.resolveUtilization(context);
    const { signals, proceed } = deriveBoundaryRecallSignals(
      toolInput,
      claimedPaths,
      rawHistory,
      this.lastFoldedRawCount || rawHistory.length,
      recallConfig,
      syntheticContext,
    );

    let recallContext = '';
    let episodeCards: EpisodeRecallCard[] = [];

    if (proceed) {
      // Build fold recall context (ambient page-in).
      const outcome = buildFoldRecallContext(
        recallState,
        rawHistory,
        signals,
        utilization,
        recallConfig,
        syntheticContext,
      );
      recallContext = outcome.text ?? '';
    }

    // Episodic recall (durable cross-session memory).
    if (this.episodeRuntime && signals.touchedPaths.length > 0) {
      const result = this.episodeRuntime.recallCards(signals.touchedPaths, {
        limit: 3,
        maxChars: 4000,
      });
      episodeCards = [...result.cards];
    }

    return {
      messages: foldOutcome.messages,
      fold: foldOutcome,
      recallContext,
      episodeCards,
      epochTriggered: isEpoch,
      recallStats: {
        cardsInjected: recallState.cardsInjected,
        hintsInjected: recallState.hintsInjected,
        recallChars: recallState.recallChars,
        suppressed: recallState.suppressed,
      },
      liveSourceDelta: isEpoch ? this.lastLiveSourceDelta : undefined,
    };
  }

  /**
   * Resolve the context utilization level from measured tokens.
   */
  private resolveUtilization(context: MemoryLoopPrepareContext): ContextUtilizationLevel {
    if (context.measuredInputTokens !== undefined && context.contextWindow && context.contextWindow > 0) {
      return getUtilizationLevel(context.measuredInputTokens, context.contextWindow);
    }
    return 'healthy';
  }

  /**
   * Build a portable hard-epoch seed with lineage glyph log (verdict/hazard
   * trail) + trace-derived episodic cross-ref. Only called when a hard epoch
   * is possible (explicit reset or pressure handling), avoiding work on turns
   * that cannot enter the reset path.
   */
  private buildPortableHardEpochSeed(
    rawHistory: FoldMessage[],
    episodeRuntime: EpisodeRuntime | null,
    recallIndex: FoldRecallState['index'],
    context: MemoryLoopPrepareContext,
  ): string {
    const lineageGlyphLog = buildLineageGlyphLogFromMessages(rawHistory);
    let episodicCrossRef = '';
    if (episodeRuntime) {
      const epochPaths = context.epochPaths ?? this.extractEpochPaths(recallIndex);
      if (epochPaths.length > 0) {
        const result = episodeRuntime.recallCards(epochPaths, {
          limit: 3,
          maxChars: 4_000,
        });
        episodicCrossRef = result.cards
          .map((c) => c.text || '')
          .filter(Boolean)
          .join('\n\n');
      }
    }
    return buildRawHardEpochSeed(rawHistory, {
      maxChars: DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS,
      episodicCrossRef: episodicCrossRef || undefined,
      lineageGlyphLog: lineageGlyphLog || undefined,
    });
  }

  /**
   * Extract normalized paths from the fold index for enrichment.
   */
  private extractEpochPaths(index: FoldRecallState['index']): string[] {
    if (!index) return [];
    const paths = new Set<string>();
    for (const entry of index.entries) {
      if (entry.kind === 'turn') {
        for (const path of entry.paths) paths.add(path);
      } else {
        if (entry.path) paths.add(entry.path);
      }
    }
    return [...paths];
  }

  /**
   * Populate enrichment carriers from host providers.
   */
  private async populateEnrichment(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;

    const tasks: Promise<void>[] = [];

    // Live-source deltas.
    if (this.enableLiveSource) {
      tasks.push(
        (async () => {
          const result = await buildLiveSourceDeltas(paths, {
            rootDir: this.rootDir,
            priorHashes: this.priorSourceHashes,
          });
          this.recallState.pathSourceDeltas = result.deltas;
          this.priorSourceHashes = result.currentHashes;
          this.lastLiveSourceDelta = result;
        })(),
      );
    }

    // Behavioral affinity.
    if (this.enableAffinity && this.touchHistory.length > 0) {
      this.recallState.pathAffinity = buildPathAffinity(this.touchHistory);
    }

    // File metadata provider.
    if (this.fileMetaProvider) {
      tasks.push(
        populateFoldRecallMeta(this.recallState, paths, this.fileMetaProvider),
      );
    }

    await Promise.all(tasks);
  }

  /**
   * Get the raw fold recall state (for inspection or serialization).
   */
  getRecallState(): FoldRecallState {
    return this.recallState;
  }

  /**
   * Get the episode runtime (for direct store operations).
   */
  getEpisodeRuntime(): EpisodeRuntime | null {
    return this.episodeRuntime;
  }
}
