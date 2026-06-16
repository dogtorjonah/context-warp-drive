/**
 * Simulation — does the glyph-grammar epistemic gate actually drive episodic recall?
 *
 * context-warp-drive's episodic engine harvests durable "voice" from a FINISHED
 * conversation window: the lines worth resurfacing in a later session. The hard
 * problem is *which* lines. An agent mid-investigation says "Found the likely
 * culprit…" and is confidently wrong half the time; the same words at the end of
 * the turn are a real conclusion. No shape regex can tell them apart from phrasing
 * alone. The glyph grammar solves it at the SOURCE: the register glyph an assistant
 * message opens with is a deliberate epistemic declaration, and the engine treats
 * it as the trust signal.
 *
 *   🏁 verdict  → harvested as `narration:verdict`  ("I verified this — remember it")
 *   ⚠️ hazard   → harvested as `narration:hazard`   ("beware this — resurface it")
 *   🔍 working  → EXCLUDED  (a hypothesis in flight — often wrong, never memory)
 *   ❓ blocked   → EXCLUDED  (an open question — not a conclusion)
 *   (untagged)  → harvested ONLY if it passes the lexical verdict-shape gate
 *                 (the absence-safe backstop, so harvest still works at 0% glyph
 *                  adoption on legacy / non-tagging engines)
 *
 * This file SIMULATES realistic finished conversations and runs them through the
 * REAL exported engine — `richEpisodeCapture.deriveEpisodesFromMessages` — then
 * asserts the harvested memory matches the contract. Nothing here is stubbed or
 * hardcoded: every PASS/FAIL is the genuine engine's output. Run it:
 *
 *   npx tsx examples/glyph-recall-sim.ts
 *
 * Exit code is 0 when the gate holds, 1 when any register leaks the wrong way —
 * so it doubles as a CI guard for the epistemic-recall invariant.
 *
 * The scenario below is a generic web-service bug hunt: nothing here is specific
 * to any one codebase — swap the prose for your own agent's transcripts.
 */
import { richEpisodeCapture, type FoldMessage } from '../src/index.ts';
import type { EpisodeAnnotation } from '../src/foldEpisodes.ts';

const { deriveEpisodesFromMessages } = richEpisodeCapture;

// A downstream consumer's identity. closedBy:'backfill' + sealTrailing:true below
// = "score a completed session" — nothing can still be growing, so every burst is
// evaluated (the honest way to grade a finished transcript).
const IDENTITY = {
  workspace: 'acme-support-app',
  instanceId: 'support-bot-7',
  closedBy: 'backfill' as const,
  nowIso: '2026-06-16T03:00:00.000Z',
};

let toolSeq = 0;

/**
 * One simulated agent turn in the live function-calling representation: the
 * assistant message carries BOTH its register-tagged prose AND the tool_use it
 * fired (Anthropic content-block shape), followed by the tool_result. Gluing the
 * prose to the touch mirrors how a real FC turn arrives — and is exactly the
 * representation bridge the capture layer documents — so the line sits inside the
 * burst it closes. `file_path` is what makes the tool_use a real "touch" that
 * forms an episode burst.
 */
function fcTurn(prose: string, filePath: string): FoldMessage[] {
  const id = `toolu_${++toolSeq}`;
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: prose },
        { type: 'tool_use', id, name: 'Edit', input: { file_path: filePath } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: `applied edit to ${filePath}` }],
    },
  ];
}

/**
 * Run a finished conversation window through the REAL exported episodic engine
 * and return every durable annotation it harvested.
 */
function harvest(messages: FoldMessage[]): EpisodeAnnotation[] {
  const { episodes } = deriveEpisodesFromMessages(messages, 0, IDENTITY, { sealTrailing: true });
  return episodes.flatMap((e) => e.annotations);
}

// ── assertion plumbing ───────────────────────────────────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];

function dump(anns: EpisodeAnnotation[]): string {
  if (anns.length === 0) return '(nothing harvested)';
  return anns.map((a) => `${a.kind} :: "${a.text}"`).join(' | ');
}

/** Assert a snippet WAS promoted to durable memory, optionally with a specific kind. */
function expectHarvested(
  scenario: string,
  anns: EpisodeAnnotation[],
  needle: string,
  kind?: EpisodeAnnotation['kind'],
): void {
  const hit = anns.find((a) => a.text.includes(needle) && (!kind || a.kind === kind));
  checks.push({
    name: `${scenario} — harvest "${needle}"${kind ? ` as ${kind}` : ''}`,
    ok: Boolean(hit),
    detail: hit ? `→ ${hit.kind} :: "${hit.text}"` : `NOT harvested. Got: ${dump(anns)}`,
  });
}

/** Assert a snippet was kept OUT of durable memory. */
function expectExcluded(scenario: string, anns: EpisodeAnnotation[], needle: string): void {
  const hit = anns.find((a) => a.text.includes(needle));
  checks.push({
    name: `${scenario} — exclude "${needle}"`,
    ok: !hit,
    detail: hit ? `LEAKED as ${hit.kind} :: "${hit.text}"` : 'correctly excluded from memory',
  });
}

// ── scenarios ────────────────────────────────────────────────────────────────

// S1 — a declared 🏁 verdict becomes durable verdict memory.
const s1 = harvest(
  fcTurn(
    '🏁 Verdict: the 800ms login latency was a synchronous bcrypt.hashSync() call in the request handler; moving it to the async API cut p99 to 40ms and all 277 tests pass.',
    'src/auth/login.ts',
  ),
);
expectHarvested('S1 verdict', s1, '800ms login latency', 'narration:verdict');

