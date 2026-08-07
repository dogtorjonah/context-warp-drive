import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER,
  TAIL_EPOCH_CONTINUITY_SECTION_POLICY,
  type RawRebirthSeedSectionId,
} from '../rawRebirthSeed.ts';
import {
  assessTailEpochContinuityCoverage,
  deriveTailEpochContinuityCoverage,
  withTailEpochConservedRebirthCoverage,
} from '../epochContinuityCapsule.ts';

/**
 * Absorbing an empty rebirth package must never be safer to skip than to do.
 *
 * `withTailEpochConservedRebirthCoverage` brands its return unconditionally and
 * `assessTailEpochContinuityCoverage` honours any branded attestation, so a base
 * that fails the brand check used to yield a *valid* attestation requiring
 * nothing — beating the gate's own render-mode-default fallback. That inverted
 * the gate: passing no coverage at all failed closed, while passing coverage
 * derived from an empty package opened it.
 *
 * These cases are unreachable from the three current hosts, which all derive an
 * attestation unconditionally. They exist because the reachability is a property
 * of the call sites, not of this function: an omitted optional property, a
 * serialization boundary that strips the `Symbol` brand or the `Set`s, or a
 * duplicate copy of the module minting a brand this one does not recognise all
 * land on the same branch, and none of them are visible here.
 */

const RENDER_MODE_SECTION_IDS: readonly RawRebirthSeedSectionId[] =
  DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.filter(
    (sectionId) => TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId].mode === 'render',
  );

const EMPTY_PACKAGE = {
  presentSectionIds: [] as readonly RawRebirthSeedSectionId[],
  renderedSectionIds: [] as readonly RawRebirthSeedSectionId[],
  block: '',
} as const;

function sorted(sectionIds: Iterable<RawRebirthSeedSectionId>): RawRebirthSeedSectionId[] {
  return [...sectionIds].sort();
}

describe('withTailEpochConservedRebirthCoverage — unverifiable base fails closed', () => {
  it('has render-mode sections to require at all', () => {
    // Guards every assertion below from passing vacuously if the section policy
    // table ever stops classifying anything as render mode.
    expect(RENDER_MODE_SECTION_IDS.length).toBeGreaterThan(0);
  });

  it('requires the render-mode default when an empty package is absorbed with no base', () => {
    const coverage = withTailEpochConservedRebirthCoverage(undefined, EMPTY_PACKAGE);

    expect(sorted(coverage.requiredRenderSectionIds)).toEqual(sorted(RENDER_MODE_SECTION_IDS));
  });

  it('treats a null base identically to an absent one', () => {
    const coverage = withTailEpochConservedRebirthCoverage(null, EMPTY_PACKAGE);

    expect(sorted(coverage.requiredRenderSectionIds)).toEqual(sorted(RENDER_MODE_SECTION_IDS));
  });

  it('treats a base that lost its brand as unverifiable rather than as an empty requirement', () => {
    // The shape a structured clone or JSON round-trip leaves behind: every field
    // present, `Symbol` brand gone. It must not be trusted to require nothing.
    const unbranded = {
      requiredRenderSectionIds: new Set<RawRebirthSeedSectionId>(),
      renderedSectionIds: new Set<RawRebirthSeedSectionId>(),
      renderedBlock: '',
      renderedBlocks: [],
    };

    const coverage = withTailEpochConservedRebirthCoverage(
      unbranded as never,
      EMPTY_PACKAGE,
    );

    expect(sorted(coverage.requiredRenderSectionIds)).toEqual(sorted(RENDER_MODE_SECTION_IDS));
  });

  it('unions the package sections onto the default when a non-empty package has no base', () => {
    const present = RENDER_MODE_SECTION_IDS.slice(0, 1);
    const coverage = withTailEpochConservedRebirthCoverage(undefined, {
      presentSectionIds: present,
      renderedSectionIds: present,
      block: 'conserved block',
    });

    for (const sectionId of RENDER_MODE_SECTION_IDS) {
      expect(coverage.requiredRenderSectionIds.has(sectionId)).toBe(true);
    }
  });

  it('never leaves absorbing an empty package weaker than absorbing nothing', () => {
    // The defect stated as an invariant: whatever the gate would have required
    // on its own, absorbing an empty package must still require at least that.
    const absorbed = withTailEpochConservedRebirthCoverage(undefined, EMPTY_PACKAGE);
    const gateFallback = assessTailEpochContinuityCoverage({
      capsuleText: '',
      candidateText: '',
      coverage: null,
    });

    const gateRenderDemands = [...gateFallback.missingSectionIds].filter(
      (sectionId) => TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId].mode === 'render',
    );
    // Without this the comparison below is vacuous: an empty demand set would
    // let the loop pass while proving nothing about the absorbed attestation.
    expect(gateRenderDemands.length).toBeGreaterThan(0);

    for (const sectionId of gateRenderDemands) {
      expect(absorbed.requiredRenderSectionIds.has(sectionId)).toBe(true);
    }
  });
});

describe('withTailEpochConservedRebirthCoverage — verified base is unchanged', () => {
  it('keeps a verified host requirement set exactly, without widening it to the default', () => {
    // The half that must not regress: the three live hosts derive narrow
    // requirement sets from their own typed rows. Widening those to the
    // render-mode default would fail closed across the fleet on sections the
    // host correctly knows it has nothing to conserve for.
    const base = deriveTailEpochContinuityCoverage({
      sourceRows: [{ kind: 'operator' }],
      renderedRows: [{ role: 'user' }],
      renderedBlock: 'host vault block',
    });

    const coverage = withTailEpochConservedRebirthCoverage(base, EMPTY_PACKAGE);

    expect(sorted(coverage.requiredRenderSectionIds)).toEqual(sorted(base.requiredRenderSectionIds));
    expect(coverage.requiredRenderSectionIds.has('activeEditDelta')).toBe(false);
  });

  it('keeps an empty verified requirement set empty', () => {
    // A host with no operator rows and no edits genuinely has nothing to
    // conserve. An empty set it vouched for is evidence; an empty set from an
    // unverifiable base is the absence of evidence, and only the latter is
    // widened.
    const base = deriveTailEpochContinuityCoverage({
      sourceRows: [],
      renderedRows: [],
      renderedBlock: '',
    });

    const coverage = withTailEpochConservedRebirthCoverage(base, EMPTY_PACKAGE);

    expect(coverage.requiredRenderSectionIds.size).toBe(0);
  });
});
