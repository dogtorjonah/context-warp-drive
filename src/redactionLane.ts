/**
 * Continuity redaction lane — the single credential/secret gate applied at
 * every continuity republication boundary: rebirth package renders (push) and
 * continuity-ledger row reads (pull). Nothing republishes before the lane.
 *
 * Redaction is declared, never silent: every redacted span is replaced in
 * place with a self-declaring `[REDACTED:<kind>]` token, and callers can emit
 * an aggregate `[REDACTION-LANE …]` banner via the declaration this module
 * formats. Raw evidence stores (vault, Atlas captures) are deliberately left
 * untouched — the lane governs what gets REPUBLISHED, so recovered raw bytes
 * may legitimately differ from shipped bytes exactly at declared spans.
 *
 * The lane is pure and deterministic: applying it twice to the same input is
 * byte-identical to applying it once (replacement tokens never re-match any
 * rule), so every entry point applies it defensively without coordination.
 */
import { createHash } from 'node:crypto';

export interface ContinuityRedactionRule {
  readonly kind: string;
  readonly pattern: RegExp;
  /** String replacement with $n backrefs; default is `[REDACTED:<kind>]`. */
  readonly replacement?: string;
}

/**
 * Structural, low-false-positive secret patterns (v1, frozen by tests).
 * Order matters: block patterns first, then specific token families, then
 * generic carriers (bearer/assignment) whose inputs the earlier rules may
 * already have rewritten into unmatchable tokens.
 */
