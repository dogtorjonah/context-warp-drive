import { describe, expect, it } from 'vitest';
import { buildContinuityReceipt } from '../continuityReceipt.ts';
import { buildRawHardEpochSeed } from '../foldFreeze.ts';
import {
  DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS,
  REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS,
  REBIRTH_PACKAGE_V6_SECTION_IDS,
  REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS,
  adaptLegacyRebirthPackageToV6,
  adaptRebirthPackageV6SectionsToLegacyKeys,
  buildContinuityLedgerCaptureFromV6Render,
  buildRebirthPackageV6Model,
  isRebirthPackageV6Model,
  renderRebirthPackageV6,
  renderRebirthPackageV6Sections,
  renderRebirthPackageV6WithReport,
  sha256ContinuityLedgerVerbatim,
  type RebirthPackageV6ActiveEditDelta,
  type RebirthPackageV6CognitiveArtifact,
  type RebirthPackageV6Model,
} from '../rebirthPackageV6.ts';

function exactDelta(
  overrides: Partial<RebirthPackageV6ActiveEditDelta> = {},
): RebirthPackageV6ActiveEditDelta {
  return {
    captureId: 'atlas-edit-capture:v1:abc',
    state: 'exact',
    capturedSourceAt: '2026-08-02T18:00:00.000Z',
    completedObservedAt: '2026-08-02T18:00:00.100Z',
    inheritedCaptureIds: [],
    files: [{
      provenanceId: 'edit-file:one',
      sourceAt: '2026-08-02T17:59:00.000Z',
      filePath: 'src/example.ts',
      changeKind: 'modified',
      baselineQuality: 'exact',
      ownership: 'mine',
      state: 'open',
      insertions: 2,
      deletions: 1,
      validationState: 'pending',
      closureState: 'open',
      contributors: [{
        provenanceId: 'contributor:one',
        instanceId: 'instance-a',
        relation: 'owner',
        sourceAt: '2026-08-02T17:59:00.000Z',
      }],
      preview: {
        text: '@@ -1 +1 @@\n-old\n+new',
        complete: true,
        omittedHunks: 0,
        omittedLines: 0,
      },
      diffHandle: 'atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"',
      snapshotHandle: 'atlas_snapshot file_path="src/example.ts" capture_id="atlas-edit-capture:v1:abc"',
      reason: null,
    }],
    omittedFiles: 0,
    truncated: false,
    reasons: [],
    ...overrides,
  };
}

function model(
  overrides: Partial<Parameters<typeof buildRebirthPackageV6Model>[0]> = {},
): RebirthPackageV6Model {
  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'continuation',
      lifecycleMeaning: 'same instance identity; new session continuation',
      captureId: 'capture-1',
      capturedAt: '2026-08-02T18:00:00.000Z',
      sourceFrontier: 'event-9',
      instanceId: 'instance-a',
      instanceName: 'worker-a',
      predecessorInstanceId: null,
      predecessorName: 'worker-a',
      workspace: 'voxxo-swarm',
      cwd: '/workspace',
      runtimeChange: null,
      activeRequest: {
        text: 'Implement the frozen v6 contract.',
        chars: 33,
        source: {
          provenanceId: 'message:user-1',
          sourceAt: '2026-08-02T17:58:00.000Z',
          status: 'exact',
        },
      },
      lastMaterialAssistant: {
        text: 'I will implement it now.',
        chars: 24,
        source: {
          provenanceId: 'message:assistant-1',
          sourceAt: '2026-08-02T17:58:30.000Z',
          status: 'exact',
        },
      },
    },
    executionState: {
      facts: [{
        provenanceId: 'rail:one',
        sourceAt: '2026-08-02T17:59:30.000Z',
        status: 'exact',
        kind: 'rail',
        text: 'rail-one · model step active',
      }],
      unknownReasons: [],
    },
    activeEditDelta: exactDelta(),
    cognitiveArtifacts: [{
      provenanceId: 'decision:one',
      sourceAt: '2026-08-02T17:59:40.000Z',
      kind: 'decision',
      text: 'Use one immutable model.',
      authority: 'current',
      supersededBy: null,
    }],
    recentConversation: [{
      provenanceId: 'message:user-1',
      sourceAt: '2026-08-02T17:58:00.000Z',
      role: 'user',
      text: 'Implement the frozen v6 contract.',
    }, {
      provenanceId: 'message:assistant-1',
      sourceAt: '2026-08-02T17:58:30.000Z',
      role: 'assistant',
      text: 'I will implement it now.',
    }, {
      provenanceId: 'message:user-older',
      sourceAt: '2026-08-02T17:57:00.000Z',
      role: 'user',
      text: 'Keep Atlas semantics stable.',
    }],
    recoveryIndex: [{
      id: 'transcript',
      label: 'transcript',
      handle: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
      status: 'available',
      count: null,
      frontier: 'event-9',
    }, {
      id: 'atlas-edit-capture',
      label: 'edit capture',
      handle: 'atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"',
      status: 'available',
      count: 1,
      frontier: 'atlas-edit-capture:v1:abc',
    }, {
      id: 'rebirth-package',
      label: 'package',
      handle: 'tap_instance_messages action="rebirth" target_instance_id="instance-a" search="capture-1"',
      status: 'available',
      count: null,
      frontier: 'capture-1',
    }, {
      id: 'continuity-ledger',
      label: 'continuity ledger',
      handle: 'continuity_ledger action="index" owner="instance-a"',
      status: 'available',
      count: null,
      frontier: 'capture-1',
    }],
    ...overrides,
  });
}

