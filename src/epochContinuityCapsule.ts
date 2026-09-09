import {
  DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER,
  TAIL_EPOCH_CONTINUITY_SECTION_POLICY,
  type RawRebirthSeedSectionId,
} from './rawRebirthSeed.ts';
import type {
  LiveObjectiveProvenance,
  LiveObjectiveSource,
} from './chronologicalProvenance.ts';
// One legend, shared with the v6 rebirth package. A tail epoch and a rebirth
// hand a successor the same anchor grammar (⟨source @time⟩), so the reader
// learns it once instead of decoding a second dialect at the other boundary.
// Type-only coupling to the package model keeps this import runtime-light.
import { CONTINUITY_LEGEND } from './continuityPresentation.ts';
import {
  isPendingAssistantContinuityState,
  PENDING_ASSISTANT_ACTION_CAPSULE_HEADER,
  PENDING_ASSISTANT_ACTION_STATE_PREFIX,
  settledPendingAssistantContinuityState,
  unknownPendingAssistantContinuityState,
  unresolvedPendingAssistantContinuityState,
  type PendingAssistantAction,
  type PendingAssistantContinuityState,
} from './pendingAssistantAction.ts';

export const EPOCH_CONTINUITY_CAPSULE_HEADER = PENDING_ASSISTANT_ACTION_CAPSULE_HEADER;
export const EPOCH_CONTINUITY_POINTERS_PREFIX = 'pointers: ';

export const EPOCH_CONTINUITY_OBJECTIVE_MAX_CHARS = 800;
export const EPOCH_CONTINUITY_TRAJECTORY_MAX_CHARS = 1_400;
export const EPOCH_CONTINUITY_VALIDATION_MAX_CHARS = 600;
export const EPOCH_CONTINUITY_LIVE_STATE_MAX_CHARS = 2_200;

export interface EpochContinuityCapsuleObjective {
  readonly text?: string | null;
  readonly provenance?: LiveObjectiveProvenance | null;
  readonly source?: LiveObjectiveSource | null;
}

export interface EpochContinuityCapsuleSource {
  readonly unit: 'event' | 'message';
  readonly sourceStart?: number | null;
  readonly sourceEndExclusive?: number | null;
  readonly rawResumeIndex?: number | null;
  readonly frameId?: string | null;
  readonly frameRowStart?: number | null;
  readonly frameRowEndInclusive?: number | null;
}

export interface RenderEpochContinuityCapsuleInput {
  readonly objective?: EpochContinuityCapsuleObjective | null;
  readonly trajectory?: string | null;
  /** Full tri-state transport. Hosts should always supply this at epoch boundaries. */
  readonly pendingAssistantState?: PendingAssistantContinuityState;
  /** @deprecated Compatibility input. Explicit null means an authoritative clear. */
  readonly pendingAssistantAction?: PendingAssistantAction | null;
  readonly validation?: string | null;
  readonly liveState?: string | null;
  readonly source: EpochContinuityCapsuleSource;
}

export type TailEpochContinuitySourceKind = 'operator' | 'edit';

export interface TailEpochContinuitySourceRow {
  readonly kind: TailEpochContinuitySourceKind;
}

export interface TailEpochContinuityRenderedRow {
  readonly role: unknown;
}

const TAIL_EPOCH_COVERAGE_ATTESTATION = Symbol('tail-epoch-coverage-attestation');

/**
 * Opaque evidence produced from typed source/render rows at the host boundary.
 * The brand prevents callers from satisfying the gate with an arbitrary list
 * of section-name strings.
 */
export interface TailEpochContinuityRenderedBlock {
  readonly block: string;
  readonly sectionIds: ReadonlySet<RawRebirthSeedSectionId>;
}

export interface TailEpochContinuityCoverageAttestation {
  readonly requiredRenderSectionIds: ReadonlySet<RawRebirthSeedSectionId>;
  readonly renderedSectionIds: ReadonlySet<RawRebirthSeedSectionId>;
  readonly renderedBlock: string;
  /**
   * Every carrier this attestation offers, each naming only the sections it can
   * itself prove. A required section is covered only by a non-empty carrier that
   * claims it AND is byte-present in the candidate band, so one installed
   * carrier can never vouch for a section that lives in a dropped one.
   */
  readonly renderedBlocks: readonly TailEpochContinuityRenderedBlock[];
  readonly [TAIL_EPOCH_COVERAGE_ATTESTATION]: true;
}

