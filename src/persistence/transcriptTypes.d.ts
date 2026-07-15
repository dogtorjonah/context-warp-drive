/**
 * Transcript types — vendored subset for context-warp.
 *
 * Trimmed from the relay's `relay/src/persistence/transcriptTypes.ts` to ONLY
 * the three types the fold engine's distinctive-term + sparse-vector primitives
 * actually consume: `ChunkType`, `TranscriptChunk`, and `SparseVector`. The full
 * relay file additionally defines BM25 / HNSW / hybrid-retrieval index types that
 * the fold engine does not use; they are intentionally omitted here.
 *
 * Zero external dependencies.
 */
export type ChunkType = 'user_ask' | 'assistant_conclusion' | 'agent_reasoning' | 'code_edit' | 'tool_failure' | 'canonical_event' | 'decision' | 'discovery' | 'result' | 'review_verdict' | 'thought' | 'rebirth_boundary';
/**
 * A retrieval unit extracted from the raw JSONL transcript.
 * This is the fundamental atom of the transcript index — everything
 * (BM25, HNSW, hybrid retrieval) operates on chunks.
 */
export interface TranscriptChunk {
    /** Unique chunk ID (uuid or sequential). */
    id: string;
    /** Semantic type of this chunk. */
    type: ChunkType;
    /** Instance ID that produced this chunk. */
    instance_id: string;
    /** Instance name at time of chunking. */
    instance_name: string;
    /** Ordered predecessor chain (oldest first). */
    predecessor_chain: string[];
    /** ISO timestamp of the source message. */
    ts: string;
    /** File paths referenced in this chunk. */
    files: string[];
    /** Tool names involved. */
    tools: string[];
    /** Coordination tags present (#decision, #blocker, etc.). */
    tags: string[];
    /** The actual text content of the chunk. */
    text: string;
    /** Approximate token count (chars / 4). */
    tokens: number;
}
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
