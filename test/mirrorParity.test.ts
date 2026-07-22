import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Enforced mirror-parity gate (project validation surface).
 *
 * The deep-diff inspector lives in the context-warp-parity Forge server
 * (`parity_check`); this suite is the AUTOMATED half: it runs inside the
 * package's own vitest surface, so any drift between the three copies of the
 * fold engine fails the same test run that a mirror-touching change already
 * requires — no separate manual invocation.
 *
 * Three axes:
 *  1. relay ↔ package manifest: `shim` files must stay thin re-exports
 *     (package canonical), `identical` files byte-equal (relay canonical),
 *     `trim`/`derived` informational only. Skipped when the monorepo relay
 *     tree is absent (standalone checkout).
 *  2. package ↔ standalone repo: every paired file — source AND tests —
 *     byte-compared. Explicit path-pairs cover tests that the standalone
 *     publishes under `test/` instead of the package's `src/__tests__/`.
 *     Only documented identity/host-enrichment variants and package-only
 *     artifacts are exempt; anything else fails.
 *  3. split @voxxo/task-rail ↔ standalone bundled taskRail.ts: the portable
 *     public exports and behavior-bearing type/constant contracts must match.
 *     Relay persistence, authorization, audit storage, and transport remain
 *     host adapters and are intentionally outside this semantic gate.
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
const TASK_RAIL_PACKAGE_ROOT =
  process.env.VOXXO_TASK_RAIL_PACKAGE_ROOT
  ?? (existsSync(join(REPO_ROOT, 'packages/task-rail'))
    ? join(REPO_ROOT, 'packages/task-rail')
    : '/home/jonah/voxxo-swarm/packages/task-rail');
const STANDALONE_TASK_RAIL = join(STANDALONE_ROOT, 'src/taskRail.ts');

type ManifestMode = 'identical' | 'shim' | 'shim-host' | 'trim' | 'derived';
interface ManifestEntry {
  pkg: string;
  src: string;
  mode: ManifestMode;
}

// Same declarations as relay/data/mcp-forge/context-warp-parity MANIFEST.
const MANIFEST: ManifestEntry[] = [
  { pkg: 'src/boundaryAuction.ts', src: 'relay/src/boundaryAuction.ts', mode: 'shim' },
  { pkg: 'src/chronologicalProvenance.ts', src: 'relay/src/chronologicalProvenance.ts', mode: 'shim' },
  // Relay re-exports the core and adds async Atlas snapshot hydration.
  { pkg: 'src/cognitiveArtifacts.ts', src: 'relay/src/cognitiveArtifacts.ts', mode: 'shim-host' },
  { pkg: 'src/contextBudget.ts', src: 'relay/src/contextBudget.ts', mode: 'shim' },
  { pkg: 'src/rollingFold.ts', src: 'relay/src/rollingFold.ts', mode: 'shim' },
  { pkg: 'src/foldBirthHydration.ts', src: 'relay/src/foldBirthHydration.ts', mode: 'shim' },
  { pkg: 'src/foldFreeze.ts', src: 'relay/src/foldFreeze.ts', mode: 'shim' },
  { pkg: 'src/foldRecall.ts', src: 'relay/src/foldRecall.ts', mode: 'shim' },
  { pkg: 'src/foldRecallUsage.ts', src: 'relay/src/foldRecallUsage.ts', mode: 'shim' },
  { pkg: 'src/foldRailPrefetch.ts', src: 'relay/src/foldRailPrefetch.ts', mode: 'shim' },
  { pkg: 'src/foldReceipts.ts', src: 'relay/src/foldReceipts.ts', mode: 'shim' },
  { pkg: 'src/foldTerms.ts', src: 'relay/src/foldTerms.ts', mode: 'shim' },
  { pkg: 'src/contextWindow.ts', src: 'relay/src/contextWindow.ts', mode: 'identical' },
  { pkg: 'src/foldEpisodes.ts', src: 'relay/src/foldEpisodes.ts', mode: 'shim' },
  { pkg: 'src/foldEpisodeCapture.ts', src: 'relay/src/foldEpisodeCapture.ts', mode: 'shim' },
  { pkg: 'src/foldPathCanon.ts', src: 'relay/src/foldPathCanon.ts', mode: 'shim' },
  { pkg: 'src/microRebirthSeed.ts', src: 'relay/src/microRebirthSeed.ts', mode: 'shim' },
  { pkg: 'src/overwatch.ts', src: 'relay/src/overwatch.ts', mode: 'shim' },
  { pkg: 'src/persistence/sparseVector.ts', src: 'relay/src/persistence/sparseVector.ts', mode: 'identical' },
  { pkg: 'src/persistence/transcriptTypes.ts', src: 'relay/src/persistence/transcriptTypes.ts', mode: 'trim' },
  { pkg: 'src/glyphs.ts', src: 'packages/voxxo-codex/src/glyphs/index.ts', mode: 'derived' },
];

