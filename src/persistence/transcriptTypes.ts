/**
 * Transcript types — minimal subset for context-warp-drive.
 *
 * The fold engine's distinctive-term + sparse-vector primitives only need
 * `ChunkType`, `TranscriptChunk`, and `SparseVector`; broader transcript-index
 * schemas are intentionally out of scope here.
 *
 * Zero external dependencies.
 */

// ── Chunk Types ──

export type ChunkType =
  | 'user_ask'
  | 'assistant_conclusion'
  | 'agent_reasoning'
  | 'code_edit'
  | 'tool_failure'
  | 'canonical_event'
  | 'decision'
  | 'discovery'
  | 'result'
  | 'review_verdict'
  | 'thought'
  | 'rebirth_boundary';

/**
 * A retrieval unit extracted from the raw JSONL transcript.
 * This is the fundamental atom of the transcript index — everything
 * (BM25, HNSW, hybrid retrieval) operates on chunks.
 */
export interface TranscriptChunk {
  // ── Identity ──
  /** Unique chunk ID (uuid or sequential). */
  id: string;
  /** Semantic type of this chunk. */
  type: ChunkType;
  /** Instance ID that produced this chunk. */
  instance_id: string;
  /** Instance name at time of chunking. */
  instance_name: string;

  // ── Lineage ──
  /** Ordered predecessor chain (oldest first). */
  predecessor_chain: string[];

  // ── Provenance ──
  /** ISO timestamp of the source message. */
  ts: string;
  /** File paths referenced in this chunk. */
  files: string[];
  /** Tool names involved. */
  tools: string[];
  /** Coordination tags present (#decision, #blocker, etc.). */
  tags: string[];

  // ── Content ──
  /** The actual text content of the chunk. */
  text: string;
  /** Optional caller-supplied token count. */
  tokens: number;
}

// ── Sparse Vector Types ──

/**
 * A sparse vector representation of a transcript chunk.
 * Dimensions are string keys (token names, metadata features).
 * Values are TF-IDF weights or binary indicators.
 */
export interface SparseVector {
  /** Chunk ID this vector represents. */
  chunkId: string;
  /** Sparse dimensions: key → weight. */
  dims: Map<string, number>;
  /** L2 norm (precomputed for fast cosine similarity). */
  norm: number;
}
