/** Whole-row continuity: retained source payloads are never character-clipped. */
export const REBIRTH_HOT_TAIL_MAX_CHARS = 50_000;

export interface RebirthHotTailRow {
  readonly id: string;
  readonly sourceAt: string;
  readonly sourceInstanceId: string;
  readonly kind: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  readonly text: string;
  readonly recover: string;
}

export interface RebirthHotTailSelection {
  readonly rows: readonly RebirthHotTailRow[];
  readonly omitted: readonly RebirthHotTailRow[];
  readonly text: string;
}

const selections = new WeakMap<readonly RebirthHotTailRow[], RebirthHotTailSelection>();

/** Only exact identity aliases; never compare prose or infer ownership by time. */
export function hotTailIdentity(id: string): string {
  return id.replace(/^(?:conversation-|message:|conversation:)+/u, '');
}

function rowText(row: RebirthHotTailRow): string {
  return `${row.kind} ⟨${row.id} @${row.sourceAt}⟩\n${row.text}`;
}

export function selectRebirthHotTail(
  source: readonly RebirthHotTailRow[],
  maxChars = REBIRTH_HOT_TAIL_MAX_CHARS,
): RebirthHotTailSelection {
  if (maxChars === REBIRTH_HOT_TAIL_MAX_CHARS) {
    const cached = selections.get(source);
    if (cached) return cached;
  }
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : REBIRTH_HOT_TAIL_MAX_CHARS;
  const ordered = source.filter((row) => row.id && Number.isFinite(Date.parse(row.sourceAt)))
    .slice().sort((a, b) => Date.parse(a.sourceAt) - Date.parse(b.sourceAt) || a.id.localeCompare(b.id));
  const header = '── Raw hot tail ──\n[RAW-HOT-TAIL]\nExact retained payloads follow; older source rows remain recoverable.\n';
  const footer = '\n[/RAW-HOT-TAIL]';
  const parts: string[] = [];
  let used = header.length + footer.length;
  let start = ordered.length;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const part = rowText(ordered[i]!);
    const cost = part.length + (parts.length ? 2 : 0);
    // Keep a contiguous suffix. An oversized row ends the raw region; it is
    // receipted, never silently clipped or skipped to backfill older material.
    if (used + cost > budget) break;
    used += cost;
    parts.push(part);
    start = i;
  }
  const rows = ordered.slice(start);
  const retained = new Set(rows);
  const result = {
    rows,
    omitted: source.filter((row) => !retained.has(row)),
    text: parts.length ? `${header}${parts.reverse().join('\n\n')}${footer}` : '',
  };
  if (maxChars === REBIRTH_HOT_TAIL_MAX_CHARS) selections.set(source, result);
  return result;
}
