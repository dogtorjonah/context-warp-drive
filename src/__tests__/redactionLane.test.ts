import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  formatRedactionDeclaration,
  redactContinuityModel,
  redactContinuityText,
} from '../redactionLane.ts';

// Every fixture is a runtime concatenation of an obviously-fake credential so
// static secret scanners never match this file, while the lane's runtime
// patterns do.
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const GITHUB = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0' + 'A1b2C3d4E5f6G7h8I9j0';
const SK = 'sk-' + 'proj4abc123def456ghi789jkl';
const SLACK = 'xoxb-' + '1234567890-abcdefghij';
const GOOGLE = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q';
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5NXgL0n3I9PlFUP0THsR8U';
const PEM = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAfakefakefake', '-----END RSA PRIVATE KEY-----'].join('\n');

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('redaction lane — text', () => {
  const battery: Array<{ kind: string; input: string; secret: string }> = [
    { kind: 'private-key-block', input: `deploy notes\n${PEM}\ndone`, secret: 'BEGIN RSA PRIVATE KEY' },
    { kind: 'aws-access-key', input: `rotate ${AWS} today`, secret: AWS },
    { kind: 'github-token', input: `push failed with ${GITHUB}`, secret: GITHUB },
    { kind: 'sk-token', input: `provider key ${SK} leaked`, secret: SK },
    { kind: 'slack-token', input: `bot uses ${SLACK}`, secret: SLACK },
    { kind: 'google-api-key', input: `maps key ${GOOGLE}`, secret: GOOGLE },
    { kind: 'jwt', input: `session ${JWT} captured`, secret: JWT },
  ];

  for (const { kind, input, secret } of battery) {
    it(`redacts ${kind} with a declared token`, () => {
      const result = redactContinuityText(input);
      expect(result.redacted).toBe(true);
      expect(result.text).not.toContain(secret);
      expect(result.text).toContain(`[REDACTED:${kind}]`);
      expect(result.spans).toEqual([{ kind, count: 1 }]);
    });
  }

  it('redacts a bearer token while preserving the scheme word', () => {
    const result = redactContinuityText('header Authorization: Bearer ' + 'abcdefghij0123456789abcdefghij' + ' sent');
    expect(result.redacted).toBe(true);
    expect(result.text).toContain('Bearer [REDACTED:bearer-token]');
    expect(result.text).not.toContain('abcdefghij0123456789abcdefghij');
  });

  it('redacts url credentials while preserving scheme and user', () => {
    const result = redactContinuityText('fetch https://jonah:' + 'hunter2pass' + '@registry.example.com/pkg failed');
    expect(result.redacted).toBe(true);
    expect(result.text).toContain('https://jonah:[REDACTED:url-credential]@registry.example.com/pkg');
    expect(result.spans).toEqual([{ kind: 'url-credential', count: 1 }]);
  });

  it('redacts credential-shaped labeled assignments but not prose values', () => {
    const hit = redactContinuityText('config had password=' + 'hunter2abc99' + ' inline');
    expect(hit.redacted).toBe(true);
    expect(hit.text).toContain('password=[REDACTED:secret-assignment]');

    const quoted = redactContinuityText('set api_key="' + 'abcdefghijklmnopqrstuvwxyz' + '" in env');
    expect(quoted.redacted).toBe(true);
    expect(quoted.text).toContain('api_key="[REDACTED:secret-assignment]"');

    const prose = redactContinuityText('the secret: rotation plan ships next week; password policy unchanged');
    expect(prose.redacted).toBe(false);
    expect(prose.text).toBe('the secret: rotation plan ships next week; password policy unchanged');
  });

  it('returns clean continuity text unchanged by reference', () => {
    const clean = 'operator turn 7 set a durable expectation at 2026-08-07T21:45:00.000Z; '
      + `proof ${'0'.repeat(64)}; recover tap_instance_messages action="canonical" search="message:7"`;
    const result = redactContinuityText(clean);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(clean);
    expect(result.spans).toEqual([]);
  });

  it('is idempotent: a redacted output never re-redacts', () => {
    const inputs = [
      ...battery.map((entry) => entry.input),
      'Bearer ' + 'abcdefghij0123456789abcdefghij',
      'https://jonah:' + 'hunter2pass' + '@host/x',
      'password=' + 'hunter2abc99',
    ];
    for (const input of inputs) {
      const once = redactContinuityText(input);
      const twice = redactContinuityText(once.text);
      expect(twice.redacted).toBe(false);
      expect(twice.text).toBe(once.text);
    }
  });

  it('counts multiple spans per kind and across kinds', () => {
    const result = redactContinuityText(`${AWS} then ${AWS} then ${SK}`);
    expect(result.spans).toEqual([
      { kind: 'aws-access-key', count: 2 },
      { kind: 'sk-token', count: 1 },
    ]);
  });
});