// S2 — a declared ⚠️ hazard becomes durable hazard memory.
const s2 = harvest(
  fcTurn(
    '⚠️ Hazard: never call bcrypt.hashSync() inside a request handler — it blocks the Node event loop and stalls every concurrent request under load.',
    'src/server/handlers.ts',
  ),
);
expectHarvested('S2 hazard', s2, 'never call bcrypt.hashSync', 'narration:hazard');

// S3 — the killer case: a 🔍 hypothesis that is VERDICT-SHAPED ("Found the likely
// culprit…") must still self-exclude. Shape says "conclusion"; the glyph says
// "in flight". The glyph wins — this is the false-positive class no regex catches.
const s3 = harvest(
  fcTurn(
    '🔍 Found the likely culprit in login.ts — but I have not confirmed the hash call is synchronous yet, so this is still a hypothesis.',
    'src/auth/login.ts',
  ),
);
expectExcluded('S3 working', s3, 'likely culprit');

// S4 — a ❓ blocked message self-excludes on the GLYPH alone (note: no trailing
// "?" — exclusion is driven by the register, not the question-mark gate).
const s4 = harvest(
  fcTurn(
    '❓ Blocked: should the fix use the async bcrypt API or offload hashing to a worker thread. I need a steer on the approach before I proceed.',
    'src/auth/login.ts',
  ),
);
expectExcluded('S4 blocked', s4, 'async bcrypt API or');

// S5 — INTEGRATION: one finished investigation containing all four registers.
// Only the 🏁 and ⚠️ survive into memory; the 🔍 and ❓ are dropped — even though
// they sit in the same burst, touch the same files, and read fluently.
const s5 = harvest([
  ...fcTurn('🔍 I think the stale-profile bug is in the cache layer, still bisecting which commit introduced it.', 'src/cache/userCache.ts'),
  ...fcTurn('🏁 Verdict: the stale reads came from a cache that was never invalidated on write; invalidating on the write path fixed it.', 'src/cache/userCache.ts'),
  ...fcTurn('⚠️ Hazard: the user cache must be invalidated on every write or the API serves stale profile data after an update.', 'src/cache/userCache.ts'),
  ...fcTurn('❓ Blocked: do we invalidate the cache eagerly on write or lazily on next read. Need a perf decision first.', 'src/cache/userCache.ts'),
]);
expectHarvested('S5 mixed', s5, 'stale reads came from a cache', 'narration:verdict');
expectHarvested('S5 mixed', s5, 'must be invalidated on every write', 'narration:hazard');
expectExcluded('S5 mixed', s5, 'still bisecting');
expectExcluded('S5 mixed', s5, 'eagerly on write or lazily');

// S6 — absence-safe backstop: an UNTAGGED but verdict-shaped closing line is still
// harvested (priority-last 'narration'), so harvest works at 0% glyph adoption.
const s6 = harvest(
  fcTurn(
    'Fixed the connection leak: each request now releases its pool client in a finally block, so the pool no longer exhausts under sustained traffic.',
    'src/db/pool.ts',
  ),
);
expectHarvested('S6 untagged-verdict', s6, 'Fixed the connection leak', 'narration');

// S7 — backstop gate: an UNTAGGED hypothesis ("I think… probably…") fails the
// lexical verdict-shape filter and stays out.
const s7 = harvest(
  fcTurn(
    'I think the bug is probably somewhere in the request parser, but I have not actually confirmed which function is responsible yet.',
    'src/parser.ts',
  ),
);
expectExcluded('S7 untagged-hypothesis', s7, 'I think the bug');

// S8 — CONTRACT PROPERTY (not a bug): the glyph is load-bearing. A PREMATURE 🏁 on
// a wrong claim is still harvested — the engine trusts the agent's declaration and
// does not second-guess it. This is the flip side of S3's guarantee: the agent owns
// its glyphs. A declared verdict is trusted, so a premature one becomes false
// memory. The sim asserts the declared-glyph rule is honored, even when uncomfortable.
const s8 = harvest(
  fcTurn(
    '🏁 The root cause is definitely the serializer and I am certain shipping this fix resolves every failing case in the suite.',
    'src/serializer.ts',
  ),
);
expectHarvested('S8 premature-verdict (glyph is load-bearing)', s8, 'root cause is definitely the serializer', 'narration:verdict');

// S9 — cross-engine compat: a BARE ⚠ (U+26A0, no VS16 presentation selector, as
// some engines emit) still classifies as a hazard and harvests. Proves the gate
// is not brittle to emoji-presentation differences.
const s9 = harvest(
  fcTurn(
    '⚠ Hazard: keep the SECRET_KEY out of client bundles or anyone can forge their own session tokens and impersonate users.',
    'src/config/secrets.ts',
  ),
);
expectHarvested('S9 bare-warning-glyph compat', s9, 'SECRET_KEY', 'narration:hazard');

// ── report ───────────────────────────────────────────────────────────────────

console.log('\n=================================================================');
console.log('  GLYPH-GRAMMAR → EPISODIC RECALL SIMULATION');
console.log('  engine under test: richEpisodeCapture.deriveEpisodesFromMessages');
console.log('  (real exported engine — no stubs, no hardcoded results)');
console.log('=================================================================\n');

let passed = 0;
for (const c of checks) {
  if (c.ok) passed++;
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log(`         ${c.detail}\n`);
}

const allPass = passed === checks.length;
console.log('-----------------------------------------------------------------');
console.log(`  ${passed}/${checks.length} checks passed`);
console.log(
  allPass
    ? '  ✅ Epistemic gate holds: 🏁/⚠️ become durable memory; 🔍/❓ never do.'
    : '  ❌ Epistemic gate BREACHED — a register leaked the wrong way (see above).',
);
console.log('-----------------------------------------------------------------\n');

process.exitCode = allPass ? 0 : 1;
