import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryLoop } from '../src/host/MemoryLoop.ts';
import { StandaloneContinuityLedgerStore } from '../src/host/continuityLedgerStore.ts';
import {
  buildRebirthPackageV6Model,
  sha256ContinuityLedgerVerbatim,
  type RebirthPackageV7LineageUnit,
} from '../src/rebirthPackageV6.ts';
import { renderRawRebirthSeedWithReport } from '../src/rawRebirthSeed.ts';
import { FoldSession } from '../src/session/FoldSession.ts';
import type { FoldConfig, FoldMessage } from '../src/rollingFold.ts';

const TEST_FOLD_CONFIG: FoldConfig = {
  activeWindowTurns: 0,
  softThresholdChars: 1_000_000,
  hardThresholdChars: 2_000_000,
  maxTurnsBeforeFold: 100,
  continuous: true,
  assistantTextBudget: { fullRetentionChars: 10, essenceRetentionChars: 0 },
  verbatimKeepChars: 0,
};

function firstHistory(prefix: string): FoldMessage[] {
  return [{
    role: 'user',
    content: `${prefix} first question`,
    sourceIdentity: `${prefix}:first:user`,
    tsMs: Date.parse('2026-08-11T18:00:00.000Z'),
  }, {
    role: 'assistant',
    content: `${prefix} first answer with durable detail`,
    sourceIdentity: `${prefix}:first:assistant`,
    tsMs: Date.parse('2026-08-11T18:01:00.000Z'),
  }, {
    role: 'user',
    content: `${prefix} second question`,
    sourceIdentity: `${prefix}:second:user`,
    tsMs: Date.parse('2026-08-11T18:02:00.000Z'),
  }, {
    role: 'assistant',
    content: `${prefix} second answer stays active`,
    sourceIdentity: `${prefix}:second:assistant`,
    tsMs: Date.parse('2026-08-11T18:03:00.000Z'),
  }];
}

function appendProfitableTail(history: FoldMessage[], prefix: string): FoldMessage[] {
  const next = [...history];
  for (let index = 0; index < 3; index += 1) {
    next.push({
      role: 'user',
      content: `${prefix} tail question ${index}`,
      sourceIdentity: `${prefix}:tail:${index}:user`,
      tsMs: Date.parse(`2026-08-11T19:0${index * 2}:00.000Z`),
    }, {
      role: 'assistant',
      content: `${prefix} ${index} ${'compressible tail detail '.repeat(300)}`,
      sourceIdentity: `${prefix}:tail:${index}:assistant`,
      tsMs: Date.parse(`2026-08-11T19:0${index * 2 + 1}:00.000Z`),
    });
  }
  return next;
}

function rebirthUnit(
  store: StandaloneContinuityLedgerStore,
  ownerInstanceId: string,
  captureId: string,
): RebirthPackageV7LineageUnit {
  const id = 'standalone-rebirth-operator';
  const verbatim = 'standalone rebirth lineage bytes from the canonical v7 render';
  return {
    id,
    sourceAt: '2026-08-11T17:59:00.000Z',
    kind: 'operator',
    verbatim,
    digest: 'standalone rebirth lineage bytes',
    eraKey: '2026-08-11',
    claim: 'standalone rebirth source remains executable',
    recover: store.renderUnitRecoveryHandle(ownerInstanceId, captureId, id),
    sha256: sha256ContinuityLedgerVerbatim(verbatim),
    verified: true,
    origin: 'declared',
    sourceInstanceId: ownerInstanceId,
  };
}