export interface DeriveTailEpochContinuityCoverageInput {
  readonly sourceRows: readonly TailEpochContinuitySourceRow[];
  readonly renderedRows: readonly TailEpochContinuityRenderedRow[];
  readonly renderedBlock: string;
}

export interface AssessTailEpochContinuityCoverageInput {
  readonly capsuleText: string;
  readonly candidateText: string;
  readonly coverage?: TailEpochContinuityCoverageAttestation | null;
  /**
   * Host-independent structural requirements observed by the builder itself,
   * such as a genuine operator prompt inside the region being removed.
   */
  readonly additionalRequiredRenderSectionIds?: readonly RawRebirthSeedSectionId[];
}

export interface TailEpochContinuityCoverageAssessment {
  readonly ok: boolean;
  readonly missingSectionIds: readonly RawRebirthSeedSectionId[];
  /**
   * Present ONLY when the capsule carried a pointer line that matched no
   * accepted registry entry. The key is omitted — not set to `undefined` — on
   * every other path, so the assessment stays structurally identical to what
   * consumers saw before this field existed.
   *
   * A missing capsule or a capsule with no pointer line needs no diagnostic:
   * `missingSectionIds` already lists the entire pointer set. An unrecognized
   * manifest is the one shape where the sections look uncovered but the band
   * did point at them, and without this the escalation that follows is
   * indistinguishable from a band that simply never had a capsule.
   */
  readonly unrecognizedPointerManifest?: string;
}

/**
 * Derive section coverage from typed rows, never marker-shaped prose.
 * `renderedBlock` is retained verbatim so the final candidate must prove that
 * the exact block assembled from those rows was actually installed.
 */
export function deriveTailEpochContinuityCoverage(
  input: DeriveTailEpochContinuityCoverageInput,
): TailEpochContinuityCoverageAttestation {
  const requiredRenderSectionIds = new Set<RawRebirthSeedSectionId>();
  for (const row of input.sourceRows) {
    if (row.kind === 'operator') requiredRenderSectionIds.add('lastUserAiMessages');
    if (row.kind === 'edit') requiredRenderSectionIds.add('activeEditDelta');
  }

  const renderedSectionIds = new Set<RawRebirthSeedSectionId>();
  if (input.renderedBlock.trim().length > 0) {
    for (const row of input.renderedRows) {
      if (row.role === 'user') renderedSectionIds.add('lastUserAiMessages');
      if (row.role === 'edit') renderedSectionIds.add('activeEditDelta');
    }
  }

  return Object.freeze({
    requiredRenderSectionIds,
    renderedSectionIds,
    renderedBlock: input.renderedBlock,
    renderedBlocks: Object.freeze([
      Object.freeze({ block: input.renderedBlock, sectionIds: renderedSectionIds }),
    ]),
    [TAIL_EPOCH_COVERAGE_ATTESTATION]: true as const,
  });
}

export interface TailEpochConservedRebirthCoverageInput {
  /** Render-mode sections whose header was found in the absorbed package. */
  readonly presentSectionIds: readonly RawRebirthSeedSectionId[];
  /** Subset actually copied into `block`. */
  readonly renderedSectionIds: readonly RawRebirthSeedSectionId[];
  readonly block: string;
}

/**
 * The render-mode sections a band must account for when no verified attestation
 * says otherwise.
 *
 * Deliberately the single definition: the absorb path
 * (`withTailEpochConservedRebirthCoverage`) and the gate
 * (`assessTailEpochContinuityCoverage`) must never disagree about what "required
 * by default" means, because the gate trusts whatever a branded attestation
 * claims. Two copies of this list is how the absorb path silently gets a weaker
 * default than the gate would have applied on its own.
 */
function defaultRequiredRenderSectionIds(): readonly RawRebirthSeedSectionId[] {
  return DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.filter(
    (sectionId) => TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId].mode === 'render',
  );
}

