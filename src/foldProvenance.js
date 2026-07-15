/**
 * Fold provenance receipts — a machine-readable trust boundary between the
 * engine's internal raw/folded state and any outside process that must decide
 * whether a compacted context is still authoritative.
 *
 * `FoldSession.prepare()` is deterministic: identical raw history + config
 * produce a byte-identical prepared view and frozen prefix. This module makes
 * that invariant EXTERNALLY ATTESTABLE without shipping the private raw
 * transcript around:
 *
 *   - `buildPrepareReceipt(messages, outcome, options?)` digests the raw
 *     history, the prepared view, and the frozen cache prefix into a small
 *     JSON-safe receipt (sha256 digests only — no raw content is embedded).
 *   - `verifyPrepareReceipt(receipt, probe)` re-derives the digests from live
 *     state and answers the downstream question directly: `safe_to_resume`
 *     or `stale`, with machine-readable stale reasons.
 *
 * Privacy boundary — stated honestly:
 *   - The RECEIPT embeds digests and counters only; it is safe to share with
 *     reviewers/agents that must not see the session.
 *   - The FOLDED VIEW is NOT content-free: fold blocks, skeletons, and
 *     Coordinate Closet literals are condensed raw history by design. The
 *     receipt attests to the view's identity; it does not sanitize the view.
 *
 * Determinism contract: pure CPU, zero I/O, no clock reads. When the host
 * omits `generatedAt`, identical inputs produce a byte-identical receipt
 * (`JSON.stringify` stable — object keys are emitted in declaration order and
 * digests use canonical sorted-key serialization).
 *
 * Token discipline (GOD RULE 7): the receipt never estimates tokens. It
 * echoes host-supplied measured provider tokens verbatim or omits the field;
 * `tokenizer` is an opaque host label, never inferred.
 */
import { createHash } from 'node:crypto';
// ── Canonical serialization + digests ──────────────────────────────────────
/**
 * Deterministic JSON serialization: object keys recursively sorted,
 * `undefined`/function/symbol object members dropped (JSON semantics),
 * non-finite numbers serialized as null. Identical structural inputs produce
 * identical strings regardless of key insertion order.
 */
