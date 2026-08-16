/**
 * Open Loop Ledger: a consolidated, state-labeled view of unfinished work
 * carried into a rebirth package. The ❓ blocked-register trail is the only
 * durable source today, so entries start as `blocked`; operator messages are
 * then scanned newest-first for detour ("pause") vs redirect ("supersede")
 * markers and the latest directive wins — the classifier is explicitly
 * heuristic and renders a label saying so. Pure string machinery, no I/O.
 */

export type OpenLoopState = 'active' | 'paused-by-user' | 'blocked' | 'superseded' | 'done';

export interface OpenLoopLedgerEntry {
  text: string;
  state: OpenLoopState;
}

export interface OpenLoopCandidate {
  text: string;
  basis: 'blocked-register' | 'pending-action' | 'rail-step';
  /** pending-action settlement; undefined = still open */
  settled?: boolean;
}

/** Detour markers — the operator paused the current objective, not abandoned it. */
export const PAUSE_MARKERS: readonly string[] = [
  'hold on',
  'hang on',
  'wait —',
  'wait,',
  'wait a second',
  'pause',
  'before you continue',
  'not yet',
  'first answer',
  'stop for a second',
  'one sec',
  'one second',
];

/** Redirect markers — the operator abandoned the prior objective. */
export const SUPERSEDE_MARKERS: readonly string[] = [
  'never mind',
  'nevermind',
  'forget that',
  'forget it',
  'scratch that',
  'change of plans',
  'do this instead',
  'instead do',
  'actually do',
  "let's do",
  'new plan',
];

export const OPEN_LOOP_LEDGER_MAX_ENTRIES = 10;
export const OPEN_LOOP_LEDGER_ENTRY_MAX_CHARS = 160;

/**
 * Classify candidates against operator texts (caller passes them NEWEST-FIRST
 * so the latest directive wins). A supersede marker supersedes every non-done
 * entry; a pause marker demotes `active` entries to `paused-by-user`;
 * blocked-register entries stay `blocked` unless superseded. Settled
 * pending actions are `done` and are never reclassified.
 */
export function classifyOpenLoopStates(
  candidates: readonly OpenLoopCandidate[],
  operatorTexts: readonly string[],
): OpenLoopLedgerEntry[] {
  const entries: OpenLoopLedgerEntry[] = candidates.map((candidate) => {
    if (candidate.settled === true) {
      return { text: candidate.text, state: 'done' };
    }
    if (candidate.basis === 'blocked-register') {
      return { text: candidate.text, state: 'blocked' };
    }
    return { text: candidate.text, state: 'active' };
  });
  let latest: 'supersede' | 'pause' | null = null;
  for (const text of operatorTexts) {
    const normalized = text.toLowerCase();
    if (SUPERSEDE_MARKERS.some((marker) => normalized.includes(marker))) {
      latest = 'supersede';
      break;
    }
    if (PAUSE_MARKERS.some((marker) => normalized.includes(marker))) {
      latest = 'pause';
      break;
    }
  }
  if (latest === 'supersede') {
    for (const entry of entries) {
      if (entry.state !== 'done') entry.state = 'superseded';
    }
  } else if (latest === 'pause') {
    for (const entry of entries) {
      if (entry.state === 'active') entry.state = 'paused-by-user';
    }
  }
  return entries;
}

export function renderOpenLoopLedger(
  entries: readonly OpenLoopLedgerEntry[],
  maxEntries: number = OPEN_LOOP_LEDGER_MAX_ENTRIES,
  entryMaxChars: number = OPEN_LOOP_LEDGER_ENTRY_MAX_CHARS,
): string | null {
  if (entries.length === 0) return null;
  const cap = Math.max(0, Math.floor(maxEntries));
  if (cap === 0) return null;
  const lines: string[] = [];
  for (const entry of entries) {
    if (lines.length >= cap) break;
    const text = entry.text.length > entryMaxChars
      ? `${entry.text.slice(0, entryMaxChars - 1)}…`
      : entry.text;
    lines.push(`- [${entry.state}] ${text}`);
  }
  if (lines.length === 0) return null;
  const omitted = entries.length > lines.length ? ` (${entries.length - lines.length} older omitted)` : '';
  return [
    '[Open Loop Ledger — heuristic states; latest operator directive wins; ❓ items stay blocked unless superseded; verify before treating as canonical]',
    ...lines,
    ...(omitted ? [`  ${omitted.trim()}`] : []),
  ].join('\n');
}

export interface OpenLoopLedgerSectionInput {
  /** Newest-first operator texts. */
  operatorTexts: readonly string[];
  /** ❓ blocked-register trail body — one entry per line. */
  blockedTrailText: string;
  maxEntries?: number;
  entryMaxChars?: number;
}

/**
 * Build the full ledger section from the two durable inputs the rebirth seed
 * already has: the ❓ trail body and the operator message stream. Header lines
 * inside blockedTrailText (e.g. the trail's own "## Open Questions" header)
 * are skipped as non-entries. Returns null when there is nothing to ledger.
 */
export function buildOpenLoopLedgerSection(input: OpenLoopLedgerSectionInput): string | null {
  const candidates: OpenLoopCandidate[] = [];
  for (const rawLine of input.blockedTrailText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    candidates.push({ text: line, basis: 'blocked-register' });
  }
  if (candidates.length === 0) return null;
  const entries = classifyOpenLoopStates(candidates, input.operatorTexts);
  return renderOpenLoopLedger(entries, input.maxEntries, input.entryMaxChars);
}
