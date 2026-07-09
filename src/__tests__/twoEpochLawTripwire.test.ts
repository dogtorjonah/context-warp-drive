/**
 * Two-epoch-law tripwire: the fold pipeline has exactly TWO committed epoch
 * types — the append-only TAIL epoch (sealed band; frozen prefix untouched)
 * and the seeded HARD epoch (whole-view rebuild paired with a rebirth-grade
 * continuity seed / portable reset). The retired third kind — a bandless,
 * seedless re-fold of the whole history — is a banned code path AND banned
 * vocabulary: prose that keeps teaching it invites the path back.
 *
 * This test scans production source under src/ and fails if the retired
 * vocabulary reappears outside a minimal allowlist of legacy-compat readers
 * (persisted pre-rename snapshots must still deserialize). Test files are not
 * scanned: they may legitimately assert the retired literal NEVER reappears
 * in live output.
 *
 * If this trips on your change, name the mechanism instead:
 *   - freeze layer / FoldSession: "whole-view rebuild" (commitFoldFreeze)
 *   - CLI providers: "whole-transcript refold" (the hard-epoch write path)
 *   - epoch taxonomy: "seeded hard epoch" / "portable reset"
 * If you are adding a genuine legacy-compat reader, extend ALLOWLIST with a
 * tight allow pattern, an exact max hit count, and a why.
 *
 * Mirror of relay/src/__tests__/twoEpochLawTripwire.test.ts in voxxo-swarm
 * (scan roots and allowlist adapted to this repo's layout).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Built from fragments so this file's own source never matches the pattern it
// hunts if a sibling scanner ever widens its net to include test files.
const BANNED = new RegExp(['f', 'ull', '[_\\- ]?', 'rec', 'ompute'].join(''), 'i');

const SCAN_ROOTS = ['src'] as const;
const EXCLUDED_DIR_NAMES = new Set(['__tests__', 'node_modules', 'dist', 'build']);

interface AllowlistEntry {
  /** Repo-relative POSIX path. */
  readonly file: string;
  /** Every banned-vocabulary hit in the file must also match this. */
  readonly allow: RegExp;
  /** Hard ceiling on allowlisted hits — growth trips the wire. */
  readonly max: number;
  readonly why: string;
}

const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    file: 'src/foldFreeze.ts',
    allow: /lastFullRecomputeReason/,
    max: 3,
    why: 'legacy-compat reader: pre-rename persisted snapshots carry the lastFullRecomputeReason key; deserializeFoldFreezeState still accepts it',
  },
];

function collectSourceFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing root is caught by the scan-count floor assertion
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    if (name.includes('.test.')) continue;
    out.push(join(dir, name));
  }
}

describe('two-epoch law tripwire', () => {
  it('bans retired bandless-refold vocabulary in fold/session source', () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) collectSourceFiles(join(REPO_ROOT, root), files);
    // Vacuous-pass guard: a broken REPO_ROOT or scan root must fail loudly,
    // never pass an empty scan.
    expect(files.length).toBeGreaterThan(15);

    const violations: string[] = [];
    const allowCounts = new Map<string, number>();
    for (const file of files) {
      const rel = relative(REPO_ROOT, file).split('\\').join('/');
      const entry = ALLOWLIST.find((candidate) => candidate.file === rel);
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!BANNED.test(line)) continue;
        if (entry && entry.allow.test(line)) {
          allowCounts.set(rel, (allowCounts.get(rel) ?? 0) + 1);
          continue;
        }
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    for (const entry of ALLOWLIST) {
      const count = allowCounts.get(entry.file) ?? 0;
      if (count > entry.max) {
        violations.push(
          `${entry.file}: ${count} allowlisted legacy-compat hits exceed max ${entry.max} — ${entry.why}`,
        );
      }
    }
    expect(
      violations,
      'Retired two-epoch-law vocabulary reappeared in production source. '
        + 'Name the mechanism instead ("whole-view rebuild", "whole-transcript refold", '
        + '"seeded hard epoch"), or — for a genuine legacy-compat reader — add a tight '
        + 'ALLOWLIST entry with a max count and a why.',
    ).toEqual([]);
  });
});
