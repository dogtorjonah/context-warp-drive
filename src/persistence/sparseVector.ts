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

// ── Tokenizer ──

/** Simple whitespace tokenizer with normalization. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./\-\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && t.length < 80);
}

// ── IDF Computation ──

/**
 * Compute inverse document frequency for all tokens across a chunk corpus.
 * IDF(t) = ln(N / (1 + df(t))) where df = number of docs containing token t.
 */
export function computeIDF(chunks: TranscriptChunk[]): Map<string, number> {
  const N = chunks.length;
  if (N === 0) return new Map();

  const df = new Map<string, number>();

  for (const chunk of chunks) {
    const seen = new Set<string>();
    for (const token of tokenize(chunk.text)) {
      if (!seen.has(token)) {
        seen.add(token);
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
  }

  const idf = new Map<string, number>();
  for (const [token, count] of df) {
    idf.set(token, Math.log(N / (1 + count)));
  }
  return idf;
}

// ── Vector Builder ──

/** Prefix constants for non-text dimensions. */
const FILE_PREFIX = 'file:';
const TOOL_PREFIX = 'tool:';
const TYPE_PREFIX = 'type:';
const TAG_PREFIX = 'tag:';

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
export function buildVector(
  chunk: TranscriptChunk,
  idf: Map<string, number>,
): SparseVector {
  const dims = new Map<string, number>();

  // ── Text token TF-IDF ──
  const tokens = tokenize(chunk.text);
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  const docLen = tokens.length || 1;
  for (const [token, count] of tf) {
    const tokenIdf = idf.get(token) ?? 0;
    if (tokenIdf > 0) {
      // Sublinear TF: 1 + ln(tf)
      const tfidf = (1 + Math.log(count)) * tokenIdf;
      dims.set(token, tfidf);
    }
  }

  // ── File path features (binary, boosted) ──
  for (const file of chunk.files) {
    dims.set(FILE_PREFIX + file, 2.0);
  }

  // ── Tool features (binary) ──
  for (const tool of chunk.tools) {
    dims.set(TOOL_PREFIX + tool, 1.0);
  }

  // ── Chunk type (one-hot, boosted for high-value types) ──
  const typeBoost: Record<string, number> = {
    decision: 2.0,
    discovery: 1.8,
    result: 1.5,
    review_verdict: 1.5,
    user_ask: 1.3,
    assistant_conclusion: 1.3,
    code_edit: 1.0,
    tool_failure: 1.2,
    thought: 0.8,
    rebirth_boundary: 0.5,
  };
  dims.set(TYPE_PREFIX + chunk.type, typeBoost[chunk.type] ?? 1.0);

  // ── Tag features (binary, boosted) ──
  for (const tag of chunk.tags) {
    dims.set(TAG_PREFIX + tag, 1.5);
  }

  // ── Compute L2 norm ──
  let sumSq = 0;
  for (const v of dims.values()) {
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq) || 1;

  return { chunkId: chunk.id, dims, norm };
}

/**
 * Build sparse vectors for an entire chunk corpus.
 * Computes IDF once, then vectorizes each chunk.
 */
export function buildVectors(chunks: TranscriptChunk[]): {
  vectors: SparseVector[];
  idf: Map<string, number>;
} {
  const idf = computeIDF(chunks);
  const vectors = chunks.map(chunk => buildVector(chunk, idf));
  return { vectors, idf };
}

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
export function buildVectorsWithIdf(
  chunks: TranscriptChunk[],
  idf: Map<string, number>,
): SparseVector[] {
  return chunks.map(chunk => buildVector(chunk, idf));
}

// ── Similarity ──

/**
 * Cosine similarity between two sparse vectors.
 * Iterates over the smaller vector's dimensions for efficiency.
 */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  // Iterate over the smaller vector
  const [smaller, larger] = a.dims.size <= b.dims.size ? [a, b] : [b, a];

  let dot = 0;
  for (const [key, valA] of smaller.dims) {
    const valB = larger.dims.get(key);
    if (valB !== undefined) {
      dot += valA * valB;
    }
  }

  const denom = a.norm * b.norm;
  return denom > 0 ? dot / denom : 0;
}

/**
 * Build a query vector from raw text + optional file hints.
 * Uses the corpus IDF for weighting.
 */
export function buildQueryVector(
  queryText: string,
  fileHints: string[],
  idf: Map<string, number>,
): SparseVector {
  const dims = new Map<string, number>();

  // Text tokens with IDF weighting
  const tokens = tokenize(queryText);
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  for (const [token, count] of tf) {
    const tokenIdf = idf.get(token) ?? 0;
    if (tokenIdf > 0) {
      dims.set(token, (1 + Math.log(count)) * tokenIdf);
    }
  }

  // File hints as boosted features
  for (const file of fileHints) {
    dims.set(FILE_PREFIX + file, 3.0); // Higher boost for explicit file hints in queries
  }

  let sumSq = 0;
  for (const v of dims.values()) {
    sumSq += v * v;
  }

  return { chunkId: '__query__', dims, norm: Math.sqrt(sumSq) || 1 };
}