describe('Rebirth Package v6', () => {
  it('renders indexed cognition absence and degradation without claiming the stores are empty', () => {
    const cognitionText = (value: RebirthPackageV6Model): string => (
      renderRebirthPackageV6Sections(value)
        .find((section) => section.id === 'cognitiveArtifacts')?.text ?? ''
    );
    const receipt = {
      status: 'complete' as const,
      capturedAt: '2026-08-02T18:00:00.000Z',
      totalMatched: 0,
      overlayCount: 0,
      missingFamilies: [] as string[],
      warnings: [] as string[],
    };

    const completeEmpty = cognitionText(model({
      cognitiveArtifacts: [],
      cognitiveArtifactCapture: receipt,
    }));
    expect(completeEmpty).toContain('bounded indexed cognitive projection returned zero current rows');
    expect(completeEmpty).toContain('Capture receipt: status=complete');
    expect(completeEmpty).not.toContain('No relevant current cognitive artifacts captured.');

    const partial = cognitionText(model({
      cognitiveArtifacts: [],
      cognitiveArtifactCapture: {
        ...receipt,
        status: 'partial',
        missingFamilies: ['star', 'rail'],
        warnings: ['cognitive ledger: indexed current query unavailable; using bounded overlay only'],
      },
    }));
    expect(partial).toContain('projection is partial; zero rendered rows are not evidence');
    expect(partial).toContain('Missing indexed families: star, rail');
    expect(partial).toContain('indexed current query unavailable; using bounded overlay only');

    const unavailable = cognitionText(model({
      cognitiveArtifacts: [],
      cognitiveArtifactCapture: { ...receipt, status: 'unavailable', totalMatched: null },
    }));
    expect(unavailable).toContain('projection is unavailable; zero rendered rows are not evidence');

    const legacyUnknown = cognitionText(model({ cognitiveArtifacts: [] }));
    expect(legacyUnknown).toContain('projection status is unknown for this persisted package');
  });

  describe('cognition render discipline', () => {
    const artifact = (
      overrides: Partial<RebirthPackageV6CognitiveArtifact> & { provenanceId: string },
    ): RebirthPackageV6CognitiveArtifact => ({
      sourceAt: '2026-08-02T17:00:00.000Z',
      kind: 'discovery',
      text: 'a finding',
      authority: 'evidence',
      supersededBy: null,
      ...overrides,
    });

    /**
     * The section BODY, with the `[REBIRTH-V6-SECTION …]` frame stripped. The
     * frame is protected envelope charged above the section cap, so asserting
     * the cap against framed text would measure the wrong string.
     */
    const cognition = (
      value: RebirthPackageV6Model,
      maxChars?: number,
    ): string => {
      const framed = renderRebirthPackageV6Sections(
        value,
        maxChars === undefined
          ? {}
          : { adaptiveBackfill: false, sectionMaxChars: { cognitiveArtifacts: maxChars } },
      ).find((section) => section.id === 'cognitiveArtifacts')?.text ?? '';
      // Frame is four lines: title, `[REBIRTH-V6-SECTION …]`, body, close.
      const openLine = framed.indexOf('[REBIRTH-V6-SECTION id=cognitiveArtifacts');
      const bodyStart = openLine < 0 ? -1 : framed.indexOf('\n', openLine) + 1;
      const close = framed.lastIndexOf('\n[/REBIRTH-V6-SECTION]');
      return bodyStart > 0 && close >= bodyStart ? framed.slice(bodyStart, close) : framed;
    };

    const receipt = {
      status: 'complete' as const,
      capturedAt: '2026-08-02T18:00:00.000Z',
      totalMatched: 6,
      selectedCount: 1,
      overlayCount: 0,
      missingFamilies: [] as string[],
      warnings: [] as string[],
      relaySuppression: {
        duplicate: 2,
        rootDuplicate: 1,
        superseded: 1,
        frontier: 3,
        crossSection: 1,
        unknownSourceTime: 1,
        overBudget: 1,
        unattributed: 0,
      },
    };

    it('keeps relay selection suppression visible and arithmetically separate from upstream rejections', () => {
      const value = model({
        cognitiveArtifacts: [artifact({ provenanceId: 'star:kept', text: 'kept result' })],
        cognitiveArtifactCapture: receipt,
      });

      const rendered = cognition(value);
      expect(rendered).toContain('rendered=1 captured=1 matched=6');
      expect(rendered).toContain(
        'relay-drops{root:1,superseded:1,thread:1,unknown-time:1,budget:1,other:0}',
      );
      expect(rendered).toContain('upstream-rejects{duplicate:2,frontier:3}');
    });

    it('ships an oversized entry whole while room remains and projects it only under contention', () => {
      const body = `${'x'.repeat(1200)} tail`;
      const value = model({
        cognitiveArtifacts: [artifact({ provenanceId: 'star:huge', text: body })],
        cognitiveArtifactCapture: receipt,
      });

      // Dynamic fill: normalize preserves the FULL body. The per-entry cap is
      // a scarcity floor and the ledger's storage economy, never a normalize
      // mutation — projecting at normalize time would make the abundance
      // render unable to ship the body it still has room for.
      const [row] = value.cognitiveArtifacts;
      expect(row.projection).toBeUndefined();
      expect(row.text).toBe(body);

      // Abundance: the body ships whole, byte-exact, with no projection.
      const full = cognition(value);
      expect(full).toContain(body);
      expect(full).not.toContain('projected{truncated');

      // Contention (cap below full assembled demand): the declared per-entry
      // projection uses the same exact byte prefix as the ledger's stored copy.
      // The cap fits the raw body but not the body plus its protected capture
      // and accounting receipts, so the demand probe must fall back to the
      // scarcity projection without dropping the row wholesale.
      const contended = cognition(value, 1400);
      expect(contended).toContain(`projection=truncated stored=${REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS}/${body.length} chars`);
      expect(contended).toContain('projected{truncated:1}');
      // No rendered artifact body may exceed the per-entry cap under pressure.
      expect(contended).not.toContain('x'.repeat(REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS + 1));
    });

    it('keeps full bodies through normalize and passes persisted projected rows through untouched', () => {
      const body = `${'y'.repeat(1500)} end`;
      const once = model({
        cognitiveArtifacts: [artifact({ provenanceId: 'star:huge', text: body })],
      }).cognitiveArtifacts;
      // Normalize is a filter/dedupe pass, not a projection pass: the full
      // body survives so the render can ship it whole under abundance.
      expect(once[0].text).toBe(body);
      expect(once[0].projection).toBeUndefined();
      const twice = model({ cognitiveArtifacts: once }).cognitiveArtifacts;
      expect(twice).toEqual(once);

      // A persisted, already-projected row (from a pre-dynamic package) passes
      // through byte-identically: re-normalizing can never truncate twice or
      // lose the original sourceChars.
      const persisted = artifact({
        provenanceId: 'star:persisted',
        text: body.slice(0, REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS),
        projection: 'truncated',
        storedChars: REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS,
        storedBytes: REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS,
        sourceChars: body.length,
        sourceBytes: body.length,
      });
      const rehydrated = model({ cognitiveArtifacts: [persisted] }).cognitiveArtifacts;
      expect(rehydrated).toEqual([persisted]);
      expect(rehydrated[0].sourceChars).toBe(body.length);
    });

    it('stores the declared per-entry projection in the ledger even when the render ships the body whole', () => {
      const body = `${'Q'.repeat(1_200)} tail`;
      const value = model({
        cognitiveArtifacts: [artifact({ provenanceId: 'star:economy', text: body })],
        cognitiveArtifactCapture: { ...receipt, totalMatched: 1 },
      });
      const { text, collapse } = renderRebirthPackageV6WithReport(value, { packageBudget: 200_000 });
      // Abundance: the shipped section carries the whole body.
      expect(text).toContain(body);

      const record = buildContinuityLedgerCaptureFromV6Render(value, collapse)!;
      const unit = record.units.find((entry) => entry.unitId === 'star:economy')!;
      // Storage economy: the persisted ledger copy is the declared byte-exact
      // PREFIX of the shipped body, and sha256 attests exactly those stored
      // bytes — never undeclared full-body bytes the store would then discard.
      expect(unit.projection?.mode).toBe('truncated');
      expect(unit.projection?.storedChars).toBe(REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS);
      expect(unit.projection?.sourceChars).toBe(body.length);
      expect(unit.verbatim).toContain(body.slice(0, REBIRTH_PACKAGE_V6_COGNITION_ENTRY_MAX_CHARS));
      expect(unit.verbatim).not.toContain(body);
      expect(unit.sha256).toBe(sha256ContinuityLedgerVerbatim(unit.verbatim));
    });

    it('drops whole units by lowest priority under pressure and declares the suppression', () => {
      const rows = [
        artifact({ provenanceId: 'a:flow', kind: 'flow', text: 'F'.repeat(300), sourceAt: '2026-08-02T17:05:00.000Z' }),
        artifact({ provenanceId: 'b:discovery', kind: 'discovery', text: 'D'.repeat(300), sourceAt: '2026-08-02T17:04:00.000Z' }),
        artifact({ provenanceId: 'c:result', kind: 'result', text: 'R'.repeat(300), sourceAt: '2026-08-02T17:03:00.000Z' }),
        artifact({ provenanceId: 'd:question', kind: 'question', text: 'Q'.repeat(300), sourceAt: '2026-08-02T17:01:00.000Z' }),
      ];
      const value = model({ cognitiveArtifacts: rows, cognitiveArtifactCapture: receipt });
      const text = cognition(value, 1400);

      expect(text.length).toBeLessThanOrEqual(1400);
      // Unresolved open loop survives; transient process voice goes first.
      expect(text).toContain('Q'.repeat(300));
      expect(text).not.toContain('F'.repeat(300));
      expect(text).toMatch(/cognition: rendered=\d+ captured=4 matched=6 · omitted-units=\d+ · suppressed\{/u);
      expect(text).toContain('dropped-whole by lowest budget priority');
      // The capture receipt is protected: it survives pressure that rows do not.
      expect(text).toContain('Capture receipt: status=complete');
    });

    it('never slices a row mid-body: every surviving row ships its exact model bytes', () => {
      const rows = Array.from({ length: 12 }, (_, index) => artifact({
        provenanceId: `row:${index}`,
        kind: 'discovery',
        text: `${String.fromCharCode(65 + index).repeat(240)}`,
        sourceAt: `2026-08-02T17:${String(index).padStart(2, '0')}:00.000Z`,
      }));
      const value = model({ cognitiveArtifacts: rows, cognitiveArtifactCapture: receipt });
      const text = cognition(value, 1800);

      expect(text.length).toBeLessThanOrEqual(1800);
      // Byte coherence: a row is present in full or absent entirely. A partial
      // body would mean the ledger's sha256 attests bytes nobody was shown.
      let shown = 0;
      for (const row of value.cognitiveArtifacts) {
        if (!text.includes(`· ${row.kind} · ${row.text} ·`)) {
          expect(text).not.toContain(row.text.slice(0, 40));
          continue;
        }
        shown += 1;
      }
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(rows.length);
      expect(text).toContain(`cognition: rendered=${shown} captured=${rows.length} matched=6`);
    });

    it('publishes one capture-scoped command whose ledger rows equal the declared omitted count', () => {
      const rows = Array.from({ length: 8 }, (_, index) => artifact({
        provenanceId: `omission:${index}`,
        kind: index === 0 ? 'question' : 'decision',
        text: index === 7 ? 'P'.repeat(1_200) : String(index).repeat(260),
        sourceAt: `2026-08-02T17:${String(index).padStart(2, '0')}:00.000Z`,
      }));
      const value = model({
        cognitiveArtifacts: rows,
        cognitiveArtifactCapture: { ...receipt, totalMatched: rows.length },
      });
      const { text, collapse } = renderRebirthPackageV6WithReport(value, {
        adaptiveBackfill: false,
        sectionMaxChars: { cognitiveArtifacts: 1_500 },
      });
      const record = buildContinuityLedgerCaptureFromV6Render(value, collapse)!;
      const omitted = record.units.filter((unit) => (
        unit.sectionId === 'cognitiveArtifacts'
        && (unit.placement !== 'rendered' || unit.projection?.mode === 'truncated')
      ));
      const declared = text.match(/cognition: rendered=\d+ captured=8 matched=8 · omitted-units=(\d+)/u);
      expect(declared).not.toBeNull();
      expect(omitted).toHaveLength(Number(declared![1]));
      const command = 'continuity_ledger action="fetch" owner="instance-a" capture_id="capture-1" section_id="cognitiveArtifacts" omitted_only=true include_unknown_source_time=true limit=200';
      expect(text.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'))).toHaveLength(1);
      expect(text).not.toContain('unit_ids=');
    });

    it('ledgers selector budget evictions as explicit cap-overflow elisions', () => {
      const dropped = [
        artifact({ provenanceId: 'selector-drop:1', text: 'first selector omission' }),
        artifact({ provenanceId: 'selector-drop:2', text: 'second selector omission' }),
      ];
      const value = model({
        cognitiveArtifacts: [artifact({ provenanceId: 'selector-kept', text: 'visible cognition' })],
        cognitiveArtifactCapture: {
          ...receipt,
          totalMatched: 3,
          selectedCount: 1,
          droppedByBudget: dropped,
          relaySuppression: {
            ...receipt.relaySuppression,
            overBudget: 2,
          },
        },
      });
      const { text, collapse } = renderRebirthPackageV6WithReport(value, { packageBudget: 200_000 });
      const record = buildContinuityLedgerCaptureFromV6Render(value, collapse)!;
      const droppedRows = record.units.filter((unit) => unit.unitId.startsWith('selector-drop:'));

      expect(text).toContain('relay-drops{root:1,superseded:1,thread:1,unknown-time:1,budget:2,other:0}');
      expect(text).not.toContain('first selector omission');
      expect(text).not.toContain('second selector omission');
      expect(droppedRows.map((unit) => unit.unitId).sort())
        .toEqual(['selector-drop:1', 'selector-drop:2']);
      expect(droppedRows.every((unit) => (
        unit.placement === 'elided'
        && unit.tier === 't4'
        && unit.tierBasis === 'cap-overflow'
      ))).toBe(true);
    });

    it('keeps every cognitive unit addressable when the package omits the whole section', () => {
      const rows = Array.from({ length: 3 }, (_, index) => artifact({
        provenanceId: `whole-section:${index}`,
        kind: index === 0 ? 'question' : 'decision',
        text: index === 2 ? 'P'.repeat(1_200) : `artifact-${index}`,
        sourceAt: `2026-08-02T17:0${index}:00.000Z`,
      }));
      const value = model({
        cognitiveArtifacts: rows,
        cognitiveArtifactCapture: { ...receipt, totalMatched: rows.length },
      });
      const { text, collapse } = renderRebirthPackageV6WithReport(value, {
        packageBudget: 1,
      });
      const record = buildContinuityLedgerCaptureFromV6Render(value, collapse)!;
      const cognitive = record.units.filter((unit) => unit.sectionId === 'cognitiveArtifacts');

      expect(collapse.omittedSectionIds).toContain('cognitiveArtifacts');
      expect(collapse.omissionSections).toEqual([{
        sectionId: 'cognitiveArtifacts',
        placements: expect.arrayContaining(rows.map((row) => expect.objectContaining({ id: row.provenanceId }))),
        sectionElided: true,
      }]);
      expect(cognitive).toHaveLength(rows.length);
      expect(cognitive.map((unit) => unit.unitId).sort()).toEqual(rows.map((row) => row.provenanceId).sort());
      expect(cognitive.every((unit) => unit.placement === 'elided' && unit.tierBasis === 'section-elision')).toBe(true);
      expect(text).toContain('[EVICTED section=cognitiveArtifacts units=3');
      expect(text).toContain(
        'recover=continuity_ledger action="fetch" owner="instance-a" capture_id="capture-1"'
        + ' section_id="cognitiveArtifacts" omitted_only=true include_unknown_source_time=true limit=200]',
      );
    });

    it('covers every one of the five ledger families when the count formula assumes them', () => {
      // Review F1 left side: the capture writer must persist one row for every
      // unit of every family the assembler's count formula sums (activeEditDelta
      // files, cognitiveArtifacts, operatorVault, episodeChapterIndex, lifeLedger).
      // If a family is added to the formula without being fed to the writer (or
      // vice versa), the relay-side count===rows invariant fails; this test pins
      // the writer's family coverage directly.
      const lineageRow = (
        id: string,
        sourceAt: string,
        kind: 'operator' | 'episode' | 'life',
        verbatim: string,
        claim: string,
      ) => ({
        id,
        sourceAt,
        sourceEndAt: null,
        kind,
        verbatim,
        digest: claim,
        claim,
        recover: 'continuity_ledger action="fetch" owner="instance-a"',
        origin: kind === 'operator' ? 'declared' as const : undefined,
      });
      const value = model({
        activeEditDelta: exactDelta({ files: [exactDelta().files[0]] }),
        cognitiveArtifacts: model().cognitiveArtifacts,
        cognitiveArtifactCapture: { ...receipt, totalMatched: model().cognitiveArtifacts.length },
        operatorVault: { units: [lineageRow('vault:1', '2026-08-02T17:55:00.000Z', 'operator', 'operator vault note', 'operator: note')], rangeRecover: null },
        episodeChapterIndex: { units: [lineageRow('ep:1', '2026-08-02T17:54:00.000Z', 'episode', 'episode chapter', 'episode: chapter')], rangeRecover: null },
        lifeLedger: { units: [lineageRow('life:1', '2026-08-02T17:53:00.000Z', 'life', 'life ledger row', 'life: row')], rangeRecover: null },
      });
      const { collapse } = renderRebirthPackageV6WithReport(value, { packageBudget: 200_000 });
      const record = buildContinuityLedgerCaptureFromV6Render(value, collapse)!;
      const expectedIds = new Set([
        'edit-file:one',
        ...value.cognitiveArtifacts.map((entry) => entry.provenanceId),
        'vault:1',
        'ep:1',
        'life:1',
      ]);
      expect(record.units.map((unit) => unit.unitId).sort()).toEqual([...expectedIds].sort());
      expect(new Set(record.units.map((unit) => unit.sectionId)))
        .toEqual(new Set(['activeEditDelta', 'cognitiveArtifacts', 'operatorVault', 'episodeChapterIndex', 'lifeLedger']));
    });

    it('selects deterministically and preserves newest-first chronology with quarantine last', () => {
      const rows = [
        artifact({ provenanceId: 'z:old', kind: 'decision', text: 'oldest decision', sourceAt: '2026-08-02T17:01:00.000Z' }),
        artifact({ provenanceId: 'a:new', kind: 'decision', text: 'newest decision', sourceAt: '2026-08-02T17:09:00.000Z' }),
        artifact({ provenanceId: 'm:none', kind: 'decision', text: 'undated decision', sourceAt: null }),
      ];
      const first = cognition(model({ cognitiveArtifacts: rows, cognitiveArtifactCapture: receipt }));
      const second = cognition(model({ cognitiveArtifacts: [...rows].reverse(), cognitiveArtifactCapture: receipt }));

      expect(first).toBe(second);
      expect(first.indexOf('newest decision')).toBeLessThan(first.indexOf('oldest decision'));
      // Unknown source time never interleaves into the chronology (GOD RULE 8).
      expect(first.indexOf('oldest decision')).toBeLessThan(first.indexOf('undated decision'));
      expect(first).toContain('Unknown source time (quarantined; not part of the chronology):');
    });
  });

  it('renders the fixed six-section order and de-duplicates promoted dialogue', () => {
    const value = model();
    const sections = renderRebirthPackageV6Sections(value);
    // Lineage sections are admitted only when they carry units or a partial
    // reason, so a lineage-free model renders the original v6 six in order.
    expect(sections.map((section) => section.id)).toEqual(
      REBIRTH_PACKAGE_V6_SECTION_IDS.filter(
        (id) => id !== 'brainMergeSynthesis'
          && !(REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS as readonly string[]).includes(id),
      ),
    );

    const rendered = renderRebirthPackageV6(value);
    expect(rendered.match(/Implement the frozen v6 contract\./gu)).toHaveLength(1);
    expect(rendered.match(/I will implement it now\./gu)).toHaveLength(1);
    expect(rendered).toContain('Keep Atlas semantics stable.');
    for (let index = 1; index < sections.length; index += 1) {
      expect(rendered.indexOf(sections[index - 1].text))
        .toBeLessThan(rendered.indexOf(sections[index].text));
    }
  });

  it('suppresses an inapplicable fork-purpose row and renders remaining absent Now-card facts as unknowns', () => {
    const boundary = renderRebirthPackageV6Sections(model())
      .find((section) => section.id === 'boundaryAndActiveTask')?.text ?? '';
    const card = boundary.split('[FACTUAL NOW CARD · descriptive boundary facts]')[1]
      ?.split('[/FACTUAL NOW CARD]')[0] ?? '';

    expect(card).not.toContain('fork-purpose=');
    expect(card).toContain('parent-identity=unknown · checkpoint=unknown');
    expect(card).toContain('parent-status=unknown');
    expect(card).toContain('current-rail=unknown · state=unknown');
    expect(card).not.toMatch(/\b(?:should|must|recommend|safe-action|next-action)\b/iu);
  });

  it('renders a persisted v6 package that predates the lineage sections', () => {
    // isRebirthPackageV6Model deliberately accepts stored v6 packages that carry
    // no lineage keys at all. Rendering one is a continuity-recovery path, so an
    // absent lineage section must read as empty rather than throwing.
    const persisted = JSON.parse(JSON.stringify(model())) as Record<string, unknown>;
    for (const id of REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS) delete persisted[id];
    persisted.version = 'rebirth-package-v6/v1';
    expect(isRebirthPackageV6Model(persisted)).toBe(true);

    const legacy = persisted as unknown as RebirthPackageV6Model;
    const sections = renderRebirthPackageV6Sections(legacy);
    expect(sections.map((section) => section.id)).toEqual(
      REBIRTH_PACKAGE_V6_SECTION_IDS.filter(
        (id) => id !== 'brainMergeSynthesis'
          && !(REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS as readonly string[]).includes(id),
      ),
    );
    expect(renderRebirthPackageV6(legacy)).toContain('contract=rebirth-package-v6/v1');
  });

  it('rejects a malformed persisted Brain Merge section before rendering', () => {
    const persisted = JSON.parse(JSON.stringify(model())) as Record<string, unknown>;
    persisted.brainMergeSynthesis = 17;
    expect(isRebirthPackageV6Model(persisted)).toBe(false);
  });

  it('keeps a relocation receipt when every conversation row was promoted', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:user-1',
        sourceAt: '2026-08-02T17:58:00.000Z',
        role: 'user',
        text: 'Implement the frozen v6 contract.',
      }, {
        provenanceId: 'message:assistant-1',
        sourceAt: '2026-08-02T17:58:30.000Z',
        role: 'assistant',
        text: 'I will implement it now.',
      }],
    });
    expect(value.recentConversation).toHaveLength(0);

    const section = renderRebirthPackageV6Sections(value)
      .find((entry) => entry.id === 'recentConversation');
    expect(section?.text).toContain('Endpoint relocation receipt');
    expect(section?.text).toContain('rendered-as=EXACT ACTIVE REQUEST');
    expect(section?.text).toContain('rendered-as=LAST MATERIAL ASSISTANT');
    expect(section?.text).toContain('Additional recent-dialogue rows retained here: 0.');
    expect(section?.text).not.toContain('Implement the frozen v6 contract.');
    expect(section?.text).not.toContain('I will implement it now.');

    const rendered = renderRebirthPackageV6(value);
    expect(rendered.match(/Implement the frozen v6 contract\./gu)).toHaveLength(1);
    expect(rendered.match(/I will implement it now\./gu)).toHaveLength(1);
  });

  it('keeps non-promoted dialogue beside the endpoint relocation receipt', () => {
    const value = model();
    expect(value.recentConversation.map((row) => row.provenanceId))
      .toEqual(['message:user-older']);

    const section = renderRebirthPackageV6Sections(value)
      .find((entry) => entry.id === 'recentConversation');
    expect(section?.text).toContain('Endpoint relocation receipt');
    expect(section?.text).toContain('Additional recent-dialogue rows retained here: 1.');
    expect(section?.text).toContain('Keep Atlas semantics stable.');
  });

  it('keeps the endpoint relocation receipt when admitted dialogue consumes the section cap', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:user-1',
        sourceAt: '2026-08-02T17:58:00.000Z',
        role: 'user',
        text: 'Implement the frozen v6 contract.',
      }, {
        provenanceId: 'message:assistant-1',
        sourceAt: '2026-08-02T17:58:30.000Z',
        role: 'assistant',
        text: 'I will implement it now.',
      }, ...Array.from({ length: 8 }, (_, index) => ({
        provenanceId: `message:retained-${index}`,
        sourceAt: `2026-08-02T17:59:0${index}.000Z`,
        role: 'assistant' as const,
        text: `retained dialogue ${index} ${'x'.repeat(180)}`,
      }))],
    });

    const rendered = renderRebirthPackageV6(value, {
      packageBudget: 200_000,
      sectionMaxChars: { recentConversation: 700 },
    });
    const section = rendered.split('[REBIRTH-V6-SECTION id=recentConversation')[1]
      ?.split('[REBIRTH-V6-SECTION-END id=recentConversation]')[0] ?? '';

    expect(section).toContain('Endpoint relocation receipt');
    expect(rendered.match(/Implement the frozen v6 contract\./gu)).toHaveLength(1);
    expect(rendered.match(/I will implement it now\./gu)).toHaveLength(1);
  });

  it('de-duplicates promoted dialogue wrapped by the legacy transcript renderer', () => {
    const activeRequest = 'Finish the interrupted migration now.';
    const lastAssistant = 'role:assistant\ncontent:\nI am finishing the interrupted migration.';
    const value = adaptLegacyRebirthPackageToV6({
      lifecycleBoundary: 'same_instance_hard_epoch',
      triggeringUserMessage: activeRequest,
      lastUserAiMessages: `🤖 LAST AI MESSAGE:\n${lastAssistant}`,
      currentThread: [
        `[message 126] 👤 USER:\nrole:user\ncontent:\n[2026-08-02 21:59] ${activeRequest}`,
        `[message 127] 🤖 YOU:\n${lastAssistant}`,
        '[message 124] 👤 USER:\nrole:user\ncontent:\n[2026-08-02 21:57] Keep this older request.',
      ].join('\n\n'),
    });

    const rendered = renderRebirthPackageV6(value);
    expect(rendered.match(/Finish the interrupted migration now\./gu)).toHaveLength(1);
    expect(rendered.match(/I am finishing the interrupted migration\./gu)).toHaveLength(1);
    expect(rendered).toContain('Keep this older request.');
  });

  it('de-duplicates a promoted request wrapped only by the dialogue header envelope', () => {
    // Real raw-seed current-thread rows carry no inner role:/content: wrapper —
    // just `[message N] 👤 USER:` above the exact message bytes. Before this
    // case the provider received the live operator request twice.
    const activeRequest = 'Okay, finish on what needs finishing now.';
    const value = adaptLegacyRebirthPackageToV6({
      lifecycleBoundary: 'same_instance_hard_epoch',
      triggeringUserMessage: activeRequest,
      currentThread: [
        `[message 126] 👤 USER:\n${activeRequest}`,
        '[message 127] 🤖 YOU:\nWorking on it.',
        '[message 124] 👤 USER:\nKeep this older request.',
      ].join('\n\n'),
    });

    const rendered = renderRebirthPackageV6(value);
    expect(rendered.match(/Okay, finish on what needs finishing now\./gu)).toHaveLength(1);
    expect(rendered).toContain('Keep this older request.');
    expect(rendered).toContain('Working on it.');
  });

  it('keeps ordinary prose that merely precedes a blank line', () => {
    const value = adaptLegacyRebirthPackageToV6({
      lifecycleBoundary: 'continuation',
      triggeringUserMessage: 'Shared trailing sentence.',
      currentThread: 'Some heading:\nShared trailing sentence.',
    });
    // The row's header is not a dialogue envelope, so the row survives intact
    // alongside the promoted request rather than being erased by a loose match.
    expect(value.recentConversation).toHaveLength(1);
    expect(value.recentConversation[0].text).toContain('Some heading:');
  });

  it('never turns unavailable edit evidence into none', () => {
    const legacy = adaptLegacyRebirthPackageToV6({
      predecessorName: 'legacy',
      currentThread: '',
      activeEditDelta: '',
    });
    expect(legacy.activeEditDelta.state).toBe('unknown');
    expect(renderRebirthPackageV6(legacy)).toContain(
      'Active edit state is unknown; absence of evidence is not rendered as none.',
    );

    const none = model({
      activeEditDelta: exactDelta({
        state: 'none',
        files: [],
      }),
    });
    expect(renderRebirthPackageV6(none)).toContain(
      'Exact immutable capture proved zero open attributable diffs.',
    );
  });

  it('renders a legacy bounded edit log behind one declared banner instead of an unknown-field spray', () => {
    const editLog = '[06:51 PM UTC] Edit → relay/src/example.ts\n  ⊕ added line';
    const legacy = adaptLegacyRebirthPackageToV6({
      predecessorName: 'legacy',
      currentThread: '',
      activeEditDelta: editLog,
    });
    const section = renderRebirthPackageV6Sections(legacy)
      .find((candidate) => candidate.id === 'activeEditDelta');
    expect(section).toBeTruthy();
    expect(section!.text).toContain(
      'evidence=bounded edit log; immutable capture unavailable: legacy Active Edit Delta adapted without an immutable Atlas capture',
    );
    // The timestamped edit log is real evidence and survives untouched.
    expect(section!.text).toContain('[06:51 PM UTC] Edit → relay/src/example.ts');
    // The seven-way unknown-field spray is gone: one declared banner instead.
    expect(section!.text).not.toContain('(legacy bounded edit evidence)');
    expect(section!.text).not.toContain('baseline=baseline_unknown');
    expect(section!.text).not.toContain('+?/−?');
    expect(section!.text).not.toContain('preview partial:');
    expect(section!.text).not.toContain('capture=unknown');
  });

  it('compacts provenance ids that embed the artifact note so each note renders once', () => {
    const note = 'Continuity Ledger locked: one store, two write sides, two read sides; never conclude absence without checking the ledger index first.';
    const value = model({
      cognitiveArtifacts: [{
        provenanceId: `instance:inst-a/star:2026-08-02T17:59:40.000Z/decision/${note}`,
        sourceAt: '2026-08-02T17:59:40.000Z',
        kind: 'decision',
        text: note,
        authority: 'current',
        supersededBy: null,
      }, {
        provenanceId: 'decision:compact',
        sourceAt: '2026-08-02T17:59:41.000Z',
        kind: 'decision',
        text: 'Use one immutable model.',
        authority: 'current',
        supersededBy: null,
      }],
    });
    const section = renderRebirthPackageV6Sections(value)
      .find((candidate) => candidate.id === 'cognitiveArtifacts');
    expect(section).toBeTruthy();
    // The note body appears exactly once; the pointer keeps its resolving prefix.
    expect(section!.text.match(/Continuity Ledger locked:/gu)).toHaveLength(1);
    expect(section!.text).toContain('source=instance:inst-a/star:2026-08-02T17:59:40.000Z/decision/…');
    // Compact ids that embed nothing stay byte-identical.
    expect(section!.text).toContain('source=decision:compact');
  });

  it('compacts embedded-note ids even when the rendered text is a truncated head of the note', () => {
    const note = `Episodic recall blackout root cause synthesis: ${'detail '.repeat(40)}end of the long note body`;
    const value = model({
      cognitiveArtifacts: [{
        provenanceId: `instance:inst-a/star:2026-08-02T17:59:40.000Z/discovery/${note}`,
        sourceAt: '2026-08-02T17:59:40.000Z',
        kind: 'discovery',
        text: `${note.slice(0, 180)}…`,
        authority: 'current',
        supersededBy: null,
      }],
    });
    const section = renderRebirthPackageV6Sections(value)
      .find((candidate) => candidate.id === 'cognitiveArtifacts');
    expect(section).toBeTruthy();
    expect(section!.text).toContain('source=instance:inst-a/star:2026-08-02T17:59:40.000Z/discovery/…');
    // The untruncated tail of the note never re-enters through the pointer.
    expect(section!.text).not.toContain('end of the long note body');
  });

  it('renders timestamped cognition newest-first and backfills toward the global package cap', () => {
    const cognitiveArtifacts = Array.from({ length: 240 }, (_, index) => ({
      provenanceId: `cognition:${index}`,
      sourceAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      kind: 'result' as const,
      text: `artifact-${index} ${'durable cognition '.repeat(28)}`,
      authority: 'current' as const,
      supersededBy: null,
    }));
    const value = model({ cognitiveArtifacts });
    const section = renderRebirthPackageV6Sections(value)
      .find((candidate) => candidate.id === 'cognitiveArtifacts');
    const rendered = renderRebirthPackageV6(value);

    expect(section).toBeTruthy();
    expect(section!.text).toContain('artifact-239');
    expect(section!.text).not.toContain('artifact-0 ');
    expect(section!.text.length).toBeGreaterThan(60_000);
    expect(rendered.length).toBeGreaterThan(90_000);
    expect(rendered.length).toBeLessThanOrEqual(DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS);
  });

  it('publishes only executable recovery commands and marks bounded store recovery partial', () => {
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      capturedAt: '2026-08-02T18:00:00.000Z',
      captureSourceId: 'capture-1',
      instance: {
        instanceId: 'instance-a',
        instanceName: 'worker-a',
        runtimeStatus: 'working',
      },
      rail: {
        railId: 'rail-recovery',
        title: 'Recovery census',
        state: 'active',
        totalSteps: 4,
        updatedAt: '2026-08-02T17:59:00.000Z',
      },
      canonicalRange: {
        traceId: 'trace-a',
        eventCount: 12,
        lastEventId: 'event-12',
        lastEventTimestamp: '2026-08-02T17:59:30.000Z',
      },
      rawTailFrontier: {
        traceId: 'trace-a',
        unit: 'event',
        index: 12,
        id: 'event-12',
        exactCount: 3,
        sourceTimestamp: '2026-08-02T17:59:30.000Z',
      },
    });
    const value = adaptLegacyRebirthPackageToV6({
      predecessorName: 'worker-a',
      triggeringUserMessage: 'Recover the boundary.',
      continuityReceipt,
    }, {
      instanceId: 'instance-a',
      instanceName: 'worker-a',
      workspace: 'voxxo-swarm',
      activeEditDelta: exactDelta(),
    });
    const handles = new Map(value.recoveryIndex.map((entry) => [entry.id, entry]));

    expect(handles.get('transcript')?.handle)
      .toBe('tap_instance_messages action="canonical" target_instance_id="instance-a"');
    expect(handles.get('cognition')?.handle)
      .toBe('tap_star action="rolodex" instance="instance-a"');
    expect(handles.get('task-rail')?.handle)
      .toBe('task_rail mode="load" operation="detail" instance_id="instance-a"');
    expect(handles.get('atlas-edit-capture')?.handle)
      .toBe('atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"');
    expect(handles.get('atlas-edit-post-frontier')?.handle)
      .toBe('atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" include_post_frontier=true mode="unified"');
    expect(handles.get('rebirth-package')?.handle)
      .toBe('tap_instance_messages action="rebirth" target_instance_id="instance-a" search="capture-1"');
    expect(handles.get('context-warp-stores')).toMatchObject({
      status: 'partial',
      handle: 'fold_recall op="range" start_event=0',
    });
    expect(handles.get('transcript')).toMatchObject({ count: 12, frontier: 'event-12' });
    expect(handles.get('current-continuity-pov')).toMatchObject({ count: 3, frontier: 'event-12' });
    expect(handles.get('task-rail')).toMatchObject({ count: 4 });
    expect(handles.get('atlas-edit-capture')).toMatchObject({ count: 1 });
    expect(handles.get('rebirth-package')).toMatchObject({ count: 1, frontier: 'capture-1' });
    expect(handles.get('identity')).toMatchObject({ count: 1 });
  });

  it('adapts the canonical continuity receipt without stale field aliases', () => {
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      capturedAt: '2026-08-02T18:00:00.000Z',
      captureSourceId: 'capture-real',
      sourceStatus: 'working',
      instance: {
        instanceId: 'instance-a',
        instanceName: 'worker-a',
        runtimeStatus: 'working',
        parentInstanceId: 'instance-parent',
      },
      activeRequestText: 'Use the typed receipt as the only adapter contract.',
      activeRequestSourceId: 'message:user-real',
      activeRequestSourceTimestamp: '2026-08-02T17:59:50.000Z',
      rail: {
        railId: 'rail-real',
        title: 'Repair v6 continuity',
        state: 'review',
        updatedAt: '2026-08-02T17:59:40.000Z',
        activeStep: {
          id: 'step-real',
          title: 'Preserve receipt facts',
          status: 'needs_review',
          updatedAt: '2026-08-02T17:59:45.000Z',
          instruction: 'Run the canonical adapter regression.',
        },
        queuedStepTitle: 'Ship only after review',
      },
      claims: ['src/claim.ts'],
      editEvidenceFiles: ['src/edit.ts'],
      hasActiveEditDelta: true,
      validationFact: 'canonical adapter regression passed',
      hazards: ['receipt hazard survives'],
      canonicalRange: {
        traceId: 'instance-a',
        eventCount: 42,
        lastEventId: 'event-42',
        lastEventTimestamp: '2026-08-02T17:59:55.000Z',
      },
      rawTailFrontier: {
        traceId: 'instance-a',
        unit: 'event',
        id: 'event-42',
        exactCount: 0,
        sourceTimestamp: '2026-08-02T17:59:55.000Z',
      },
      extraDisagreements: ['typed disagreement survives'],
      chatroomMembership: '[CHATROOM MEMBERSHIP]\nfix-rebirth — worker-a\n[END CHATROOM MEMBERSHIP]',
      subscriptions: ['mention:worker-a'],
      subscriptionsKnown: true,
    });

    const value = adaptLegacyRebirthPackageToV6({ continuityReceipt });

    expect(value.boundaryAndActiveTask).toMatchObject({
      captureId: 'capture-real',
      sourceFrontier: 'event-42',
      instanceId: 'instance-a',
      instanceName: 'worker-a',
      predecessorInstanceId: 'instance-parent',
    });
    expect(value.boundaryAndActiveTask.activeRequest).toMatchObject({
      text: 'Use the typed receipt as the only adapter contract.',
      source: {
        provenanceId: 'message:user-real',
        sourceAt: '2026-08-02T17:59:50.000Z',
        status: 'exact',
      },
    });
    expect(value.executionState.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime', text: 'working' }),
      expect.objectContaining({ kind: 'next_action', text: 'Use the typed receipt as the only adapter contract.' }),
      expect.objectContaining({ kind: 'claim', text: 'src/claim.ts' }),
      expect.objectContaining({ kind: 'validation', text: 'canonical adapter regression passed' }),
      expect.objectContaining({ kind: 'blocker', text: 'receipt hazard survives' }),
      expect.objectContaining({ kind: 'review', text: 'needs_review' }),
      expect.objectContaining({ kind: 'coordination', text: 'room=fix-rebirth' }),
      expect.objectContaining({ kind: 'coordination', text: 'subscription=mention:worker-a' }),
    ]));
    expect(value.executionState.unknownReasons).toContain('typed disagreement survives');
    expect(value.activeEditDelta.files).toEqual([
      expect.objectContaining({ filePath: 'src/edit.ts', baselineQuality: 'baseline_unknown' }),
    ]);
  });

  it('adapts an unresolved assistant action ahead of an older rail action', () => {
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      capturedAt: '2026-08-02T18:00:00.000Z',
      captureSourceId: 'capture-pending',
      pendingAssistantAction: {
        status: 'unresolved',
        text: 'Check whether the QR code works before changing the brochure.',
        basis: 'assistant-commitment',
        source: {
          unit: 'message',
          index: 17,
          id: 'message:assistant-17',
          timestamp: '2026-08-02T17:59:55.000Z',
        },
      },
      rail: {
        railId: 'rail-older',
        title: 'Older brochure work',
        state: 'active',
        activeStep: {
          id: 'step-older',
          title: 'Resume layout edits',
          status: 'active',
          instruction: 'Resume the older brochure layout.',
        },
      },
    });

    const value = adaptLegacyRebirthPackageToV6({ continuityReceipt });

    expect(value.boundaryAndActiveTask.lastMaterialAssistant).toMatchObject({
      text: 'Check whether the QR code works before changing the brochure.',
      source: {
        provenanceId: 'message:assistant-17',
        sourceAt: '2026-08-02T17:59:55.000Z',
        status: 'exact',
      },
    });
    expect(value.executionState.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'pending_assistant_action',
        text: 'Check whether the QR code works before changing the brochure.',
      }),
    ]));
    expect(value.executionState.facts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'next_action', text: 'Resume the older brochure layout.' }),
    ]));
  });

  it('flags stale rail direction while sourcing a mirrored next_action from the active request', () => {
    // Lived fixture: a 17:11 rail row still commanding after the operator
    // pivoted at 17:18:50. The rail must carry the measured-order flag, while
    // next_action (which buildContinuityReceipt mirrors from activeRequestText)
    // must carry the operator row's own provenance and remain unflagged.
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      capturedAt: '2026-08-14T17:30:00.000Z',
      captureSourceId: 'capture-stale-rail',
      activeRequestText: 'its ok fold bug hunt is on it.',
      activeRequestSourceId: 'message:operator-pivot',
      activeRequestSourceTimestamp: '2026-08-14T17:18:50.158Z',
      pendingAssistantAction: {
        status: 'unresolved',
        text: 'Commit the diagnostics packet to the room.',
        basis: 'assistant-commitment',
        source: {
          unit: 'message',
          index: 11,
          id: 'message:assistant-11',
          timestamp: '2026-08-14T17:11:30.000Z',
        },
      },
      rail: {
        railId: 'rail-58fc5e71',
        title: 'Cog-artifacts packet',
        state: 'active',
        updatedAt: '2026-08-14T17:11:00.000Z',
        activeStep: {
          id: 'step-post-packet',
          title: 'Post the empty-artifacts packet',
          status: 'active',
          updatedAt: '2026-08-14T17:11:10.000Z',
          instruction: 'Post the packet and wait for ACK.',
        },
        queuedStepTitle: 'Await ACK before editing',
      },
    });

    const value = adaptLegacyRebirthPackageToV6({ continuityReceipt });
    const byKind = new Map(value.executionState.facts.map((fact) => [fact.kind, fact]));
    expect(byKind.get('rail')?.predatesActiveRequest).toBe(true);
    expect(byKind.get('next_action')).toMatchObject({
      text: 'its ok fold bug hunt is on it.',
      sourceAt: '2026-08-14T17:18:50.158Z',
      status: 'exact',
    });
    expect(byKind.get('next_action')?.provenanceId).toMatch(/^message:operator-pivot:/);
    expect(byKind.get('next_action')?.predatesActiveRequest).toBeUndefined();
    expect(byKind.get('pending_assistant_action')?.predatesActiveRequest).toBeUndefined();

    const rendered = renderRebirthPackageV6(value);
    expect(rendered).toMatch(/- rail · rail-58fc5e71[^\n]* · authority=predates-active-request/);
    expect(rendered).toMatch(/- next_action · its ok fold bug hunt is on it\. · source=message:operator-pivot:[^\n]* · source-time=2026-08-14T17:18:50.158Z · status=exact/);
    expect(rendered).not.toMatch(/- next_action ·[^\n]*authority=predates-active-request/);
    expect(rendered).not.toMatch(/- pending_assistant_action ·[^\n]*authority=predates-active-request/);

    // A receipt whose nextAction is genuinely rail-derived still keeps the
    // older step source and the measured staleness marker.
    const railDerived = adaptLegacyRebirthPackageToV6({
      continuityReceipt: {
        ...continuityReceipt,
        nextAction: 'Await ACK before editing',
      },
    });
    const railNextAction = railDerived.executionState.facts.find((fact) => fact.kind === 'next_action');
    expect(railNextAction).toMatchObject({
      text: 'Await ACK before editing',
      sourceAt: '2026-08-14T17:11:10.000Z',
      status: 'exact',
      predatesActiveRequest: true,
    });
    expect(railNextAction?.provenanceId).toMatch(/^rail-58fc5e71:step-post-packet:/);
  });

  it('never flags rail facts when the rail postdates the request or either time is unknown', () => {
    const postdating = adaptLegacyRebirthPackageToV6({
      continuityReceipt: buildContinuityReceipt({
        boundary: 'continuation',
        predecessorName: 'worker-a',
        capturedAt: '2026-08-14T18:00:00.000Z',
        captureSourceId: 'capture-current-rail',
        activeRequestText: 'load the rail, take care of the fold side.',
        activeRequestSourceId: 'message:operator-order',
        activeRequestSourceTimestamp: '2026-08-14T17:52:44.787Z',
        rail: {
          railId: 'rail-current',
          title: 'Fold-side slices',
          state: 'active',
          updatedAt: '2026-08-14T17:53:30.000Z',
          activeStep: {
            id: 'step-live',
            title: 'Slice 1 settlement',
            status: 'active',
            updatedAt: '2026-08-14T17:53:40.000Z',
            instruction: 'Implement operator-superseded settlement.',
          },
          queuedStepTitle: 'Slice 2 diagnosis slot',
        },
      }),
    });
    for (const fact of postdating.executionState.facts) {
      expect(fact.predatesActiveRequest).toBeUndefined();
    }
    expect(renderRebirthPackageV6(postdating)).not.toContain('authority=predates-active-request');

    // Unknown request time: a rail row with a known time must NOT be flagged
    // against a request whose time is unknown — no side of the comparison is
    // ever guessed (God Rule 8).
    const unknownRequestTime = adaptLegacyRebirthPackageToV6({
      continuityReceipt: buildContinuityReceipt({
        boundary: 'continuation',
        predecessorName: 'worker-a',
        capturedAt: '2026-08-14T18:00:00.000Z',
        captureSourceId: 'capture-unknown-request',
        activeRequestText: 'continue',
        rail: {
          railId: 'rail-known-time',
          title: 'Known-time rail',
          state: 'active',
          updatedAt: '2026-08-14T17:40:00.000Z',
        },
      }),
    });
    for (const fact of unknownRequestTime.executionState.facts) {
      expect(fact.predatesActiveRequest).toBeUndefined();
    }
    expect(renderRebirthPackageV6(unknownRequestTime)).not.toContain('authority=predates-active-request');
  });

  it('preserves the newest known conversation rows when the section budget overflows', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:older-oversized',
        sourceAt: '2026-08-02T17:50:00.000Z',
        role: 'user',
        text: `OVERSIZED_OLDER_TURN ${'x'.repeat(15_000)}`,
      }, {
        provenanceId: 'message:second-newest-retained',
        sourceAt: '2026-08-02T17:58:00.000Z',
        role: 'user',
        text: 'SECOND_NEWEST_TURN_MUST_SURVIVE',
      }, {
        provenanceId: 'message:newest-retained',
        sourceAt: '2026-08-02T17:59:59.000Z',
        role: 'assistant',
        text: 'NEWEST_TURN_MUST_SURVIVE',
      }, {
        provenanceId: 'message:unknown-oversized',
        sourceAt: null,
        role: 'runtime',
        text: `UNKNOWN_TIME_MUST_NOT_DISPLACE_RECENCY ${'y'.repeat(15_000)}`,
      }],
    });

    const section = renderRebirthPackageV6Sections(value, {
      sectionMaxChars: { recentConversation: 700 },
    }).find((entry) => entry.id === 'recentConversation');

    expect(section?.complete).toBe(false);
    expect(section?.text).toContain('Endpoint relocation receipt');
    expect(section?.text).toContain('SECOND_NEWEST_TURN_MUST_SURVIVE');
    expect(section?.text).toContain('NEWEST_TURN_MUST_SURVIVE');
    expect(section?.text).not.toContain('OVERSIZED_OLDER_TURN');
    expect(section?.text).not.toContain('UNKNOWN_TIME_MUST_NOT_DISPLACE_RECENCY');
    expect(section?.text).toContain('1 earlier known-time row omitted');
    expect(section?.text).toContain('1 unknown-time quarantine row omitted');
    expect(section?.text).toContain('source-time-range=2026-08-02T17:50:00.000Z..2026-08-02T17:50:00.000Z');
    expect(section?.text).toContain('retained-from=2026-08-02T17:58:00.000Z');
  });

  it('keeps newest known content ahead of omission metadata under a tiny section cap', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:older-tiny-cap',
        sourceAt: '2026-08-02T17:58:00.000Z',
        role: 'assistant',
        text: `OLDER_TINY_CAP ${'x'.repeat(200)}`,
      }, {
        provenanceId: 'message:newest-tiny-cap',
        sourceAt: '2026-08-02T17:59:59.000Z',
        role: 'user',
        text: `NEWEST_CANARY ${'y'.repeat(200)}`,
      }],
    });

    const section = renderRebirthPackageV6Sections(value, {
      sectionMaxChars: { recentConversation: 128 },
    }).find((entry) => entry.id === 'recentConversation');

    expect(section?.complete).toBe(false);
    expect(section?.text).toContain('Endpoint relocation receipt');
    expect(section?.text).toContain('NEWEST_CANARY');
    expect(section?.text).not.toContain('OLDER_TINY_CAP');
    expect(section?.text).toContain('latest-tail=omitted');
  });

  it('renders sensitive files without preview bytes or content recovery handles', () => {
    const canary = 'SUPER_SECRET_CANARY';
    const value = model({
      activeEditDelta: exactDelta({
        files: [{
          provenanceId: 'edit-file:secret',
          sourceAt: null,
          filePath: '.env.production',
          changeKind: 'modified',
          baselineQuality: 'withheld_sensitive',
          ownership: 'mine',
          state: 'withheld_sensitive',
          insertions: null,
          deletions: null,
          validationState: 'unknown',
          closureState: 'open',
          contributors: [],
          preview: {
            text: canary,
            complete: true,
            omittedHunks: 0,
            omittedLines: 0,
          },
          diffHandle: 'atlas-agent-diff://must-not-render',
          snapshotHandle: 'atlas-snapshot://must-not-render',
          reason: 'secret-bearing file',
        }],
      }),
    });
    const rendered = renderRebirthPackageV6(value);
    expect(rendered).toContain('.env.production');
    expect(rendered).toContain('sensitive content withheld');
    expect(rendered).not.toContain(canary);
    expect(rendered).not.toContain('must-not-render');
  });

  it('preserves Atlas-landed closure evidence in the Active Edit Delta contract', () => {
    const value = model({
      activeEditDelta: exactDelta({
        files: [{
          ...exactDelta().files[0],
          closureState: 'atlas_landed',
        }],
      }),
    });

    expect(renderRebirthPackageV6(value)).toContain('closure=atlas_landed');
  });

  it('reports every preview and package truncation honestly with recovery', () => {
    const value = model({
      activeEditDelta: exactDelta({
        truncated: true,
        omittedFiles: 3,
        files: [{
          ...exactDelta().files[0],
          preview: {
            text: '@@ visible hunk',
            complete: false,
            omittedHunks: 2,
            omittedLines: 19,
          },
        }],
      }),
    });
    const rendered = renderRebirthPackageV6(value, {
      sectionMaxChars: { cognitiveArtifacts: 80 },
      packageBudget: 2_500,
    });
    expect(rendered).toContain('omitted-hunks=2 omitted-lines=19 recover=atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"');
    expect(rendered).toContain('omitted-files=3');
    expect(rendered).toContain('REBIRTH-V6-PACKAGE-ELISION');
    expect(rendered).toContain('tap_instance_messages action="rebirth" target_instance_id="instance-a" search="capture-1"');
  });

  it('never elides the Brain Merge synthesis mandate under package pressure', () => {
    const value = model({
      brainMergeSynthesis: [
        'You absorbed Conference Plan (donor-conference-plan).',
        'Synthesize its exact donor cognition before continuing.',
      ].join('\n'),
    });
    const rendered = renderRebirthPackageV6(value, { packageBudget: 2_500 });
    expect(rendered).toContain('[REBIRTH-V6-SECTION id=brainMergeSynthesis');
    expect(rendered).toContain('Conference Plan (donor-conference-plan)');
  });

  it('filters superseded cognition and quarantines unknown-time rows', () => {
    const value = model({
      cognitiveArtifacts: [{
        provenanceId: 'superseded',
        sourceAt: '2026-08-02T17:00:00.000Z',
        kind: 'decision',
        text: 'Old decision',
        authority: 'historical',
        supersededBy: 'current',
      }, {
        provenanceId: 'current',
        sourceAt: '2026-08-02T18:00:00.000Z',
        kind: 'decision',
        text: 'Current decision',
        authority: 'current',
        supersededBy: null,
      }, {
        provenanceId: 'unknown-time',
        sourceAt: null,
        kind: 'hazard',
        text: 'Timestamp unavailable',
        authority: 'current',
        supersededBy: null,
      }, {
        provenanceId: 'flow-old-known',
        sourceAt: '2026-08-02T16:00:00.000Z',
        kind: 'flow',
        text: 'Older known-time flow',
        authority: 'flow',
        supersededBy: null,
      }, {
        provenanceId: 'flow-new-known',
        sourceAt: '2026-08-02T18:00:00.000Z',
        kind: 'flow',
        text: 'Newest live flow item',
        authority: 'flow',
        supersededBy: null,
      }, {
        provenanceId: 'flow-unknown',
        sourceAt: null,
        kind: 'flow',
        text: 'Unknown-time flow not claimed as newest',
        authority: 'flow',
        supersededBy: null,
      }],
    });
    const rendered = renderRebirthPackageV6(value);
    expect(rendered).not.toContain('Old decision');
    expect(rendered).toContain('Current decision');
    // Newest-known-source-time flow wins; an older known-time flow is dropped.
    expect(rendered).not.toContain('Older known-time flow');
    expect(rendered).toContain('Newest live flow item');
    // God Rule 8: unknown-time cognition is quarantined, never surfaced as the
    // "newest" flow — it appears only under the unknown-time banner.
    expect(rendered).toContain('Unknown-time flow not claimed as newest');
    expect(rendered).toContain('Unknown source time (quarantined; not part of the chronology)');
  });

  it('keeps every recovery route alive under its own section cap', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `route:${index}`,
      label: `recovery route ${index}`,
      handle: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
      status: 'available' as const,
      count: null,
      frontier: 'event-9',
    }));
    const value = model({
      recoveryIndex: [...many, {
        id: 'rebirth-package',
        label: 'captured package artifact',
        handle: 'tap_instance_messages action="rebirth" target_instance_id="instance-a" search="capture-1"',
        status: 'available',
        count: null,
        frontier: 'capture-1',
      }],
    });
    const rendered = renderRebirthPackageV6(value, {
      sectionMaxChars: { recoveryIndex: 90 },
    });
    // The protected Recovery Index section never truncates into "exact recovery
    // unavailable": overflow elides whole entries and points at an exact
    // recovery handle that carries the complete index. When the overflowing
    // entry itself has an exact handle, that exact handle is preserved (the
    // entry's own recovery route is the most on-point one to keep alive), even
    // though the `rebirth-package` artifact handle is not the first to elide.
    expect(rendered).not.toContain('exact recovery unavailable');
    expect(rendered).toContain('elided for budget; recover the complete index');
    expect(rendered).toContain('tap_instance_messages action="canonical" target_instance_id="instance-a"');
    // A partial section must not report itself complete to manifests/consumers.
    const sections = renderRebirthPackageV6Sections(value, {
      sectionMaxChars: { recoveryIndex: 90 },
    });
    const recoverySection = sections.find((section) => section.id === 'recoveryIndex');
    expect(recoverySection?.complete).toBe(false);
  });

  it('preserves the exact inline-evidence handle on elision with no rebirth-package handle', () => {
    // A retained/adapted model can carry an atlas-handoff-card entry (with a
    // captured card body + exact Atlas handle) while having NO rebirth-package
    // artifact handle. Under a tiny section cap the card body elides, but the
    // overflow fallback must preserve the entry's EXACT Atlas handle rather
    // than degrading to `unavailable` just because there is no package handle.
    const value = model({
      recoveryIndex: [{
        id: 'atlas-handoff-card',
        label: 'captured Atlas handoff card (inline body below)',
        handle: 'atlas_query action="history" workspace="/tmp/parity" author_instance_id="instance-a"',
        status: 'available',
        count: null,
        frontier: null,
        inlineEvidence: '## 🧭 Rebirth Atlas Cards\nConcepts: Atlas Steering Layer\nHazards: src/a.ts:L1 keep stable.',
      }, {
        id: 'transcript',
        label: 'transcript',
        handle: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
        status: 'available',
        count: null,
        frontier: 'event-9',
      }],
    });
    const sections = renderRebirthPackageV6Sections(value, {
      sectionMaxChars: { recoveryIndex: 80 },
    });
    const recoverySection = sections.find((section) => section.id === 'recoveryIndex');
    const rendered = recoverySection?.text ?? '';
    // The exact Atlas handle — not a generic "unavailable" — must survive the
    // elision, even with no rebirth-package entry in the index.
    expect(rendered).toContain('atlas_query action="history" workspace="/tmp/parity" author_instance_id="instance-a"');
    expect(rendered).not.toContain('exact recovery handle unavailable');
    expect(rendered).not.toContain('exact package artifact unavailable');
    // A partial section must not report itself complete.
    expect(recoverySection?.complete).toBe(false);
  });

  it('separates inherited, local, and shared-contributor edit evidence on a fresh fork', () => {
    const value = model({
      boundaryAndActiveTask: {
        ...model().boundaryAndActiveTask,
        lifecycle: 'fresh_fork',
        lifecycleMeaning: 'new instance identity; predecessor evidence is inherited',
      },
      activeEditDelta: exactDelta({
        inheritedCaptureIds: ['atlas-edit-capture:v1:parent'],
        files: [{
          ...exactDelta().files[0],
          provenanceId: 'edit-file:predecessor',
          filePath: 'shared/module.ts',
          ownership: 'inherited',
          changeKind: 'modified',
          contributors: [{
            provenanceId: 'contributor:predecessor',
            instanceId: 'instance-parent',
            relation: 'owner',
            sourceAt: '2026-08-02T10:00:00.000Z',
          }, {
            provenanceId: 'contributor:post-frontier',
            instanceId: 'instance-a',
            relation: 'later_contributor',
            sourceAt: '2026-08-02T18:05:00.000Z',
          }],
        }, {
          ...exactDelta().files[0],
          provenanceId: 'edit-file:local',
          sourceAt: '2026-08-02T18:02:00.000Z',
          filePath: 'src/local.ts',
          ownership: 'mine',
          contributors: [{
            provenanceId: 'contributor:local',
            instanceId: 'instance-a',
            relation: 'owner',
            sourceAt: '2026-08-02T18:02:00.000Z',
          }],
        }],
      }),
      recoveryIndex: [{
        id: 'atlas-edit-post-frontier',
        label: 'explicit edits observed after the immutable capture frontier',
        handle: 'atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" include_post_frontier=true mode="unified"',
        status: 'available',
        count: 1,
        frontier: 'atlas-edit-capture:v1:abc',
      }],
    });
    const rendered = renderRebirthPackageV6(value);
    // Fresh-fork lifecycle: inherited evidence is carried from the predecessor.
    expect(rendered).toContain('fresh_fork · new instance identity; predecessor evidence is inherited');
    expect(rendered).toContain('inherited-captures=atlas-edit-capture:v1:parent');
    // Inherited ownership is labeled; shared contributors render a chronology
    // with the later contributor distinct from the inherited owner.
    expect(rendered).toContain('shared/module.ts · inherited · baseline=exact');
    expect(rendered).toContain('instance-parent:owner@2026-08-02T10:00:00.000Z; instance-a:later_contributor@2026-08-02T18:05:00.000Z');
    // Local (post-frontier fork) edits are separated, owned by the new instance.
    expect(rendered).toContain('src/local.ts · mine · baseline=exact');
    expect(rendered).toContain('instance-a:owner@2026-08-02T18:02:00.000Z');
    // The post-frontier recovery route is advertised for edits made after the
    // immutable capture frontier.
    expect(rendered).toContain('atlas-edit-post-frontier');
  });

  it('renders shared contributors with an explicit unknown-time quarantine', () => {
    const value = model({
      activeEditDelta: exactDelta({
        files: [{
          ...exactDelta().files[0],
          provenanceId: 'edit-file:shared',
          filePath: 'src/shared.ts',
          ownership: 'shared',
          contributors: [{
            provenanceId: 'contributor:known',
            instanceId: 'instance-a',
            relation: 'owner',
            sourceAt: '2026-08-02T17:59:00.000Z',
          }, {
            provenanceId: 'contributor:unknown-time',
            instanceId: 'instance-b',
            relation: 'later_contributor',
            sourceAt: null,
          }],
        }],
      }),
    });
    const rendered = renderRebirthPackageV6(value);
    expect(rendered).toContain('src/shared.ts · shared · baseline=exact');
    expect(rendered).toContain('instance-a:owner@2026-08-02T17:59:00.000Z');
    // Unknown-time contributor is quarantined, never merged into the chronology.
    expect(rendered).toContain('unknown-time-quarantine=[instance-b:later_contributor:contributor:unknown-time]');
  });

  it('keeps one model stable across repeated tail-epoch and hard-epoch renders', () => {
    const value = model({
      boundaryAndActiveTask: {
        ...model().boundaryAndActiveTask,
        lifecycle: 'same_instance_hard_epoch',
        lifecycleMeaning: 'same instance identity; provider context reset',
      },
    });
    const baseline = renderRebirthPackageV6(value);
    let rendered = baseline;
    for (let epoch = 0; epoch < 15; epoch += 1) rendered = renderRebirthPackageV6(value);
    expect(rendered).toBe(baseline);
    expect(rendered).toContain('src/example.ts');
    expect(rendered).toContain('same_instance_hard_epoch');
  });

  it('uses the six-section contract for the host-unavailable hard-epoch fallback', () => {
    const rendered = buildRawHardEpochSeed([{
      role: 'user',
      content: 'Keep the Atlas snapshot semantics stable.',
      sourceIdentity: 'message:user-older',
      tsMs: Date.parse('2026-08-02T17:57:00.000Z'),
    }, {
      role: 'assistant',
      content: 'The baseline capture remains immutable.',
      sourceIdentity: 'message:assistant-1',
      tsMs: Date.parse('2026-08-02T17:58:30.000Z'),
    }, {
      role: 'user',
      content: 'Finish the canonical hard-epoch fallback.',
      sourceIdentity: 'message:user-active',
      tsMs: Date.parse('2026-08-02T18:00:00.000Z'),
    }], {
      predecessorName: 'worker-a',
      capturedAt: '2026-08-02T18:00:01.000Z',
    });

    const titles = [
      'Boundary and Active Task',
      'Execution State',
      'Active Edit Delta',
      'Cognitive Artifacts',
      'Recent Conversation',
      'Recovery Index',
    ];
    for (let index = 1; index < titles.length; index += 1) {
      expect(rendered.indexOf(`── ${titles[index - 1]} ──`))
        .toBeLessThan(rendered.indexOf(`── ${titles[index]} ──`));
    }
    // The raw hard-epoch v6 path must carry the same protected boundary
    // envelope the relay rich formatters emit: exactly one [CONTEXT REBIRTH]
    // lifecycle header with the silent directive, plus the chronological
    // provenance clock block, above the six framed sections.
    expect(rendered.match(/\[CONTEXT REBIRTH\]/gu)).toHaveLength(1);
    expect(rendered).toContain('Lifecycle boundary: same_instance_hard_epoch');
    expect(rendered).toContain('Continue silently; do not produce wake-up commentary.');
    expect(rendered).toContain('[Chronological Provenance v1]');
    expect(rendered).toContain('lifecycle=same_instance_hard_epoch');
    expect(rendered.match(/Finish the canonical hard-epoch fallback\./gu)).toHaveLength(1);
    expect(rendered).toContain('Active edit state is unknown; absence of evidence is not rendered as none.');
    expect(rendered).not.toContain('Coordinate Closet');
  });

  it('maps v6 into retained context-package keys without changing profile IDs', () => {
    const legacy = adaptRebirthPackageV6SectionsToLegacyKeys(model());
    expect(Object.keys(legacy).sort()).toEqual([
      'activeEditDelta',
      'atlasCrossRef',
      'currentThread',
      'lastUserAiMessages',
      'starredMoments',
      'taskRailContext',
    ]);
    expect(legacy.lastUserAiMessages).toContain('Boundary and Active Task');
    expect(legacy.activeEditDelta).toContain('Active Edit Delta');
    expect(legacy.atlasCrossRef).toContain('Recovery Index');
  });
});
