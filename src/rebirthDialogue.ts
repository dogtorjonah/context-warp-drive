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
 * Reject relay-authored user-role control rows while retaining operator prose
 * that merely contains or discusses the same words. This predicate is shared
 * by worker hydration and every renderer so coverage cannot drift by path.
 */
export function isGenuineRebirthOperatorMessage(text: string | null | undefined): boolean {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return false;
  if (isChatroomDelivery(trimmed)) return false;
  if (/^@\w+/u.test(trimmed) && trimmed.length < 200) return false;
  if (/^\[(?:DIGEST DELTA|Digest Delta|RELAY DIGEST DELTA|Control Signals|System)\]/u.test(trimmed)) {
    return false;
  }
  if (/^\[(?:long-horizon-continue|sidequest-cleanup)\b/iu.test(trimmed)) return false;
  if (/^🏁 Your agent ".+" \(.+\) is done\./u.test(trimmed)) return false;
  if (/^\[(?:CONTEXT REBIRTH|INSTANCE RESURRECTED|FIXER MODE BATCH #\d+)\]/u.test(trimmed)) {
    return false;
  }
  if (/^\[Chronological Provenance v\d+\]/u.test(trimmed)) return false;
  if (/^package_version:\s*\d+\s*\n\[CONTEXT REBIRTH\]/u.test(trimmed)) return false;
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
