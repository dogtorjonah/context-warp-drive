import type { FoldMessage } from './rollingFold.ts';
import type { FoldOutcome } from './session/FoldSession.ts';
/**
 * Deterministic JSON serialization: object keys recursively sorted,
 * `undefined`/function/symbol object members dropped (JSON semantics),
 * non-finite numbers serialized as null. Identical structural inputs produce
 * identical strings regardless of key insertion order.
 */
export declare function canonicalJson(value: unknown): string;
/** sha256 digest of a value's canonical JSON, rendered as `sha256:<hex>`. */
export declare function foldProvenanceDigest(value: unknown): string;
export declare const FOLD_PREPARE_RECEIPT_VERSION: 1;
/** Machine-readable staleness reason codes emitted by {@link verifyPrepareReceipt}. */
export type FoldReceiptStaleReason = 'receipt_version_unsupported' | 'raw_history_digest_changed' | 'folded_view_digest_changed' | 'frozen_prefix_digest_changed' | 'config_digest_changed';
/**
 * Documented invalidation conditions baked into every receipt so a downstream
 * consumer knows what the digests do — and do not — cover. Digest-checkable
 * conditions map to {@link FoldReceiptStaleReason} codes; the rest describe
 * environmental assumptions the consumer must track itself.
 */
export declare const FOLD_RECEIPT_STALE_IF: readonly string[];
export interface FoldReceiptSubject {
    /** Host-supplied opaque session identifier. */
    readonly sessionId?: string;
    /** Host-supplied provider label (e.g. "anthropic"). */
    readonly provider?: string;
    /** Host-supplied model label (e.g. "claude-sonnet-4-6"). */
    readonly model?: string;
    /** Conversational turns detected across the raw history (from FoldStats). */
    readonly turnCount: number;
    /** Raw provider-shaped message count handed to prepare(). */
    readonly messageCount: number;
}
export interface FoldReceiptInput {
    /** sha256 of the canonical serialization of the FULL raw history array. */
    readonly rawHistoryDigest: string;
    readonly messageCount: number;
    /**
     * Host-supplied opaque pointer to where the raw history lives (e.g.
     * "local-only:episode-store/...."). Never dereferenced by this module.
     */
    readonly rawHistoryStoreRef?: string;
    /** Host-supplied opaque tokenizer label. Never inferred. */
    readonly tokenizer?: string;
    /**
     * Measured provider/relay input tokens echoed VERBATIM from the host.
     * Omitted when the host has no measured telemetry — never estimated.
     */
    readonly measuredInputTokens?: number;
}
export interface FoldReceiptFold {
    /** Human-readable strategy label; override when freeze/eviction are disabled. */
    readonly strategy: string;
    /**
     * sha256 of the host's canonicalized config fingerprint (e.g. the
     * FoldSessionOptions object or any stable config identity the host chooses).
     * Omitted when the host supplied no fingerprint.
     */
    readonly configDigest?: string;
    /** sha256 of the canonical serialization of the prepared (folded) view. */
    readonly foldedViewDigest: string;
    /** Message count of the prepared view. */
    readonly preparedMessageCount: number;
    /**
     * sha256 of the frozen cache prefix (the first `sealedBoundary` prepared
     * messages) — the byte-identity that keeps the provider cache hot. Null when
     * no cacheable boundary has been sealed yet.
     */
    readonly frozenPrefixDigest: string | null;
    /** Sealed freeze boundary as a prepared-view message count; null when none. */
    readonly sealedBoundary: number | null;
    /** True when this prepare() reused the byte-identical frozen prefix. */
    readonly cacheHot: boolean;
    /** Freeze telemetry: total epochs and hot reuses since the last epoch. */
    readonly epochs: number;
    readonly hotReuses: number;
    /** Recompute reason when this call was an epoch. */
    readonly epochReason?: string;
    /** Fresh-fold telemetry echoed from FoldStats when present. */
    readonly turnsFolded?: number;
    readonly originalChars?: number;
    readonly foldedChars?: number;
    readonly savingsPercent?: number;
}
export interface FoldReceiptPrivacy {
    /** The receipt itself carries digests and counters only. */
    readonly receiptEmbedsRawContent: false;
    readonly digestsOnly: true;
    /**
     * Honest disclosure: the prepared view referenced by `foldedViewDigest`
     * contains condensed raw history (fold skeletons, Coordinate Closet
     * literals) by design. Attestation is not sanitization.
     */
    readonly foldedViewDerivedFromRawHistory: true;
}
export interface FoldPrepareReceipt {
    readonly version: typeof FOLD_PREPARE_RECEIPT_VERSION;
    readonly kind: 'fold-prepare-receipt';
    readonly subject: FoldReceiptSubject;
    readonly input: FoldReceiptInput;
    readonly fold: FoldReceiptFold;
    readonly privacy: FoldReceiptPrivacy;
    readonly staleIf: readonly string[];
    /**
     * Host-injected ISO timestamp. Omitted by default so identical inputs yield
     * byte-identical receipts (determinism contract).
     */
    readonly generatedAt?: string;
}
export interface BuildPrepareReceiptOptions {
    /** Opaque host identifiers for the subject block. */
    readonly sessionId?: string;
    readonly provider?: string;
    readonly model?: string;
    /** Opaque pointer to the local raw-history store; never dereferenced. */
    readonly rawHistoryStoreRef?: string;
    /** Opaque tokenizer label; never inferred. */
    readonly tokenizer?: string;
    /** Measured provider/relay input tokens, echoed verbatim (GOD RULE 7). */
    readonly measuredInputTokens?: number;
    /**
     * Any stable structural identity for the fold configuration (typically the
     * same FoldSessionOptions object passed to the FoldSession constructor).
     * Canonicalized + digested; functions inside are dropped structurally.
     */
    readonly configFingerprint?: unknown;
    /** Strategy label override (default `rolling-fold+freeze+coordinate-closet`). */
    readonly strategy?: string;
    /** Host-injected timestamp (ISO string). Omit for byte-identical receipts. */
    readonly generatedAt?: string;
}
export declare const DEFAULT_FOLD_RECEIPT_STRATEGY = "rolling-fold+freeze+coordinate-closet";
/**
 * Digest the inputs and outputs of one `FoldSession.prepare()` call into a
 * shareable provenance receipt. Pure and deterministic: no clock, no I/O.
 *
 * @param messages the SAME full raw history array passed to prepare().
 * @param outcome the FoldOutcome returned by prepare().
 * @param options host-supplied identifiers, config fingerprint, and labels.
 */