/**
 * Add the sections recovered from an absorbed rebirth package to a host
 * attestation as a second independently verified carrier.
 *
 * Every section present in the package becomes required, whether or not it was
 * copied, so absorbing a package that lost a render-mode section fails the gate
 * instead of silently deleting it.
 *
 * FAIL-CLOSED ON AN UNVERIFIABLE BASE. This function brands its return
 * unconditionally and the gate honours any branded attestation it is handed, so
 * seeding an empty requirement set here would make absorbing an *empty* package
 * strictly less safe than absorbing nothing at all: a caller that supplies no
 * coverage leaves the gate's own `coverage` undefined and it falls back to every
 * render-mode section, whereas a branded empty set wins that fallback and
 * requires none of them. The default is therefore seeded whenever `base` is
 * absent or fails the brand check.
 *
 * That condition is reachable by four routes, none of them visible at the call
 * site: an omitted optional `continuityCoverage`; a malformed attestation; one
 * whose `Set`s or `Symbol` brand did not survive a serialization boundary; and
 * one minted by a duplicate copy of this module, since the brand is a
 * module-local `Symbol` and this file is mirrored to a standalone package.
 */
export function withTailEpochConservedRebirthCoverage(
  base: TailEpochContinuityCoverageAttestation | null | undefined,
  input: TailEpochConservedRebirthCoverageInput,
): TailEpochContinuityCoverageAttestation {
  const verifiedBase = isTailEpochContinuityCoverageAttestation(base) ? base : null;
  const requiredRenderSectionIds = new Set<RawRebirthSeedSectionId>(
    verifiedBase?.requiredRenderSectionIds ?? defaultRequiredRenderSectionIds(),
  );
  for (const sectionId of input.presentSectionIds) requiredRenderSectionIds.add(sectionId);

  const conservedSectionIds = new Set<RawRebirthSeedSectionId>(input.renderedSectionIds);
  const renderedSectionIds = new Set<RawRebirthSeedSectionId>([
    ...(verifiedBase?.renderedSectionIds ?? []),
    ...conservedSectionIds,
  ]);

  const renderedBlocks: TailEpochContinuityRenderedBlock[] = [
    ...(verifiedBase?.renderedBlocks
      ?? (verifiedBase
        ? [{ block: verifiedBase.renderedBlock, sectionIds: verifiedBase.renderedSectionIds }]
        : [])),
  ];
  if (input.block.trim().length > 0) {
    renderedBlocks.push(Object.freeze({
      block: input.block,
      sectionIds: Object.freeze(conservedSectionIds) as ReadonlySet<RawRebirthSeedSectionId>,
    }));
  }

  return Object.freeze({
    requiredRenderSectionIds,
    renderedSectionIds,
    renderedBlock: verifiedBase?.renderedBlock ?? input.block,
    renderedBlocks: Object.freeze(renderedBlocks),
    [TAIL_EPOCH_COVERAGE_ATTESTATION]: true as const,
  });
}

function isTailEpochContinuityCoverageAttestation(
  value: TailEpochContinuityCoverageAttestation | null | undefined,
): value is TailEpochContinuityCoverageAttestation {
  return Boolean(
    value
    && value[TAIL_EPOCH_COVERAGE_ATTESTATION] === true
    && value.requiredRenderSectionIds instanceof Set
    && value.renderedSectionIds instanceof Set,
  );
}

/**
 * Engine-agnostic fail-closed gate. Pointer coverage is accepted only from the
 * exact canonical capsule block. Render coverage is accepted only from a
 * branded typed-row attestation whose exact rendered block is present in the
 * candidate band.
 */
