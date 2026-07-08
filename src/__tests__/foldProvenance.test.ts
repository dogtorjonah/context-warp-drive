import { describe, expect, it } from 'vitest';

import {
  FoldSession,
  buildPrepareReceipt,
  verifyPrepareReceipt,
  canonicalJson,
  foldProvenanceDigest,
  FOLD_RECEIPT_STALE_IF,
  type FoldConfig,
  type FoldMessage,
} from '../index.ts';

const TEST_FOLD_CONFIG: FoldConfig = {
  activeWindowTurns: 0,
  softThresholdChars: 1_000_000,
  hardThresholdChars: 2_000_000,
  maxTurnsBeforeFold: 100,
  continuous: true,
  assistantTextBudget: {
    fullRetentionChars: 10,
    essenceRetentionChars: 0,
  },
  verbatimKeepChars: 0,
};

const RAW_SENTINEL = 'SECRET_RAW_PAYLOAD_ZX81';

function sampleHistory(): FoldMessage[] {
  return [
    { role: 'user', content: `first question about ${RAW_SENTINEL}` },
    { role: 'assistant', content: 'alpha beta gamma delta epsilon' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer stays active' },
  ];
}

function freshSession(): FoldSession {
  return new FoldSession({
    foldConfig: TEST_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
    now: () => 1_000,
  });
}

describe('canonicalJson', () => {
  it('is key-order independent and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 1, gone: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson([1, 'x', null])).toBe('[1,"x",null]');
    expect(canonicalJson({ n: Number.NaN })).toBe('{"n":null}');
  });

  it('produces stable sha256 digests', () => {
    const digest = foldProvenanceDigest({ b: 1, a: 2 });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(foldProvenanceDigest({ a: 2, b: 1 })).toBe(digest);
  });
});

describe('buildPrepareReceipt determinism', () => {
  it('two identical sessions over the same history produce byte-identical receipts', () => {
    const history = sampleHistory();
    const options = { sessionId: 's-1', provider: 'anthropic', model: 'test-model', configFingerprint: { band: 40_000 } };

    const receiptA = buildPrepareReceipt(history, freshSession().prepare(history), options);
    const receiptB = buildPrepareReceipt(history, freshSession().prepare(history), options);

    expect(JSON.stringify(receiptA)).toBe(JSON.stringify(receiptB));
    expect(receiptA.input.rawHistoryDigest).toMatch(/^sha256:/);
    expect(receiptA.fold.foldedViewDigest).toMatch(/^sha256:/);
    expect(receiptA.staleIf).toEqual(FOLD_RECEIPT_STALE_IF);
  });

  it('hot reuse keeps the folded view and frozen prefix digests stable and marks cacheHot', () => {
    const session = freshSession();
    const history = sampleHistory();

    const epochReceipt = buildPrepareReceipt(history, session.prepare(history, { hardEpoch: true }));
    const hotReceipt = buildPrepareReceipt(history, session.prepare(history));

    expect(epochReceipt.fold.cacheHot).toBe(false);
    expect(hotReceipt.fold.cacheHot).toBe(true);
    expect(hotReceipt.fold.foldedViewDigest).toBe(epochReceipt.fold.foldedViewDigest);
    expect(epochReceipt.fold.frozenPrefixDigest).toMatch(/^sha256:/);
    expect(hotReceipt.fold.frozenPrefixDigest).toBe(epochReceipt.fold.frozenPrefixDigest);
    expect(hotReceipt.fold.hotReuses).toBeGreaterThan(0);
  });

  it('a hard epoch seals a frozen prefix and the receipt digests it', () => {
    const session = freshSession();
    const history = sampleHistory();

    const outcome = session.prepare(history, { hardEpoch: true });
    const receipt = buildPrepareReceipt(history, outcome);

    expect(receipt.fold.sealedBoundary).toBe(outcome.sealedBoundary);
    expect(receipt.fold.sealedBoundary).not.toBeNull();
    expect(receipt.fold.frozenPrefixDigest).toMatch(/^sha256:/);
  });

  it('embeds no raw message content — digests and counters only', () => {
    const history = sampleHistory();
    const receipt = buildPrepareReceipt(history, freshSession().prepare(history), {
      sessionId: 's-privacy',
      configFingerprint: TEST_FOLD_CONFIG,
    });

    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(RAW_SENTINEL);
    expect(serialized).not.toContain('alpha beta gamma');
    expect(receipt.privacy).toEqual({
      receiptEmbedsRawContent: false,
      digestsOnly: true,
      foldedViewDerivedFromRawHistory: true,
    });
  });

  it('echoes measured tokens verbatim and omits them when absent (no estimation)', () => {
    const history = sampleHistory();
    const outcome = freshSession().prepare(history);

    const withTokens = buildPrepareReceipt(history, outcome, { measuredInputTokens: 12_345 });
    const withoutTokens = buildPrepareReceipt(history, outcome);

    expect(withTokens.input.measuredInputTokens).toBe(12_345);
    expect('measuredInputTokens' in withoutTokens.input).toBe(false);
  });

  it('omits generatedAt unless the host injects one', () => {
    const history = sampleHistory();
    const outcome = freshSession().prepare(history);

    expect('generatedAt' in buildPrepareReceipt(history, outcome)).toBe(false);
    expect(buildPrepareReceipt(history, outcome, { generatedAt: '2026-01-01T00:00:00Z' }).generatedAt)
      .toBe('2026-01-01T00:00:00Z');
  });
});

