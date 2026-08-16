/**
 * Fold transition audit (fold diff): a pure, deterministic renderer comparing
 * pre-fold and post-fold inventories so each fold's transition — what stayed
 * resident, what moved behind recovery, what was newly summarized, which open
 * loops were retained — is inspectable from context rather than only from
 * logs. No I/O, no wall-clock timestamps, and byte-stable for identical input
 * (safe to cache alongside the frozen view). Counts come from session state;
 * this module never fabricates a number the session cannot supply.
 */

export interface FoldDiffInventory {
  epochs: number;
  frozenViewChars: number;
  frozenRawCount: number;
  frozenBands: number;
  sealedVaultRows: number;
  residentZones: number;
  /** Lifetime turns tombstoned out of the standing fold block. */
  evictedTurnLifetime: number;
  /** Turns newly evicted by THIS fold. */
  newlyEvictedTurns: number;
  turnsFolded: number;
  turnsRetained: number;
  /** Optional cheap proxy: ❓ blocked-register markers in the retained tail. */
  openLoops?: number;
  /** Optional: superseded-statement count when a session can supply one honestly. */
  supersededStatements?: number;
}

export interface FoldDiffTransition {
  kind: 'hard-epoch' | 'rolling' | 'baseline';
  reason?: string;
  pre: FoldDiffInventory;
  post: FoldDiffInventory;
}

export const FOLD_DIFF_PREFIX = '[fold diff ·';

/**
 * Count ❓ blocked-register lines across bounded text excerpts. This is a
 * heuristic open-loop proxy — labeled as such wherever it is rendered.
 */
export function countBlockedRegisterMarkers(texts: readonly string[]): number {
  let count = 0;
  for (const text of texts) {
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (/^❓\s/u.test(line)) count += 1;
    }
  }
  return count;
}

function fmtDelta(pre: number, post: number): string {
  const delta = post - pre;
  if (delta === 0) return `${post}`;
  return delta > 0 ? `${pre}→${post} (+${delta})` : `${pre}→${post} (−${-delta})`;
}

/**
 * Render the transition audit. Returns null for baseline (foundation
 * initialization is not a fold) and for inventories where nothing moved —
 * a diff block must never narrate "nothing changed."
 */
export function buildFoldDiff(transition: FoldDiffTransition): string | null {
  const { pre, post, kind, reason } = transition;
  if (kind === 'baseline') return null;
  const foldedDelta = post.turnsFolded - pre.turnsFolded;
  const evictedDelta = post.newlyEvictedTurns - pre.newlyEvictedTurns;
  if (pre.epochs === post.epochs && foldedDelta === 0 && evictedDelta === 0) return null;
  const lines: string[] = [
    `[fold diff · ${kind}${reason ? ` · ${reason}` : ''} · epochs ${fmtDelta(pre.epochs, post.epochs)}]`,
    `  retained resident: ${post.residentZones} zones · ${post.sealedVaultRows} sealed vault rows · ${post.frozenBands} frozen bands (${post.frozenViewChars.toLocaleString('en-US')} chars)`,
  ];
  if (evictedDelta > 0 || post.evictedTurnLifetime > 0) {
    lines.push(
      `  moved behind recovery: ${evictedDelta > 0 ? `+${evictedDelta}` : '±0'} turn(s) evicted this fold · ${post.evictedTurnLifetime} lifetime — raw history + episodic store`,
    );
  }
  if (foldedDelta > 0 || post.frozenRawCount !== pre.frozenRawCount) {
    lines.push(
      `  newly summarized: ${foldedDelta > 0 ? `+${foldedDelta}` : '±0'} turn(s) folded · raw ${fmtDelta(pre.frozenRawCount, post.frozenRawCount)} msgs → ${post.frozenBands} frozen bands`,
    );
  }
  if (post.openLoops !== undefined) {
    lines.push(`  open loops retained: ${post.openLoops}`);
  }
  if (post.supersededStatements !== undefined || pre.supersededStatements !== undefined) {
    lines.push(`  superseded statements: ${post.supersededStatements ?? pre.supersededStatements ?? 0}`);
  }
  return lines.join('\n');
}