describe('standalone continuity ledger store', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('records MemoryLoop tail and hard epochs content-free and recovers exact canonical source bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-'));
    roots.push(root);
    const ledgerPath = join(root, 'continuity-ledger.jsonl');
    const sourcePath = join(root, 'authoritative-sources.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({
      ledgerPath,
      sourcePath,
      now: () => new Date('2026-08-11T20:00:00.000Z'),
    });

    const rebirthCaptureId = 'standalone-owner:rebirth#1';
    const renderedRebirthUnit = rebirthUnit(store, 'standalone-owner', rebirthCaptureId);
    const rebirthModel = buildRebirthPackageV6Model({
      boundaryAndActiveTask: {
        lifecycle: 'same_instance_hard_epoch',
        lifecycleMeaning: 'same instance identity; provider context reset',
        captureId: rebirthCaptureId,
        capturedAt: '2026-08-11T20:00:00.000Z',
        sourceFrontier: 'message#0',
        instanceId: 'standalone-owner',
        instanceName: 'standalone-owner',
        predecessorInstanceId: null,
        predecessorName: 'standalone-owner',
        workspace: 'context-warp-drive',
        cwd: root,
        runtimeChange: null,
        activeRequest: null,
        lastMaterialAssistant: null,
      },
      operatorVault: {
        units: [renderedRebirthUnit],
        rangeRecover: store.renderIndexHandle('standalone-owner'),
        partialReason: null,
      },
      recoveryIndex: [{
        id: 'continuity-ledger',
        label: 'standalone continuity ledger',
        handle: store.renderIndexHandle('standalone-owner'),
        status: 'available',
        count: null,
        frontier: null,
      }],
    });
    const renderedRebirth = renderRawRebirthSeedWithReport({
      predecessorName: 'standalone-owner',
      rebirthV6: rebirthModel,
    });
    expect(renderedRebirth.text).toContain(renderedRebirthUnit.verbatim);
    expect(renderedRebirth.continuityLedger?.lifecycle).toBe('rebirth');
    if (!renderedRebirth.continuityLedger) throw new Error('rebirth render omitted its ledger');
    await store.record(renderedRebirth.continuityLedger);
    const directRebirthRecovery = await store.executeHandle(renderedRebirthUnit.recover);
    expect(directRebirthRecovery.action).toBe('recover');
    if (directRebirthRecovery.action === 'recover') {
      expect(directRebirthRecovery.recovery?.verbatim).toBe(renderedRebirthUnit.verbatim);
    }

    const tailSession = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const tailLoop = new MemoryLoop({
      session: tailSession,
      sessionId: 'standalone-owner',
      continuityLedgerStore: store,
      continuityWorkspace: 'context-warp-drive',
    });
    const first = firstHistory('tail');
    await tailLoop.prepare(first);
    const tail = await tailLoop.prepare(appendProfitableTail(first, 'tail'), {
      measuredInputTokens: 70_000,
    });
    expect(tail.fold.stats.appendDecision).toBe('committed');
    expect(tail.fold.continuityLedger?.lifecycle).toBe('tail-epoch');
    expect(tail.fold.continuityLedger?.units.every((unit) => (
      unit.recover.startsWith('continuity_ledger action="recover"')
    ))).toBe(true);

    const hardSession = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      now: () => 2_000,
    });
    const hardLoop = new MemoryLoop({
      session: hardSession,
      sessionId: 'standalone-owner',
      continuityLedgerStore: store,
      continuityWorkspace: 'context-warp-drive',
    });
    const hard = await hardLoop.prepare(firstHistory('hard'), {
      hardEpoch: true,
      hardEpochSeed: 'portable hard-epoch seed',
    });
    expect(hard.fold.stats.epochReason).toBe('hard-epoch');
    expect(hard.fold.continuityLedger?.lifecycle).toBe('hard-epoch');

    await Promise.all([
      tailLoop.flushContinuityLedger(),
      hardLoop.flushContinuityLedger(),
    ]);

    const page1 = store.index({ ownerInstanceId: 'standalone-owner', limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBeGreaterThan(2);
    expect(page1.nextOffset).toBe(2);
    const page2 = await store.executeHandle(
      'continuity_ledger action="index" owner="standalone-owner" offset=2 limit=2',
    );
    expect(page2.action).toBe('index');
    if (page2.action !== 'index') throw new Error('index handle routed incorrectly');
    expect(page2.page.offset).toBe(2);
    expect(page2.page.rows.length).toBeLessThanOrEqual(2);

    const all = store.fetch({ ownerInstanceId: 'standalone-owner', limit: 500 });
    expect(new Set(all.rows.map((row) => row.lifecycle))).toEqual(
      new Set(['rebirth', 'tail-epoch', 'hard-epoch']),
    );
    expect(all.rows.every((row) => row.sourceProvenanceId.length > 0)).toBe(true);
    expect(all.rows.some((row) => row.sourceTime === '2026-08-11T19:00:00.000Z')).toBe(true);
    expect(all.rows
      .filter((row) => row.lifecycle !== 'rebirth')
      .every((row) => row.captureSourceStartIndex !== null)).toBe(true);

    const capturedUnits = [
      ...renderedRebirth.continuityLedger.units,
      ...(tail.fold.continuityLedger?.units ?? []),
      ...(hard.fold.continuityLedger?.units ?? []),
    ];
    for (const unit of [
      ...(tail.fold.continuityLedger?.units ?? []),
      ...(hard.fold.continuityLedger?.units ?? []),
    ]) {
      const recovered = await store.executeHandle(unit.recover);
      expect(recovered.action).toBe('recover');
      if (recovered.action === 'recover') {
        expect(recovered.recovery?.verbatim).toBe(unit.verbatim);
      }
    }
    for (const row of all.rows) {
      const expected = capturedUnits.find((unit) => (
        unit.unitId === row.unitId && unit.sha256 === row.sha256
      ));
      expect(expected, `missing canonical unit for ${row.unitId}`).toBeDefined();
      const recovered = await store.executeHandle(row.recover);
      expect(recovered.action).toBe('recover');
      if (recovered.action !== 'recover' || !recovered.recovery || !expected) {
        throw new Error(`source handle did not recover ${row.unitId}`);
      }
      expect(recovered.recovery.row.sourceProvenanceId).toBe(row.sourceProvenanceId);
      expect(recovered.recovery.verbatim).toBe(expected.verbatim);
      expect(sha256ContinuityLedgerVerbatim(recovered.recovery.verbatim)).toBe(row.sha256);
    }

    const ledgerText = await readFile(ledgerPath, 'utf8');
    const sourceText = await readFile(sourcePath, 'utf8');
    expect(ledgerText).not.toContain('"verbatim"');
    expect(ledgerText).not.toContain('compressible tail detail');
    expect(sourceText).toContain('"verbatim"');
    expect(sourceText).toContain('compressible tail detail');

    const reopened = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath });
    for (const row of all.rows) {
      const reopenedRecovery = await reopened.executeHandle(row.recover);
      expect(reopenedRecovery.action).toBe('recover');
      if (reopenedRecovery.action === 'recover') {
        expect(reopenedRecovery.recovery?.verbatim).toBe(
          capturedUnits.find((unit) => unit.unitId === row.unitId)?.verbatim,
        );
      }
    }
  });

  it('fails exact recovery closed when source bytes no longer match the ledger proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-corrupt-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath });
    const session = new FoldSession({ foldConfig: TEST_FOLD_CONFIG });
    const loop = new MemoryLoop({
      session,
      sessionId: 'corrupt-owner',
      continuityLedgerStore: store,
    });
    const outcome = await loop.prepare(firstHistory('corrupt'), {
      hardEpoch: true,
      hardEpochSeed: 'hard seed',
    });
    await loop.flushContinuityLedger();
    const handle = outcome.fold.continuityLedger?.units[0]?.recover;
    if (!handle) throw new Error('fixture did not emit a recovery handle');

    const sourceText = await readFile(sourcePath, 'utf8');
    await rm(sourcePath);
    const corrupted = sourceText.replace('corrupt first question', 'tampered first question');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(sourcePath, corrupted, 'utf8');
    const reopened = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath });
    const result = await reopened.executeHandle(handle);
    expect(result.action).toBe('recover');
    if (result.action === 'recover') expect(result.recovery).toBeNull();
  });
});
