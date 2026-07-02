# Step 8 — Trace-Only Seed vs Full-Package Seed: Executable Spec + Blocker

*Companion note for the CWD↔voxxo-swarm reconciliation rail (rail-b75aed85, step 8).
Drafted 2026-07-02. Status: SPEC + BLOCKER — no live scores produced.*

## 0. Why this is a spec, not results

The step-8 acceptance criteria explicitly allow landing "an executable arm spec +
concrete blocker note" as a fallback to live paired scores. This note is that
fallback. No synthetic or estimated numbers are recorded anywhere below; the
reasoning for *not* running a pilot here is structural, not a lack of effort.

## 1. The category error in the step-8 framing

Step 8 was framed as "compare trace-only seeds vs full-package seeds, scored with
the continuity scorer." On investigation this framing conflates two different
evidence streams defined by this paper:

| Stream | Question it answers | Instrument |
|---|---|---|
| **Seed-fidelity metric** (this step's literal wording) | How closely does a trace-only seed reproduce the full package's coordinate closet / last-user-AI / current-thread literals? | continuity-scorer package emit + text comparison |
| **Causal non-inferiority** (`controlled-ab-spec.md` §1, `confirmatory-test-elaboration.md`) | Given the same work trace and the same user intent, does a mid-turn rebirth preserve completed task outcome nearly as well as a no-rebirth continuation? | operator-approved live fork-and-compare with LLM-judged right-work/right-action |

The continuity-scorer Forge surface emits and compares **rebirth package text**
(policy arms: `default`, `lean-economy`, `fold`; `policies_json` drives emission;
it reports `seedMessages`, `packageVersion`, and text). It does **not** judge
task outcomes. Scoring a trace-only seed and a full-package seed with it would
produce seed-overlap / literal-preservation numbers — a *proxy* — and then label
those proxy numbers as if they answered the non-inferiority question. The
acceptance criteria ("No synthetic/estimated numbers — measured scorer output
only") forbid presenting proxy numbers as the answer.

So the honest outcomes are: run the real causal test (out of scope for this rail),
or land this spec + blocker. This rail lands the spec + blocker.

## 2. The builder that exists and is correct

The trace-only seed builder is real, tested, and byte-identical across both repos:

```ts
// src/rawRebirthSeed.ts — shared file, present in BOTH repos
export function buildRawRebirthSeedFromMessages(
  messages: readonly FoldMessage[],
  options: RawRebirthSeedFromMessagesOptions = {},
): string
```

It renders the trace-only rebirth seed from a message trace:
`renderRawRebirthSeed({ predecessorName, packageBudget, runtimeModel,
relayBootTime, traceEventCount, sectionMaxChars, lastUserAiMessages,
currentThread, rawTraceCoordinateCloset })`. The `currentThread` and
`rawTraceCoordinateCloset` are derived deterministically from the messages
(`buildCurrentThreadFromMessages`,
`buildRawTraceCoordinateClosetFromMessages`). This is the "trace-only arm"
building block; it is verified by `test/rawRebirthSeed.test.ts` in both repos.

The "full-package arm" is the full rebirth package the relay normally emits at a
hard-epoch boundary — which includes everything the trace-only seed contains,
*plus* fold summaries, episodic recall, active-edit delta, rail state, digest
deltas, and live runtime coordinates. `ghost-rebirth-preview` exposes the
persisted seed for a given instance for inspection.

## 3. Executable spec for the proxy measurement (if someone wants it later)

This is runnable today with no new code, and produces honest seed-fidelity
numbers — but they must be labeled as a **seed-preservation proxy**, not as
non-inferiority evidence.

1. Pick N≥3 real instances that crossed a hard epoch. For each, capture:
   - `source_instance_id`, `fork_point_message_id` (epoch boundary), `engine/model`.
2. Pull the full rebirth package text via `ghost-rebirth-preview`.
3. Rebuild the trace-only seed from the same pre-epoch message trace via
   `buildRawRebirthSeedFromMessages(messages, { predecessorName, runtimeModel,
   relayBootTime, traceEventCount })`.
4. For each instance compute literal-preservation metrics over the sections the
   two share (Coordinate Closet, Last User+AI, Current Thread): exact-literal
   overlap, coordinate-id survival, path survival, value survival.
5. Record paired per-instance numbers. Headline metric: **fraction of coordinate
   IDs / paths / values in the full-package Closet that survive in the
   trace-only Closet.** Label N, label as proxy.

Expected honest result: trace-only will preserve Coordinate-Closet literals well
(they are derived by the same extraction path) but will lack fold/episodic/rail
state entirely, so the *information* delta is large even where literal overlap is
high. That gap is itself the useful finding and maps directly to Arm D's
"package value" question — but at the seed-text level, not the task-outcome level.

## 4. The concrete blocker for the *real* test

The causal non-inferiority test (`controlled-ab-spec.md` Arms A/B/C/D) cannot run
inside a reconciliation rail because:

- **It requires operator-approved live forks.** Arms B/C force a standardized
  mid-turn rebirth on a real running trace; Arm A continues with no forced
  rebirth; Arm D forks a cold transcript with no package. All need isolated
  final snapshots / branches provisioned by the operator (agents must not create
  git worktrees). This is an operator gate, not an agent decision.
- **Its endpoint is LLM-judged task outcome** (`success` / `partial` /
  `wrong_action` / `wrong_intent` / `censored`), not seed text. No scorer in the
  continuity-scorer / context-warp-lab chain emits that label — it needs a judge
  packet workflow (see the paper's existing
  `experiments/agent-judge-landmark/` artifacts in the voxxo-swarm repo).
- **It is research-ops scope**, not reconciliation scope. The reconciliation rail
  converges two source trees; the confirmatory test validates a research claim.
  Mixing them is what turned step 8 into a sinkhole.

**Unblock path:** hand the spec in `controlled-ab-spec.md` + §3 above to the
research-ops tooling (`research-ops` Forge facade) under explicit operator
approval, with a frozen root manifest and censoring ruleset. That is where the
fork-and-compare + judge workflow properly lives.

## 5. Recommendation

- Treat step 8 as **satisfied by this spec + blocker** (the explicit fallback).
- Do not record proxy numbers on this rail; if proxy numbers are wanted, run §3
  under a separate research task and label them as seed-preservation only.
- The reconciliation work itself (steps 1–7) is the substantive deliverable and
  is complete and green; this step was always adjacent research, not
  reconciliation.