describe('verifyPrepareReceipt', () => {
  it('returns safe_to_resume when every supplied probe matches', () => {
    const session = freshSession();
    const history = sampleHistory();
    const outcome = session.prepare(history);
    const receipt = buildPrepareReceipt(history, outcome, { configFingerprint: { band: 40_000 } });

    const result = verifyPrepareReceipt(receipt, {
      messages: history,
      outcome,
      configFingerprint: { band: 40_000 },
    });

    expect(result.verdict).toBe('safe_to_resume');
    expect(result.staleReasons).toEqual([]);
  });

  it('flags raw_history_digest_changed when the raw history mutates', () => {
    const history = sampleHistory();
    const receipt = buildPrepareReceipt(history, freshSession().prepare(history));

    const mutated = sampleHistory();
    mutated[1] = { role: 'assistant', content: 'rewritten in place' };

    const result = verifyPrepareReceipt(receipt, { messages: mutated });
    expect(result.verdict).toBe('stale');
    expect(result.staleReasons).toContain('raw_history_digest_changed');
  });

  it('flags folded_view_digest_changed when the prepared view diverges', () => {
    const history = sampleHistory();
    const receipt = buildPrepareReceipt(history, freshSession().prepare(history));

    // A different config produces a different fold of the same history.
    const divergent = new FoldSession({
      foldConfig: {
        ...TEST_FOLD_CONFIG,
        assistantTextBudget: { fullRetentionChars: 5_000, essenceRetentionChars: 0 },
      },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      now: () => 1_000,
    }).prepare(history);

    const result = verifyPrepareReceipt(receipt, { outcome: divergent });
    expect(result.verdict).toBe('stale');
    expect(result.staleReasons).toContain('folded_view_digest_changed');
  });

  it('flags config_digest_changed on fingerprint mismatch or missing receipt digest', () => {
    const history = sampleHistory();
    const outcome = freshSession().prepare(history);

    const withConfig = buildPrepareReceipt(history, outcome, { configFingerprint: { band: 40_000 } });
    expect(verifyPrepareReceipt(withConfig, { configFingerprint: { band: 99_999 } }).staleReasons)
      .toContain('config_digest_changed');

    const withoutConfig = buildPrepareReceipt(history, outcome);
    expect(verifyPrepareReceipt(withoutConfig, { configFingerprint: { band: 40_000 } }).staleReasons)
      .toContain('config_digest_changed');
  });

  it('flags frozen_prefix_digest_changed when the sealed prefix no longer matches', () => {
    const session = freshSession();
    const history = sampleHistory();
    const hardOutcome = session.prepare(history, { hardEpoch: true });
    const receipt = buildPrepareReceipt(history, hardOutcome);
    expect(receipt.fold.frozenPrefixDigest).not.toBeNull();

    // A fresh session's plain epoch has no sealed boundary — prefix identity lost.
    const unrelated = freshSession().prepare(history);
    const result = verifyPrepareReceipt(receipt, { outcome: unrelated });
    expect(result.verdict).toBe('stale');
    expect(result.staleReasons).toContain('frozen_prefix_digest_changed');
  });

  it('rejects unsupported receipt versions', () => {
    const history = sampleHistory();
    const receipt = buildPrepareReceipt(history, freshSession().prepare(history));
    const forged = { ...receipt, version: 99 } as unknown as typeof receipt;

    const result = verifyPrepareReceipt(forged);
    expect(result.verdict).toBe('stale');
    expect(result.staleReasons).toContain('receipt_version_unsupported');
  });
});