export function canonicalJson(value) {
    if (value === null || value === undefined)
        return 'null';
    const t = typeof value;
    if (t === 'number')
        return Number.isFinite(value) ? String(value) : 'null';
    if (t === 'boolean')
        return value ? 'true' : 'false';
    if (t === 'string')
        return JSON.stringify(value);
    if (t === 'function' || t === 'symbol' || t === 'undefined')
        return 'null';
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    }
    if (t === 'object') {
        const record = value;
        const keys = Object.keys(record).sort();
        const parts = [];
        for (const key of keys) {
            const member = record[key];
            if (member === undefined || typeof member === 'function' || typeof member === 'symbol')
                continue;
            parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
        }
        return `{${parts.join(',')}}`;
    }
    return 'null';
}
/** sha256 digest of a value's canonical JSON, rendered as `sha256:<hex>`. */
export function foldProvenanceDigest(value) {
    return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
// ── Receipt schema ──────────────────────────────────────────────────────────
export const FOLD_PREPARE_RECEIPT_VERSION = 1;
/**
 * Documented invalidation conditions baked into every receipt so a downstream
 * consumer knows what the digests do — and do not — cover. Digest-checkable
 * conditions map to {@link FoldReceiptStaleReason} codes; the rest describe
 * environmental assumptions the consumer must track itself.
 */
export const FOLD_RECEIPT_STALE_IF = [
    'raw_history_digest_changed',
    'folded_view_digest_changed',
    'frozen_prefix_digest_changed',
    'config_digest_changed',
    'raw_history_store_unavailable',
    'provider_cache_semantics_changed',
];
export const DEFAULT_FOLD_RECEIPT_STRATEGY = 'rolling-fold+freeze+coordinate-closet';
// ── Build ───────────────────────────────────────────────────────────────────
/**
 * Digest the inputs and outputs of one `FoldSession.prepare()` call into a
 * shareable provenance receipt. Pure and deterministic: no clock, no I/O.
 *
 * @param messages the SAME full raw history array passed to prepare().
 * @param outcome the FoldOutcome returned by prepare().
 * @param options host-supplied identifiers, config fingerprint, and labels.
 */
export function buildPrepareReceipt(messages, outcome, options = {}) {
    const sealedBoundary = typeof outcome.sealedBoundary === 'number' && outcome.sealedBoundary > 0
        ? outcome.sealedBoundary
        : null;
    const frozenPrefixDigest = sealedBoundary !== null
        ? foldProvenanceDigest(outcome.messages.slice(0, sealedBoundary))
        : null;
    const configDigest = options.configFingerprint !== undefined
        ? foldProvenanceDigest(options.configFingerprint)
        : undefined;
    return {
        version: FOLD_PREPARE_RECEIPT_VERSION,
        kind: 'fold-prepare-receipt',
        subject: {
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(options.provider !== undefined ? { provider: options.provider } : {}),
            ...(options.model !== undefined ? { model: options.model } : {}),
            turnCount: outcome.stats.totalTurns,
            messageCount: messages.length,
        },
        input: {
            rawHistoryDigest: foldProvenanceDigest(messages),
            messageCount: messages.length,
            ...(options.rawHistoryStoreRef !== undefined ? { rawHistoryStoreRef: options.rawHistoryStoreRef } : {}),
            ...(options.tokenizer !== undefined ? { tokenizer: options.tokenizer } : {}),
            ...(typeof options.measuredInputTokens === 'number' && Number.isFinite(options.measuredInputTokens)
                ? { measuredInputTokens: options.measuredInputTokens }
                : {}),
        },
        fold: {
            strategy: options.strategy ?? DEFAULT_FOLD_RECEIPT_STRATEGY,
            ...(configDigest !== undefined ? { configDigest } : {}),
            foldedViewDigest: foldProvenanceDigest(outcome.messages),
            preparedMessageCount: outcome.messages.length,
            frozenPrefixDigest,
            sealedBoundary,
            cacheHot: outcome.cacheHot,
            epochs: outcome.stats.epochs,
            hotReuses: outcome.stats.hotReuses,
            ...(outcome.stats.epochReason !== undefined ? { epochReason: outcome.stats.epochReason } : {}),
            ...(outcome.stats.turnsFolded !== undefined ? { turnsFolded: outcome.stats.turnsFolded } : {}),
            ...(outcome.stats.originalChars !== undefined ? { originalChars: outcome.stats.originalChars } : {}),
            ...(outcome.stats.foldedChars !== undefined ? { foldedChars: outcome.stats.foldedChars } : {}),
            ...(outcome.stats.savingsPercent !== undefined ? { savingsPercent: outcome.stats.savingsPercent } : {}),
        },
        privacy: {
            receiptEmbedsRawContent: false,
            digestsOnly: true,
            foldedViewDerivedFromRawHistory: true,
        },
        staleIf: FOLD_RECEIPT_STALE_IF,
        ...(options.generatedAt !== undefined ? { generatedAt: options.generatedAt } : {}),
    };
}
/**
 * Re-derive digests from live state and compare against a receipt. Only the
 * probes actually supplied are checked — a receipt cannot go stale on a
 * dimension the caller did not provide evidence for. `safe_to_resume` means
 * every supplied probe matched; it is not a claim about unchecked dimensions
 * (see `receipt.staleIf` for the full documented invalidation surface).
 */
export function verifyPrepareReceipt(receipt, probe = {}) {
    const staleReasons = [];
    if (receipt.version !== FOLD_PREPARE_RECEIPT_VERSION) {
        staleReasons.push('receipt_version_unsupported');
    }
    if (probe.messages !== undefined
        && foldProvenanceDigest(probe.messages) !== receipt.input.rawHistoryDigest) {
        staleReasons.push('raw_history_digest_changed');
    }
    if (probe.outcome !== undefined) {
        if (foldProvenanceDigest(probe.outcome.messages) !== receipt.fold.foldedViewDigest) {
            staleReasons.push('folded_view_digest_changed');
        }
        const probeBoundary = typeof probe.outcome.sealedBoundary === 'number' && probe.outcome.sealedBoundary > 0
            ? probe.outcome.sealedBoundary
            : null;
        if (receipt.fold.frozenPrefixDigest !== null) {
            const probePrefixDigest = probeBoundary !== null
                ? foldProvenanceDigest(probe.outcome.messages.slice(0, probeBoundary))
                : null;
            if (probePrefixDigest !== receipt.fold.frozenPrefixDigest) {
                staleReasons.push('frozen_prefix_digest_changed');
            }
        }
    }
    if (probe.configFingerprint !== undefined) {
        const probeConfigDigest = foldProvenanceDigest(probe.configFingerprint);
        if (receipt.fold.configDigest === undefined || probeConfigDigest !== receipt.fold.configDigest) {
            staleReasons.push('config_digest_changed');
        }
    }
    return {
        verdict: staleReasons.length === 0 ? 'safe_to_resume' : 'stale',
        staleReasons,
    };
}
//# sourceMappingURL=foldProvenance.js.map