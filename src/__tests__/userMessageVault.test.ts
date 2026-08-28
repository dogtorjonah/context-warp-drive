import { describe, expect, it } from 'vitest';

import { parseHistoricalPayloadRecord } from '../rollingFold.ts';
import { renderUserMessageVault } from '../userMessageVault.ts';

function vaultPayloads(rendered: string): string[] {
  return rendered.split('\n').flatMap((line) => {
    const record = parseHistoricalPayloadRecord(line);
    return record?.kind === 'vault-row' ? [record.text] : [];
  });
}

describe('portable user-message vault surface caps', () => {
  it('counts recall metadata inside the configured per-row character cap', () => {
    const rendered = renderUserMessageVault([
      {
        text: `head ${'x'.repeat(2_000)} relay/src/example.ts changelog_id=41818 ${'y'.repeat(2_000)} tail`,
      },
      { text: 'newest row' },
    ]);
    const [older] = vaultPayloads(rendered);

    expect(older).toBeDefined();
    expect(older!.length).toBeLessThanOrEqual(900);
    expect(older).toContain('write any token to recall full text');
  });

  it('falls back to an exact prefix when the cap is smaller than the marker', () => {
    const previous = process.env.WARP_USER_VAULT_OLDER_CHARS;
    process.env.WARP_USER_VAULT_OLDER_CHARS = '8';
    try {
      const rendered = renderUserMessageVault([
        { text: 'x'.repeat(200) },
        { text: 'newest row' },
      ]);
      const [older] = vaultPayloads(rendered);

      expect(older).toHaveLength(8);
    } finally {
      if (previous === undefined) delete process.env.WARP_USER_VAULT_OLDER_CHARS;
      else process.env.WARP_USER_VAULT_OLDER_CHARS = previous;
    }
  });
});