export const CONTINUITY_REDACTION_RULES: readonly ContinuityRedactionRule[] = [
  {
    kind: 'private-key-block',
    pattern: /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z0-9 ]{0,32}PRIVATE KEY-----/g,
  },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  {
    kind: 'github-token',
    pattern: /\b(?:gh[posur]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  { kind: 'sk-token', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: 'bearer-token',
    pattern: /\b([Bb]earer)[ \t]+[A-Za-z0-9._~+/-]{20,}=*/g,
    replacement: '$1 [REDACTED:bearer-token]',
  },
  {
    kind: 'url-credential',
    // Brackets excluded from the value class so a replaced token never
    // re-matches on a second pass (idempotency).
    pattern: /(\/\/[^\s/:@]{1,64}):[^\s@/[\]]{1,256}@/g,
    replacement: '$1:[REDACTED:url-credential]@',
  },
  {
    // Labeled assignments only, and the value must look like a credential:
    // 16+ token chars, or 8+ containing a digit. Plain prose values
    // ("secret: rotation") stay untouched.
    kind: 'secret-assignment',
    pattern: /\b(api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|password|passwd)(\s*[:=]\s*)(["']?)(?:[A-Za-z0-9._~+/-]{16,}|(?=[A-Za-z0-9._~+/-]{8,})[A-Za-z0-9._~+/-]*\d[A-Za-z0-9._~+/-]*)\3/gi,
    replacement: '$1$2$3[REDACTED:secret-assignment]$3',
  },
];

export interface RedactionSpanSummary {
  readonly kind: string;
  readonly count: number;
}

export interface RedactionTextResult {
  readonly text: string;
  readonly redacted: boolean;
  readonly spans: readonly RedactionSpanSummary[];
}

const EMPTY_SPANS: readonly RedactionSpanSummary[] = Object.freeze([]);

/** Redact one text through every rule; spans are aggregated per kind. */
export function redactContinuityText(text: string): RedactionTextResult {
  if (!text) return { text, redacted: false, spans: EMPTY_SPANS };
  let out = text;
  let counts: Map<string, number> | null = null;
  for (const rule of CONTINUITY_REDACTION_RULES) {
    const matches = out.match(rule.pattern);
    if (!matches || matches.length === 0) continue;
    out = out.replace(rule.pattern, rule.replacement ?? `[REDACTED:${rule.kind}]`);
    counts ??= new Map<string, number>();
    counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + matches.length);
  }
  if (!counts) return { text, redacted: false, spans: EMPTY_SPANS };
  const spans = Array.from(counts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  return { text: out, redacted: true, spans };
}

const DECLARATION_KIND_CAP = 8;

/**
 * One bounded declaration line for a set of redaction spans, or null when
 * nothing was redacted — the "declared, never silent" aggregate banner.
 */
export function formatRedactionDeclaration(
  spans: readonly RedactionSpanSummary[],
): string | null {
  const total = spans.reduce((sum, span) => sum + span.count, 0);
  if (total === 0) return null;
  const shown = spans.slice(0, DECLARATION_KIND_CAP);
  const kinds = shown.map((span) => `${span.kind}×${span.count}`).join(',');
  const overflow = spans.length > shown.length ? `,+${spans.length - shown.length}-more` : '';
  return `[REDACTION-LANE spans=${total} kinds=${kinds}${overflow}]`;
}

/**
 * Keys whose string values are identities, proofs, or executable recovery
 * coordinates — never republished prose. Redacting a recover handle would
 * break the executed-handle gate; redacting a sha would corrupt a proof.
 */
const SKIP_KEYS: ReadonlySet<string> = new Set([
  'id',
  'sha256',
  'recover',
  'handle',
  'tier',
  'tierBasis',
  'kind',
  'origin',
  'workspace',
  'sourceIdentity',
  'version',
  'lifecycle',
]);
const SKIP_KEY_SUFFIX = /(?:Id|Ids|Handle|Key|Sha256|Time|At)$/;

function isSkippedKey(key: string): boolean {
  return SKIP_KEYS.has(key) || SKIP_KEY_SUFFIX.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface WalkState {
  counts: Map<string, number>;
}

function tallySpans(state: WalkState, spans: readonly RedactionSpanSummary[]): void {
  for (const span of spans) {
    state.counts.set(span.kind, (state.counts.get(span.kind) ?? 0) + span.count);
  }
}

function walkValue(value: unknown, state: WalkState): unknown {
  if (typeof value === 'string') {
    const result = redactContinuityText(value);
    if (!result.redacted) return value;
    tallySpans(state, result.spans);
    return result.text;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const walked = walkValue(entry, state);
      if (walked !== entry) changed = true;
      return walked;
    });
    return changed ? next : value;
  }
  if (isPlainObject(value)) return walkObject(value, state);
  return value;
}

function walkObject(obj: Record<string, unknown>, state: WalkState): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(obj)) {
    if (typeof entry === 'string' && isSkippedKey(key)) {
      next[key] = entry;
      continue;
    }
    const walked = walkValue(entry, state);
    if (walked !== entry) changed = true;
    next[key] = walked;
  }
  if (!changed) return obj;
  // Proof maintenance: when redaction changed a unit's verbatim AND the prior
  // sha genuinely attested the prior bytes, re-mint over the redacted bytes so
  // downstream mint gates (worker hash check) keep holding. A sha that never
  // matched its bytes is left stale — the lane maintains proofs it disturbed,
  // it never launders broken ones into looking verified.
  const prevVerbatim = obj.verbatim;
  const nextVerbatim = next.verbatim;
  const prevSha = obj.sha256;
  if (
    typeof prevVerbatim === 'string'
    && typeof nextVerbatim === 'string'
    && nextVerbatim !== prevVerbatim
    && typeof prevSha === 'string'
    && /^[0-9a-f]{64}$/i.test(prevSha)
    && createHash('sha256').update(prevVerbatim, 'utf8').digest('hex') === prevSha.toLowerCase()
  ) {
    next.sha256 = createHash('sha256').update(nextVerbatim, 'utf8').digest('hex');
  }
  return next;
}

export interface ContinuityModelRedactionResult<T extends object> {
  readonly model: T;
  readonly spans: readonly RedactionSpanSummary[];
  /** Aggregate banner, or null when the model carried no secret spans. */
  readonly declaration: string | null;
}

const MODEL_CACHE = new WeakMap<object, ContinuityModelRedactionResult<object>>();

/**
 * Push-side lane: redact every republishable string in a continuity model
 * (identity/proof/handle keys skipped), preserving object identity along
 * unchanged paths. Deterministic and cached: the input and the redacted output
 * both resolve to the same result, so render, envelope, and ledger-capture
 * entry points can each apply the lane and stay byte-consistent.
 */
export function redactContinuityModel<T extends object>(model: T): ContinuityModelRedactionResult<T> {
  const cached = MODEL_CACHE.get(model);
  if (cached) return cached as ContinuityModelRedactionResult<T>;
  const state: WalkState = { counts: new Map<string, number>() };
  const walked = walkValue(model, state) as T;
  const spans = Array.from(state.counts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const result: ContinuityModelRedactionResult<T> = {
    model: walked,
    spans,
    declaration: formatRedactionDeclaration(spans),
  };
  MODEL_CACHE.set(model, result);
  if (walked !== (model as object)) MODEL_CACHE.set(walked, result);
  return result;
}