describe('redaction lane — declaration', () => {
  it('formats a bounded aggregate banner and returns null for zero spans', () => {
    expect(formatRedactionDeclaration([])).toBeNull();
    expect(formatRedactionDeclaration([
      { kind: 'aws-access-key', count: 2 },
      { kind: 'jwt', count: 1 },
    ])).toBe('[REDACTION-LANE spans=3 kinds=aws-access-key×2,jwt×1]');
  });

  it('caps the kind list and declares the overflow', () => {
    const spans = Array.from({ length: 10 }, (_, index) => ({ kind: `kind-${index}`, count: 1 }));
    const declaration = formatRedactionDeclaration(spans);
    expect(declaration).toContain('spans=10');
    expect(declaration).toContain('kind-7×1');
    expect(declaration).not.toContain('kind-8×1');
    expect(declaration).toContain(',+2-more]');
  });
});

describe('redaction lane — model walk', () => {
  it('redacts republishable strings, skips identity/proof/handle keys, and re-mints disturbed shas', () => {
    const dirtyVerbatim = `[operator · source=message:7] rotate ${AWS} now`;
    const staleVerbatim = `stale proof body with ${SK}`;
    const input = {
      boundary: { activeRequest: `please rotate ${AWS}` },
      clean: { note: 'nothing secret here', nested: { claim: 'still clean' } },
      units: [
        {
          id: 'operator-message:7',
          verbatim: dirtyVerbatim,
          sha256: hash(dirtyVerbatim),
          claim: `turn 7 pasted ${AWS}`,
          recover: `tap_instance_messages action="canonical" search="${AWS}"`,
          eraKey: `era-${AWS}`,
        },
        {
          id: 'operator-message:8',
          verbatim: staleVerbatim,
          sha256: '0'.repeat(64),
          claim: 'clean claim',
          recover: 'tap_instance_messages action="canonical" search="message:8"',
        },
      ],
    };
    const result = redactContinuityModel(input);
    expect(result.spans.length).toBeGreaterThan(0);
    expect(result.declaration).toContain('[REDACTION-LANE spans=');

    const [dirty, stale] = result.model.units;
    // Republishable fields redacted.
    expect(result.model.boundary.activeRequest).toContain('[REDACTED:aws-access-key]');
    expect(dirty.verbatim).not.toContain(AWS);
    expect(dirty.claim).not.toContain(AWS);
    // Skipped keys carry pattern-shaped bytes untouched: handles must stay
    // executable and era keys must stay stable identifiers.
    expect(dirty.recover).toContain(AWS);
    expect(dirty.eraKey).toContain(AWS);
    // A sha that attested the prior bytes is re-minted over the redacted bytes.
    expect(dirty.sha256).toBe(hash(dirty.verbatim));
    expect(dirty.sha256).not.toBe(hash(dirtyVerbatim));
    // A sha that never matched its bytes is left stale, not laundered.
    expect(stale.verbatim).not.toContain(SK);
    expect(stale.sha256).toBe('0'.repeat(64));
    // Structural sharing: untouched subtrees keep object identity.
    expect(result.model.clean).toBe(input.clean);
  });

  it('returns the input untouched and undeclared when nothing matches', () => {
    const input = { note: 'clean', units: [{ id: 'u1', claim: 'clean claim' }] };
    const result = redactContinuityModel(input);
    expect(result.model).toBe(input);
    expect(result.spans).toEqual([]);
    expect(result.declaration).toBeNull();
  });

  it('caches deterministically: input and output resolve to the same result', () => {
    const input = { claim: `key ${AWS}` };
    const first = redactContinuityModel(input);
    expect(redactContinuityModel(input)).toBe(first);
    expect(redactContinuityModel(first.model)).toBe(first);
  });
});