export function assessTailEpochContinuityCoverage(
  input: AssessTailEpochContinuityCoverageInput,
): TailEpochContinuityCoverageAssessment {
  const pointerScan = scanEpochContinuityPointerSections(input.capsuleText);
  const pointerSections = pointerScan.status === 'matched'
    ? pointerScan.sections
    : new Set<RawRebirthSeedSectionId>();
  const missing = new Set<RawRebirthSeedSectionId>();
  for (const sectionId of DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER) {
    if (
      TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId].mode === 'pointer'
      && !pointerSections.has(sectionId)
    ) {
      missing.add(sectionId);
    }
  }

  const coverage = isTailEpochContinuityCoverageAttestation(input.coverage)
    ? input.coverage
    : null;
  const requiredRenderSections = new Set<RawRebirthSeedSectionId>(
    coverage?.requiredRenderSectionIds ?? defaultRequiredRenderSectionIds(),
  );
  for (const sectionId of input.additionalRequiredRenderSectionIds ?? []) {
    if (TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId]?.mode === 'render') {
      requiredRenderSections.add(sectionId);
    }
  }

  // Legacy single-carrier attestations are read as a one-entry carrier list, so
  // the per-carrier rule below is a strict superset of the original check.
  const carriers: readonly TailEpochContinuityRenderedBlock[] = coverage
    ? (coverage.renderedBlocks
      ?? [{ block: coverage.renderedBlock, sectionIds: coverage.renderedSectionIds }])
    : [];
  const installedSectionIds = new Set<RawRebirthSeedSectionId>();
  for (const carrier of carriers) {
    if (carrier.block.trim().length === 0) continue;
    if (!input.candidateText.includes(carrier.block)) continue;
    for (const sectionId of carrier.sectionIds) installedSectionIds.add(sectionId);
  }
  for (const sectionId of requiredRenderSections) {
    if (!installedSectionIds.has(sectionId)) missing.add(sectionId);
  }

  const missingSectionIds = DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.filter(
    (sectionId) => missing.has(sectionId),
  );
  // Built mutably so the diagnostic key can be OMITTED rather than set to
  // `undefined`. Callers on every pre-existing path must receive an object with
  // exactly the keys they had before, or a strict-equality consumer starts
  // failing on a field that carries no information for it.
  const assessment: {
    ok: boolean;
    missingSectionIds: readonly RawRebirthSeedSectionId[];
    unrecognizedPointerManifest?: string;
  } = {
    ok: missingSectionIds.length === 0,
    missingSectionIds,
  };
  if (pointerScan.status === 'unrecognized-manifest') {
    assessment.unrecognizedPointerManifest = pointerScan.diagnostic;
  }
  return Object.freeze(assessment);
}

export interface PackUnframedNoCarriersInput {
  /** The failed assessment being classified. */
  readonly assessment: TailEpochContinuityCoverageAssessment;
  /** Sections recovered from the absorbed package, or null when none was absorbed. */
  readonly conserved: TailEpochConservedRebirthCoverageInput | null;
  /** The host attestation as passed to the absorb path, BEFORE package widening. */
  readonly hostCoverage: TailEpochContinuityCoverageAttestation | null | undefined;
  /** Sections the caller required independently of any attestation. */
  readonly additionalRequiredRenderSectionIds?: readonly RawRebirthSeedSectionId[];
}

/**
 * Distinguish the one coverage failure that is safe to retry-later from the ones
 * that are not.
 *
 * A failed assessment flattens four independent causes: a pointer scan that did
 * not match, an absent host carrier, a package-contributed section with no
 * carrier, and a section the caller required outright. Only the third is a
 * property of bytes already written by a past producer — an absorbed package
 * whose render-section headers are present but whose payloads carry no
 * recoverable envelope can never be conserved, no matter how many times the fold
 * is retried, yet the host vault and the pointer capsule are both intact and the
 * pinned package row survives untouched. Degrading that band to pointer mode
 * preserves strictly more than escalating the whole session to a hard epoch.
 *
 * The other three must keep failing loudly. A pointer-scan failure means the
 * capsule the caller just built is malformed, and a missing host carrier means
 * the vault did not install — both are internal defects of the current process,
 * and reporting them as "nothing to fold yet" would convert a live bug into
 * silence across the fleet.
 *
 * Requirement ownership is resolved exactly as the gate resolves it, including
 * the unbranded-attestation fallback to the render-mode default. An unverifiable
 * host attestation therefore makes the gate own every render section, and this
 * predicate correctly refuses to downgrade rather than crediting the package for
 * a requirement it did not introduce.
 */
export function isPackUnframedNoCarriersCoverageGap(
  input: PackUnframedNoCarriersInput,
): boolean {
  const conserved = input.conserved;
  if (conserved === null) return false;
  // The package must have declared sections and framed none of them. A package
  // that framed something is a partial-loss case and stays escalating; a package
  // that declared nothing contributed no requirement and cannot be the cause.
  if (conserved.presentSectionIds.length === 0) return false;
  if (conserved.renderedSectionIds.length > 0) return false;
  // A capsule that carried an unrecognized manifest is a malformation of this
  // process's own output, not of the absorbed bytes.
  if (input.assessment.unrecognizedPointerManifest !== undefined) return false;
  if (input.assessment.missingSectionIds.length === 0) return false;

  const hostRequired = new Set<RawRebirthSeedSectionId>(
    isTailEpochContinuityCoverageAttestation(input.hostCoverage)
      ? input.hostCoverage.requiredRenderSectionIds
      : defaultRequiredRenderSectionIds(),
  );
  const callerRequired = new Set<RawRebirthSeedSectionId>(
    input.additionalRequiredRenderSectionIds ?? [],
  );
  const packPresent = new Set<RawRebirthSeedSectionId>(conserved.presentSectionIds);

  return input.assessment.missingSectionIds.every((sectionId) => (
    TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId]?.mode === 'render'
    && packPresent.has(sectionId)
    && !hostRequired.has(sectionId)
    && !callerRequired.has(sectionId)
  ));
}

