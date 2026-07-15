/**
 * Apply light suffix-stripping stemming. Returns the stem of a single token.
 * Pure function, no side effects, deterministic.
 *
 * Special rules:
 *   -ies → -y  ("queries" → "query", "retries" → "retry")
 *   -ied → -y  ("carried" → "carry")
 *   -es  → -e  ("instances" → "instance", "files" → "file")
 *   -ss  preserved ("compress" stays "compress", not "compres")
 *
 * All other suffixes are stripped directly: "folding" → "fold", "blocked" →
 * "block", "files" → "file", "compressed" → "compress". Imperfections (e.g.
 * "compression" → "compres" vs "compress") are caught by the synonym map.
 */
export declare function stem(token: string): string;
/**
 * Load a pre-computed synonym map at init time. Keys and values must be stems
 * (not surface forms) — the build script normalizes via the same stem()
 * function. Pass an empty map to disable synonym expansion.
 */
export declare function setSynonymMap(map: ReadonlyMap<string, readonly string[]>): void;
/**
 * Whether the synonym map has been loaded. Used by tests and diagnostics.
 */
export declare function isSynonymMapLoaded(): boolean;
export interface ExtractOpts {
    /** Max terms to retain — bounded for storage + match cost. Default 64. */
    cap?: number;
    /**
     * Min token length kept (sparseVector.tokenize already drops length<2; this
     * additionally drops short low-signal tokens). Default 3.
     */
    minLen?: number;
}
/**
 * Extract a bounded, deduped set of candidate terms from text. Distinctiveness
 * (rarity) is applied LATER at match time via IDF — here we only strip
 * grammatical stopwords and short tokens, then dedupe. Order is first-seen
 * (deterministic) for stable storage and reproducible matching. Truncation at
 * `cap` is a storage bound; a v2 could rank by local TF before truncating, but
 * first-seen keeps v1 deterministic and cheap.
 */
export declare function extractDistinctiveTerms(text: string, opts?: ExtractOpts): string[];
export interface OverlapMatch {
    term: string;
    idf: number;
}
export interface OverlapResult {
    /** Sum of IDF weights of all matched terms (idf>0). Scales with ln(corpus). */
    score: number;
    /**
     * Count of matched terms whose IDF >= the distinctiveness floor. This is the
     * scale-INVARIANT gate callers should threshold on (e.g. `>= 2`), because the
     * raw `score` grows with ln(corpusSize) and is not comparable across stores.
     */
    distinctiveCount: number;
    /** Matched terms with their IDF weight, descending by IDF. */
    matched: OverlapMatch[];
}
export interface OverlapOpts {
    /**
     * IDF floor: a matched term counts toward `distinctiveCount` only when its IDF
     * is >= this. Default 0.3 — above the ~0.18 IDF of a term that appears in the
     * large majority of documents, below the IDF of a genuinely rare coined term.
     */
    idfFloor?: number;
    /**
     * Fallback IDF for a matched term absent from the IDF map. A term shared by
     * BOTH query and candidate yet unseen in the corpus is, by construction, rare
     * → treat as distinctive. Default 1.0.
     */
    unseenIdf?: number;
}
/**
 * IDF-weighted set-intersection between a query term set and a candidate term
 * set. Returns the summed weight AND a scale-invariant count of DISTINCTIVE
 * matches (IDF >= floor). Callers should gate recall/selection on
 * `distinctiveCount >= 2` (robust across corpus sizes) rather than on a raw
 * `score` threshold. A term with IDF <= 0 (present in ~every document) carries
 * zero signal and is dropped — this is what stops common-word-only overlap from
 * ever faulting, the precise failure mode that got auto-RAG kill-switched.
 */
export declare function scoreTermOverlap(queryTerms: readonly string[], candTerms: readonly string[], idf: ReadonlyMap<string, number>, opts?: OverlapOpts): OverlapResult;
/**
 * Convenience: derive an IDF map from per-term document-frequency counts using
 * the same formula as sparseVector.computeIDF — `ln(N / (1 + df))`. Kept here
 * (rather than importing the chunk-corpus IDF) so the cross-reference path has
 * no dependency on the transcript-chunk search store. `N` is the number of
 * sealed episodes; `df` is how many carry the term.
 */
export declare function idfFromDocumentFrequency(documentFrequency: ReadonlyMap<string, number>, totalDocuments: number): Map<string, number>;