export declare function buildPrepareReceipt(messages: readonly FoldMessage[], outcome: FoldOutcome, options?: BuildPrepareReceiptOptions): FoldPrepareReceipt;
export interface VerifyPrepareReceiptProbe {
    /** Current raw history to check against `input.rawHistoryDigest`. */
    readonly messages?: readonly FoldMessage[];
    /** A fresh prepare() outcome to check the view + frozen prefix identity. */
    readonly outcome?: FoldOutcome;
    /** Current config fingerprint to check against `fold.configDigest`. */
    readonly configFingerprint?: unknown;
}
export interface VerifyPrepareReceiptResult {
    readonly verdict: 'safe_to_resume' | 'stale';
    readonly staleReasons: readonly FoldReceiptStaleReason[];
}
/**
 * Re-derive digests from live state and compare against a receipt. Only the
 * probes actually supplied are checked — a receipt cannot go stale on a
 * dimension the caller did not provide evidence for. `safe_to_resume` means
 * every supplied probe matched; it is not a claim about unchecked dimensions
 * (see `receipt.staleIf` for the full documented invalidation surface).
 */
export declare function verifyPrepareReceipt(receipt: FoldPrepareReceipt, probe?: VerifyPrepareReceiptProbe): VerifyPrepareReceiptResult;
