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

/* ------------------------------------------------------------------------
 * Audit-3 A5/C6 (seam S2 conversation-exchange/v1): exchange-native selection.
 *
 * The defect: independent user/assistant quotas plus newest-first overflow let
 * operator floors survive while their replies were evicted (the 23-hour hole:
 * 15 operator rows with zero replies rendered). The exchange model makes the
 * EXCHANGE the selection/eviction unit: one genuine operator row plus its
 * material assistant replies travel together, exchanges are selected
 * newest-first, and the renderer evicts whole exchanges oldest-first.
 *
 * Exchange identity (frozen S2 grammar): the exchange id is the OPERATOR
 * row's id; leading assistant rows before any operator row form the leading
 * exchange `pre:<first-row-id>`. Every selected row carries the tag so the
 * assembler can forward it and the renderer can group by it; untagged legacy
 * rows degrade to one group per row at render (never mis-tagged).
 * --------------------------------------------------------------------- */

/** Audit-3 S2: material assistant replies retained per exchange (newest K). */
export const DEFAULT_REBIRTH_DIALOGUE_EXCHANGE_REPLY_LIMIT = 4;

export interface RebirthDialogueExchangeSelectionOptions {
  /** Newest exchanges guaranteed in the window (operator turn + its replies). */
  readonly maxExchanges: number;
  /** Material assistant replies retained per exchange, newest first kept. */
  readonly maxRepliesPerExchange: number;
  /**
   * Authentic older exchanges admitted whole beyond the exchange floor while
   * this source-character budget remains. Stops at the first exchange that
   * does not fit so chronology never develops a hidden hole (same doctrine as
   * the character backfill above).
   */
  readonly backfillBudgetChars: number;
}

/** Exchange tag attached to every row the exchange selector admits. */
export interface RebirthDialogueExchangeTag {
  readonly exchangeId: string;
}

/** Stability key for one logical streamed message (id minus `:segment-N`). */
function rebirthDialogueMessageBaseId(id: string): string {
  return id.replace(/:segment-\d+$/u, '');
}

/**
 * Select the newest genuine exchanges from an ordered dialogue candidate
 * stream and tag every admitted row with its exchange id.
 *
 * Membership walk is chronological: a genuine-operator row opens a new
 * exchange; every later assistant row joins until the next operator row.
 * Relay-authored user-role rows and non-dialogue rows never start or join an
 * exchange (they were never dialogue). Within an exchange the operator row is
 * always kept; replies keep the NEWEST `maxRepliesPerExchange` logical
 * assistant messages — segment fragments of one streamed message (`:segment-N`
 * continuation ids) count and travel as ONE logical reply so a kept reply
 * never renders headless or tailless.
 */
export function selectRebirthDialogueExchanges<T extends RebirthDialogueMessageLike>(
  messages: readonly T[],
  options: RebirthDialogueExchangeSelectionOptions,
): Array<T & RebirthDialogueExchangeTag> {
  const maxExchanges = positiveInteger(options.maxExchanges);
  const maxReplies = positiveInteger(options.maxRepliesPerExchange);
  const backfillBudget = positiveInteger(options.backfillBudgetChars);
  if (maxExchanges === 0) return [];

  const indexed = messages.map((message, inputIndex) => ({ message, inputIndex }));
  const chronologyKnown = indexed.every(({ message }) => sourceEpochMs(message) !== null);
  const ordered = chronologyKnown
    ? [...indexed].sort((left, right) => (
        sourceEpochMs(left.message)! - sourceEpochMs(right.message)!
        || (left.message.id ?? '').localeCompare(right.message.id ?? '')
        || left.inputIndex - right.inputIndex
      ))
    : indexed;

  interface Exchange {
    readonly id: string;
    /** Operator row first (absent on the leading `pre:` exchange), then replies. */
    readonly operator: { message: T; inputIndex: number } | null;
    readonly replies: Array<{ message: T; inputIndex: number }>;
  }
  const exchanges: Exchange[] = [];
  const openLeadingExchange = (first: { message: T; inputIndex: number }): Exchange => {
    const firstId = first.message.id?.trim() || `row-${first.inputIndex}`;
    const leading: Exchange = { id: `pre:${firstId}`, operator: null, replies: [] };
    exchanges.push(leading);
    return leading;
  };
  for (const row of ordered) {
    const type = row.message.type ?? row.message.ty ?? '';
    const text = (row.message.text ?? row.message.tx)?.trim() ?? '';
    if (!text) continue;
    if (type === 'user') {
      // Relay-authored user-role rows are not dialogue and never consume
      // exchange structure (same predicate as the role-window helpers).
      if (!isGenuineRebirthOperatorMessage(text)) continue;
      exchanges.push({
        id: row.message.id?.trim() || `row-${row.inputIndex}`,
        operator: row,
        replies: [],
      });
      continue;
    }
    if (type !== 'assistant_text') continue;
    const current = exchanges.length > 0 ? exchanges[exchanges.length - 1]! : openLeadingExchange(row);
    current.replies.push(row);
  }

  // Per-exchange content: the operator row plus the newest K logical replies.
  // A fragment run (`base`, `base:segment-1`, …) is one logical reply and is
  // kept or dropped as a run.
  const keptRows = (exchange: Exchange): Array<{ message: T; inputIndex: number }> => {
    if (maxReplies <= 0) return exchange.operator ? [exchange.operator] : [];
    const runs: Array<Array<{ message: T; inputIndex: number }>> = [];
    for (const reply of exchange.replies) {
      const baseId = rebirthDialogueMessageBaseId(reply.message.id?.trim() || `row-${reply.inputIndex}`);
      const previous = runs[runs.length - 1];
      const previousBaseId = previous
        ? rebirthDialogueMessageBaseId(previous[0]!.message.id?.trim() || `row-${previous[0]!.inputIndex}`)
        : null;
      if (previous && previousBaseId === baseId) {
        previous.push(reply);
      } else {
        runs.push([reply]);
      }
    }
    const kept = runs.slice(-maxReplies).flat();
    return exchange.operator ? [exchange.operator, ...kept] : kept;
  };

  // Newest `maxExchanges` exchanges form the guaranteed floor; older exchanges
  // backfill whole while the character budget remains (exchange-granular, so a
  // backfilled operator row always brings its material replies along).
  const floorStart = Math.max(0, exchanges.length - maxExchanges);
  const selected = new Set<number>();
  for (let index = floorStart; index < exchanges.length; index += 1) selected.add(index);
  let admittedChars = 0;
  for (let index = floorStart - 1; index >= 0; index -= 1) {
    const rows = keptRows(exchanges[index]!);
    if (rows.length === 0) continue;
    const chars = rows.reduce((total, row) => total + ((row.message.text ?? row.message.tx) ?? '').trim().length, 0);
    if (admittedChars + chars > backfillBudget) break;
    selected.add(index);
    admittedChars += chars;
  }

  const out: Array<T & RebirthDialogueExchangeTag> = [];
  for (let index = 0; index < exchanges.length; index += 1) {
    if (!selected.has(index)) continue;
    const exchange = exchanges[index]!;
    for (const row of keptRows(exchange)) {
      out.push({ ...row.message, exchangeId: exchange.id });
    }
  }
  return out;
}
