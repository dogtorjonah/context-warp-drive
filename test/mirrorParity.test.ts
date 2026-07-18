import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Enforced mirror-parity gate (project validation surface).
 *
 * The deep-diff inspector lives in the context-warp-parity Forge server
 * (`parity_check`); this suite is the AUTOMATED half: it runs inside the
 * package's own vitest surface, so any drift between the three copies of the
 * fold engine fails the same test run that a mirror-touching change already
 * requires — no separate manual invocation.
 *
 * Two axes:
 *  1. relay ↔ package manifest: `shim` files must stay thin re-exports
 *     (package canonical), `identical` files byte-equal (relay canonical),
 *     `trim`/`derived` informational only. Skipped when the monorepo relay
 *     tree is absent (standalone checkout).
 *  2. package ↔ standalone repo: every paired file — source AND tests —
 *     byte-compared. Only the declared allowlists (package-only artifacts,
 *     expected standalone identity drift) are exempt; anything else fails.
 *
 * The allowlists below intentionally mirror the Forge server's declarations;
 * both surfaces must agree on what is exempt.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const PKG_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const RELAY_ROOT = join(REPO_ROOT, 'relay');
const STANDALONE_ROOT =
  process.env.VOXXO_CONTEXT_WARP_STANDALONE_ROOT ?? '/home/jonah/context-warp-drive';

type ManifestMode = 'identical' | 'shim' | 'trim' | 'derived';
interface ManifestEntry {
  pkg: string;
  src: string;
  mode: ManifestMode;
}

// Same declarations as relay/data/mcp-forge/context-warp-parity MANIFEST.
const MANIFEST: ManifestEntry[] = [
  { pkg: 'src/rollingFold.ts', src: 'relay/src/rollingFold.ts', mode: 'shim' },
  { pkg: 'src/foldFreeze.ts', src: 'relay/src/foldFreeze.ts', mode: 'shim' },
  { pkg: 'src/foldRecall.ts', src: 'relay/src/foldRecall.ts', mode: 'shim' },
  { pkg: 'src/foldTerms.ts', src: 'relay/src/foldTerms.ts', mode: 'shim' },
  { pkg: 'src/contextWindow.ts', src: 'relay/src/contextWindow.ts', mode: 'identical' },
  { pkg: 'src/foldEpisodes.ts', src: 'relay/src/foldEpisodes.ts', mode: 'shim' },
  { pkg: 'src/foldEpisodeCapture.ts', src: 'relay/src/foldEpisodeCapture.ts', mode: 'shim' },
  { pkg: 'src/foldPathCanon.ts', src: 'relay/src/foldPathCanon.ts', mode: 'shim' },
  { pkg: 'src/overwatch.ts', src: 'relay/src/overwatch.ts', mode: 'shim' },
  { pkg: 'src/persistence/sparseVector.ts', src: 'relay/src/persistence/sparseVector.ts', mode: 'identical' },
  { pkg: 'src/persistence/transcriptTypes.ts', src: 'relay/src/persistence/transcriptTypes.ts', mode: 'trim' },
  { pkg: 'src/glyphs.ts', src: 'packages/voxxo-codex/src/glyphs/index.ts', mode: 'derived' },
];

// Same declarations as the Forge server's standalone carve-outs.
const EXPECTED_STANDALONE_DRIFT = new Set([
  '.gitignore',
  'README.md',
  'docs/architecture.md',
  'docs/context-folding.md',
  'examples/anthropic-loop.ts',
  'examples/openai-loop.ts',
  'package.json',
  'src/index.ts',
  'tsup.config.ts',
]);

const EXPECTED_PACKAGE_ONLY = new Set([
  'data/synonym-map.json',
  'docs/briefing-rebirth-folding-cache.html',
  'docs/builders-map-rebirth-rolling-fold.html',
  'docs/context-warp.html',
  'docs/fold-freeze-economics.html',
  'scripts/build-synonym-map.py',
  'src/__tests__/overwatch.test.ts',
  'src/overwatch.ts',
]);

