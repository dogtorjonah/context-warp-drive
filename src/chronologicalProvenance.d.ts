/**
 * Universal chronological provenance for model-visible continuity artifacts.
 *
 * The compact text grammar makes prompt topology explicit: where source
 * material lived, when it was transformed, where exact raw history resumes,
 * and whether newer raw state overrides the synthesis. Pure CPU, no clocks,
 * no I/O, and no token estimates. Hosts must pass every coordinate they know;
 * unavailable coordinates remain visibly unknown.
 */
import { type FoldMessage } from './rollingFold.ts';
export type ChronologicalContentClass = 'raw' | 'exact-excerpt' | 'synthesized-history' | 'retrieved-history' | 'reconstructed-state' | 'live-state' | 'boundary';
export type ChronologicalCoordinateUnit = 'event' | 'message' | 'row' | 'turn' | 'exchange';
export interface ChronologicalPoint {
    readonly traceId?: string;
    readonly unit: ChronologicalCoordinateUnit;
    readonly index?: number;
    readonly id?: string;
    /** Measured source timestamp. Never inferred from another coordinate. */
    readonly timestamp?: string;
}
export interface ChronologicalSpan {
    readonly start: ChronologicalPoint;
    /** Exclusive when numeric; the renderer prints `[start..end)`. */
    readonly endExclusive?: ChronologicalPoint;
    readonly count?: number;
    readonly lastTimestamp?: string;
}
export interface ChronologicalTopology {
    readonly host: 'dedicated-synthetic-message' | 'dedicated-band-message' | 'continuity-package' | 'embedded-message-suffix';
    readonly previous: 'frozen-prefix' | 'rebirth-seed' | 'raw-history' | 'unknown';
    readonly next: 'raw-tail' | 'later-band' | 'none' | 'unknown';
    readonly representation: 'canonical' | 'alias';
    readonly rawTailCount: number;
}
export interface ChronologicalProvenanceEnvelope {
    readonly artifact: string;
    readonly contentClass: ChronologicalContentClass;
    readonly source: ChronologicalSpan;
    readonly transformedAt: ChronologicalPoint;
    readonly rawResumesAt?: ChronologicalPoint;
    readonly authority: 'historical-background' | 'current-as-of-frontier' | 'live';
    readonly supersession: 'later-raw-wins' | 'none-known' | 'explicit';
    readonly supersededAt?: ChronologicalPoint;
    readonly topology: ChronologicalTopology;
    readonly liveObjective?: string;
}
export interface ChronologicalValidationResult {
    readonly valid: boolean;
    readonly errors: readonly string[];
}
export declare function validateChronologicalProvenance(envelope: ChronologicalProvenanceEnvelope): ChronologicalValidationResult;
/** Render the stable grammar; contradictory coordinates become an explicit invalid marker. */
export declare function renderChronologicalProvenance(envelope: ChronologicalProvenanceEnvelope): string | null;
/** Single-line form for repeated embedded artifacts such as recall cards. */
export declare function renderChronologicalProvenanceCompact(envelope: ChronologicalProvenanceEnvelope): string | null;
export interface TailEpochProvenanceInput {
    readonly traceId?: string;
    readonly epoch: number;
    readonly unit: 'message' | 'row';
    readonly sourceStart: number;
    readonly sourceEndExclusive: number;
    readonly sourceFirstTimestamp?: string;
    readonly sourceLastTimestamp?: string;
    readonly committedAt: string;
    readonly rawTailCount: number;
    readonly rawResumeIndex?: number;
    readonly host: ChronologicalTopology['host'];
    readonly previous?: ChronologicalTopology['previous'];
    readonly liveObjective?: string;
}
export interface TailEpochAliasProvenanceInput {
    readonly traceId?: string;
    readonly epoch: number;
    readonly rawTailCount: number;
}
/** Compact pointer used by transient boundary notices; the canonical row owns exact ranges. */
export declare function renderTailEpochAliasProvenance(input: TailEpochAliasProvenanceInput): string | null;
export interface ContinuityPackageProvenanceInput {
    readonly artifact: string;
    readonly traceId?: string;
    readonly sourceEventCount?: number;
    /** Exact raw rows that follow the package in the model-visible prompt. */
    readonly rawTailCount: number;
}
export interface EmbeddedContinuityArtifactProvenanceInput {
    readonly artifact: string;
    readonly contentClass: 'exact-excerpt' | 'synthesized-history';
    readonly traceId: string;
    readonly unit: 'message' | 'row';
    readonly sourceStart: number;
    readonly sourceEndExclusive: number;
    readonly sourceFirstTimestamp?: string;
    readonly sourceLastTimestamp?: string;
    readonly authority: 'historical-background' | 'current-as-of-frontier' | 'live';
    readonly previous?: ChronologicalTopology['previous'];
}
/**
 * Locate a compact excerpt/synthesis embedded inside another continuity
 * message. The enclosing epoch/package owns the global seam; this alias owns
 * its exact local source window so it cannot masquerade as a newer raw turn.
 */
export declare function renderEmbeddedContinuityArtifactProvenance(input: EmbeddedContinuityArtifactProvenanceInput): string | null;
/**
 * Locate a rebirth/resurrection package against its persisted predecessor
 * trace and the exact live frontier that follows it. Hosts pass measured event
 * counts only; an unavailable count stays visibly unknown.
 */
export declare function renderContinuityPackageProvenance(input: ContinuityPackageProvenanceInput): string | null;
export declare function renderTailEpochProvenance(input: TailEpochProvenanceInput): string | null;
/** Measured message timestamp bounds; absent timestamps remain absent. */
export declare function foldMessageTimestampBounds(messages: readonly FoldMessage[]): {
    firstTimestamp?: string;
    lastTimestamp?: string;
};
/** Append a dedicated relay-internal user message; never mutates source arrays. */
export declare function appendDedicatedChronologicalMessage<T extends FoldMessage>(view: readonly T[], provenance: string | null): T[];
/**
 * Move a proposed raw-tail split left when it would sever a completed tool
 * call/result pair or fold away a call that still has no result. Repeats to
 * closure for parallel or nested calls.
 */
export declare function selectPairingSafeRawTailStart(messages: readonly FoldMessage[], proposedStart: number): number;
