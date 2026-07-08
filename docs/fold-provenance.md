# Fold Provenance Receipts — `buildPrepareReceipt` / `verifyPrepareReceipt`

A **prepare receipt** is a small, machine-readable provenance artifact for one
`FoldSession.prepare()` call. It is the trust boundary between the engine's
internal raw/folded state and any *outside* process — a downstream agent, an
operator, a resume harness, a reviewer — that must decide whether a compacted
context is still authoritative **without replaying the private raw history**.

The engine's core invariant makes this cheap: `prepare()` is deterministic —
identical raw history + config produce a byte-identical prepared view and
frozen cache prefix. A receipt turns that invariant into something externally
attestable: three sha256 digests plus counters.

```ts
import { FoldSession, buildPrepareReceipt, verifyPrepareReceipt } from 'context-warp-drive';

const session = new FoldSession(options);
const outcome = session.prepare(history, { measuredInputTokens });

const receipt = buildPrepareReceipt(history, outcome, {
  sessionId: 'agent-42',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  rawHistoryStoreRef: 'local-only:transcripts/agent-42.jsonl',
  configFingerprint: options,          // any stable structural config identity
  measuredInputTokens,                 // echoed VERBATIM — never estimated
});
// receipt is JSON-safe, digest-only, safe to share.
```

## What the receipt contains

| Section | Contents |
|---------|----------|
| `subject` | Host-supplied `sessionId` / `provider` / `model`, plus observed turn and message counts. |
| `input` | `rawHistoryDigest` (sha256 of the canonicalized full raw history), optional opaque `rawHistoryStoreRef` and `tokenizer` labels, and a **verbatim** `measuredInputTokens` echo (omitted when the host has no measured telemetry — the engine never estimates tokens). |
| `fold` | `strategy` label, optional `configDigest` (sha256 of the host's config fingerprint), `foldedViewDigest` (sha256 of the prepared view), `frozenPrefixDigest` + `sealedBoundary` (identity of the byte-frozen cache prefix; `null` before any boundary seals), `cacheHot`, and the freeze/fold telemetry echoed from `FoldStats`. |
| `privacy` | Honest constants — see below. |
| `staleIf` | The documented invalidation surface, so consumers know what the digests cover and what they must track themselves (e.g. provider cache semantics). |

All digests use **canonical serialization** (recursively sorted object keys,
dropped `undefined` members, JSON number semantics), so structurally identical
inputs digest identically regardless of key insertion order. When the host
omits `generatedAt`, identical inputs produce a **byte-identical receipt** —
the regression fixture in `src/__tests__/foldProvenance.test.ts` asserts this.

## The privacy boundary, stated honestly

- **The receipt embeds digests and counters only.** No prompt text, no tool
  output, no closet literals. It is safe to hand to a process that must not
  see the session.
- **The folded view is NOT content-free.** Fold skeletons and Coordinate
  Closet literals are *condensed raw history by design* — that's what makes
  the compacted context useful. The receipt attests to the view's identity
  (`foldedViewDigest`); it does not sanitize the view. Do not treat a receipt
  as permission to ship the folded view across a privacy boundary.
- Separating those two is the point: the proof object (receipt) and the
  private evidence object (raw history + folded view) travel on different
  trust rails. The receipt can say "the raw history exists at
  `rawHistoryStoreRef` and hashes to X" without embedding any of it.

## The resume decision — `verifyPrepareReceipt`

```ts
const check = verifyPrepareReceipt(receipt, {
  messages: currentHistory,        // → raw_history_digest_changed?
  outcome: freshPrepareOutcome,    // → folded_view / frozen_prefix digest changed?
  configFingerprint: options,      // → config_digest_changed?
});
// check.verdict: 'safe_to_resume' | 'stale'
// check.staleReasons: typed machine-readable codes
```

Verification is **probe-scoped**: only the dimensions you supply evidence for
are checked. `safe_to_resume` means every supplied probe matched — it is not a
claim about unchecked dimensions (`receipt.staleIf` lists the full documented
invalidation surface, including conditions no digest can see, like provider
cache-semantics changes).

Stale reason codes:

| Code | Meaning |
|------|---------|
| `raw_history_digest_changed` | The raw history you'd resume from is not the history that was folded. |
| `folded_view_digest_changed` | A fresh `prepare()` no longer reproduces the attested view (config/engine drift). |
| `frozen_prefix_digest_changed` | The byte-frozen cache prefix identity was lost or diverged — provider cache hits are no longer guaranteed. |
| `config_digest_changed` | The fold config fingerprint doesn't match (or the receipt never carried one). |
| `receipt_version_unsupported` | Unknown receipt schema version. |

## What this is (and isn't)

- **Is:** an externally checkable regression fixture for the determinism
  claim; a cache-identity attestation (`frozenPrefixDigest` is exactly the
  byte-identity that keeps provider prompt caches hot); a resume gate another
  agent can evaluate without trust in the producer's narration.
- **Isn't:** a token accountant (measured telemetry is echoed verbatim or
  omitted — never synthesized), a sanitizer, or a replacement for the live
  benchmarks. It's the small machine-readable boundary between CWD's internal
  state and the reviewer who has to decide whether to trust it.

Receipts are pure CPU, zero I/O, and composable *outside* the hot path —
`FoldSession.prepare()` itself is untouched; build a receipt only on the turns
where a downstream consumer needs one (epoch boundaries, handoffs, session
seals).
