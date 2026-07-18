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
  recallEpisodeCards,
  createEpisodeRecallState,
  normalizeTouchPath,
  type EpisodeDatabase,
  type EpisodeRecallCard,
  type EpisodeRecallOptions,
  type EpisodeRecallState,
  type PortableEpisode,
  type PortableMessage,
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
  /** Optional rendered-card count. Omitted leaves cardinality to maxChars/the caller. */
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
  private readonly maxCoalescedChapters?: number;
  private recallState: EpisodeRecallState;

  constructor(db: EpisodeDatabase, options: EpisodeRuntimeOptions = {}) {
    this.db = db;
    this.sessionId = options.sessionId ?? 'default';
    this.runId = options.runId;
    this.foldEpochId = options.foldEpochId;
    this.rebirthEpochId = options.rebirthEpochId;
    this.crossSession = options.crossSession ?? false;
    this.maxCoalescedChapters = options.maxCoalescedChapters;
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

    // Load every unserved candidate first. Ranking must see the complete pool;
    // rendered-card limits and maxChars are applied only after chainScore.
    const candidates = recallEpisodeCards(this.db, {
      paths: normalized,
      excludeEpisodeIds: this.recallState.servedEpisodeIds,
    });
    const ranked = this.applyChainScore(candidates, normalized);
    const cards = selectRenderedCards(
      ranked,
      options.maxChars,
      options.limit ?? this.maxCoalescedChapters,
    );
    this.recallState = {
      servedEpisodeIds: [...new Set([
        ...this.recallState.servedEpisodeIds,
        ...cards.map((card) => card.episodeId),
      ])],
    };

    return { cards, state: this.recallState };
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

function selectRenderedCards(
  cards: readonly EpisodeRecallCard[],
  maxChars: number | undefined,
  limit: number | undefined,
): readonly EpisodeRecallCard[] {
  const renderedLimit = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
  const selected: EpisodeRecallCard[] = [];
  let usedChars = 0;
  for (const card of cards) {
    if (renderedLimit !== undefined && selected.length >= renderedLimit) break;
    const nextChars = usedChars + card.text.length;
    if (maxChars !== undefined && nextChars > maxChars) break;
    selected.push(card);
    usedChars = nextChars;
  }
  return selected;
}
