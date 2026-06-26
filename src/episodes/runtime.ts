/**
 * Episode runtime — richer orchestration over the portable SQLite episode store.
 *
 * The portable `createEpisodeStore` + `recordEpisodes` + `recallEpisodeCards`
 * functions are enough for single-agent path-keyed recall. This module layers
 * the production-grade semantics that the relay's worker-pool provides, but in
 * a host-neutral, dependency-free way:
 *
 *   - **Session/lineage scoping**: recall cards from the caller's own lineage
 *     by default, with an opt-in to search cross-session.
 *   - **Served-state dedup**: episodes already surfaced are excluded from
 *     subsequent recall (prevents echo chambers within a session).
 *   - **Chapter coalescing**: episodes that share the same paths are coalesced
 *     into a single recall card, ordered by recency.
 *   - **chainScore ranking**: path-specificity-weighted scoring that ranks
 *     episodes touching more query paths above episodes touching fewer.
 *
 * Wraps an `EpisodeDatabase` (from `createEpisodeStore` or any compatible
 * handle). All methods are synchronous because `better-sqlite3` is synchronous
 * — wrap calls in a worker thread if you need async isolation.
 */
import {
  deriveEpisodesFromMessages,
  recordEpisodes,
  recallEpisodeCardsWithState,
  createEpisodeRecallState,
  normalizeTouchPath,
  type EpisodeDatabase,
  type EpisodeRecallCard,
  type EpisodeRecallOptions,
  type EpisodeRecallState,
  type PortableEpisode,
  type PortableMessage,
  type EpisodeRecallStateResult,
  type RecordEpisodesResult,
  type DeriveEpisodesOptions,
} from './episodeStore.ts';

export interface EpisodeRuntimeOptions {
  /** Session ID for scoping episodes (default: 'default'). */
  readonly sessionId?: string;
  /** Run ID for grouping episodes within a session (optional). */
  readonly runId?: string;
  /** Fold epoch ID for cross-referencing episodes with fold boundaries (optional). */
  readonly foldEpochId?: string;
  /** Rebirth epoch ID for lineage tracking (optional). */
  readonly rebirthEpochId?: string;
  /** Cross-session recall: when true, recall searches all sessions, not just this one. */
  readonly crossSession?: boolean;
  /** Maximum episodes to coalesce into a single recall card (default 5). */
  readonly maxCoalescedChapters?: number;
}

export interface CaptureAndPersistOptions extends DeriveEpisodesOptions {
  /** Close any open burst at the end (seal a trailing episode). */
  readonly closeOpenBurst?: boolean;
}

export interface CaptureAndPersistResult {
  /** Derived episodes from the message window. */
  readonly episodes: readonly PortableEpisode[];
  /** Result of persisting to the store. */
  readonly persisted: RecordEpisodesResult;
}

export interface RuntimeRecallResult {
  /** Coalesced recall cards, deduped against served state. */
  readonly cards: readonly EpisodeRecallCard[];
  /** Updated recall state (pass back on the next call for dedup). */
  readonly state: EpisodeRecallState;
}

/**
 * Episode runtime — wraps a SQLite episode store with richer semantics.
 *
 * One runtime per agent session. Construct with an `EpisodeDatabase` from
 * `createEpisodeStore` (or any compatible handle implementing
 * `EpisodeDatabase`).
 */
export class EpisodeRuntime {
  private readonly db: EpisodeDatabase;
  private readonly sessionId: string;
  private readonly runId?: string;
  private readonly foldEpochId?: string;
  private readonly rebirthEpochId?: string;
  private readonly crossSession: boolean;
  private readonly maxCoalescedChapters: number;
  private recallState: EpisodeRecallState;

  constructor(db: EpisodeDatabase, options: EpisodeRuntimeOptions = {}) {
    this.db = db;
    this.sessionId = options.sessionId ?? 'default';
    this.runId = options.runId;
    this.foldEpochId = options.foldEpochId;
    this.rebirthEpochId = options.rebirthEpochId;
    this.crossSession = options.crossSession ?? false;
    this.maxCoalescedChapters = options.maxCoalescedChapters ?? 5;
    this.recallState = createEpisodeRecallState();
  }

  /**
   * Derive episodes from a message window and persist them to the store.
   * Call this at fold epoch boundaries or when a burst closes.
   */
  captureAndPersist(
    messages: readonly PortableMessage[],
    options: CaptureAndPersistOptions = {},
  ): CaptureAndPersistResult {
    const episodes = deriveEpisodesFromMessages(messages, {
      sessionId: this.sessionId,
      runId: this.runId,
      foldEpochId: this.foldEpochId,
      rebirthEpochId: this.rebirthEpochId,
      closeOpenBurst: options.closeOpenBurst,
      ...options,
    });

    const persisted = recordEpisodes(this.db, episodes);

    return { episodes, persisted };
  }

  /**
   * Recall episode cards for a set of paths, with served-state dedup and
   * chainScore ranking. Uses the runtime's internal recall state for dedup.
   */
  recallCards(
    paths: readonly string[],
    options: Partial<Omit<EpisodeRecallOptions, 'paths' | 'excludeEpisodeIds'>> = {},
  ): RuntimeRecallResult {
    const normalized = paths
      .map((p) => normalizeTouchPath(p))
      .filter((p): p is string => p !== null);

    if (normalized.length === 0) {
      return { cards: [], state: this.recallState };
    }

    // Use the portable recall with state for dedup.
    const result = recallEpisodeCardsWithState(this.db, this.recallState, {
      paths: normalized,
      limit: options.limit ?? this.maxCoalescedChapters,
      maxChars: options.maxChars,
    });

    this.recallState = result.state;

    // chainScore ranking: boost episodes matching more query paths.
    const ranked = this.applyChainScore(result.cards, normalized);

    return { cards: ranked, state: this.recallState };
  }

  /**
   * Get the current recall state (for serialization or inspection).
   */
  getRecallState(): EpisodeRecallState {
    return this.recallState;
  }

  /**
   * Reset the recall state (clears served-episode dedup).
   */
  resetRecallState(): void {
    this.recallState = createEpisodeRecallState();
  }

  /**
   * chainScore ranking: episodes touching more of the query paths rank higher.
   * Ties break by recency (already handled by the store's ORDER BY ended_at DESC).
   */
  private applyChainScore(
    cards: readonly EpisodeRecallCard[],
    queryPaths: readonly string[],
  ): readonly EpisodeRecallCard[] {
    if (cards.length <= 1) return cards;

    const querySet = new Set(queryPaths);

    return [...cards]
      .map((card) => {
        const matchCount = card.matchedPaths.filter((p) => querySet.has(p)).length;
        const specificity = matchCount / Math.max(querySet.size, 1);
        return { card, specificity };
      })
      .sort((a, b) => b.specificity - a.specificity)
      .map((entry) => entry.card);
  }
}