export function boundEpochContinuityText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const headChars = Math.ceil(maxChars * 0.58);
  const tailChars = maxChars - headChars - 1;
  return `${normalized.slice(0, headChars)}…${normalized.slice(-tailChars)}`;
}

export function deriveEpochContinuityValidation(text: string): string | null {
  const trajectory = text.replace(/\s+/g, ' ').trim();
  const clauses = text
    .split(/(?<=[.!?])\s+|\r?\n|\s+\|\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .flatMap((clause) => {
      if (!/\b(?:test|tests|typecheck|validation|validated|regression|build)\b/i.test(clause)) return [];
      if (!/\b(?:pass|passed|fail|failed|clean|green|error|pending|progress|running)\b/i.test(clause)) return [];
      const marker = clause.search(/\b(?:validation|validated|tests?|typecheck|regression|build)\b/i);
      return [marker > 0 ? clause.slice(marker) : clause];
    });
  if (clauses.length === 0) return null;
  const evidence = boundEpochContinuityText(
    clauses.slice(-3).join(' | '),
    EPOCH_CONTINUITY_VALIDATION_MAX_CHARS,
  );
  return evidence.replace(/\s+/g, ' ').trim() === trajectory ? null : evidence;
}

function pointerManifest(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.flatMap((sectionId) => {
      const policy = TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId];
      return policy.mode === 'pointer'
        ? [[sectionId, policy.authoritativeSource] as const]
        : [];
    }),
  ));
}

const TAIL_EPOCH_POINTER_MANIFEST = pointerManifest();

export function renderEpochContinuityPointers(): string {
  return `${EPOCH_CONTINUITY_POINTERS_PREFIX}${JSON.stringify(TAIL_EPOCH_POINTER_MANIFEST)}`;
}

export interface AcceptedEpochContinuityPointerManifest {
  readonly ordinal: number;
  readonly line: string;
}

/**
 * APPEND ONLY. Never edit or delete an existing entry — add a new one.
 *
 * Editing or deleting an entry orphans every band already written under it:
 * those bands stop matching any accepted manifest. Appending is the only safe
 * operation, because a manifest that was ever live must stay creditable forever.
 *
 * Scope, stated precisely, because it is easy to over-read. Today this registry
 * is a BUILD-TIME conformance tripwire: the membership test runs in CI, so a
 * policy-table edit cannot land without the matching append and floor bump in
 * the same commit. It is NOT a runtime gate yet — no production path credits a
 * persisted capsule against it. `assess` pointer-scans only the capsule text it
 * was handed, and both call sites pass a freshly rendered one, so an orphaned
 * entry cannot fail a live band today.
 *
 * That deferral is the hazard, not manifest rotation. A registry with no runtime
 * reader is maintained on trust: drift stays invisible until a reader of
 * persisted capsules lands, and then fails closed retroactively against bands
 * written long before the mismatch was observable. Append-only is what keeps
 * that future activation safe, so honor it while it still costs nothing.
 *
 * Entries are checked-in literals on purpose. Deriving them from git history at
 * build time would reintroduce the live-constant coupling this registry exists
 * to remove.
 *
 * Ordinals are dense and monotonic from 1; the floor below makes a deletion
 * break loudly instead of silently.
 */
