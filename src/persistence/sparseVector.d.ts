/**
 * Sparse Vector Builder — zero-cost TF-IDF + metadata feature vectors.
 *
 * Converts TranscriptChunks into sparse vectors for HNSW indexing.
 * No external dependencies. No embedding models. No API calls.
 *
 * Vector dimensions:
 *   - Text tokens (TF-IDF weighted)
 *   - File paths mentioned (binary)
 *   - Tool names used (binary)
 *   - Chunk type (one-hot)
 *   - Tags (binary)
 */
import type { TranscriptChunk, SparseVector } from './transcriptTypes.ts';
/** Simple whitespace tokenizer with normalization. */
export declare function tokenize(text: string): string[];
/**
 * Compute inverse document frequency for all tokens across a chunk corpus.
 * IDF(t) = ln(N / (1 + df(t))) where df = number of docs containing token t.
 */
export declare function computeIDF(chunks: TranscriptChunk[]): Map<string, number>;
/**
 * Build a sparse vector from a transcript chunk.
 *
 * Dimensions:
 *   - `token_name`: TF-IDF weight for text tokens
 *   - `file:path/to/file.ts`: 1.0 if file referenced
 *   - `tool:Edit`: 1.0 if tool used
 *   - `type:decision`: 1.0 for chunk type (one-hot)
 *   - `tag:#blocker`: 1.0 if tag present
 */
export declare function buildVector(chunk: TranscriptChunk, idf: Map<string, number>): SparseVector;
/**
 * Build sparse vectors for an entire chunk corpus.
 * Computes IDF once, then vectorizes each chunk.
 */
export declare function buildVectors(chunks: TranscriptChunk[]): {
    vectors: SparseVector[];
    idf: Map<string, number>;
};
/**
 * Phase 1.5 — build sparse vectors for a candidate set with an EXTERNAL
 * (corpus-level) IDF map. This is the variant used on the bounded semantic
 * path where:
 *   - candidates are a small subset (~48 chunks) top-N from BM25
 *   - the IDF comes from `chunkStore.loadSparseIdf(instanceIds)` which is
 *     computed from the SAME basis as these candidate vectors
 *     (`sparseVector.tokenize(chunk.text)`), NOT the BM25/indexed-text basis
 *   - the query vector is built with `buildQueryVectorWithIdf` against the
 *     same corpus IDF — keeping both sides of cosine in a single space
 *
 * Candidate-local IDF via `buildVectors(candidates)` would drift the cosine
 * space between candidate and query vectors; the separate `chunk_sparse_token_stats`
 * basis in SQLite keeps the two aligned.
 */
export declare function buildVectorsWithIdf(chunks: TranscriptChunk[], idf: Map<string, number>): SparseVector[];
/**
 * Cosine similarity between two sparse vectors.
 * Iterates over the smaller vector's dimensions for efficiency.
 */
export declare function cosineSimilarity(a: SparseVector, b: SparseVector): number;
/**
 * Build a query vector from raw text + optional file hints.
 * Uses the corpus IDF for weighting.
 */
export declare function buildQueryVector(queryText: string, fileHints: string[], idf: Map<string, number>): SparseVector;
