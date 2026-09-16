import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryLoop } from '../src/host/MemoryLoop.ts';
import { StandaloneContinuityLedgerStore } from '../src/host/continuityLedgerStore.ts';
import {
  buildRebirthPackageV6Model,
  sha256ContinuityLedgerVerbatim,
  type ContinuityLedgerCaptureRecord,
  type ContinuityLedgerCaptureUnit,
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

function captureUnit(
  unitId: string,
  overrides: Partial<ContinuityLedgerCaptureUnit> = {},
): ContinuityLedgerCaptureUnit {
  const verbatim = overrides.verbatim ?? `${unitId} canonical bytes`;
  return {
    unitId,
    kind: 'operator',
    sectionId: 'cognitiveArtifacts',
    sourceProvenanceId: unitId,
    sourceIdentityAuthority: 'exact',
    sourceIndex: null,
    sourceInstanceId: 'owner-a',
    sourceTime: '2026-08-11T19:30:00.000Z',
    sourceEndTime: null,
    eraKey: '2026-08-11',
    tier: 't4',
    tierBasis: 'cap-overflow',
    placement: 'folded',
    claim: `${unitId} source`,
    verbatim,
    sha256: sha256ContinuityLedgerVerbatim(verbatim),
    origin: 'declared',
    recover: 'continuity_ledger action="recover" owner="owner-a"',
    workspace: 'context-warp-drive',
    ...overrides,
  };
}

function captureRecord(
  ownerInstanceId: string,
  captureId: string,
  units: readonly ContinuityLedgerCaptureUnit[],
): ContinuityLedgerCaptureRecord {
  return {
    ownerInstanceId,
    captureId,
    workspace: 'context-warp-drive',
    lifecycle: 'hard-epoch',
    sourceStartIndex: 0,
    sourceEndIndexExclusive: units.length,
    sourceFirstTime: '2026-08-11T19:00:00.000Z',
    sourceLastTime: '2026-08-11T19:30:00.000Z',
    units,
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
    // Eviction-only (relay parity): a unit the render delivered as t0 is a
    // removal signal, never ledger inventory. Its exact bytes reach the
    // successor through the delivered package, so this store must advertise no
    // row for it and recover nothing — the source file stays free of it too.
    const deliveredRows = store.fetch({
      ownerInstanceId: 'standalone-owner',
      unitIds: [renderedRebirthUnit.id],
      limit: 10,
    });
    expect(deliveredRows.rows).toHaveLength(0);
    const directRebirthRecovery = await store.executeHandle(renderedRebirthUnit.recover);
    expect(directRebirthRecovery.action).toBe('recover');
    if (directRebirthRecovery.action === 'recover') {
      expect(directRebirthRecovery.recovery).toBeNull();
    }

    const tailSession = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      // A committed tail-epoch append requires the single-ceiling routing: with
      // `singleCeilingMode: false` the same P hit escalates to a hard epoch
      // instead, and the measured append predicate is never consulted.
      singleCeilingMode: true,
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
      // A P hit at the ceiling is what commits the append (the previous 70k
      // reading sat below the ceiling and hot-reused without an epoch).
      measuredInputTokens: 150_000,
      // Explicit epoch identity: MemoryLoop's minted capture id is a per-loop
      // sequence (`<owner>:memory-loop-epoch#1`), so two loop instances under one
      // owner collide — and capture identity is immutable, so the second capture
      // is refused. Distinct addresses keep this fixture's two epochs distinct.
      continuityLedger: {
        ownerInstanceId: 'standalone-owner',
        captureId: 'standalone-owner:tail-epoch#1',
        workspace: 'context-warp-drive',
      },
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
      continuityLedger: {
        ownerInstanceId: 'standalone-owner',
        captureId: 'standalone-owner:hard-epoch#1',
        workspace: 'context-warp-drive',
      },
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
    // Eviction-only: the rebirth capture's only unit was DELIVERED (a removal,
    // asserted above), so the stored inventory holds the tail and hard epoch
    // captures — a rebirth capture with no omitted unit keeps nothing.
    expect(new Set(all.rows.map((row) => row.lifecycle))).toEqual(
      new Set(['tail-epoch', 'hard-epoch']),
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

  it('treats rendered placements as removals: no inventory, no source bytes, replay-stable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-evict-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const historyPath = join(root, 'captures.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath, captureHistoryPath: historyPath });

    const first = await store.record(captureRecord('owner-a', 'capture-a', [
      captureUnit('durable-unit'),
      captureUnit('episode-unit', { kind: 'episode', sectionId: 'episodeChapterIndex' }),
    ]));
    expect(first).toMatchObject({ recorded: 1, replaced: 0, removed: 0, rejected: [] });
    const excluded = await store.executeHandle(
      store.renderUnitRecoveryHandle('owner-a', 'capture-a', 'episode-unit'),
    );
    expect(excluded.action).toBe('recover');
    if (excluded.action === 'recover') expect(excluded.recovery).toBeNull();
    const sourceText = await readFile(sourcePath, 'utf8');
    expect(sourceText).toContain('durable-unit canonical bytes');
    expect(sourceText).not.toContain('episode-unit canonical bytes');

    const retired = await store.record(captureRecord('owner-a', 'capture-c', [
      captureUnit('durable-unit', { placement: 'rendered', tierBasis: 'rendered' }),
    ]));
    expect(retired).toMatchObject({ recorded: 0, removed: 1 });
    expect(store.fetch({ ownerInstanceId: 'owner-a', limit: 100 }).total).toBe(0);
    // The removal clears current inventory and its own capture only: an older
    // capture's exact recovery is untouched.
    const historical = await store.executeHandle(
      store.renderUnitRecoveryHandle('owner-a', 'capture-a', 'durable-unit'),
    );
    expect(historical.action).toBe('recover');
    if (historical.action === 'recover') {
      expect(historical.recovery?.verbatim).toBe('durable-unit canonical bytes');
    }

    const reopened = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath, captureHistoryPath: historyPath });
    expect(reopened.fetch({ ownerInstanceId: 'owner-a', limit: 100 }).total).toBe(0);
    const afterReopen = await reopened.executeHandle(
      reopened.renderUnitRecoveryHandle('owner-a', 'capture-a', 'durable-unit'),
    );
    expect(afterReopen.action).toBe('recover');
    if (afterReopen.action === 'recover') {
      expect(afterReopen.recovery?.verbatim).toBe('durable-unit canonical bytes');
    }
  });

  it('preserves a projected omission and retires it only on full delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-projection-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const historyPath = join(root, 'captures.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath, captureHistoryPath: historyPath });

    const projected = captureUnit('projected-unit', {
      placement: 'rendered',
      verbatim: 'stored prefix of a longer source',
      projection: {
        mode: 'truncated',
        algorithm: 'head-clamp',
        version: 1,
        storedChars: 32,
        storedBytes: 32,
        sourceChars: 4096,
        sourceBytes: 4096,
      },
    });
    const first = await store.record(captureRecord('owner-a', 'capture-a', [projected]));
    // A truncated delivery is an omission: the row is stored, not retired.
    expect(first).toMatchObject({ recorded: 1, removed: 0, rejected: [] });
    const inventory = store.fetch({ ownerInstanceId: 'owner-a', limit: 10 });
    expect(inventory.rows.map((row) => row.unitId)).toEqual(['projected-unit']);
    expect(inventory.rows[0]!.projection?.mode).toBe('truncated');

    // Re-capturing the same partial delivery must not retire it either.
    const again = await store.record(captureRecord('owner-a', 'capture-b', [projected]));
    expect(again).toMatchObject({ recorded: 1, replaced: 1, removed: 0 });
    expect(store.fetch({ ownerInstanceId: 'owner-a', limit: 10 }).rows).toHaveLength(1);

    // Only a FULL delivery retires the row — and the frozen capture keeps the
    // projection proof, so the historical answer never shrinks.
    const full = await store.record(captureRecord('owner-a', 'capture-c', [
      captureUnit('projected-unit', { placement: 'rendered', tierBasis: 'rendered', verbatim: 'complete source' }),
    ]));
    expect(full).toMatchObject({ recorded: 0, removed: 1 });
    expect(store.fetch({ ownerInstanceId: 'owner-a', limit: 10 }).rows).toHaveLength(0);
    const frozen = store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-a', limit: 10 });
    expect(frozen.captureMembership).toMatchObject({ status: 'complete', recordedUnits: 1 });
    expect(frozen.rows[0]!.projection).toMatchObject({ mode: 'truncated', sourceChars: 4096 });

    // Replay preserves the projected row's proof instead of removing it.
    const reopened = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath, captureHistoryPath: historyPath });
    expect(reopened.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-a', limit: 10 }).rows[0]!.projection?.mode)
      .toBe('truncated');
  });

  it('keeps an older capture complete and unshrunk after a restamp and a later retirement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-history-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const historyPath = join(root, 'captures.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath, captureHistoryPath: historyPath });

    await store.record(captureRecord('owner-a', 'capture-a', [
      captureUnit('shared-unit', { verbatim: 'first capture bytes' }),
    ]));
    await store.record(captureRecord('owner-a', 'capture-b', [
      captureUnit('shared-unit', { verbatim: 'second capture bytes' }),
    ]));
    await store.record(captureRecord('owner-a', 'capture-c', [
      captureUnit('shared-unit', { verbatim: 'delivered bytes', placement: 'rendered', tierBasis: 'rendered' }),
    ]));

    // C delivered the source, so current inventory is empty — while both older
    // captures still answer from their own frozen membership.
    expect(store.fetch({ ownerInstanceId: 'owner-a', limit: 100 }).total).toBe(0);
    const firstPage = store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-a', limit: 100 });
    expect(firstPage.captureMembership).toMatchObject({ status: 'complete', recordedUnits: 1, returnedUnits: 1 });
    expect(firstPage.rows[0]).toMatchObject({
      unitId: 'shared-unit',
      chars: 'first capture bytes'.length,
      sha256: sha256ContinuityLedgerVerbatim('first capture bytes'),
    });
    const secondPage = store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-b', limit: 100 });
    expect(secondPage.captureMembership).toMatchObject({ status: 'complete', recordedUnits: 1, returnedUnits: 1 });
    expect(secondPage.rows[0]).toMatchObject({
      sha256: sha256ContinuityLedgerVerbatim('second capture bytes'),
    });

    const firstRecovery = store.recoverUnit('owner-a', 'capture-a', 'shared-unit');
    expect(firstRecovery?.verbatim).toBe('first capture bytes');
    const secondRecovery = store.recoverUnit('owner-a', 'capture-b', 'shared-unit');
    expect(secondRecovery?.verbatim).toBe('second capture bytes');

    // History stays content-free: membership rows carry proofs, never bodies.
    const historyText = await readFile(historyPath, 'utf8');
    expect(historyText).toContain('"kind":"capture-snapshot"');
    expect(historyText).not.toContain('first capture bytes');
    expect(historyText).not.toContain('"verbatim"');
  });

  it('bounds capture history and reports pruned or unknown captures as unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-retention-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const historyPath = join(root, 'captures.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({
      ledgerPath,
      sourcePath,
      captureHistoryPath: historyPath,
      captureHistoryLimit: 2,
    });
    for (const captureId of ['capture-a', 'capture-b', 'capture-c']) {
      await store.record(captureRecord('owner-a', captureId, [captureUnit(`unit-${captureId}`)]));
    }

    const pruned = store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-a', limit: 100 });
    expect(pruned.rows).toHaveLength(0);
    expect(pruned.captureMembership).toMatchObject({
      status: 'unavailable',
      recordedUnits: null,
      returnedUnits: 0,
      reason: 'legacy-capture',
    });
    expect(store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-c', limit: 100 }).captureMembership)
      .toMatchObject({ status: 'complete', recordedUnits: 1 });
    expect(store.fetch({ ownerInstanceId: 'owner-a', captureId: 'never-observed', limit: 100 }).captureMembership)
      .toMatchObject({ status: 'unavailable', reason: 'no-snapshot' });

    const historyText = await readFile(historyPath, 'utf8');
    expect(historyText.split('\n').filter((line) => line.trim())).toHaveLength(2);

    const reopened = await StandaloneContinuityLedgerStore.open({
      ledgerPath,
      sourcePath,
      captureHistoryPath: historyPath,
      captureHistoryLimit: 2,
    });
    expect(reopened.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-b', limit: 100 }).captureMembership)
      .toMatchObject({ status: 'complete', recordedUnits: 1 });
    expect(reopened.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-a', limit: 100 }).captureMembership)
      .toMatchObject({ status: 'unavailable' });
  });

  it('freezes capture identity: identical retries are no-ops and divergence is declared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-identity-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const historyPath = join(root, 'captures.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({
      ledgerPath,
      sourcePath,
      captureHistoryPath: historyPath,
    });

    const record = captureRecord('owner-a', 'capture-a', [
      captureUnit('unit-one', { verbatim: 'original bytes' }),
    ]);
    expect(await store.record(record)).toMatchObject({ recorded: 1, removed: 0, rejected: [] });
    // Byte-identical retry: no second snapshot, no duplicate source row.
    expect(await store.record(record)).toMatchObject({ recorded: 0, replaced: 0, rejected: [] });
    // Divergent write for the same identity: declared, and nothing is written,
    // so frozen membership and its recovery bytes cannot be overwritten.
    const conflict = await store.record(captureRecord('owner-a', 'capture-a', [
      captureUnit('unit-one', { verbatim: 'tampered bytes' }),
    ]));
    expect(conflict.recorded).toBe(0);
    expect(conflict.rejected).toHaveLength(1);
    expect(conflict.rejected[0]!.reason).toContain('capture-id-conflict');

    expect(store.recoverUnit('owner-a', 'capture-a', 'unit-one')?.verbatim).toBe('original bytes');
    expect(store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-a', limit: 10 }).captureMembership)
      .toMatchObject({ status: 'complete', recordedUnits: 1 });
    const historyText = await readFile(historyPath, 'utf8');
    expect(historyText.split('\n').filter((line) => line.trim())).toHaveLength(1);
    const sourceText = await readFile(sourcePath, 'utf8');
    expect(sourceText).not.toContain('tampered bytes');
    expect(sourceText.split('\n').filter((line) => line.trim())).toHaveLength(1);
  });

  it('reports a capture with refused units as incomplete, never a complete inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-rejected-'));
    roots.push(root);
    const store = await StandaloneContinuityLedgerStore.open({
      ledgerPath: join(root, 'ledger.jsonl'),
      sourcePath: join(root, 'sources.jsonl'),
      captureHistoryPath: join(root, 'captures.jsonl'),
    });

    const write = await store.record(captureRecord('owner-a', 'capture-mixed', [
      captureUnit('good-unit'),
      captureUnit('bad-unit', { sha256: 'f'.repeat(64) }),
    ]));
    expect(write.rejected).toHaveLength(1);
    expect(write.rejected[0]).toMatchObject({ unitId: 'bad-unit', reason: 'sha256-mismatch' });
    const mixedPage = store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-mixed', limit: 10 });
    expect(mixedPage.rows.map((row) => row.unitId)).toEqual(['good-unit']);
    expect(mixedPage.captureMembership).toMatchObject({
      status: 'incomplete',
      recordedUnits: 1,
      returnedUnits: 1,
      rejectedUnits: 1,
    });

    const clean = await store.record(captureRecord('owner-a', 'capture-clean', [captureUnit('clean-unit')]));
    expect(clean.rejected).toHaveLength(0);
    expect(store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-clean', limit: 10 }).captureMembership)
      .toMatchObject({ status: 'complete', rejectedUnits: 0 });
  });

  it('filters legacy episode rows and replays legacy rendered rows as removals on reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-legacy-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const historyPath = join(root, 'captures.jsonl');
    const kept = 'legacy kept bytes';
    const retired = 'legacy retired bytes';
    const episode = 'legacy episode bytes';
    const legacyRow = (
      captureId: string,
      unitId: string,
      placement: string,
      verbatim: string,
      kind = 'operator',
      sectionId = 'cognitiveArtifacts',
    ): string => JSON.stringify({
      ownerInstanceId: 'owner-a',
      captureId,
      workspace: null,
      lifecycle: 'hard-epoch',
      captureSourceStartIndex: 0,
      captureSourceEndIndexExclusive: 1,
      captureSourceFirstTime: null,
      captureSourceLastTime: null,
      unitId,
      kind,
      sectionId,
      sourceProvenanceId: unitId,
      sourceIdentityAuthority: 'exact',
      sourceIndex: null,
      sourceInstanceId: 'owner-a',
      sourceTime: null,
      sourceEndTime: null,
      eraKey: null,
      tier: 't4',
      tierBasis: 'cap-overflow',
      placement,
      claim: `${unitId} source`,
      chars: verbatim.length,
      sha256: sha256ContinuityLedgerVerbatim(verbatim),
      origin: 'declared',
      recover: 'continuity_ledger action="recover" owner="owner-a"',
      recordedAt: '2026-08-11T20:00:00.000Z',
    });
    const legacySource = (captureId: string, unitId: string, verbatim: string): string => JSON.stringify({
      ownerInstanceId: 'owner-a',
      captureId,
      sourceIndex: null,
      unitId,
      sourceProvenanceId: unitId,
      chars: verbatim.length,
      sha256: sha256ContinuityLedgerVerbatim(verbatim),
      verbatim,
      recordedAt: '2026-08-11T20:00:00.000Z',
    });
    // A ledger written before this policy: episode rows and fully rendered rows
    // were stored as inventory.
    await writeFile(ledgerPath, [
      legacyRow('capture-a', 'unit-kept', 'folded', kept),
      legacyRow('capture-b', 'unit-retired', 'folded', retired),
      legacyRow('capture-c', 'unit-retired', 'rendered', retired),
      legacyRow('capture-d', 'unit-episode', 'folded', episode, 'episode', 'episodeChapterIndex'),
    ].join('\n') + '\n', 'utf8');
    await writeFile(sourcePath, [
      legacySource('capture-a', 'unit-kept', kept),
      legacySource('capture-b', 'unit-retired', retired),
      legacySource('capture-c', 'unit-retired', retired),
      legacySource('capture-d', 'unit-episode', episode),
    ].join('\n') + '\n', 'utf8');

    const store = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath, captureHistoryPath: historyPath });
    expect(store.fetch({ ownerInstanceId: 'owner-a', limit: 100 }).rows.map((row) => row.unitId))
      .toEqual(['unit-kept']);
    // The legacy rendered row is a removal: no recovery is advertised for it,
    // while the older capture keeps its own exact bytes.
    expect(store.recoverUnit('owner-a', 'capture-c', 'unit-retired')).toBeNull();
    expect(store.recoverUnit('owner-a', 'capture-b', 'unit-retired')?.verbatim).toBe(retired);
    // Episode rows are never inventory and never recoverable here.
    expect(store.recoverUnit('owner-a', 'capture-d', 'unit-episode')).toBeNull();

    const reopened = await StandaloneContinuityLedgerStore.open({ ledgerPath, sourcePath, captureHistoryPath: historyPath });
    expect(reopened.fetch({ ownerInstanceId: 'owner-a', limit: 100 }).rows.map((row) => row.unitId))
      .toEqual(['unit-kept']);
  });

  it('keeps an observed capture identity reserved after its snapshot is pruned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-expired-id-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const historyPath = join(root, 'captures.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({
      ledgerPath,
      sourcePath,
      captureHistoryPath: historyPath,
      captureHistoryLimit: 2,
    });
    await store.record(captureRecord('owner-a', 'capture-a', [captureUnit('unit-a')]));
    await store.record(captureRecord('owner-a', 'capture-b', [captureUnit('unit-b')]));
    await store.record(captureRecord('owner-a', 'capture-c', [captureUnit('unit-c')]));
    // Retention pruned capture-a's snapshot while its durable rows and recovery
    // bytes remain — so the identity must stay reserved.
    expect(store.fetch({ ownerInstanceId: 'owner-a', captureId: 'capture-a', limit: 10 }).captureMembership)
      .toMatchObject({ status: 'unavailable' });
    const reuse = await store.record(captureRecord('owner-a', 'capture-a', [captureUnit('unit-a-reused')]));
    expect(reuse.recorded).toBe(0);
    expect(reuse.rejected[0]!.reason).toContain('capture-id-reuse-after-expiry');
    expect(store.fetch({ ownerInstanceId: 'owner-a', limit: 100 }).rows.map((row) => row.unitId))
      .not.toContain('unit-a-reused');

    const reopened = await StandaloneContinuityLedgerStore.open({
      ledgerPath,
      sourcePath,
      captureHistoryPath: historyPath,
      captureHistoryLimit: 2,
    });
    const reuseAfterReopen = await reopened.record(
      captureRecord('owner-a', 'capture-a', [captureUnit('unit-a-reopened')]),
    );
    expect(reuseAfterReopen.rejected[0]!.reason).toContain('capture-id-reuse-after-expiry');
  });

  it('mints distinct capture identities so two default loops under one owner both record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-ledger-two-loops-'));
    roots.push(root);
    const ledgerPath = join(root, 'ledger.jsonl');
    const sourcePath = join(root, 'sources.jsonl');
    const historyPath = join(root, 'captures.jsonl');
    const store = await StandaloneContinuityLedgerStore.open({
      ledgerPath,
      sourcePath,
      captureHistoryPath: historyPath,
    });
    const runEpoch = async (prefix: string): Promise<void> => {
      const session = new FoldSession({
        foldConfig: TEST_FOLD_CONFIG,
        freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
        pressureCeiling: 150_000,
        singleCeilingMode: true,
        now: () => 1_000,
      });
      const loop = new MemoryLoop({
        session,
        sessionId: 'owner-b',
        continuityLedgerStore: store,
        continuityWorkspace: 'context-warp-drive',
      });
      const first = firstHistory(prefix);
      await loop.prepare(first);
      await loop.prepare(appendProfitableTail(first, prefix), { measuredInputTokens: 150_000 });
      await loop.flushContinuityLedger();
    };
    await runEpoch('loop-one');
    await runEpoch('loop-two');

    // Two default-configured loops share one owner and one store: both epochs
    // are recorded because each loop mints its own capture identity, and each
    // loop's own content is present (neither was refused as a conflict).
    const rows = store.fetch({ ownerInstanceId: 'owner-b', limit: 100 }).rows;
    const captureIds = new Set(rows.map((row) => row.captureId));
    expect(captureIds.size).toBe(2);
    for (const captureId of captureIds) {
      expect(rows.filter((row) => row.captureId === captureId).length).toBeGreaterThan(0);
    }
    expect(rows.some((row) => row.sourceProvenanceId.includes('loop-one'))).toBe(true);
    expect(rows.some((row) => row.sourceProvenanceId.includes('loop-two'))).toBe(true);
  });

  it('reserves an empty capture identity after expiry and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-warp-empty-capture-'));
    roots.push(root);
    const options = { ledgerPath: join(root, 'ledger.jsonl'), captureHistoryLimit: 1 };
    const store = await StandaloneContinuityLedgerStore.open(options);
    const empty = captureRecord('owner-a', 'empty', []);
    await store.record(empty);
    await store.record(captureRecord('owner-a', 'later', [captureUnit('later-unit')]));
    const reopened = await StandaloneContinuityLedgerStore.open(options);
    expect(reopened.fetch({ ownerInstanceId: 'owner-a', captureId: 'empty' }).captureMembership?.status)
      .toBe('unavailable');
    expect((await reopened.record(empty)).rejected[0]?.reason).toContain('reuse-after-expiry');
  });
});
