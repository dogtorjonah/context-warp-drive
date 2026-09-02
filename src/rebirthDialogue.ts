/**
 * Pure, provider-agnostic selection for the readable rebirth dialogue window.
 *
 * Dialogue roles have independent quotas. Tool/thought/status rows are admitted
 * through a smaller ambient quota, so a tool-heavy turn can never crowd every
 * persisted operator request out of the successor's Current Thread.
 */

export interface RebirthDialogueMessageLike {
  readonly id?: string;
  readonly type?: string;
  readonly text?: string | null;
  readonly ty?: string;
  readonly tx?: string | null;
  readonly created_at?: string;
  readonly ts?: string;
}

export interface RebirthDialogueWindowOptions {
  readonly recentUserMessages: number;
  readonly recentAssistantMessages: number;
  readonly recentAmbientMessages: number;
}

export interface RebirthDialogueBackfillOptions extends RebirthDialogueWindowOptions {
  /** Authentic older dialogue admitted beyond the guaranteed role quotas. */
  readonly backfillBudgetChars: number;
}

export interface RebirthDialogueHydrationOptions {
  /** Independent correctness floor for genuine operator rows. */
  readonly recentUserMessages: number;
  /** Independent correctness floor for assistant rows. */
  readonly recentAssistantMessages: number;
  /** Total bounded persisted-message source window available to backfill. */
  readonly transcriptMessageBudget: number;
}

export interface RebirthDialogueWindowCoverage {
  readonly persistedGenuineUsers: number;
  readonly persistedAssistants: number;
  readonly selectedGenuineUsers: number;
  readonly selectedAssistants: number;
  readonly selectedAmbient: number;
}

export interface RebirthDialogueWindow<T> {
  readonly messages: T[];
  readonly coverage: RebirthDialogueWindowCoverage;
}

/** Small non-dialogue belt retained for tool/thought provenance around turns. */
export const DEFAULT_REBIRTH_AMBIENT_MESSAGE_LIMIT = 8;

function positiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function isChatroomDelivery(text: string): boolean {
  return text.startsWith('[Chat Room "')
    || /^── .+ in #.+ ──(?:\n|$)/u.test(text);
}

/**
 * Review-wave prompts drive a successor through a user-role provider message,
 * but they are authored by the relay rather than by the operator. New prompts
 * carry an explicit marker. The structural fallback keeps already-persisted
 * pre-marker prompts out of genuine-user quotas without rejecting ordinary
 * operator prose that merely discusses review waves.
 */
export function isRelayGeneratedReviewWaveMessage(text: string | null | undefined): boolean {
  const trimmed = text?.trimStart() ?? '';
  if (!trimmed) return false;
  if (/^\[RELAY WAVE DIRECTIVE\b[^\]]*\]/u.test(trimmed)) return true;
  if (/^(?:Predecessor Review Protocol|(?:Review \+ Fix|Improve|Investigate|Load-Rail|Decompose|Shoot-Rail|Review Rail Shot|Exploration|Find Work|Bug Hunter|Research|Documentation) Wave Protocol)(?:\n|$)/u.test(trimmed)) {
    return true;
  }
  return trimmed.includes('\nCurrent wave launch\n')
    && trimmed.includes('\nPhase marker\nCurrent phase:')
    && trimmed.includes('\nWave room\n')
    && trimmed.includes('\nWave completion escape hatch\n');
}

/**
 * Reject relay-authored user-role control rows while retaining operator prose
 * that merely contains or discusses the same words. This predicate is shared
 * by worker hydration and every renderer so coverage cannot drift by path.
 */
