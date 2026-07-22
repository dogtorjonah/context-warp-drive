/**
 * Origin grammar for model-visible historical claims.
 *
 * A witnessed claim is the only class allowed to carry a witness authority
 * position, and constructing one requires a stable source identity. Derived
 * and synthesized claims may cite inputs in their prose, but cannot acquire a
 * `witness` field through this discriminated union. The renderer validates at
 * runtime too so untyped/legacy callers fail closed instead of laundering an
 * origin label.
 */

export type HistoricalClaimOrigin = 'witnessed' | 'derived' | 'synthesized';

export interface HistoricalClaimWitness {
  /** Stable event/row identity from the canonical source. */
  readonly sourceIdentity: string;
  /** Measured source time. Unknown remains absent; it is never inferred. */
  readonly sourceTimestamp?: string;
}

interface HistoricalClaimBase {
  readonly text: string;
}

export interface WitnessedHistoricalClaim extends HistoricalClaimBase {
  readonly origin: 'witnessed';
  readonly witness: HistoricalClaimWitness;
}

export interface DerivedHistoricalClaim extends HistoricalClaimBase {
  readonly origin: 'derived';
  readonly witness?: never;
}

export interface SynthesizedHistoricalClaim extends HistoricalClaimBase {
  readonly origin: 'synthesized';
  readonly witness?: never;
}

export type HistoricalClaim =
  | WitnessedHistoricalClaim
  | DerivedHistoricalClaim
  | SynthesizedHistoricalClaim;

export interface RenderedHistoricalClaim {
  readonly text: string;
  readonly origin: HistoricalClaimOrigin;
  readonly witness: HistoricalClaimWitness | null;
  readonly valid: boolean;
}

function normalizedWitness(value: unknown): HistoricalClaimWitness | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { sourceIdentity?: unknown; sourceTimestamp?: unknown };
  if (typeof candidate.sourceIdentity !== 'string' || !candidate.sourceIdentity.trim()) return null;
  if (candidate.sourceTimestamp !== undefined
    && (typeof candidate.sourceTimestamp !== 'string'
      || !candidate.sourceTimestamp.trim()
      || !Number.isFinite(Date.parse(candidate.sourceTimestamp)))) return null;
  return {
    sourceIdentity: candidate.sourceIdentity.trim(),
    ...(candidate.sourceTimestamp !== undefined
      ? { sourceTimestamp: candidate.sourceTimestamp.trim() }
      : {}),
  };
}

export function witnessedHistoricalClaim(
  text: string,
  witness: HistoricalClaimWitness,
): WitnessedHistoricalClaim {
  const normalized = normalizedWitness(witness);
  if (!normalized) throw new TypeError('witnessed historical claims require a stable source identity');
  return { origin: 'witnessed', text, witness: normalized };
}

export function derivedHistoricalClaim(text: string): DerivedHistoricalClaim {
  return { origin: 'derived', text };
}

export function synthesizedHistoricalClaim(text: string): SynthesizedHistoricalClaim {
  return { origin: 'synthesized', text };
}

/**
 * Runtime guard for persisted/untyped payloads. A forged witnessed label with
 * no valid source identity is demoted to derived and marked invalid; it can
 * never reach a witnessed rendering position.
 */
export function classifyHistoricalClaim(claim: HistoricalClaim | unknown): RenderedHistoricalClaim {
  if (!claim || typeof claim !== 'object') {
    return { text: '[invalid historical claim]', origin: 'derived', witness: null, valid: false };
  }
  const candidate = claim as { origin?: unknown; text?: unknown; witness?: unknown };
  const text = typeof candidate.text === 'string' ? candidate.text : '[invalid historical claim]';
  const textValid = typeof candidate.text === 'string';
  if (candidate.origin === 'witnessed') {
    const witness = normalizedWitness(candidate.witness);
    if (witness && textValid) return { text, origin: 'witnessed', witness, valid: true };
    return { text, origin: 'derived', witness: null, valid: false };
  }
  const carriesWitness = candidate.witness !== undefined;
  if (candidate.origin === 'synthesized') {
    return { text, origin: 'synthesized', witness: null, valid: textValid && !carriesWitness };
  }
  return {
    text,
    origin: 'derived',
    witness: null,
    valid: candidate.origin === 'derived' && textValid && !carriesWitness,
  };
}

export function isWitnessedHistoricalClaim(claim: HistoricalClaim | unknown): claim is WitnessedHistoricalClaim {
  const classified = classifyHistoricalClaim(claim);
  return classified.origin === 'witnessed' && classified.valid;
}

const RESERVED_ORIGIN_TOKEN_RE = /\[(?=\s*origin\s*=)/giu;

/**
 * Keep payload-authored origin-looking tokens inert. Normal text is returned
 * byte-identically; only the reserved `[` is escaped, after backslashes are
 * doubled so the transform remains reversible.
 */
export function escapeHistoricalClaimText(text: string): string {
  RESERVED_ORIGIN_TOKEN_RE.lastIndex = 0;
  if (!RESERVED_ORIGIN_TOKEN_RE.test(text)) return text;
  RESERVED_ORIGIN_TOKEN_RE.lastIndex = 0;
  return text.replace(/\\/gu, '\\\\').replace(RESERVED_ORIGIN_TOKEN_RE, '\\u005b');
}

export function decodeHistoricalClaimText(text: string): string {
  let decoded = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\\') {
      decoded += text[index];
      continue;
    }
    if (text.startsWith('\\u005b', index)) {
      decoded += '[';
      index += 5;
      continue;
    }
    if (text[index + 1] === '\\') {
      decoded += '\\';
      index += 1;
      continue;
    }
    decoded += text[index];
  }
  return decoded;
}

/** Compact, line-local label: readable without spending source identity twice. */
export function renderHistoricalClaim(claim: HistoricalClaim | unknown): string {
  const classified = classifyHistoricalClaim(claim);
  const invalid = classified.valid ? '' : ' invalid-origin=untrusted-or-mixed';
  return `${escapeHistoricalClaimText(classified.text)} [origin=${classified.origin}${invalid}]`;
}

/** Origin class for whole fold artifacts whose content class is already typed. */
export function chronologicalContentOrigin(
  contentClass:
    | 'raw'
    | 'exact-excerpt'
    | 'synthesized-history'
    | 'retrieved-history'
    | 'reconstructed-state'
    | 'live-state'
    | 'boundary',
): HistoricalClaimOrigin {
  if (contentClass === 'raw' || contentClass === 'exact-excerpt') return 'witnessed';
  if (contentClass === 'synthesized-history' || contentClass === 'reconstructed-state') return 'synthesized';
  return 'derived';
}