export const ACCEPTED_EPOCH_CONTINUITY_POINTER_MANIFESTS:
readonly AcceptedEpochContinuityPointerManifest[] = Object.freeze([
  {
    // Introduced with the tail-epoch continuity capsule. Measured as the only
    // manifest ever persisted: identical across git, disk, and the standalone
    // mirror at the time the registry was seeded.
    ordinal: 1,
    line: 'pointers: {"currentThread":"band-local cognitive artifact plus raw-tail frontier","starredMoments":"persisted tap_star waypoint store","rawTraceCoordinateCloset":"typed fold receipts and trace-recall coordinate index","traceNeighborhoods":"trace-recall neighborhood store","taskRailContext":"live task rail","episodicCrossRef":"episodic recall store","lineageGlyphLog":"persisted glyph/waypoint log","openQuestions":"persisted blocked-register and episodic recall","atlasCrossRef":"live Atlas index","workspaceContext":"live relay session/workspace state","thinkingTrail":"canonical event trace and cognitive recall","lifetimeChangelogArc":"Atlas changelog","chatroomMembership":"live chatroom membership state","delegatedWork":"live instance/fork presence state","coordinationState":"live claims and coordination stores","squadThoughts":"live squad thought/presence state"}',
  },
]);

/**
 * Deletion floor. Deliberately adjacent to the array rather than in the test
 * file, so whoever edits the data sees the guard in the same field of view.
 * This number only ever increases.
 */
export const ACCEPTED_POINTER_MANIFEST_MIN_ENTRIES = 1;

const POINTER_MODE_SECTION_IDS: ReadonlySet<RawRebirthSeedSectionId> = new Set(
  DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.filter(
    (sectionId) => TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId].mode === 'pointer',
  ),
);

/**
 * Credit only the sections an entry's own manifest named. Crediting the live
 * pointer set on a match against an older entry would claim coverage for
 * sections that band never pointed at — a silent over-credit. Keys that no
 * longer exist, or are no longer pointer mode, are ignored rather than credited.
 *
 * This reads a checked-in constant, not band text, so it is not per-key credit
 * of untrusted input: matching still requires byte-equality against an entry.
 */
export function creditedEpochContinuityPointerSections(
  line: string,
): ReadonlySet<RawRebirthSeedSectionId> {
  // The prefix check is not redundant with the scan's own guard. This is an
  // exported entry point, and blind-slicing a fixed width off an arbitrary
  // string can leave behind valid JSON — `0123456789{"currentThread":1}` would
  // otherwise credit a section from text that is not a manifest at all.
  if (!line.startsWith(EPOCH_CONTINUITY_POINTERS_PREFIX)) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(EPOCH_CONTINUITY_POINTERS_PREFIX.length));
  } catch {
    return new Set();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
  return new Set(
    DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.filter(
      (sectionId) => POINTER_MODE_SECTION_IDS.has(sectionId)
        && Object.prototype.hasOwnProperty.call(parsed, sectionId),
    ),
  );
}

const ACCEPTED_POINTER_MANIFEST_SECTIONS:
ReadonlyMap<string, ReadonlySet<RawRebirthSeedSectionId>> = new Map(
  ACCEPTED_EPOCH_CONTINUITY_POINTER_MANIFESTS.map(
    (entry) => [entry.line, creditedEpochContinuityPointerSections(entry.line)] as const,
  ),
);

/**
 * FNV-1a over UTF-16 code units — deliberately inline, never `node:crypto`.
 * This module is byte-mirrored into the standalone package and imports nothing
 * but ./rawRebirthSeed.ts, so a runtime import would make the two copies'
 * dependency surfaces diverge in a file whose parity is enforced by byte
 * identity. The fingerprint is a label in a bug report, not a gate: credit
 * still requires byte-equality against a registry entry, so a forged
 * fingerprint buys nothing.
 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** -1 when identical; otherwise the first index at which the two strings differ. */
function firstDivergenceIndex(observed: string, expected: string): number {
  const shared = Math.min(observed.length, expected.length);
  for (let index = 0; index < shared; index += 1) {
    if (observed[index] !== expected[index]) return index;
  }
  return observed.length === expected.length ? -1 : shared;
}

/**
 * Bounded, allocation-light description of a manifest that matched no accepted
 * entry. Length disambiguates FNV collisions, and the divergence index points
 * at which key moved — far more actionable than a bare hash.
 */
function describeUnrecognizedManifest(line: string): string {
  return `len=${line.length} fnv1a32=${fnv1a32(line)} `
    + `diverges@${firstDivergenceIndex(line, renderEpochContinuityPointers())}`;
}

/**
 * A pointer scan has three distinct failure shapes, and only one of them is a
 * registry problem. Collapsing them into an empty set is what made a
 * fleet-wide degradation invisible.
 */
export type EpochContinuityPointerScan =
  | { readonly status: 'matched'; readonly sections: ReadonlySet<RawRebirthSeedSectionId> }
  | { readonly status: 'no-capsule' }
  | { readonly status: 'no-pointer-line' }
  | { readonly status: 'unrecognized-manifest'; readonly diagnostic: string };

