/**
 * Provider-neutral pending-assistant-action continuity.
 *
 * Assistant promises/progress are executable state. The state is reduced from
 * raw speech, serialized into authenticated epoch capsules, and carried until
 * later completion/cancellation evidence — or a substantive genuine operator
 * message, which supersedes the commitment (authority order: later operator >
 * pending action) — emits a tombstone. Silence, tool rows, continuation
 * nudges ("continue", "ok"), non-genuine user rows (chatroom deliveries,
 * digest frames), malformed capsules, and quoted capsule text never mutate it.
 *
 * Pure CPU, deterministic, zero I/O.
 */

import { parseRegisterGlyph } from './glyphs.ts';
import { isPortableGenuineOperatorMessage } from './rebirthDialogue.ts';
import {
  extractAssistantText,
  extractUserText,
  type FoldMessage,
  type SyntheticContextOptions,
} from './rollingFold.ts';

export const PENDING_ASSISTANT_ACTION_MAX_CHARS = 1_400;
export const PENDING_ASSISTANT_ACTION_STATE_VERSION = 1 as const;
/** Shared literal used by the renderer and the structural state parser. */
export const PENDING_ASSISTANT_ACTION_CAPSULE_HEADER = '[Epoch Continuity Capsule]';
export const PENDING_ASSISTANT_ACTION_STATE_PREFIX = 'pending_assistant_state: ';

export type PendingAssistantActionBasis = 'assistant-register' | 'assistant-commitment';
export type PendingAssistantActionSourceUnit = 'event' | 'message';
export type PendingAssistantSettlementReason =
  | 'assistant-final'
  | 'assistant-cancelled'
  | 'operator-cancelled'
  | 'operator-superseded';

export interface PendingAssistantActionSource {
  /** Exact provider/persisted identity only. Synthetic positions stay null. */
  readonly id: string | null;
  /** Original source time only. Capture/render time is never substituted. */
  readonly timestamp: string | null;
  readonly unit: PendingAssistantActionSourceUnit;
  /** Absolute coordinate in `unit`; unknown stays null. */
  readonly index: number | null;
}

export interface PendingAssistantAction {
  readonly text: string;
  readonly status: 'unresolved';
  readonly basis: PendingAssistantActionBasis;
  readonly source: PendingAssistantActionSource;
}

export interface PendingAssistantSettlement {
  readonly reason: PendingAssistantSettlementReason;
  readonly source: PendingAssistantActionSource;
}

export type PendingAssistantContinuityState =
  | {
      readonly version: typeof PENDING_ASSISTANT_ACTION_STATE_VERSION;
      readonly state: 'unknown';
    }
  | {
      readonly version: typeof PENDING_ASSISTANT_ACTION_STATE_VERSION;
      readonly state: 'unresolved';
      readonly action: PendingAssistantAction;
    }
  | {
      readonly version: typeof PENDING_ASSISTANT_ACTION_STATE_VERSION;
      readonly state: 'none';
      readonly settledBy: PendingAssistantSettlement | null;
    };

export type PendingAssistantActionTransition =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'opened'; readonly action: PendingAssistantAction }
  | { readonly kind: 'settled'; readonly settlement: PendingAssistantSettlement };

export interface ReducePendingAssistantContinuityOptions {
  readonly syntheticContext?: SyntheticContextOptions;
  readonly sourceUnit?: PendingAssistantActionSourceUnit;
  /** Absolute coordinate corresponding to messages[0]. */
  readonly sourceIndexOffset?: number;
  /** Optional per-message absolute coordinates when the projection is sparse. */
  readonly sourceIndexes?: readonly (number | null | undefined)[];
}

export function unknownPendingAssistantContinuityState(): PendingAssistantContinuityState {
  return { version: PENDING_ASSISTANT_ACTION_STATE_VERSION, state: 'unknown' };
}

export function unresolvedPendingAssistantContinuityState(
  action: PendingAssistantAction,
): PendingAssistantContinuityState {
  return { version: PENDING_ASSISTANT_ACTION_STATE_VERSION, state: 'unresolved', action };
}