const IGNORE_DIRS = new Set(['.atlas', '.git', 'node_modules', 'dist', 'coverage', '.turbo', '.next']);
const IGNORE_FILE_SUFFIXES = ['.tsbuildinfo'];
// Transient tooling artifacts that are never paired: the focused-typecheck
// runner writes scoped tsconfig snapshots into repo roots mid-run.
const IGNORE_FILE_PREFIXES = ['.voxxo-focused-tc-'];

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (!IGNORE_DIRS.has(name)) walk(abs);
      } else if (
        !IGNORE_FILE_SUFFIXES.some((s) => name.endsWith(s))
        && !IGNORE_FILE_PREFIXES.some((p) => name.startsWith(p))
      ) {
        out.push(abs.slice(root.length + 1).replace(/\\/g, '/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

describe('relay ↔ package manifest parity (monorepo only)', () => {
  it.skipIf(!existsSync(RELAY_ROOT))('shim files stay thin re-exports of the package copy', () => {
    const failures: string[] = [];
    for (const entry of MANIFEST.filter((e) => e.mode === 'shim')) {
      const relayAbs = join(REPO_ROOT, entry.src);
      const pkgAbs = join(PKG_ROOT, entry.pkg);
      if (!existsSync(pkgAbs)) {
        failures.push(`${entry.pkg}: shim target missing from package`);
        continue;
      }
      if (!existsSync(relayAbs)) {
        failures.push(`${entry.src}: relay shim missing`);
        continue;
      }
      const text = readFileSync(relayAbs, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      if (!text.includes('export * from')) {
        failures.push(`${entry.src}: no \`export * from\` re-export — shim replaced by a divergent copy?`);
      } else if (lines.length > 10) {
        failures.push(`${entry.src}: shim unexpectedly large (${lines.length}L) — body added alongside the re-export?`);
      }
    }
    expect(failures).toEqual([]);
  });

  it.skipIf(!existsSync(RELAY_ROOT))('identical files stay byte-equal with the relay copy', () => {
    const failures: string[] = [];
    for (const entry of MANIFEST.filter((e) => e.mode === 'identical')) {
      const relayAbs = join(REPO_ROOT, entry.src);
      const pkgAbs = join(PKG_ROOT, entry.pkg);
      if (!existsSync(relayAbs) || !existsSync(pkgAbs)) {
        failures.push(`${entry.pkg}: missing on one side (relay=${existsSync(relayAbs)} pkg=${existsSync(pkgAbs)})`);
        continue;
      }
      if (!readFileSync(relayAbs).equals(readFileSync(pkgAbs))) {
        failures.push(`${entry.pkg}: byte drift vs ${entry.src}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('package ↔ standalone mirror parity', () => {
  it.skipIf(!existsSync(STANDALONE_ROOT))('every paired source and test file is byte-identical unless declared exempt', () => {
    const failures: string[] = [];
    const packageFiles = walkFiles(PKG_ROOT);
    const standaloneFiles = new Set(existsSync(STANDALONE_ROOT) ? walkFiles(STANDALONE_ROOT) : []);
    for (const rel of packageFiles) {
      if (EXPECTED_PACKAGE_ONLY.has(rel)) continue;
      if (!standaloneFiles.has(rel)) {
        failures.push(`${rel}: present in package, missing in standalone`);
        continue;
      }
      if (EXPECTED_STANDALONE_DRIFT.has(rel)) continue;
      const pkgBuf = readFileSync(join(PKG_ROOT, rel));
      const standaloneBuf = readFileSync(join(STANDALONE_ROOT, rel));
      if (!pkgBuf.equals(standaloneBuf)) {
        failures.push(`${rel}: byte drift (package=${pkgBuf.length}B standalone=${standaloneBuf.length}B)`);
      }
    }
    expect(failures).toEqual([]);
  });
});
