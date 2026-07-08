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
import type { FoldMessage } from './rollingFold.ts';
import type { FoldOutcome } from './session/FoldSession.ts';

// ── Canonical serialization + digests ──────────────────────────────────────

/**
 * Deterministic JSON serialization: object keys recursively sorted,
 * `undefined`/function/symbol object members dropped (JSON semantics),
 * non-finite numbers serialized as null. Identical structural inputs produce
 * identical strings regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (t === 'boolean') return (value as boolean) ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'function' || t === 'symbol' || t === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const member = record[key];
      if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/** sha256 digest of a value's canonical JSON, rendered as `sha256:<hex>`. */
export function foldProvenanceDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

// ── Receipt schema ──────────────────────────────────────────────────────────

export const FOLD_PREPARE_RECEIPT_VERSION = 1 as const;

/** Machine-readable staleness reason codes emitted by {@link verifyPrepareReceipt}. */
export type FoldReceiptStaleReason =
  | 'receipt_version_unsupported'
  | 'raw_history_digest_changed'
  | 'folded_view_digest_changed'
  | 'frozen_prefix_digest_changed'
  | 'config_digest_changed';

/**
 * Documented invalidation conditions baked into every receipt so a downstream
 * consumer knows what the digests do — and do not — cover. Digest-checkable
 * conditions map to {@link FoldReceiptStaleReason} codes; the rest describe
 * environmental assumptions the consumer must track itself.
 */
export const FOLD_RECEIPT_STALE_IF: readonly string[] = [
  'raw_history_digest_changed',
  'folded_view_digest_changed',
  'frozen_prefix_digest_changed',
  'config_digest_changed',
  'raw_history_store_unavailable',
  'provider_cache_semantics_changed',
];

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
export function buildPrepareReceipt(
  messages: readonly FoldMessage[],
  outcome: FoldOutcome,
  options: BuildPrepareReceiptOptions = {},
): FoldPrepareReceipt {
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

// ── Verify ──────────────────────────────────────────────────────────────────

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
export function verifyPrepareReceipt(
  receipt: FoldPrepareReceipt,
  probe: VerifyPrepareReceiptProbe = {},
): VerifyPrepareReceiptResult {
  const staleReasons: FoldReceiptStaleReason[] = [];
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