/**
 * Structural scan for the typed pointer manifest. Credit requires byte-equality
 * against an accepted registry entry inside an exact capsule block, so quoted
 * section-name prose in folded history still proves nothing.
 *
 * Returns the disposition as a value rather than emitting it. This runs on the
 * fold path, where a module-level emitter would be an open invitation to put
 * blocking I/O behind it; a returned value structurally cannot become I/O.
 */
export function scanEpochContinuityPointerSections(text: string): EpochContinuityPointerScan {
  const lines = text.split(/\r?\n/);
  let sawCapsule = false;
  let unrecognized: string | null = null;
  for (let headerIndex = 0; headerIndex < lines.length; headerIndex += 1) {
    if (lines[headerIndex] !== EPOCH_CONTINUITY_CAPSULE_HEADER) continue;
    sawCapsule = true;
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line === EPOCH_CONTINUITY_CAPSULE_HEADER || line.startsWith('source: canonical ')) break;
      if (!line.startsWith(EPOCH_CONTINUITY_POINTERS_PREFIX)) continue;
      const sections = ACCEPTED_POINTER_MANIFEST_SECTIONS.get(line);
      if (sections) return Object.freeze({ status: 'matched' as const, sections });
      unrecognized ??= describeUnrecognizedManifest(line);
    }
  }
  if (unrecognized !== null) {
    return Object.freeze({ status: 'unrecognized-manifest' as const, diagnostic: unrecognized });
  }
  return Object.freeze({ status: sawCapsule ? ('no-pointer-line' as const) : ('no-capsule' as const) });
}

/**
 * Parse the typed pointer manifest from a rendered capsule. Consumers and
 * conformance tests use this instead of treating arbitrary section-name text
 * in folded history as coverage.
 */
export function parseEpochContinuityPointerSections(
  text: string,
): ReadonlySet<RawRebirthSeedSectionId> {
  const scan = scanEpochContinuityPointerSections(text);
  // A copy, never the registry's own set. Before the scan existed this wrapper
  // built a fresh set per call; a matched scan now hands back the module-level
  // instance that every future match for that manifest will share, so passing
  // it straight through would let one caller's mutation poison registry credit
  // for the rest of the process. ReadonlySet stops that in TypeScript only.
  return scan.status === 'matched' ? new Set(scan.sections) : new Set();
}

function sourceCoordinate(value: number | null | undefined): number | 'unknown' {
  return typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
}

/**
 * Package-canonical tail-epoch continuity renderer. Hosts select their own
 * objective and trajectory from native transcript shapes, then this pure
 * formatter applies one bounded layout and one typed registry pointer manifest.
 */