// Same declarations as the Forge server's standalone carve-outs.
const EXPECTED_STANDALONE_DRIFT = new Set([
  '.gitignore',
  'LICENSE',
  'README.md',
  'docs/architecture.md',
  'docs/context-folding.md',
  'examples/anthropic-loop.ts',
  'examples/openai-loop.ts',
  'package.json',
  'src/__tests__/cognitiveArtifacts.test.ts',
  'src/cognitiveArtifacts.ts',
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

/** Package tests whose standalone mirror intentionally lives under `test/`. */
const RELOCATED_STANDALONE_PAIRS = new Map<string, string>([
  ['src/__tests__/foldArtifactMode.test.ts', 'test/foldArtifactMode.test.ts'],
  ['src/__tests__/foldReconciliation.test.ts', 'test/foldReconciliation.test.ts'],
  ['src/__tests__/foldReceipts.test.ts', 'test/foldReceipts.test.ts'],
]);

/**
 * Normalize only the documented identity differences in relocated tests.
 * Their shared test bodies must still compare byte-for-byte after normalization.
 */
const RELOCATED_TEST_NORMALIZERS = new Map<string, (source: string) => string>([
  [
    'src/__tests__/foldArtifactMode.test.ts',
    (source) => source.replace("} from '../index.ts';", "} from '../src/index.ts';"),
  ],
  [
    'src/__tests__/foldReconciliation.test.ts',
    (source) => source
      .replace("} from '../foldReconciliation.ts';", "} from '<fold-reconciliation>';")
      .replace("} from '../src/foldReconciliation.ts';", "} from '<fold-reconciliation>';")
      .replace("from '../foldReceipts.ts';", "from '<fold-receipts>';")
      .replace("from '../src/foldReceipts.ts';", "from '<fold-receipts>';"),
  ],
  [
    'src/__tests__/foldReceipts.test.ts',
    (source) => source
      .replace("} from '../index.ts';", "} from '<fold-receipts>';")
      .replace("} from '../src/foldReceipts.ts';", "} from '<fold-receipts>';")
      .replace("import type { FoldMessage } from '../index.ts';", "import type { FoldMessage } from '<rolling-fold>';")
      .replace("import type { FoldMessage } from '../src/rollingFold.ts';", "import type { FoldMessage } from '<rolling-fold>';"),
  ],
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

function collectBarrelExports(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from/g)) {
    for (const cell of match[1].split(',')) {
      const clean = cell.trim();
      if (!clean) continue;
      const alias = clean.split(/\s+as\s+/);
      names.add(alias.at(-1)!);
    }
  }
  return [...names].sort();
}

function collectDirectExports(source: string): string[] {
  return [...new Set(
    [...source.matchAll(/^export\s+(?:declare\s+)?(?:const|type|interface|class|function)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((match) => match[1]),
  )].sort();
}

function quotedLiterals(source: string, declaration: string): string[] {
  const escaped = declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const constMatch = source.match(new RegExp(`export\\s+const\\s+${escaped}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const`));
  const typeMatch = source.match(new RegExp(`export\\s+type\\s+${escaped}\\s*=([\\s\\S]*?);`));
  const body = constMatch?.[1] ?? typeMatch?.[1] ?? '';
  return [...body.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function interfaceKeys(source: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`export\\s+interface\\s+${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) return [];
  return [...match[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\??\s*:/gm)]
    .map((field) => field[1])
    .sort();
}

describe('relay ↔ package manifest parity (monorepo only)', () => {
  it.skipIf(!existsSync(RELAY_ROOT))('shim files re-export the package copy and only declared host shims carry integration logic', () => {
    const failures: string[] = [];
    for (const entry of MANIFEST.filter((e) => e.mode === 'shim' || e.mode === 'shim-host')) {
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
      const match = text.match(/export\s+\*\s+from\s+['"]([^'"]+)['"]/);
      const expectedTarget = relative(dirname(relayAbs), pkgAbs).replace(/\\/g, '/');
      if (!match) {
        failures.push(`${entry.src}: no \`export * from\` re-export — shim replaced by a divergent copy?`);
      } else if (match[1] !== expectedTarget) {
        failures.push(`${entry.src}: re-export points at ${match[1]}, expected ${expectedTarget}`);
      } else if (entry.mode === 'shim' && lines.length > 10) {
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
      const standaloneRel = RELOCATED_STANDALONE_PAIRS.get(rel) ?? rel;
      if (!standaloneFiles.has(standaloneRel)) {
        failures.push(`${rel}: present in package, missing standalone pair ${standaloneRel}`);
        continue;
      }
      if (EXPECTED_STANDALONE_DRIFT.has(rel)) continue;
      const pkgBuf = readFileSync(join(PKG_ROOT, rel));
      const standaloneBuf = readFileSync(join(STANDALONE_ROOT, standaloneRel));
      const normalize = RELOCATED_TEST_NORMALIZERS.get(rel);
      const comparablePkg = normalize ? Buffer.from(normalize(pkgBuf.toString('utf8'))) : pkgBuf;
      const comparableStandalone = normalize
        ? Buffer.from(normalize(standaloneBuf.toString('utf8')))
        : standaloneBuf;
      if (!comparablePkg.equals(comparableStandalone)) {
        const driftKind = normalize ? 'normalized byte drift' : 'byte drift';
        failures.push(`${rel} ↔ ${standaloneRel}: ${driftKind} (package=${pkgBuf.length}B standalone=${standaloneBuf.length}B)`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('portable Task Rail semantic parity', () => {
  it.skipIf(!existsSync(TASK_RAIL_PACKAGE_ROOT) || !existsSync(STANDALONE_TASK_RAIL))(
    'standalone exposes every package-canonical portable contract',
    () => {
      const packageIndex = readFileSync(join(TASK_RAIL_PACKAGE_ROOT, 'src/index.ts'), 'utf8');
      const packageSources = [
        'types.ts',
        'lifecycle.ts',
        'execution.ts',
        'drafts.ts',
        'template.ts',
        'stepsFile.ts',
      ].map((file) => readFileSync(join(TASK_RAIL_PACKAGE_ROOT, 'src', file), 'utf8')).join('\n');
      const standaloneSource = readFileSync(STANDALONE_TASK_RAIL, 'utf8');

      const packageExports = collectBarrelExports(packageIndex);
      const standaloneExports = new Set(collectDirectExports(standaloneSource));
      expect(packageExports.filter((name) => !standaloneExports.has(name))).toEqual([]);

      const missingExportControl = new Set(collectDirectExports(
        standaloneSource.replace('export function parseStepsFileText', 'function parseStepsFileText'),
      ));
      expect(packageExports.filter((name) => !missingExportControl.has(name)))
        .toContain('parseStepsFileText');

      for (const declaration of [
        'TaskRailMode',
        'TaskRailState',
        'TaskRailDraftState',
        'TASK_RAIL_LOAD_OPERATIONS',
        'TASK_RAIL_DRAFT_OPERATIONS',
        'TASK_RAIL_ACK_STATUSES',
        'TASK_RAIL_ROLES',
        'TASK_RAIL_ROLE_STATUSES',
      ]) {
        expect(quotedLiterals(standaloneSource, declaration), declaration)
          .toEqual(quotedLiterals(packageSources, declaration));
      }

      for (const contract of [
        'TaskRailRoleRegistration',
        'TaskRailLifecycle',
        'ShootArgs',
        'ShootAckInput',
        'ShootResult',
        'TaskRailTemplate',
        'TaskRailTemplateStep',
        'TaskRailTemplateIndexEntry',
        'TaskRailTemplateStepSeed',
        'SnapshotTemplateMeta',
      ]) {
        expect(interfaceKeys(standaloneSource, contract), contract)
          .toEqual(interfaceKeys(packageSources, contract));
      }
    },
  );

  it.skipIf(!existsSync(TASK_RAIL_PACKAGE_ROOT) || !existsSync(STANDALONE_TASK_RAIL))(
    'shared pure operations produce equivalent state transitions',
    async () => {
      const packageApi = await import(
        /* @vite-ignore */ pathToFileURL(join(TASK_RAIL_PACKAGE_ROOT, 'src/index.ts')).href
      );
      const standaloneApi = await import(
        /* @vite-ignore */ pathToFileURL(STANDALONE_TASK_RAIL).href
      );
      const now = '2026-07-22T05:30:00.000Z';
      const steps = ['one', 'two', 'three', 'four'].map((id) => ({
        id,
        title: id,
        instruction: `Do ${id}`,
        acceptanceCriteria: [`${id} complete`],
        status: 'pending' as const,
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      }));
      const railFixture = {
        id: 'rail-parity',
        instanceId: 'agent-parity',
        title: 'Parity rail',
        objective: 'Compare state transitions.',
        state: 'ready' as const,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        lockedAt: now,
        steps,
        history: [],
      };
      const packageRail = structuredClone(railFixture);
      const standaloneRail = structuredClone(railFixture);

      const packageSprint = packageApi.sprint(
        packageRail,
        { sprintCount: 4, note: 'reserve' },
        { now: '2026-07-22T05:31:00.000Z', actorId: 'agent-parity' },
      );
      const standaloneSprint = standaloneApi.sprint(
        standaloneRail,
        { sprintCount: 4, note: 'reserve' },
        { now: '2026-07-22T05:31:00.000Z', actorId: 'agent-parity' },
      );
      expect(standaloneSprint).toEqual(packageSprint);
      expect(standaloneRail).toEqual(packageRail);

      const batch = {
        acks: [
          { ackStepId: 'one', ackStatus: 'done', evidence: 'one-pass' },
          { ackStepId: 'two', ackStatus: 'done', evidence: 'two-pass' },
          { ackStepId: 'three', ackStatus: 'needs_review', note: 'pause' },
          { ackStepId: 'four', ackStatus: 'done' },
        ],
      };
      const packageShoot = packageApi.shoot(
        packageRail,
        batch,
        { now: '2026-07-22T05:32:00.000Z', actorId: 'agent-parity' },
      );
      const standaloneShoot = standaloneApi.shoot(
        standaloneRail,
        batch,
        { now: '2026-07-22T05:32:00.000Z', actorId: 'agent-parity' },
      );
      expect(standaloneShoot).toEqual(packageShoot);
      expect(standaloneRail).toEqual(packageRail);

      const meta = {
        id: 'tpl-parity',
        name: 'Parity template',
        createdBy: 'agent-parity',
        now: '2026-07-22T05:33:00.000Z',
      };
      const packageTemplate = packageApi.railToTemplate(packageRail, meta);
      const standaloneTemplate = standaloneApi.railToTemplate(standaloneRail, meta);
      expect(standaloneTemplate).toEqual(packageTemplate);
      expect(standaloneApi.templateIndexEntry(standaloneTemplate))
        .toEqual(packageApi.templateIndexEntry(packageTemplate));
      expect(standaloneApi.templateToStepSeeds(standaloneTemplate))
        .toEqual(packageApi.templateToStepSeeds(packageTemplate));

      for (const input of [
        '["one", {"title":"Two"}, 3]',
        '{"title":"One"}\n"two"\nplain',
        'first\n\nsecond',
      ]) {
        expect(standaloneApi.parseStepsFileText(input))
          .toEqual(packageApi.parseStepsFileText(input));
      }
    },
  );
});
