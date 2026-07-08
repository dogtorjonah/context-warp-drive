/**
 * Micro Rebirth Seed — trajectory preservation for tail-epoch fold bands.
 *
 * v2 architecture (operator directive): point the ACTUAL rebirth seed machinery
 * at the fold window instead of a bespoke 3-line approximation. A hard epoch
 * re-renders the entire visible history through the rebirth-seed pipeline, so
 * the successor lands with explicit orientation. A tail epoch is append-only:
 * it skeletonizes the freshest window — exactly the material that orientation
 * is made of — and the surviving agent keeps the frozen prefix but loses
 * direction: what was asked, what was in flight, which files were mid-edit.
 *
 * This module closes that gap by delegating to `buildMicroSeedFromMessages`
 * from the rebirth seed pipeline, using a lean "band" budget profile that
 * enables only the two trace-derived narrative sections (last-user-AI + current
 * thread) and disables all external-state sections (rail, chatroom, squad,
 * workspace, episodic, etc.) since those live outside the fold and survive it
 * anyway. The result is a compact, bounded block merged into the band body
 * alongside the [cognitive] block.
 *
 * The public API is unchanged from v1: `buildMicroSeedBlock(messages)` → string.
 * All six wiring sites (FoldSession tail/recompute, fcBaseSession tail,
 * claudeCliFold, codexFold, codexBandAppend) call this without modification.
 */

import type { FoldMessage } from './rollingFold.ts';
import { buildMicroSeedFromMessages } from './rawRebirthSeed.ts';

/**
 * Build a band-level micro-seed from the fold-window raw messages (the window
 * being destroyed by the tail-epoch fold). Delegates to the actual rebirth
 * seed machinery with a lean band profile — same pipeline that powers hard-
 * epoch seeds, pointed at just the destroyed window.
 *
 * Returns '' when the window yields no trajectory state (no genuine operator
 * or assistant turns). The band then carries no [micro-seed] block.
 *
 * Pure (no I/O) and bounded by the band profile's character-only render
 * safety cap. Output is deterministic for a given input — no timestamps or counters — so a
 * committed band never churns the injection cache.
 */
export function buildMicroSeedBlock(messages: readonly FoldMessage[]): string {
  if (!messages || messages.length === 0) return '';
  return buildMicroSeedFromMessages(messages).trim();
}
