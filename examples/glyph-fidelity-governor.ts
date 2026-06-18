/**
 * Example — the quality-driven fidelity governor.
 *
 * The fold band has two independent levers:
 *
 *   • band SIZE   (cost-driven)    — how much total history is retained.
 *   • FIDELITY    (quality-driven) — what FRACTION of that band stays at full
 *                                    verbatim vs. essence vs. skeleton.
 *
 * The band can only hold or shrink (cost lever). Fidelity is BIDIRECTIONAL: the
 * governor reads the agent's register-glyph stream and decides whether the agent
 * needs MORE verbatim history (struggling) or can afford LESS (thriving):
 *
 *   ❓ blocked / re-reading folded paths (thrash) → WIDEN  (raise full/essence %)
 *   🏁 verdict clearing the cache-shrink breakeven → TIGHTEN (lower full/essence %)
 *   ⚠️ hazard / ▶ executing                       → HOLD   (don't disturb)
 *   (no corroborated signal)                       → HOLD   (null = keep prior)
 *
 * This file runs the REAL exported governor (`governByTrace`) over three trace
 * windows representing those cognitive states, then threads the recommendation
 * into a live `FoldSession` via `prepare({ fidelity })` and reads back the
 * `appliedFidelity` it baked into the view. Nothing is stubbed. Run it:
 *
 *   npx tsx examples/glyph-fidelity-governor.ts
 *
 * Exit code is 0 when every state moves fidelity the expected direction, 1 on a
 * regression — so it doubles as a CI guard for the bidirectional-fidelity gate.
 */
import {
  governByTrace,
  DEFAULT_FIDELITY_RATIOS,
  FoldSession,
  ALWAYS_ON_FOLD_CONFIG,
  type TraceToken,
  type OverwatchPressure,
  type FidelityRatios,
  type FidelityOverrides,
  type FoldMessage,
} from '../src/index.ts';

// A healthy provider-pressure reading (20% window utilization — measured, not
// derived from chars). Same shape every window; only the trace glyphs change.
const HEALTHY: OverwatchPressure = { measuredTokens: 40_000, windowTokens: 200_000 };
const PRIOR_BAND = 100_000;

function fmt(f: FidelityOverrides | FidelityRatios | null): string {
  if (!f) return 'null (hold prior)';
  const full = f.fullRetentionFraction?.toFixed(3) ?? '—';
  const essence = f.essenceRetentionFraction?.toFixed(3) ?? '—';
  return `full=${full} essence=${essence}`;
}

// ── 1. HEALTHY — work in flight, no struggle and no verdict → HOLD ────────────
const healthyWindow: TraceToken[] = [
  { kind: 'msg', glyph: 'working' },
  { kind: 'tool', toolClass: 'read', pathArgs: ['src/parser.ts'] },
  { kind: 'tool', toolClass: 'search' },
];
const healthy = governByTrace(healthyWindow, HEALTHY, PRIOR_BAND);

// ── 2. STRUGGLING — re-reading a folded path then ❓ blocked → WIDEN ──────────
const strugglingWindow: TraceToken[] = [
  { kind: 'tool', toolClass: 'read', pathArgs: ['src/parser.ts'] },
  { kind: 'tool', toolClass: 'edit', pathArgs: ['src/parser.ts'] },
  { kind: 'tool', toolClass: 'read', pathArgs: ['src/parser.ts'] }, // thrash: re-read
  { kind: 'msg', glyph: 'blocked' },
];
const struggling = governByTrace(strugglingWindow, HEALTHY, PRIOR_BAND);

// ── 3. THRIVING — work then 🏁 verdict, cache reuse pays for a shrink → TIGHTEN ─
const thrivingWindow: TraceToken[] = [
  { kind: 'tool', toolClass: 'read', pathArgs: ['src/parser.ts'] },
  { kind: 'tool', toolClass: 'edit', pathArgs: ['src/parser.ts'] },
  { kind: 'tool', toolClass: 'test' },
  { kind: 'msg', glyph: 'verdict' },
];
// Measured hot-reuse evidence makes the breakeven gate clear the band shrink,
// which in turn unlocks the fidelity tighten (agent is coping → less verbatim).
const thriving = governByTrace(
  thrivingWindow,
  { ...HEALTHY, cache: { hotReuses: 50, epochs: 1 } },
  PRIOR_BAND,
);

console.log('── Governor fidelity decisions (glyph → quality lever) ─────────────');
console.log(`healthy   (working)        → band=${healthy.bandTokens} fidelity=${fmt(healthy.fidelity)}`);
console.log(`struggling(❓ blocked+thrash) → band=${struggling.bandTokens} fidelity=${fmt(struggling.fidelity)}`);
console.log(`thriving  (🏁 verdict)       → band=${thriving.bandTokens} fidelity=${fmt(thriving.fidelity)}`);
console.log('  derivation (struggling):', struggling.derivation.find((d) => d.startsWith('fidelity:')));
console.log('  derivation (thriving):  ', thriving.derivation.find((d) => d.startsWith('fidelity:')));

// ── 4. Thread the WIDENED recommendation into a live FoldSession ──────────────
// The governor is harness-specific (it owns the trace window); FoldSession just
// CONSUMES the recommendation via prepare({ fidelity }) and applies it at the
// next fold epoch (cache-safe — never mid hot-reuse). It echoes appliedFidelity.
const session = new FoldSession({ foldConfig: ALWAYS_ON_FOLD_CONFIG });
const history: FoldMessage[] = Array.from({ length: 24 }, (_, i) =>
  i % 2 === 0
    ? { role: 'user', content: `step ${i}: inspect module ${i}` }
    : { role: 'assistant', content: `🔍 step ${i}: ${'analysis '.repeat(40)}` },
);
const outcome = session.prepare(history, { fidelity: struggling.fidelity ?? undefined });
const baseFull = ALWAYS_ON_FOLD_CONFIG.assistantTextBudget?.fullRetentionChars ?? 0;
console.log('\n── FoldSession.prepare({ fidelity }) ──────────────────────────────');
console.log(`appliedFidelity baked into view: ${fmt(outcome.appliedFidelity ?? null)}`);
console.log(`base full-retention budget: ${baseFull} chars → widened applies more verbatim history`);

// ── Assertions (directional — the bidirectional gate must hold) ───────────────
const checks: Array<[string, boolean]> = [
  ['healthy holds fidelity (null)', healthy.fidelity === null],
  [
    'struggling WIDENS above default',
    struggling.fidelity !== null && struggling.fidelity.fullRetentionFraction > DEFAULT_FIDELITY_RATIOS.fullRetentionFraction,
  ],
  ['struggling holds band (cost lever untouched)', struggling.bandTokens === PRIOR_BAND],
  [
    'thriving TIGHTENS below default',
    thriving.fidelity !== null && thriving.fidelity.fullRetentionFraction < DEFAULT_FIDELITY_RATIOS.fullRetentionFraction,
  ],
  ['thriving also shrinks band', thriving.bandTokens !== null && thriving.bandTokens < PRIOR_BAND],
  [
    'FoldSession echoes the widened fidelity',
    outcome.appliedFidelity != null &&
      outcome.appliedFidelity.fullRetentionFraction === struggling.fidelity?.fullRetentionFraction,
  ],
];

console.log('\n── Gate ───────────────────────────────────────────────────────────');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${label}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? '\n🏁 Bidirectional fidelity gate holds.' : `\n❌ ${failed} regression(s).`);
process.exitCode = failed === 0 ? 0 : 1;
