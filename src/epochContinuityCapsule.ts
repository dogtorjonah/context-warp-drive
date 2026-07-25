import {
  DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER,
  TAIL_EPOCH_CONTINUITY_SECTION_POLICY,
  type RawRebirthSeedSectionId,
} from './rawRebirthSeed.ts';

export const EPOCH_CONTINUITY_CAPSULE_HEADER = '[Epoch Continuity Capsule]';
export const EPOCH_CONTINUITY_POINTERS_PREFIX = 'pointers: ';

export const EPOCH_CONTINUITY_OBJECTIVE_MAX_CHARS = 800;
export const EPOCH_CONTINUITY_TRAJECTORY_MAX_CHARS = 1_400;
export const EPOCH_CONTINUITY_VALIDATION_MAX_CHARS = 600;
export const EPOCH_CONTINUITY_LIVE_STATE_MAX_CHARS = 2_200;

export interface EpochContinuityCapsuleObjective {
  readonly text?: string | null;
  readonly confidence?: string | null;
  readonly source?: string | null;
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
export interface TailEpochContinuityCoverageAttestation {
  readonly requiredRenderSectionIds: ReadonlySet<RawRebirthSeedSectionId>;
  readonly renderedSectionIds: ReadonlySet<RawRebirthSeedSectionId>;
  readonly renderedBlock: string;
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
  const pointerSections = parseEpochContinuityPointerSections(input.capsuleText);
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
    coverage?.requiredRenderSectionIds
      ?? DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.filter(
        (sectionId) => TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId].mode === 'render',
      ),
  );
  for (const sectionId of input.additionalRequiredRenderSectionIds ?? []) {
    if (TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId]?.mode === 'render') {
      requiredRenderSections.add(sectionId);
    }
  }

  const renderedBlockInstalled = Boolean(
    coverage
    && coverage.renderedBlock.trim().length > 0
    && input.candidateText.includes(coverage.renderedBlock),
  );
  for (const sectionId of requiredRenderSections) {
    if (!renderedBlockInstalled || !coverage?.renderedSectionIds.has(sectionId)) {
      missing.add(sectionId);
    }
  }

  const missingSectionIds = DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.filter(
    (sectionId) => missing.has(sectionId),
  );
  return Object.freeze({
    ok: missingSectionIds.length === 0,
    missingSectionIds,
  });
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

/**
 * Parse the typed pointer manifest from a rendered capsule. Consumers and
 * conformance tests use this instead of treating arbitrary section-name text
 * in folded history as coverage.
 */
export function parseEpochContinuityPointerSections(
  text: string,
): ReadonlySet<RawRebirthSeedSectionId> {
  const lines = text.split(/\r?\n/);
  const canonicalPointerLine = renderEpochContinuityPointers();
  for (let headerIndex = 0; headerIndex < lines.length; headerIndex += 1) {
    if (lines[headerIndex] !== EPOCH_CONTINUITY_CAPSULE_HEADER) continue;
    for (let index = headerIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line === EPOCH_CONTINUITY_CAPSULE_HEADER || line.startsWith('source: canonical ')) break;
      if (line !== canonicalPointerLine) continue;
      return new Set(
        DEFAULT_RAW_REBIRTH_SEED_RENDER_ORDER.filter(
          (sectionId) => TAIL_EPOCH_CONTINUITY_SECTION_POLICY[sectionId].mode === 'pointer',
        ),
      );
    }
  }
  return new Set();
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
  const confidence = input.objective?.confidence?.trim() || 'unknown';
  const objectiveSource = input.objective?.source?.trim() || 'none';

  return [
    EPOCH_CONTINUITY_CAPSULE_HEADER,
    objectiveText
      ? `objective: ${objectiveText} [confidence=${confidence} source=${objectiveSource}]`
      : 'objective: unknown [confidence=unknown source=none]',
    trajectory ? `trajectory: ${trajectory}` : '',
    validation ? `validation: ${validation}` : '',
    liveState ? `live_state:\n${liveState}` : '',
    renderEpochContinuityPointers(),
    `source: canonical ${input.source.unit}s ${sourceStart}..${sourceEndExclusive} (end-exclusive); raw resumes at ${input.source.unit} ${rawResumeIndex}; local pre-fold frame ${frameId} rows ${frameRowStart}..${frameRowEndInclusive}`,
  ].filter(Boolean).join('\n');
}
