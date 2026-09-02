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
  it('labels the package capture as an artifact without changing its provenance id', () => {
    const boundary = renderRebirthPackageV6Sections(model())
      .find((section) => section.id === 'boundaryAndActiveTask')?.text ?? '';

    expect(boundary).toContain('capture-artifact=capture-1');
    expect(boundary).not.toContain('\ncapture=capture-1');
  });

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
      expect(contended).toContain('projected{rendered-truncated:1}');
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
      expect(text).toMatch(/cognition: rendered=\d+ captured=4 matched=6 · incomplete-rows=\d+ \(=suppressed-whole \+ rendered-truncated\) · suppressed\{/u);
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
        kind: index === 0 ? 'question' : index === 7 ? 'flow' : 'decision',
        text: index === 0 || index === 7 ? 'P'.repeat(1_200) : String(index).repeat(260),
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
      const declared = text.match(/cognition: rendered=\d+ captured=8 matched=8 · incomplete-rows=(\d+) \(=suppressed-whole \+ rendered-truncated\)/u);
      expect(declared).not.toBeNull();
      expect(omitted).toHaveLength(Number(declared![1]));
      const suppressedWhole = record.units.filter((unit) => (
        unit.sectionId === 'cognitiveArtifacts' && unit.placement !== 'rendered'
      ));
      const renderedTruncated = record.units.filter((unit) => (
        unit.sectionId === 'cognitiveArtifacts'
        && unit.placement === 'rendered'
        && unit.projection?.mode === 'truncated'
      ));
      expect(suppressedWhole.some((unit) => unit.projection?.mode === 'truncated')).toBe(true);
      expect(text).toContain(`projected{rendered-truncated:${renderedTruncated.length}}`);
      expect(Number(declared![1])).toBe(suppressedWhole.length + renderedTruncated.length);
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

    it('keeps every cognitive unit addressable when the normal body yields to a framed receipt', () => {
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
      expect(text).toContain('[REBIRTH-V6-SECTION id=cognitiveArtifacts');
      expect(text).toContain('[EVICTED section=cognitiveArtifacts units=3');
      expect(text).toContain(
        'recover=continuity_ledger action="fetch" owner="instance-a" capture_id="capture-1"'
        + ' section_id="cognitiveArtifacts" omitted_only=true include_unknown_source_time=true limit=200]',
      );
    });

    it('re-admits cognition at the largest fitting cap when residual capacity survives the protected sections', () => {
      // Specimen #38 shape: the package is over budget at cognition's current
      // cap but carries tens of thousands of chars of unused residual capacity.
      // The inclusion loop must retry at a reduced whole-unit cap instead of
      // eliding the only cognitive carry-over wholesale.
      const rows = Array.from({ length: 60 }, (_, index) => {
        const newest = index === 59;
        return artifact({
          provenanceId: `cog:${index}`,
          kind: newest ? 'question' : 'decision',
          text: newest ? 'NEWEST-KEPT-ROW-BODY' : `body-${index}-${'C'.repeat(1_000)}`,
          sourceAt: `2026-08-02T17:${String(index).padStart(2, '0')}:00.000Z`,
        });
      });
      const value = model({
        cognitiveArtifacts: rows,
        cognitiveArtifactCapture: { ...receipt, totalMatched: rows.length },
      });
      const budget = 40_000;
      const { text, collapse } = renderRebirthPackageV6WithReport(value, { packageBudget: budget });
      const record = buildContinuityLedgerCaptureFromV6Render(value, collapse)!;
      const cognitive = record.units.filter((unit) => unit.sectionId === 'cognitiveArtifacts');
      const renderedIds = cognitive.filter((unit) => unit.placement === 'rendered').map((unit) => unit.unitId);

      expect(text.length).toBeLessThanOrEqual(budget);
      expect(text).toContain('[REBIRTH-V6-SECTION id=cognitiveArtifacts');
      expect(text).not.toContain('[EVICTED section=cognitiveArtifacts');
      expect(text).toContain('NEWEST-KEPT-ROW-BODY');
      expect(collapse.omittedSectionIds).not.toContain('cognitiveArtifacts');
      // The retry genuinely reduced the cap: some units survived, some did not.
      expect(renderedIds.length).toBeGreaterThan(0);
      expect(renderedIds.length).toBeLessThan(rows.length);
      // Every source row stays addressable through the resized render.
      expect(cognitive).toHaveLength(rows.length);
      expect(cognitive.every((unit) => unit.placement === 'rendered' || unit.placement === 'elided')).toBe(true);
      // Report placements derive from the resized section set, not the full-cap render.
      const report = collapse.omissionSections.find((entry) => entry.sectionId === 'cognitiveArtifacts');
      expect(report?.sectionElided).toBe(false);
      expect((report?.placements ?? []).filter((placement) => placement.placement === 'rendered'))
        .toHaveLength(renderedIds.length);
    });

    it('keeps the cognitive section frame when no single cognitive unit fits', () => {
      const rows = Array.from({ length: 8 }, (_, index) => artifact({
        provenanceId: `unfittable:${index}`,
        kind: 'decision',
        text: `${'D'.repeat(1_200)}-${index}`,
        // Audit-2 A22: recent (<=24h) result/hazard/decision rows store up to
        // 900 chars. So these whole-unit admission fixtures use rows older
        // than the 24h recency window to keep the 600-char per-entry cap the
        // budget arithmetic below was written against.
        sourceAt: `2026-07-15T17:${String(index).padStart(2, '0')}:00.000Z`,
      }));
      const value = model({
        cognitiveArtifacts: rows,
        cognitiveArtifactCapture: { ...receipt, totalMatched: rows.length },
      });
      // Residual capacity below one whole-unit entry (per-entry projection
      // ≈600 chars + header/tail overhead) must NOT admit projected slivers as
      // content. Under the dynamic water-fill renderer the section ships WHOLE
      // bodies while the envelope has room (demand-first), so the honest
      // contract under a tight package budget is: never exceed the budget,
      // every shipped row is a whole (un-projected) unit or a declared
      // projection, and every source row stays ledger-addressable. When not a
      // single whole unit can be admitted the section yields to an explicit
      // eviction envelope (covered deterministically by the budget-1 fixture).
      const budget = 10_800;
      const { text, collapse } = renderRebirthPackageV6WithReport(value, { packageBudget: budget });
      const record = buildContinuityLedgerCaptureFromV6Render(value, collapse)!;
      const cognitive = record.units.filter((unit) => unit.sectionId === 'cognitiveArtifacts');

      expect(text.length).toBeLessThanOrEqual(budget);
      expect(text).toContain('[REBIRTH-V6-SECTION id=cognitiveArtifacts');
      // Either the whole demand fit (complete) or the section evicted/routed
      // with an explicit frame — never a mid-render sliver that reads as full
      // content.
      const cognitiveRendered = cognitive.filter((u) => u.placement === 'rendered');
      if (collapse.omittedSectionIds.includes('cognitiveArtifacts')) {
        expect(text).toContain('[EVICTED section=cognitiveArtifacts');
        expect(cognitiveRendered).toHaveLength(0);
      } else {
        // Every kept ledger unit was rendered whole (the reduced-cap path never
        // counts a projected sliver as content); what was dropped stayed out of
        // the ledger rather than reading as a kept whole unit.
        expect(cognitive.every((unit) => unit.placement === 'rendered')).toBe(true);
      }
    });

    it('re-admits conversation at a reduced cap instead of evicting every dialogue row', () => {
      const rows = Array.from({ length: 30 }, (_, index) => ({
        provenanceId: `message:extra-${index}`,
        sourceAt: `2026-08-02T17:${String(index).padStart(2, '0')}:00.000Z`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        text: `dialogue-${index}-${'V'.repeat(400)}`,
      }));
      const value = model({
        recentConversation: [...model().recentConversation, ...rows],
      });
      const budget = 20_000;
      const { text, collapse } = renderRebirthPackageV6WithReport(value, { packageBudget: budget });

      expect(text.length).toBeLessThanOrEqual(budget);
      expect(text).toContain('[REBIRTH-V6-SECTION id=recentConversation');
      expect(text).not.toContain('[EVICTED section=recentConversation');
      expect(collapse.omittedSectionIds).not.toContain('recentConversation');
      expect(text).toContain('dialogue-29-');
    });

    it('never exceeds an explicit caller cap even when the reduced-cap retry fires', () => {
      const rows = Array.from({ length: 60 }, (_, index) => artifact({
        provenanceId: `explicit-cap:${index}`,
        kind: 'decision',
        text: `body-${index}-${'E'.repeat(1_000)}`,
        // Outside the A22 24h recency window so these 1,000-char bodies keep
        // the 600-char per-entry cap this cap-budget test was sized against.
        sourceAt: `2026-07-15T17:${String(index).padStart(2, '0')}:00.000Z`,
      }));
      const value = model({
        cognitiveArtifacts: rows,
        cognitiveArtifactCapture: { ...receipt, totalMatched: rows.length },
      });
      const explicitCap = 30_000;
      const budget = 40_000;
      const { text } = renderRebirthPackageV6WithReport(value, {
        packageBudget: budget,
        sectionMaxChars: { cognitiveArtifacts: explicitCap },
      });
      // `dir=` (audit-2 A27) may or may not follow `order=N` on the frame.
      const sectionMatch = text.match(/\[REBIRTH-V6-SECTION id=cognitiveArtifacts order=5[^\]]*chars=(\d+)\]/);
      expect(sectionMatch).not.toBeNull();
      expect(Number(sectionMatch![1])).toBeLessThanOrEqual(explicitCap);
      expect(text.length).toBeLessThanOrEqual(budget);
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

  it('renders known rail absence as none and failed capture as reasoned unavailable', () => {
    const base = model();
    const source = { provenanceId: 'capture-1:task-rail-capture', sourceAt: null, status: 'partial' as const };
    const renderWith = (status: 'none' | 'unavailable', reason: string | null) => (
      renderRebirthPackageV6Sections(model({
        boundaryAndActiveTask: {
          ...base.boundaryAndActiveTask,
          nowCard: {
            forkPurpose: null,
            parentIdentity: null,
            parentStatus: null,
            currentRail: null,
            currentRailAvailability: { status, reason, source },
          },
        },
      })).find((section) => section.id === 'boundaryAndActiveTask')?.text ?? ''
    );

    const none = renderWith('none', null);
    expect(none).toContain('current-rail=none · state=n/a · active-step=n/a · step-status=n/a');
    expect(none).not.toContain('capture-degraded=task-rail');

    const unavailable = renderWith('unavailable', 'read-failed:EIO');
    expect(unavailable).toContain('capture-degraded=task-rail');
    expect(unavailable).toContain('current-rail=unavailable:read-failed:EIO');
    expect(unavailable).not.toContain('current-rail=unknown');
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
    expect(renderRebirthPackageV6(legacy)).toContain(
      'schema=rebirth-package-v6/v1 · render=v6-sections · capture-naming=v2',
    );
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

  it('coalesces a glyph-only base row into its same-message segment continuation', () => {
    // D5 + audit-2 A1: a streaming provider can emit the leading register glyph
    // as its own pre-tool block; persistence mints `id:segment-N` for the
    // post-tool text of the SAME message. A1 generalizes the D5 glyph-only merge
    // to every same-message fragment regardless of glyph-ness, so the base and
    // its continuation fuse into ONE envelope whose text is the exact delta
    // join (no fabricated newline). The renderer adds visible `⟨segment-N⟩`
    // seam markers without touching the attested body.
    const value = model({
      recentConversation: [{
        provenanceId: 'message:assistant-5',
        sourceAt: '2026-08-02T17:59:00.000Z',
        role: 'assistant',
        text: '🔍',
      }, {
        provenanceId: 'message:assistant-5:segment-1',
        sourceAt: '2026-08-02T17:59:00.000Z',
        role: 'assistant',
        text: 'Full connective map almost complete.',
      }],
    });
    expect(value.recentConversation.map((row) => row.provenanceId))
      .toEqual(['message:assistant-5']);
    const merged = value.recentConversation
      .find((row) => row.provenanceId === 'message:assistant-5');
    expect(merged?.text).toBe('🔍Full connective map almost complete.');
    expect(merged?.segmentOffsets).toEqual([2]); // seam after '🔍' (U+1F50D = 2 UTF-16 units)
    expect(merged?.sourceAt).toBe('2026-08-02T17:59:00.000Z');

    const section = renderRebirthPackageV6Sections(value)
      .find((entry) => entry.id === 'recentConversation');
    expect(section?.text.match(/source=message:assistant-5/gu)).toHaveLength(1);
    // The base-id envelope is a single message (`source=message:assistant-5`,
    // never `source=message:assistant-5:segment-1`). The fragment suffix only
    // survives inside the seam/count tokens.
    expect(section?.text).not.toContain('source=message:assistant-5:segment-1');
    expect(section?.text).toContain('segments=2'); // base + one continuation
    expect(section?.text).toContain('⟨segment-1⟩'); // visible seam marker
  });

  it('coalesces a trailing glyph-only segment into its substantive base row', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:assistant-6',
        sourceAt: '2026-08-02T17:59:10.000Z',
        role: 'assistant',
        text: 'Narration with words.',
      }, {
        provenanceId: 'message:assistant-6:segment-1',
        sourceAt: '2026-08-02T17:59:10.000Z',
        role: 'assistant',
        text: '🏁',
      }],
    });
    expect(value.recentConversation.map((row) => row.provenanceId))
      .toEqual(['message:assistant-6']);
    expect(value.recentConversation
      .find((row) => row.provenanceId === 'message:assistant-6')?.text)
      .toBe('Narration with words.🏁');
    expect(value.recentConversation
      .find((row) => row.provenanceId === 'message:assistant-6')?.segmentOffsets)
      .toEqual([21]); // seam between 'Narration with words.' (21 chars) and '🏁'
  });

  it('coalesces two substantive segments of one message into one envelope with seam markers', () => {
    // audit-2 A1: the OLD D5 rule kept two substantive fragments of one message
    // as separate envelopes (visible evidence of the tool boundary). A1
    // overrides that: two same-message segments are the SAME message rendered
    // once, so they fuse and the collocation record survives as `⟨segment-1⟩`.
    const value = model({
      recentConversation: [{
        provenanceId: 'message:assistant-7',
        sourceAt: '2026-08-02T17:59:20.000Z',
        role: 'assistant',
        text: 'First half of the answer.',
      }, {
        provenanceId: 'message:assistant-7:segment-1',
        sourceAt: '2026-08-02T17:59:20.000Z',
        role: 'assistant',
        text: 'Second half after the tool call.',
      }],
    });
    expect(value.recentConversation.map((row) => row.provenanceId))
      .toEqual(['message:assistant-7']);
    const merged = value.recentConversation.find((row) => row.provenanceId === 'message:assistant-7');
    expect(merged?.text).toBe('First half of the answer.Second half after the tool call.');
    expect(merged?.segmentOffsets).toEqual([25]); // 'First half of the answer.' is 25 chars
  });

  it('does not merge segment fragments across an interleaved newer row', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:assistant-8',
        sourceAt: '2026-08-02T17:59:30.000Z',
        role: 'assistant',
        text: '🔍',
      }, {
        provenanceId: 'message:user-8',
        sourceAt: '2026-08-02T17:59:31.000Z',
        role: 'user',
        text: 'Interleaved question.',
      }, {
        provenanceId: 'message:assistant-8:segment-1',
        sourceAt: '2026-08-02T17:59:32.000Z',
        role: 'assistant',
        text: 'Post-tool body.',
      }],
    });
    // Chronological sort places the user row between the two fragments, so
    // they are not adjacent and keep their own envelopes.
    expect(value.recentConversation.map((row) => row.provenanceId))
      .toEqual([
        'message:assistant-8',
        'message:user-8',
        'message:assistant-8:segment-1',
      ]);
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

    expect(section).toContain('endpoint rows: rendered in Boundary (active request + last assistant)');
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
      'evidence=bounded edit log; immutable capture not-requested: legacy Active Edit Delta adapted without an immutable Atlas capture',
    );
    // The timestamped edit log is real evidence and survives untouched.
    expect(section!.text).toContain('[06:51 PM UTC] Edit → relay/src/example.ts');
    // The seven-way unknown-field spray is gone: one declared banner instead.
    expect(section!.text).not.toContain('(legacy bounded edit evidence)');
    expect(section!.text).not.toContain('baseline=baseline_unknown');
    expect(section!.text).not.toContain('+?/−?');
    expect(section!.text).not.toContain('preview partial:');
    expect(section!.text).not.toContain('capture=unknown');
    expect(section!.text).not.toContain('capture-artifact=unknown');
  });

  it('keeps the newest legacy edit tail and points truncated history at Atlas', () => {
    const editLog = [
      '[2026-08-27 08:00 PM UTC] Edit → relay/src/stale-edit.ts',
      `OLD_EDIT_BODY ${'x'.repeat(900)}`,
      '[2026-08-28 06:30 AM UTC] Edit → relay/src/newest-edit.ts',
      'NEWEST_OPERATIONAL_EDIT',
    ].join('\n');
    const legacy = adaptLegacyRebirthPackageToV6({
      predecessorName: 'legacy',
      currentThread: '',
      activeEditDelta: editLog,
    }, {
      instanceId: 'instance-a',
      workspace: 'voxxo-swarm',
    });
    const section = renderRebirthPackageV6Sections(legacy, {
      sectionMaxChars: { activeEditDelta: 520 },
    }).find((candidate) => candidate.id === 'activeEditDelta');
    const banner = 'evidence=bounded edit log; immutable capture not-requested: legacy Active Edit Delta adapted without an immutable Atlas capture';

    expect(section?.text).toContain(banner);
    expect(section?.text).toContain('NEWEST_OPERATIONAL_EDIT');
    expect(section?.text).not.toContain('OLD_EDIT_BODY');
    // S11 + audit-2 A3: the entry-aware cut renders the FULL honest omission
    // (`omitted-prefix` chars/entries reported relative to the whole text, not
    // only the alignment window), and the retained tail starts at a clean entry
    // header.
    expect(section?.text).toContain('older prefix omitted');
    expect(section?.text).toMatch(/omitted-prefix=\d+ \(\d+ entries\)/u);
    expect(section?.text).toMatch(/alignment-sacrifice=\d+\/\d+/u);
    expect(section?.text).toContain('kept newest');
    expect(section?.text).toContain(
      'recovery=authoritative-history atlas_query action="history" workspace="voxxo-swarm" author_instance_id="instance-a"',
    );
    expect(section?.text).toContain('byte-exact event replay=unavailable');
    expect(section?.text).not.toContain('exact recovery unavailable');

    const newestTinyCap = banner.length + 2;
    const newestTiny = renderRebirthPackageV6Sections(legacy, {
      sectionMaxChars: { activeEditDelta: newestTinyCap },
    }).find((candidate) => candidate.id === 'activeEditDelta');
    expect(newestTiny?.text).toContain(`chars=${newestTinyCap}]`);
    expect(newestTiny?.text).toContain(`${banner}\n…\n[/REBIRTH-V6-SECTION]`);

    const bannerTiny = renderRebirthPackageV6Sections(legacy, {
      sectionMaxChars: { activeEditDelta: 8 },
    }).find((candidate) => candidate.id === 'activeEditDelta');
    expect(bannerTiny?.text).toContain('chars=8]');
    expect(bannerTiny?.text).toContain(`${banner.slice(0, 7)}…\n[/REBIRTH-V6-SECTION]`);
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
      .toBe('psychic_pov view="rolodex" instance="instance-a"');
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
      handle: 'tap_instance_messages action="recent" target_instance_id="instance-a"',
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

  it('labels a fully resolved rail as awaiting closeout, never an open review demand', () => {
    // task-rail lifecycle: state 'review' ⟺ every step resolved, one refresh
    // from 'complete'. Only a needs_review STEP (rail forced to 'blocked') is
    // an open demand.
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      sourceStatus: 'idle',
      instance: { instanceId: 'instance-a', instanceName: 'worker-a', runtimeStatus: 'idle' },
      rail: {
        railId: 'rail-resolved',
        title: 'Resolved rail',
        state: 'review',
        updatedAt: '2026-08-02T18:00:00.000Z',
      },
    });
    const value = adaptLegacyRebirthPackageToV6({ continuityReceipt });
    expect(value.executionState.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review', text: 'all-resolved-awaiting-closeout' }),
    ]));
    expect(value.executionState.facts.some((fact) => fact.text === 'needs_review')).toBe(false);
  });

  it('labels an ordinary active rail as review state none, no demand text', () => {
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      rail: {
        railId: 'rail-active',
        title: 'Active rail',
        state: 'active',
        updatedAt: '2026-08-02T18:00:00.000Z',
        activeStep: { id: 'step-1', title: 'Work', status: 'active' },
      },
    });
    const value = adaptLegacyRebirthPackageToV6({ continuityReceipt });
    expect(value.executionState.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review', text: 'none' }),
    ]));
    expect(value.executionState.facts.some(
      (fact) => fact.kind === 'review' && fact.text !== 'none',
    )).toBe(false);
  });

  it('rejects the membership scope/source-time footnote as a coordination room row', () => {
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      chatroomMembership: '[CHATROOM MEMBERSHIP]\n  scope=current room membership only; source-time reflects latest known join, not room activity\n  fix-rebirth — worker-a\n[END CHATROOM MEMBERSHIP]',
    });
    const value = adaptLegacyRebirthPackageToV6({ continuityReceipt });
    expect(value.executionState.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'coordination', text: 'room=fix-rebirth' }),
    ]));
    expect(value.executionState.facts.some((fact) => fact.text.includes('scope='))).toBe(false);
  });

  it('admits an anchored label-less outcome only from the trusted rail channel', () => {
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      validationSources: [
        { text: 'validation: 189 focused tests passed', sourceId: 'rail:old/step:s6', sourceTimestamp: '2026-08-27T02:32:26.983Z' },
        { text: 'Fresh green at exact working tree + class sweep clean', sourceId: 'rail:new/step:b4', sourceTimestamp: '2026-08-28T17:06:28.638Z', trustedOutcomeChannel: true },
      ],
    });
    expect(receipt.validation.fact)
      .toBe('Fresh green at exact working tree + class sweep clean');
    expect(receipt.liveState?.validation.source.id).toBe('rail:new/step:b4');
  });

  it('keeps the strict label gate for prose and rejects modal futures on the trusted channel', () => {
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      validationSources: [
        { text: 'validation: 189 focused tests passed', sourceTimestamp: '2026-08-27T02:32:26.983Z' },
        // Label-less outcome on an UNTRUSTED source: still rejected.
        { text: '63/63 passed', sourceTimestamp: '2026-08-28T06:08:04.688Z' },
        // Anchored but modal/future: rejected even on the trusted channel.
        { text: 'All tests should pass once I run them', sourceTimestamp: '2026-08-28T06:09:00.000Z', trustedOutcomeChannel: true },
        // Anchored outcome on the trusted channel: admitted, freshest wins.
        { text: '54/54 tests passed', sourceId: 'rail:valid/step:s6', sourceTimestamp: '2026-08-28T06:10:00.000Z', trustedOutcomeChannel: true },
      ],
    });
    expect(receipt.validation.fact).toBe('54/54 tests passed');
  });

  it('renders step-status=n/a when the current rail has no active step', () => {
    const base = model();
    const value = buildRebirthPackageV6Model({
      ...base,
      boundaryAndActiveTask: {
        ...base.boundaryAndActiveTask,
        nowCard: {
          forkPurpose: null,
          parentIdentity: null,
          parentStatus: null,
          currentRail: {
            railId: 'rail-resolved',
            state: 'review',
            activeStepId: null,
            activeStepStatus: null,
            source: { provenanceId: 'rail:rail-resolved', sourceAt: '2026-08-02T18:01:00.000Z', status: 'exact' },
          },
        },
      },
    });
    const boundary = renderRebirthPackageV6Sections(value)
      .find((section) => section.id === 'boundaryAndActiveTask')?.text ?? '';
    const card = boundary.split('[FACTUAL NOW CARD · descriptive boundary facts]')[1]
      ?.split('[/FACTUAL NOW CARD]')[0] ?? '';
    expect(card).toContain('current-rail=rail-resolved · state=review · active-step=none · step-status=n/a');

    // Second half of the invariant: a step id whose status could not be
    // resolved keeps the honest 'unknown', distinct from the n/a above.
    const unknown = buildRebirthPackageV6Model({
      ...base,
      boundaryAndActiveTask: {
        ...base.boundaryAndActiveTask,
        nowCard: {
          forkPurpose: null,
          parentIdentity: null,
          parentStatus: null,
          currentRail: {
            railId: 'rail-mid',
            state: 'active',
            activeStepId: 'step-9',
            activeStepStatus: null,
            source: { provenanceId: 'rail:rail-mid', sourceAt: '2026-08-02T18:02:00.000Z', status: 'exact' },
          },
        },
      },
    });
    const unknownCard = (renderRebirthPackageV6Sections(unknown)
      .find((section) => section.id === 'boundaryAndActiveTask')?.text ?? '')
      .split('[FACTUAL NOW CARD · descriptive boundary facts]')[1]
      ?.split('[/FACTUAL NOW CARD]')[0] ?? '';
    expect(unknownCard).toContain('active-step=step-9 · step-status=unknown');
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

  it('does not swallow a decoration-only Resume Point as a structured rail fact', () => {
    // Aug-30 audit E1: the no-rail fallback renders "── Resume Point ──
    // 💭 Last thought: …" (UI decoration over a thought bubble). Ingesting it
    // as kind:'rail' with a minted legacy-execution id rendered prose-as-data
    // in Execution State.
    const value = adaptLegacyRebirthPackageToV6({
      lifecycleBoundary: 'continuation',
      resumePoint: '── Resume Point ──\n💭 Last thought: Finished, ready for next task',
      predecessorName: 'worker-a',
    });

    expect(value.executionState.facts.some(
      (fact) => fact.kind === 'rail' && fact.text.includes('Last thought:'),
    )).toBe(false);
  });

  it('still admits a resume point that carries real rail structure', () => {
    const value = adaptLegacyRebirthPackageToV6({
      lifecycleBoundary: 'continuation',
      resumePoint: [
        '── Resume Point ──',
        '📋 Continue fold-continuity repair (rail-9e2b1075) — active — 3/9 (33%)',
        '▶ Active: step-4 [active]',
      ].join('\n'),
      predecessorName: 'worker-a',
    });

    expect(value.executionState.facts.some(
      (fact) => fact.kind === 'rail' && fact.text.includes('rail-9e2b1075'),
    )).toBe(true);
  });

  it('never mints a none-prefixed provenance id for a non-observed source', () => {
    // Aug-30 audit E2: a review fact whose live-field source id is 'none'
    // rendered as `source=none:review:<hash>` — a fabricated identity for a
    // non-observation. The honest fallback identity has no none: prefix.
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      capturedAt: '2026-08-30T23:00:00.000Z',
      captureSourceId: 'capture-none-review',
      railCapture: { status: 'unavailable', reason: 'worker-timeout' },
    });
    const value = adaptLegacyRebirthPackageToV6({ continuityReceipt });

    const reviewFact = value.executionState.facts.find((fact) => fact.kind === 'review');
    if (reviewFact) {
      expect(reviewFact.provenanceId.startsWith('none:')).toBe(false);
    }
    for (const fact of value.executionState.facts) {
      expect(fact.provenanceId.startsWith('none:')).toBe(false);
    }
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
    expect(section?.text).toContain('endpoint rows: rendered in Boundary (active request + last assistant)');
    expect(section?.text).toContain('SECOND_NEWEST_TURN_MUST_SURVIVE');
    expect(section?.text).toContain('NEWEST_TURN_MUST_SURVIVE');
    expect(section?.text).not.toContain('OVERSIZED_OLDER_TURN');
    expect(section?.text).not.toContain('UNKNOWN_TIME_MUST_NOT_DISPLACE_RECENCY');
    expect(section?.text).toContain('1 of 3 known-time candidate rows omitted');
    expect(section?.text).toContain('1 unknown-time quarantine row omitted');
    expect(section?.text).toContain('source-time-range=2026-08-02T17:50:00.000Z..2026-08-02T17:50:00.000Z');
    expect(section?.text).toContain('retained-from=2026-08-02T17:58:00.000Z');
    expect(section?.text).toContain('after=2026-08-02T17:50:00.000Z');
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
    expect(section?.text).toContain('endpoint rows: rendered in Boundary (active request + last assistant)');
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

  it('measures every canonical section across adaptive and final render passes without changing bytes', () => {
    let tick = 0;
    const value = model();
    const measured = renderRebirthPackageV6WithReport(value, {
      measureSectionTimings: true,
      sectionTimingClock: () => tick++,
    });
    const unmeasured = renderRebirthPackageV6WithReport(value);

    expect(measured.text).toBe(unmeasured.text);
    expect(unmeasured.sectionTimingsMs).toBeUndefined();
    expect(Object.keys(measured.sectionTimingsMs ?? {}).sort())
      .toEqual([...REBIRTH_PACKAGE_V6_SECTION_IDS].sort());
    for (const sectionId of REBIRTH_PACKAGE_V6_SECTION_IDS) {
      // One adaptive-cap render plus the final admission render proves the
      // accumulator covers repeated passes instead of timing a cheap final pass.
      expect(measured.sectionTimingsMs?.[sectionId]).toBeGreaterThanOrEqual(2);
    }
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

// ────────────────────────────────────────────────────────────────────────────
// Audit-2 Lane A regression battery (findings A1/A3/A11/A14/A21/A22/A26/A27/
// A28/A29-3). Self-contained minimal models because the render helpers above
// are scoped to their describe blocks.
// ────────────────────────────────────────────────────────────────────────────
describe('audit-2 Lane A render regressions', () => {
  const ROOT = {
    lifecycle: 'continuation' as const,
    lifecycleMeaning: 'x',
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
    activeRequest: null,
    lastMaterialAssistant: null,
  };
  it('A27: frame headers declare dir= matching each section sort', () => {
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: ROOT,
      executionState: { facts: [], unknownReasons: [] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [{ provenanceId: 'm:1', sourceAt: '2026-08-02T17:00:00.000Z', role: 'user', text: 'hello' }],
      recoveryIndex: [],
      cognitiveArtifacts: [{ provenanceId: 'c:1', sourceAt: '2026-08-02T17:00:00.000Z', kind: 'result', text: 'r', authority: 'a', supersededBy: null }],
    });
    const text = renderRebirthPackageV6(value);
    expect(text).toMatch(/id=cognitiveArtifacts order=5 dir=desc chars=/u); // newest-first
    expect(text).toMatch(/id=activeEditDelta order=4 dir=asc chars=/u);     // oldest-first
    expect(text).toMatch(/id=recoveryIndex order=10 dir=asc chars=/u);      // directory order
    expect(text).toMatch(/id=boundaryAndActiveTask order=1(?! dir=) chars=/u); // no dir (head content)
  });

  it('A3: honest omitted-prefix/alignment-sacrifice accounting on the newest-edit marker', () => {
    const editLines: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      editLines.push(`[2026-08-26 ${String(i % 12).padStart(2, '0')}:00 PM UTC] Edit → relay/src/a-${i}.ts`);
      editLines.push(`  ⊕ ${'x'.repeat(140)} line-${i}`);
    }
    const legacy = adaptLegacyRebirthPackageToV6({
      predecessorName: 'legacy-a',
      currentThread: '',
      activeEditDelta: editLines.join('\n'),
    });
    const section = renderRebirthPackageV6Sections(
      legacy,
      { sectionMaxChars: { activeEditDelta: 1_000 }, adaptiveBackfill: false },
    ).find((entry) => entry.id === 'activeEditDelta');
    expect(section?.text).toContain('omitted-prefix=');
    expect(section?.text).toMatch(/omitted-prefix=\d+ \(\d+ entries\)/u);
    expect(section?.text).toMatch(/alignment-sacrifice=\d+\/\d+/u);
  });

  it('A1: same base id with a DIFFERENT source time is a separate message, never coalesced', () => {
    // Persistence only mints continuation rows under the SAME source time as one
    // streamed message. Rows sharing the base `assistant:y` but with a genuinely
    // different source time are two separate messages and must stay separate.
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: ROOT,
      executionState: { facts: [], unknownReasons: [] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [
        { provenanceId: 'assistant:y:segment-1', sourceAt: '2026-08-02T18:00:00.000Z', role: 'assistant', text: 'First.' },
        { provenanceId: 'assistant:y:segment-2', sourceAt: '2026-08-02T18:05:00.000Z', role: 'assistant', text: 'Much later tail.' },
      ],
      recoveryIndex: [],
    });
    expect(value.recentConversation.map((row) => row.provenanceId))
      .toEqual(['assistant:y:segment-1', 'assistant:y:segment-2']);
  });

  it('A11: lineageChain renders born-as only when the birth name differs', () => {
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: {
        ...ROOT,
        nowCard: {
          forkPurpose: null,
          parentIdentity: null,
          parentStatus: null,
          currentRail: null,
          lineageChain: [
            { instanceId: 'old-id', instanceName: 'current-name', bornAs: 'old-birth-name', sourceAt: '2026-08-01T00:00:00.000Z', sourceEndAt: '2026-08-01T01:00:00.000Z', archived: true },
            { instanceId: 'plain-id', instanceName: 'plain-name', bornAs: 'plain-name', sourceAt: '2026-08-01T01:00:00.000Z', archived: false },
          ],
        },
      },
      executionState: { facts: [], unknownReasons: [] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [],
      recoveryIndex: [],
    });
    const text = renderRebirthPackageV6(value);
    expect(text).toContain('current-name (old-id)');
    expect(text).toContain('born-as=old-birth-name');     // renamed hop surfaces its birth name
    expect(text).toContain('plain-name (plain-id)');       // unchanged hop
    expect((text.match(/born-as=/gu) ?? []).length).toBe(1); // only the differing hop
  });

  it('A21: disagreement rows render as conflict, not unknown', () => {
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: ROOT,
      executionState: { facts: [], unknownReasons: ['runtime status=idle conflicts with executable rail state=active'] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [],
      recoveryIndex: [],
    });
    const text = renderRebirthPackageV6(value);
    expect(text).toContain('- conflict: runtime status=idle');
  });

  it('A15: a context-warp-stores recovery row carrying the explicit reason renders it', () => {
    const value = buildRebirthPackageV6Model(
      {
        boundaryAndActiveTask: ROOT,
        executionState: { facts: [], unknownReasons: [] },
        activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
        recentConversation: [],
        recoveryIndex: [{
          id: 'context-warp-stores',
          label: 'ambient recall; user sources use transcript recovery',
          handle: 'tap_instance_messages action="recent" target_instance_id="instance-a"',
          status: 'partial',
          count: null,
          frontier: 'event-9',
          reason: 'summary-only; re-derived from the raw transcript; exact rebirth artifacts are separately indexed',
        }],
      },
    );
    const text = renderRebirthPackageV6(value);
    expect(text).toContain('context-warp-stores');
    expect(text).toContain('reason=summary-only; re-derived from the raw transcript');
  });

  it('A29-3: self-lint never ships an empty newline-only diagnostic block (no-op newline branch)', () => {
    // A check list with one entry that costs more than the remain budget must
    // produce a bounded omission note — never a bare '\n'
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: ROOT,
      executionState: { facts: [], unknownReasons: [] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [],
      recoveryIndex: [{ id: 'dangling', label: 'inline body below on recovery lane', handle: 'h', status: 'available', count: null, frontier: null }],
    });
    const { text } = renderRebirthPackageV6WithReport(value, { packageBudget: 400_000 });
    const lintAt = text.indexOf('package self-check');
    expect(lintAt).toBeGreaterThan(-1);
    const after = text.slice(lintAt);
    expect(after).toContain('dangling');
    // No bare newline-only diagnostic: every self-check opens with '\n⚠ self-check'
    expect(after.split('\n').some((line) => line.trim() === '⚠ self-check')).toBe(false);
  });

  it('A25 start-tier units begin below t0 and are never promoted past their declared tier', () => {
    const make = (id: string, startTier: any) => ({
      id, sourceAt: '2026-08-02T17:00:00.000Z', kind: 'operator' as const,
      verbatim: 'VERBATIM-' + id.repeat(40), digest: 'DIGEST-' + id,
      claim: 'CLAIM-' + id, recover: 'tap', ...(startTier ? { startTier } : {}),
    });
    const units = [make('old-a', 't2' as const), make('old-b', 't0' as const)];
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: ROOT, executionState: { facts: [], unknownReasons: [] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [], recoveryIndex: [],
      operatorVault: { units, rangeRecover: 'tap-op' },
    });
    // Large budget: the t2-starting unit must NOT render back up to verbatim/ t0 —
    // pressure never promotes past the declared startTier; only the t0 unit does.
    const { text } = renderRebirthPackageV6WithReport(value, { packageBudget: 400_000, sectionMaxChars: { operatorVault: 60_000 }, adaptiveBackfill: false });
    expect(text).not.toContain('VERBATIM-old-a');
    expect(text).toContain('CLAIM-old-a'); // era/receipt/rollup representation survived
  });

  it('A1: same-message substantive segments coalesce into one envelope with seam offsets', () => {
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: ROOT,
      executionState: { facts: [], unknownReasons: [] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [
        { provenanceId: 'assistant:x', sourceAt: '2026-08-02T18:00:00.000Z', role: 'assistant', text: 'Alpha.' },
        { provenanceId: 'assistant:x:segment-1', sourceAt: '2026-08-02T18:00:00.000Z', role: 'assistant', text: 'Beta.' },
        { provenanceId: 'assistant:x:segment-2', sourceAt: '2026-08-02T18:00:00.000Z', role: 'assistant', text: 'Gamma.' },
      ],
      recoveryIndex: [],
    });
    // Three same-sourceTime fragments of ONE streamed message collapse to a
    // single base envelope whose text is the exact delta join; seam offsets
    // make the renderer's ⟨segment-N⟩ collocation markers possible without
    // corrupting the attested bytes.
    expect(value.recentConversation.map((row) => row.provenanceId)).toEqual(['assistant:x']);
    expect(value.recentConversation[0]?.text).toBe('Alpha.Beta.Gamma.');
    expect(value.recentConversation[0]?.segmentOffsets).toEqual([6, 11]);
  });

  it('A14: the episode chapter floor keeps the newest K episodes per-row under a tiny partition', () => {
    const make = (minute: number) => ({
      id: `ep:${String(minute).padStart(4, '0')}`,
      sourceAt: `2026-08-02T17:${String(minute).padStart(2, '0')}:00.000Z`,
      kind: 'episode' as const,
      verbatim: `episode-entity-${minute}`,
      digest: `episode-digest-${minute}`,
      claim: `episode-entity-${minute}`,
      recover: 'tap-episode',
    });
    const units = Array.from({ length: 315 }, (_, i) => make(i));
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: ROOT,
      executionState: { facts: [], unknownReasons: [] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [],
      recoveryIndex: [],
      episodeChapterIndex: { units, rangeRecover: 'tap-episodes' },
    });
    const { text, collapse } = renderRebirthPackageV6WithReport(value, {
      packageBudget: 12_000,
      sectionMaxChars: { episodeChapterIndex: 5_000 },
    });
    const report = collapse.sections.find((s) => s.sectionId === 'episodeChapterIndex');
    expect(report).toBeTruthy();
    // A single rollup covering ALL units would be the audit-2 A14 bug. The
    // recency floor K=5 keeps the newest episodes at digest-or-better, so the
    // latest episode's identity must still render per-row (not inside a rollup).
    expect(text).toContain('episode-entity-314');
  });

  it('A1 repair: >=12 fragments of one message join base,1..N under the lexical provenance sort', () => {
    // audit-2 scramble DECISIVE 1: a lexicographic provenance tiebreak orders
    // `:segment-10` before `:segment-2`, so a single-pass adjacent merge would
    // transpose multi-digit fragments (1,10..19,2..9). The helper groups by
    // message identity and joins by NUMERIC ordinal, so the coalesced text is
    // base,1..N regardless of the caller's sort order. buildRebirthPackageV6Model
    // sorts via compareSourceRows, whose provenance tiebreak is exactly the
    // lexical order that used to corrupt a 12-fragment message.
    const fragments = Array.from({ length: 12 }, (_, index) => ({
      provenanceId: `assistant:big:segment-${index + 1}`,
      sourceAt: '2026-08-02T18:00:00.000Z',
      role: 'assistant' as const,
      text: `FRAG-${index + 1}.`,
    }));
    const value = buildRebirthPackageV6Model({
      boundaryAndActiveTask: ROOT,
      executionState: { facts: [], unknownReasons: [] },
      activeEditDelta: { captureId: null, state: 'none', capturedSourceAt: null, completedObservedAt: null, inheritedCaptureIds: [], files: [], omittedFiles: 0, truncated: false, reasons: ['none'] },
      recentConversation: [
        { provenanceId: 'assistant:big', sourceAt: '2026-08-02T18:00:00.000Z', role: 'assistant', text: 'BASE.' },
        ...fragments,
      ],
      recoveryIndex: [],
    });
    const expectedText = `BASE.${fragments.map((fragment) => fragment.text).join('')}`;
    const expectedOffsets: number[] = [];
    let cursor = 'BASE.'.length;
    for (const fragment of fragments) {
      expectedOffsets.push(cursor);
      cursor += fragment.text.length;
    }
    expect(value.recentConversation).toHaveLength(1);
    expect(value.recentConversation[0]?.provenanceId).toBe('assistant:big');
    expect(value.recentConversation[0]?.text).toBe(expectedText);
    expect(value.recentConversation[0]?.segmentOffsets).toEqual(expectedOffsets);
    // The rendered Recent Conversation row carries the ordered whole message
    // with numeric-order seam markers (⟨segment-1⟩..⟨segment-12⟩ in order).
    const text = renderRebirthPackageV6(value);
    expect(text).toContain('BASE.⟨segment-1⟩FRAG-1.⟨segment-2⟩FRAG-2.⟨segment-3⟩FRAG-3.⟨segment-4⟩FRAG-4.⟨segment-5⟩FRAG-5.⟨segment-6⟩FRAG-6.⟨segment-7⟩FRAG-7.⟨segment-8⟩FRAG-8.⟨segment-9⟩FRAG-9.⟨segment-10⟩FRAG-10.⟨segment-11⟩FRAG-11.⟨segment-12⟩FRAG-12.');
  });

  it('A6 repair: a source-carrying hazard descriptor wins same-text dedupe over the bare hazard array', () => {
    // audit-2 #42903 self-defeating precedence (scramble DECISIVE): the bare
    // `hazards` rows used to pre-seed the dedupe set, so a same-text
    // `hazardsWithSource` descriptor was skipped and the source-stamped
    // blocker could never render — every real receipt hazard stayed a
    // source-less unknown-time row even when its descriptor carried the exact
    // row id + time. The descriptor must win: exactly one blocker with the
    // descriptor's id/time/excerpt, and no unknown-time duplicate from the
    // bare array.
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      capturedAt: '2026-08-02T18:00:00.000Z',
      captureSourceId: 'capture-a6-precedence',
      hazards: ['provider call failed: boom'],
    });
    const value = adaptLegacyRebirthPackageToV6({
      continuityReceipt: {
        ...receipt,
        hazardsWithSource: [{
          text: 'provider call failed: boom',
          sourceId: 'msg:row-1',
          sourceTimestamp: '2026-08-02T17:59:00.000Z',
          excerpt: 'boom detail',
        }],
      },
    });
    const blockers = value.executionState.facts.filter((fact) => (
      fact.kind === 'blocker' && fact.text.startsWith('provider call failed: boom')
    ));
    expect(blockers).toHaveLength(1);
    // The winner is the DESCRIPTOR form (stamped + excerpt), never the bare row.
    expect(blockers[0]).toMatchObject({
      text: 'provider call failed: boom · excerpt="boom detail"',
      sourceAt: '2026-08-02T17:59:00.000Z',
      status: 'exact',
    });
    expect(blockers[0]!.provenanceId).toMatch(/^msg:row-1:/u);
    // No source-less (unknown-time) duplicate survives for the same text.
    expect(blockers.filter((blocker) => blocker.status !== 'exact')).toHaveLength(0);
  });
});