export function settledPendingAssistantContinuityState(
  settledBy: PendingAssistantSettlement | null,
): PendingAssistantContinuityState {
  return { version: PENDING_ASSISTANT_ACTION_STATE_VERSION, state: 'none', settledBy };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isPendingAssistantActionSource(value: unknown): value is PendingAssistantActionSource {
  if (!isRecord(value)) return false;
  return isNullableString(value.id)
    && isNullableString(value.timestamp)
    && (value.unit === 'event' || value.unit === 'message')
    && (value.index === null || (typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0));
}

export function isPendingAssistantAction(value: unknown): value is PendingAssistantAction {
  if (!isRecord(value)) return false;
  return typeof value.text === 'string'
    && value.text.trim().length > 0
    && value.status === 'unresolved'
    && (value.basis === 'assistant-register' || value.basis === 'assistant-commitment')
    && isPendingAssistantActionSource(value.source);
}

function isPendingAssistantSettlement(value: unknown): value is PendingAssistantSettlement {
  if (!isRecord(value)) return false;
  return (
    value.reason === 'assistant-final'
    || value.reason === 'assistant-cancelled'
    || value.reason === 'operator-cancelled'
    || value.reason === 'operator-superseded'
  ) && isPendingAssistantActionSource(value.source);
}

export function isPendingAssistantContinuityState(
  value: unknown,
): value is PendingAssistantContinuityState {
  if (!isRecord(value) || value.version !== PENDING_ASSISTANT_ACTION_STATE_VERSION) return false;
  if (value.state === 'unknown') return true;
  if (value.state === 'unresolved') return isPendingAssistantAction(value.action);
  if (value.state === 'none') {
    return value.settledBy === null || isPendingAssistantSettlement(value.settledBy);
  }
  return false;
}

const COMMITMENT_CUES = [
  /\b(?:i['’]ll|i will|i['’]m going to|i am going to|let me)\s+(?:now\s+)?(?:check|verify|validate|inspect|trace|test|run|look|review|investigate|fix|patch|update|change|edit|build|create|write|implement|wire|compare|confirm|measure|reproduce|finish|continue|resume|open|read|find|determine|work)\b/giu,
  /\b(?:i['’]m|i am)\s+(?:now\s+)?(?:checking|verifying|validating|inspecting|tracing|testing|running|looking|reviewing|investigating|fixing|patching|updating|changing|editing|building|creating|writing|implementing|wiring|comparing|confirming|measuring|reproducing|continuing|resuming|working)\b/giu,
  /\b(?:next|now|first|then)\s*,?\s+i(?:['’]ll| will)\b/giu,
] as const;

const SETTLEMENT_CUES = [
  /\b(?:done|completed|finished|resolved|fixed|implemented|verified|validated|confirmed|tested|checked)\b/giu,
  /\bi(?:['’]ve| have)\s+(?:now\s+)?(?:completed|finished|resolved|fixed|implemented|verified|validated|confirmed|tested|checked)\b/giu,
] as const;

const ASSISTANT_CANCELLATION_CUES = [
  /\bi\s+(?:will not|won['’]t|should not|am not going to)\s+(?:continue|proceed|resume|check|verify|inspect|test|run|fix|patch|update|change|edit|build|implement|work)\b/giu,
  /\bi(?:['’]m| am)\s+(?:stopping|cancelling|canceling|dropping|abandoning)\b/giu,
] as const;

const OPERATOR_CANCELLATION_CUES = [
  /^\s*(?:stop|cancel that|never\s*mind|skip that)(?:\b|[.!])/iu,
  /\b(?:do not|don['’]t)\s+(?:continue|proceed|resume|check|verify|inspect|test|run|fix|patch|update|change|edit|build|implement|work on)\b/iu,
] as const;

/**
 * Whole-message continuation endorsements. A nudge ratifies the open
 * commitment instead of superseding it, so matching is deliberately exact
 * over a closed list (after trimming and dropping terminal punctuation):
 * operator text carrying anything beyond one of these forms is a genuine
 * redirect and settles the register as operator-superseded.
 */
const OPERATOR_CONTINUATION_NUDGES: ReadonlySet<string> = new Set([
  'continue', 'please continue', 'continue please', 'keep going', 'keep at it',
  'carry on', 'go', 'go on', 'go ahead', 'proceed', 'do it', 'do that',
  'yes', 'y', 'yes please', 'yeah', 'yep', 'ya', 'sure', 'sure thing',
  'ok', 'okay', 'k', 'kk', 'ok continue', 'okay continue', 'ok keep going',
  'sounds good', 'good', 'nice', 'great', 'perfect', 'cool', 'love it',
  'thanks', 'thank you', 'ty', 'thx', 'lgtm', 'approved', '👍',
]);

function operatorContinuationNudge(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s.!…]+$/u, '');
  return OPERATOR_CONTINUATION_NUDGES.has(normalized);
}

function lastMatchIndex(text: string, patterns: readonly RegExp[]): number {
  let latest = -1;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      latest = Math.max(latest, match.index);
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
    pattern.lastIndex = 0;
  }
  return latest;
}

/** Classify one assistant text without inventing state from generic prose. */
export function classifyPendingAssistantActionText(
  text: string,
): PendingAssistantActionBasis | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const register = parseRegisterGlyph(trimmed, { asciiAliases: true });
  if (register.ok) {
    if (register.register === 'executing' || register.register === 'in_progress') {
      return 'assistant-register';
    }
    return null;
  }

  const commitmentAt = lastMatchIndex(trimmed, COMMITMENT_CUES);
  if (commitmentAt < 0) return null;
  const settledAt = Math.max(
    lastMatchIndex(trimmed, SETTLEMENT_CUES),
    lastMatchIndex(trimmed, ASSISTANT_CANCELLATION_CUES),
  );
  return commitmentAt > settledAt ? 'assistant-commitment' : null;
}

function assistantSettlementReason(text: string): PendingAssistantSettlementReason | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const register = parseRegisterGlyph(trimmed, { asciiAliases: true });
  if (register.ok && register.classification.final) return 'assistant-final';
  const cancelledAt = lastMatchIndex(trimmed, ASSISTANT_CANCELLATION_CUES);
  const settledAt = lastMatchIndex(trimmed, SETTLEMENT_CUES);
  const commitmentAt = lastMatchIndex(trimmed, COMMITMENT_CUES);
  const terminalAt = Math.max(cancelledAt, settledAt);
  if (terminalAt < 0 || terminalAt < commitmentAt) return null;
  return cancelledAt >= settledAt ? 'assistant-cancelled' : 'assistant-final';
}

function operatorExplicitlyCancels(text: string): boolean {
  return OPERATOR_CANCELLATION_CUES.some((pattern) => pattern.test(text));
}

function originalSourceTimestamp(message: FoldMessage): string | null {
  if (typeof message.tsMs !== 'number' || !Number.isFinite(message.tsMs)) return null;
  return new Date(message.tsMs).toISOString();
}

function canonicalSource(
  message: FoldMessage,
  index: number,
  options: ReducePendingAssistantContinuityOptions,
): PendingAssistantActionSource {
  const rawIdentity = message.sourceIdentity?.trim();
  const identityAuthority = message.sourceIdentityAuthority;
  const id = rawIdentity && identityAuthority !== 'synthetic-position' ? rawIdentity : null;
  const explicitIndex = options.sourceIndexes?.[index];
  const offset = options.sourceIndexOffset;
  const sourceIndex = explicitIndex === null
    ? null
    : typeof explicitIndex === 'number' && Number.isSafeInteger(explicitIndex) && explicitIndex >= 0
      ? explicitIndex
      : typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0
        ? offset + index
        : index;
  return {
    id,
    timestamp: originalSourceTimestamp(message),
    unit: options.sourceUnit ?? 'message',
    index: sourceIndex,
  };
}

/**
 * Reduce one raw source window to explicit evidence. Synthetic messages are
 * always inert here; trusted capsule state is consumed only through the
 * structural trusted-carrier reader below.
 */
export function derivePendingAssistantActionTransition(
  messages: readonly FoldMessage[],
  options: ReducePendingAssistantContinuityOptions = {},
): PendingAssistantActionTransition {
  let transition: PendingAssistantActionTransition = { kind: 'unchanged' };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.contextWarpSynthetic) continue;

    if (message.role === 'user') {
      const userText = extractUserText([message], options.syntheticContext).trim();
      if (userText && operatorExplicitlyCancels(userText)) {
        transition = {
          kind: 'settled',
          settlement: {
            reason: 'operator-cancelled',
            source: canonicalSource(message, index, options),
          },
        };
      } else if (
        userText
        && !userText.includes(PENDING_ASSISTANT_ACTION_CAPSULE_HEADER)
        && isPortableGenuineOperatorMessage(userText)
        && !operatorContinuationNudge(userText)
      ) {
        // A substantive genuine operator message outranks any earlier open
        // commitment (authority order: later operator > pending action).
        // Settling here is what stops a finished conversation from re-issuing
        // a stale chore after the next fold; the successor takes direction
        // from the operator line itself, which continuity carries separately
        // (active request / operator vault). Continuation nudges ratify the
        // commitment; non-genuine user rows (chatroom deliveries, digest
        // frames) stay inert; capsule-quoting text stays inert too, keeping
        // the module's anti-echo invariant intact for raw user rows.
        transition = {
          kind: 'settled',
          settlement: {
            reason: 'operator-superseded',
            source: canonicalSource(message, index, options),
          },
        };
      }
      continue;
    }
    if (message.role !== 'assistant' && message.role !== 'model') continue;
    const text = extractAssistantText([message]).trim();
    if (!text) continue;

    const basis = classifyPendingAssistantActionText(text);
    if (basis) {
      transition = {
        kind: 'opened',
        action: {
          text: text.slice(0, PENDING_ASSISTANT_ACTION_MAX_CHARS),
          status: 'unresolved',
          basis,
          source: canonicalSource(message, index, options),
        },
      };
      continue;
    }
    const reason = assistantSettlementReason(text);
    if (reason) {
      transition = {
        kind: 'settled',
        settlement: { reason, source: canonicalSource(message, index, options) },
      };
    }
  }
  return transition;
}

export function reducePendingAssistantContinuity(
  prior: PendingAssistantContinuityState | null | undefined,
  messages: readonly FoldMessage[],
  options: ReducePendingAssistantContinuityOptions = {},
): PendingAssistantContinuityState {
  const current = prior && isPendingAssistantContinuityState(prior)
    ? prior
    : unknownPendingAssistantContinuityState();
  const transition = derivePendingAssistantActionTransition(messages, options);
  if (transition.kind === 'opened') return unresolvedPendingAssistantContinuityState(transition.action);
  if (transition.kind === 'settled') return settledPendingAssistantContinuityState(transition.settlement);
  return current;
}

/**
 * Reduce a complete chronological view containing both trusted folded carriers
 * and ordinary raw messages. Carried state is applied at its exact position;
 * only later raw evidence may replace it. This prevents raw rows that predate a
 * capsule from being replayed after that capsule and resurrecting elder work.
 */
export function reducePendingAssistantContinuityTimeline(
  messages: readonly FoldMessage[],
  options: ReducePendingAssistantContinuityOptions = {},
): PendingAssistantContinuityState {
  let state = unknownPendingAssistantContinuityState();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.contextWarpSynthetic === 'folded-context' && typeof message.content === 'string') {
      const carried = parsePendingAssistantActionCapsule(message.content);
      if (carried && carried.state !== 'unknown') state = carried;
      continue;
    }
    const explicitIndex = options.sourceIndexes?.[index];
    const offset = options.sourceIndexOffset;
    state = reducePendingAssistantContinuity(state, [message], {
      syntheticContext: options.syntheticContext,
      sourceUnit: options.sourceUnit,
      sourceIndexOffset: typeof offset === 'number' ? offset + index : index,
      ...(explicitIndex === null || typeof explicitIndex === 'number'
        ? { sourceIndexes: [explicitIndex] }
        : {}),
    });
  }
  return state;
}

/** First-window compatibility helper. Durable hosts should retain the full state union. */
export function derivePendingAssistantAction(
  messages: readonly FoldMessage[],
  syntheticContext?: SyntheticContextOptions,
): PendingAssistantAction | null {
  const state = reducePendingAssistantContinuity(undefined, messages, { syntheticContext });
  return state.state === 'unresolved' ? state.action : null;
}

/**
 * Parse the newest versioned state record from canonical capsule bytes.
 * Trust is intentionally NOT inferred here; callers must authenticate the
 * carrier (ledger-owned/fold-engine synthetic) before applying the result.
 * Legacy capsules and malformed records return undefined/unchanged.
 */
export function parsePendingAssistantActionCapsule(
  text: string,
): PendingAssistantContinuityState | undefined {
  const lines = text.split(/\r?\n/u);
  let latest: PendingAssistantContinuityState | undefined;
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start]?.trim() !== PENDING_ASSISTANT_ACTION_CAPSULE_HEADER) continue;
    let end = start + 1;
    while (end < lines.length && lines[end]?.trim() !== PENDING_ASSISTANT_ACTION_CAPSULE_HEADER) {
      end += 1;
    }
    const block = lines.slice(start + 1, end);
    if (
      !block.some((line) => line.startsWith('pointers: '))
      || !block.some((line) => line.startsWith('source: canonical '))
    ) {
      start = end - 1;
      continue;
    }
    const stateRows = block.filter((line) => line.startsWith(PENDING_ASSISTANT_ACTION_STATE_PREFIX));
    if (stateRows.length !== 1) {
      start = end - 1;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(
        stateRows[0].slice(PENDING_ASSISTANT_ACTION_STATE_PREFIX.length),
      );
      if (isPendingAssistantContinuityState(parsed)) latest = parsed;
    } catch {
      // Malformed state is unknown/unchanged, never an implicit clear.
    }
    start = end - 1;
  }
  return latest;
}

/**
 * Resolve state only from host-authenticated folded carriers. An unresolved or
 * none record replaces elder state; unknown records and legacy absence do not.
 */
export function readPendingAssistantContinuityFromTrustedMessages(
  messages: readonly FoldMessage[],
): PendingAssistantContinuityState {
  let state = unknownPendingAssistantContinuityState();
  for (const message of messages) {
    if (message.contextWarpSynthetic !== 'folded-context') continue;
    if (typeof message.content !== 'string') continue;
    const parsed = parsePendingAssistantActionCapsule(message.content);
    if (!parsed || parsed.state === 'unknown') continue;
    state = parsed;
  }
  return state;
}

/** Return the executable action only when the full state says unresolved. */
export function pendingAssistantActionFromState(
  state: PendingAssistantContinuityState | null | undefined,
): PendingAssistantAction | null {
  return state?.state === 'unresolved' ? state.action : null;
}