export function isGenuineRebirthOperatorMessage(text: string | null | undefined): boolean {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return false;
  if (isChatroomDelivery(trimmed)) return false;
  if (isRelayGeneratedReviewWaveMessage(trimmed)) return false;
  if (/^@\w+/u.test(trimmed) && trimmed.length < 200) return false;
  if (/^\[(?:DIGEST DELTA|Digest Delta|RELAY DIGEST DELTA|Control Signals|System)\]/u.test(trimmed)) {
    return false;
  }
  // Relay signaling deliveries are authoring frames, not operator requests.
  // They are NOT genuine-user messages and must never consume genuine-operator
  // dialogue quota even when their text is later relayed into a trace. Control
  // signals are prefixed `control signal from <sender>` at delivery
  // (build-queue / forge job / peer). Follow-up: the persistence path stamps
  // og:'relay' on signals end-to-end so classification stops depending on text.
  if (/^control signal from\b/iu.test(trimmed) || /^\[Control Signal from\b/u.test(trimmed)) {
    return false;
  }
  // `sidequest-cleanup` is retired as an active lifecycle surface, but its
  // persisted user-role rows remain historical synthetic input forever.
  if (/^\[(?:long-horizon-continue|sidequest-cleanup)\b/iu.test(trimmed)) return false;
  // Atlas-debt nudges are relay-authored lifecycle rows persisted with a user
  // role (statusChange.ts buildAtlasDebtNudge, persistUserMessage: true). They
  // are never operator requests and must not consume genuine-user quota.
  if (/^\[atlas-debt\]/iu.test(trimmed)) return false;
  if (/^🏁 Your agent ".+" \(.+\) is done\./u.test(trimmed)) return false;
  if (/^\[(?:CONTEXT REBIRTH|INSTANCE RESURRECTED|FIXER MODE BATCH #\d+)\]/u.test(trimmed)) {
    return false;
  }
  if (/^\[Chronological Provenance v\d+\]/u.test(trimmed)) return false;
  if (/^package_version:\s*\d+\s*\n\[CONTEXT REBIRTH\]/u.test(trimmed)) return false;
  return true;
}

/**
 * Genuine-operator filter shared with band-enrichment modules: true when a
 * user-role message is an actual operator turn rather than a chatroom
 * delivery, mention ping, digest delta, or ephemeral-only coordination frame.
 * Canonical home is here beside its base predicate so low-level continuity
 * reducers can consume it without importing the seed renderer (which itself
 * imports those reducers); rawRebirthSeed re-exports it for existing callers.
 */
export function isPortableGenuineOperatorMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!isGenuineRebirthOperatorMessage(trimmed)) return false;
  // Strip known ephemeral coordination markers
  const stripped = trimmed
    .replace(/\[DIGEST DELTA[^\]]*\][\s\S]*?\[END DIGEST DELTA\]/g, '')
    .replace(/\[Control Signals\][\s\S]*?\[\/Control Signals\]/g, '')
    .trim();
  if (stripped.length === 0) return false;
  return true;
}

function pushBounded<T>(target: Array<{ message: T; index: number }>, value: { message: T; index: number }, limit: number): void {
  if (limit <= 0) return;
  target.push(value);
  if (target.length > limit) target.shift();
}

function sourceEpochMs(message: RebirthDialogueMessageLike): number | null {
  const sourceTime = message.created_at ?? message.ts;
  if (!sourceTime) return null;
  const parsed = Date.parse(sourceTime);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Keep the newest genuine users and assistants independently, then add only a
 * bounded amount of ambient tool/thought context from the same recent span.
 * Returned rows retain their original chronological interleaving.
 */
export function selectRoleAwareRebirthDialogueWindow<T extends RebirthDialogueMessageLike>(
  messages: readonly T[],
  options: RebirthDialogueWindowOptions,
): RebirthDialogueWindow<T> {
  const userLimit = positiveInteger(options.recentUserMessages);
  const assistantLimit = positiveInteger(options.recentAssistantMessages);
  const ambientLimit = positiveInteger(options.recentAmbientMessages);
  const users: Array<{ message: T; index: number }> = [];
  const assistants: Array<{ message: T; index: number }> = [];
  const ambient: Array<{ message: T; index: number }> = [];
  let persistedGenuineUsers = 0;
  let persistedAssistants = 0;

  const indexed = messages.map((message, index) => ({ message, inputIndex: index }));
  const sourceChronologyKnown = indexed.every(({ message }) => sourceEpochMs(message) !== null);
  const ordered = sourceChronologyKnown
    ? indexed.sort((left, right) => (
        sourceEpochMs(left.message)! - sourceEpochMs(right.message)!
        || (left.message.id ?? '').localeCompare(right.message.id ?? '')
        || left.inputIndex - right.inputIndex
      ))
    : indexed;

  ordered.forEach(({ message }, index) => {
    const type = message.type ?? message.ty ?? '';
    const text = (message.text ?? message.tx)?.trim();
    if (!text) return;
    const candidate = { message, index };
    if (type === 'user') {
      if (!isGenuineRebirthOperatorMessage(text)) return;
      persistedGenuineUsers += 1;
      pushBounded(users, candidate, userLimit);
      return;
    }
    if (type === 'assistant_text') {
      persistedAssistants += 1;
      pushBounded(assistants, candidate, assistantLimit);
      return;
    }
    pushBounded(ambient, candidate, ambientLimit);
  });

  const selected = [...users, ...assistants, ...ambient]
    .sort((left, right) => left.index - right.index)
    .map(({ message }) => message);
  return {
    messages: selected,
    coverage: {
      persistedGenuineUsers,
      persistedAssistants,
      selectedGenuineUsers: users.length,
      selectedAssistants: assistants.length,
      selectedAmbient: ambient.length,
    },
  };
}

/**
 * Preserve independent role quotas as a guaranteed recent floor, then extend
 * backward with genuine dialogue while an explicit source-character budget
 * remains. The extension never invents or slices a row: if the next older row
 * does not fit, selection stops so chronology does not develop a hidden hole.
 */
export function selectRoleAwareRebirthDialogueWithBackfill<T extends RebirthDialogueMessageLike>(
  messages: readonly T[],
  options: RebirthDialogueBackfillOptions,
): RebirthDialogueWindow<T> {
  const base = selectRoleAwareRebirthDialogueWindow(messages, options);
  const budget = positiveInteger(options.backfillBudgetChars);
  if (budget === 0) return base;

  const expanded = selectRoleAwareRebirthDialogueWindow(messages, {
    recentUserMessages: messages.length,
    recentAssistantMessages: messages.length,
    recentAmbientMessages: options.recentAmbientMessages,
  });
  const selected = new Set(base.messages);
  let admittedChars = 0;
  for (let index = expanded.messages.length - 1; index >= 0; index -= 1) {
    const message = expanded.messages[index];
    if (selected.has(message)) continue;
    const chars = ((message.text ?? message.tx) ?? '').trim().length;
    if (admittedChars + chars > budget) break;
    selected.add(message);
    admittedChars += chars;
  }

  const selectedMessages = expanded.messages.filter((message) => selected.has(message));
  let selectedGenuineUsers = 0;
  let selectedAssistants = 0;
  let selectedAmbient = 0;
  for (const message of selectedMessages) {
    const type = message.type ?? message.ty ?? '';
    if (type === 'user') selectedGenuineUsers += 1;
    else if (type === 'assistant_text') selectedAssistants += 1;
    else selectedAmbient += 1;
  }
  return {
    messages: selectedMessages,
    coverage: {
      ...expanded.coverage,
      selectedGenuineUsers,
      selectedAssistants,
      selectedAmbient,
    },
  };
}

/**
 * Normalize independent role floors and the total bounded source window.
 * Source capacity is deliberately not promoted into a per-role requirement:
 * doing so makes a 1,000-row source window demand 1,000 users plus 1,000
 * assistants and forces a full-history scan on every mature trace.
 */
export function resolveRebirthDialogueHydrationLimits(
  options: RebirthDialogueHydrationOptions,
): RebirthDialogueHydrationOptions {
  return {
    recentUserMessages: positiveInteger(options.recentUserMessages),
    recentAssistantMessages: positiveInteger(options.recentAssistantMessages),
    transcriptMessageBudget: positiveInteger(options.transcriptMessageBudget),
  };
}