export function renderEpochContinuityCapsule(
  input: RenderEpochContinuityCapsuleInput,
): string {
  const objectiveText = input.objective?.text
    ? boundEpochContinuityText(
        input.objective.text,
        EPOCH_CONTINUITY_OBJECTIVE_MAX_CHARS,
      )
    : null;
  const trajectory = input.trajectory
    ? boundEpochContinuityText(
        input.trajectory,
        EPOCH_CONTINUITY_TRAJECTORY_MAX_CHARS,
      )
    : null;
  const hasStateInput = Object.prototype.hasOwnProperty.call(input, 'pendingAssistantState');
  const hasActionInput = Object.prototype.hasOwnProperty.call(input, 'pendingAssistantAction');
  const hasExplicitContinuityInput = hasStateInput || hasActionInput;
  let pendingAssistantState: PendingAssistantContinuityState;
  if (hasStateInput && isPendingAssistantContinuityState(input.pendingAssistantState)) {
    pendingAssistantState = input.pendingAssistantState;
  } else if (hasActionInput) {
    pendingAssistantState = input.pendingAssistantAction
      ? unresolvedPendingAssistantContinuityState(input.pendingAssistantAction)
      : settledPendingAssistantContinuityState(null);
  } else {
    // No explicit continuity input: the state stays honestly unknown. Never
    // manufacture unresolved state from trajectory prose — a null-id/null-time
    // action serialized into the state row below becomes trusted carried state
    // at the next fold, which authenticates a guess as freshness. Every
    // production host supplies pendingAssistantState; a stateless caller still
    // gets the low-authority legacy `trajectory:` line rendered further down.
    pendingAssistantState = unknownPendingAssistantContinuityState();
  }
  const pendingAssistantAction = pendingAssistantState.state === 'unresolved'
    ? pendingAssistantState.action
    : null;
  const pendingAssistantActionText = pendingAssistantAction
    ? boundEpochContinuityText(
        pendingAssistantAction.text,
        EPOCH_CONTINUITY_TRAJECTORY_MAX_CHARS,
      )
    : null;
  const validation = input.validation === undefined
    ? (trajectory ? deriveEpochContinuityValidation(trajectory) : null)
    : input.validation
      ? boundEpochContinuityText(
          input.validation,
          EPOCH_CONTINUITY_VALIDATION_MAX_CHARS,
        )
      : null;
  const liveState = input.liveState?.trim()
    ? input.liveState.trim().slice(0, EPOCH_CONTINUITY_LIVE_STATE_MAX_CHARS)
    : null;
  const sourceStart = sourceCoordinate(input.source.sourceStart);
  const sourceEndExclusive = sourceCoordinate(input.source.sourceEndExclusive);
  const rawResumeIndex = sourceCoordinate(
    input.source.rawResumeIndex ?? input.source.sourceEndExclusive,
  );
  const frameId = input.source.frameId?.trim() || 'implicit';
  const frameRowStart = sourceCoordinate(
    input.source.frameRowStart ?? input.source.sourceStart,
  );
  const frameRowEndInclusive = sourceCoordinate(
    input.source.frameRowEndInclusive
      ?? (typeof input.source.sourceEndExclusive === 'number'
        ? Math.max(
            typeof input.source.sourceStart === 'number' ? input.source.sourceStart : 0,
            input.source.sourceEndExclusive - 1,
          )
        : null),
  );
  const provenance = input.objective?.provenance?.trim() || 'unknown';
  const objectiveSource = input.objective?.source?.trim() || 'none';
  const stateJson = JSON.stringify(pendingAssistantState);
  const renderLegacyTrajectory = !hasExplicitContinuityInput && !pendingAssistantAction && trajectory;
  const pendingSource = pendingAssistantAction?.source;

  return [
    EPOCH_CONTINUITY_CAPSULE_HEADER,
    objectiveText
      ? `objective: ${objectiveText} [provenance=${provenance} source=${objectiveSource}]`
      : 'objective: unknown [provenance=unknown source=none]',
    pendingAssistantActionText
      ? `pending_assistant_action: ${pendingAssistantActionText} [status=unresolved basis=${pendingAssistantAction?.basis ?? 'unknown'} source-id=${pendingSource?.id ?? 'unknown'} source-coordinate=${pendingSource?.unit ?? input.source.unit}#${pendingSource?.index ?? 'unknown'} source-time=${pendingSource?.timestamp ?? 'unknown'} outranks=live-task-rail]`
      // A real settlement is rendered visibly, not only inside the state JSON:
      // a successor must see WHO closed the commitment (operator supersession,
      // cancellation, or assistant verdict) without structural parsing. An
      // explicit-null tombstone (settledBy=null) and unknown state stay
      // line-free — absence of evidence is not rendered as a settlement.
      : pendingAssistantState.state === 'none' && pendingAssistantState.settledBy
        ? `pending_assistant_action: none [settled-by=${pendingAssistantState.settledBy.reason} source-id=${pendingAssistantState.settledBy.source.id ?? 'unknown'} source-coordinate=${pendingAssistantState.settledBy.source.unit}#${pendingAssistantState.settledBy.source.index ?? 'unknown'} source-time=${pendingAssistantState.settledBy.source.timestamp ?? 'unknown'}]`
        : renderLegacyTrajectory
          ? `trajectory: ${trajectory}`
          : '',
    `${PENDING_ASSISTANT_ACTION_STATE_PREFIX}${stateJson}`,
    validation ? `validation: ${validation}` : '',
    liveState ? `live_state:\n${liveState}` : '',
    CONTINUITY_LEGEND,
    renderEpochContinuityPointers(),
    `source: canonical ${input.source.unit}s ${sourceStart}..${sourceEndExclusive} (end-exclusive); raw resumes at ${input.source.unit} ${rawResumeIndex}; local pre-fold frame ${frameId} rows ${frameRowStart}..${frameRowEndInclusive}`,
  ].filter(Boolean).join('\n');
}
