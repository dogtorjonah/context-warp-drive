# Step 14 Controlled A/B Spec - Rebirth Continuity

*rebirth-continuity paper. Drafted 2026-06-04 after Round 2 red-team. Status: SPEC ONLY; live forks require explicit operator approval.*

## 0. Purpose

The observational packet says rebirth usually works, but it cannot answer the causal question:

> Given the same work trace and the same user intent, what changes when we interrupt the trace with rebirth, and what changes when the successor model is hot-swapped?

This spec turns the proposed fork-and-compare design into the causal capstone. It also folds in the long-arc task lesson: the phenomenon is not only "handoff recovered one request." It is a temporal arc where different models can occupy one trace across turns while preserving the work's direction.

## 1. Claims This Test Can Support

Primary causal claims:

- **Rebirth non-inferiority:** a mid-turn rebirth preserves the user's intent nearly as well as a no-rebirth continuation from the same trace.
- **Bounded-context dominance:** if quality is non-inferior, rebirth wins on context economics because the successor gets a bounded package instead of carrying an unbounded live transcript.
- **Hot-swap non-inferiority:** model changes across rebirth do not materially reduce continuity compared with same-model rebirth.

Secondary claims:

- **Package value:** warm rebirth beats a cold transcript fork when both start from the same visible conversation but only one receives the rebirth package.
- **Temporal orchestration:** one task identity can move through phase-appropriate models across time: plan model, execution model, review model, without resetting the arc.

Do **not** use this experiment to claim "hot-swap improves quality" unless the paired results actually show it. The pre-registered headline is non-inferiority plus cost.

## 2. Arms

Each root task is cloned from the same fork point. Branch labels are hidden from judges.

| Arm | Name | What happens | Main contrast |
|---|---|---|---|
| A | **No-rebirth continuation** | Same instance/session continues after the user message. No forced rebirth. | Ceiling arm for quality and latency. |
| B | **Warm rebirth, same model** | Same user message, then a standardized mid-turn rebirth. Successor keeps the same model/tier. | Tests rebirth vs no-rebirth. |
| C | **Warm rebirth, hot-swap** | Same as B, but successor model/tier changes at the rebirth. For multi-turn traces, swap each turn or phase. | Tests hot-swap vs same-model rebirth. |
| D | **Cold transcript fork** | Same visible transcript prefix and user message, but no rebirth package: no Active Edit Delta, no gradient trail, no live claim/rail/chatroom cargo. | Optional package-value baseline. |

Arm D is optional until the relay supports a safe package-ablation path. Do not fake it by deleting live runtime data. Branching is instance/transcript-level only. For code/edit roots, each arm must have an isolated final artifact snapshot, patch bundle, or operator-provisioned branch/worktree; otherwise exclude that root from the live pilot. No new git worktree should be created by agents without explicit operator approval.

## 3. Root Task Set

Use paired roots, not convenience anecdotes. Minimum useful pilot: **30 roots**. Paper-grade run: **150-250 roots**, enough for tight paired CIs on quality gaps and a meaningful hot-swap cell.

Stratify roots before running:

- **Direct dogfood:** operator/user message lands, the turn is interrupted before a completing answer.
- **Mid-edit code work:** predecessor has read/edited concrete files and is cut while work is active.
- **Long-arc creative/technical work:** multiple prior decisions matter. The Mandelbrot zoomer is the motivating exemplar: preserve design direction, not just file identity.
- **Review/adversarial work:** successor must inherit critique, exclusions, and settled caveats.

Balance by task type, expected duration, engine family, and whether file edits are required.

Direct-dogfood roots should be harvested with the same observable pattern: user message opens an unserved intent, there is no completing assistant answer before the cut, and the next live work unit is a rebirth continuation. Those roots become the natural source for controlled transcript forks.

## 4. Standardized Cut

For B/C, the rebirth cut is pre-registered per root:

- **Message-cut:** send the user message, then trigger rebirth before any final assistant answer.
- **Tool-cut:** trigger rebirth after the first relevant read/search/tool call.
- **Edit-cut:** trigger rebirth after the first patch or before the next planned edit.

The cut rule must be content-blind once selected. Do not move the cut because a branch looks good or bad.

Record:

- `root_id`, `fork_point_message_id`, source instance, source model, workspace.
- arm label, hidden judge label, successor model, cut mode, cut timestamp.
- package size/tokens, active edit files, rail/chatroom cargo, and whether model changed.
- user interventions after branch start, with timestamps and reason.

## 5. Primary Outcome

The primary outcome is **right work/right action**, judged against the original open intent.

Judge question:

> Did this branch do the work the user was actually asking for, in the correct direction, without needing the user to rescue or redirect it?

Labels:

- `success`: correct intent, correct action, useful endpoint.
- `partial`: same intent, incomplete or materially weaker endpoint.
- `wrong_action`: plausible local work but wrong action for the intent.
- `wrong_intent`: shifted to a different task.
- `censored`: operator supersession, external preemption, or insufficient evidence.

File-touch, first-touch targeting, and same-file reads are **supporting diagnostics only**. They cannot decide the primary outcome.

## 6. Censoring And Sensitivity

Pre-state censoring content-blind:

- **Operator supersession:** the operator/user intentionally changes the ask. Exclude from the uncensored should-persist denominator and report as its own censored cell.
- **External preemption:** relay crash, unrelated system/agent interrupt, or squad message that materially changes the task. Always exclude from the uncensored denominator and report as a separate stratum/sensitivity bucket; never decide case-by-case after seeing the outcome.
- **Ambiguous endpoint:** not enough evidence to decide. Report all-fail and all-success sensitivity.
- **Same-intent nudge:** "did you fix it?", "go for it", "continue" stays in-chain and is followed forward. If the nudge arrives before branch completion, it still counts against the raw floor unless a pre-stated censoring rule applies.

Report both:

- **Raw floor:** fresh intervention before completion counts against the branch unless censored by rule.
- **Uncensored recovery:** excludes pre-stated supersession/preemption/ambiguous cells.

## 7. Secondary Outcomes

Quality/cost:

- time to useful endpoint.
- turns to useful endpoint.
- input/output tokens and estimated cost.
- package size at boundary.
- context-cost delta: Arm A's live transcript growth vs B/C bounded rebirth package. Report median package tokens and cap; current framing expects roughly a 13K-token package, capped around 38K, plus cache/handoff reuse when available.
- reorientation burden: explicit "what was I doing" behavior, taps, transcript rereads, repeated planning.

Behavioral diagnostics:

- first useful tool/action.
- first file touched and whether it was part of engaged pre-state.
- whether successor reread before editing resumed files.
- wrong-file edits or harmful churn.
- tests/build/review result when applicable.

Arc preservation for Mandelbrot-style traces:

- did the branch preserve settled design decisions?
- did it move to the next logical phase rather than relitigating?
- did the model change add a useful fresh prior without losing the trace?

## 8. Blinding And Review

Judges receive only:

- original root intent and necessary pre-state summary.
- branch output, diffs, and relevant terminal/test results.
- no arm label, no model label, no package-size label.

At least 20% of roots get dual review. Disagreements are adjudicated into a final label and kept visible in the appendix. Human review is the anchor; LLM judges can scale the first pass but do not replace spot-checks.

## 9. Analysis

Primary contrasts:

- `B - A`: warm rebirth vs no-rebirth ceiling.
- `C - B`: hot-swap rebirth vs same-model rebirth.
- `B - D`: warm rebirth vs cold transcript fork, if D is available.

Report paired differences with 95% CIs. For binary success, use paired/McNemar-style discordant counts where possible; also show raw arm rates so the result remains legible.

Non-inferiority margins:

- primary success: **5 percentage points**.
- judged quality score, if numeric: **0.25 on a 5-point scale**.
- cost: rebirth may spend small reorientation overhead, but should keep package/input growth bounded compared with Arm A.

Headline template:

> In paired controlled forks, warm rebirth was X pp from no-rebirth continuation on right-work/right-action, with median reorientation cost Y turns / Z seconds / K tokens; hot-swap was X2 pp from same-model rebirth. Context at the boundary stayed bounded at P package tokens versus Q continuing-session context.

Include the cache/boundary reuse number when instrumented; the current implication target is bounded package cost plus roughly 93% cache at the boundary, not quality alone.

## 10. Temporal Trace Case Study

Use one concrete long-running task as a preregistered rich case study, not as the whole
statistical test.

Design:

- choose one concrete task arc with 5-10 checkpoints.
- run Arm A as same-session continuation.
- run Arm B as same-model rebirth at each checkpoint.
- run Arm C as model-swapped rebirth at each checkpoint, rotating phase-appropriate models.
- judge each checkpoint for arc preservation, useful next action, and design-decision retention.

This captures the motivating systems claim: one evolving trace should remain followable across
model swaps. The statistical table is designed to adjudicate non-inferiority; the case study
shows the lived shape of temporal orchestration.

## 11. Acceptance Gates

Before live execution:

- root list and cut rules are frozen.
- censoring rules are frozen.
- judge rubric is frozen and blinded.
- edit-heavy roots have isolated final snapshots/patch bundles or operator-provisioned branches/worktrees for every arm; otherwise they are excluded from the live pilot.
- package-ablation path for Arm D is either implemented safely or Arm D is omitted.
- no relay restart is required during live branches unless the operator explicitly chooses it.
- no git worktree is created by agents.

Ship criteria for the paper:

- primary A/B/C results with paired CIs.
- raw floor and uncensored rates.
- context-cost delta.
- hot-swap same-model contrast.
- at least one audited long-arc trace, preferably Mandelbrot.
- appendix with censored cells, judge disagreements, and examples of success/partial/failure.

## 12. Current Connection To Hard Numbers

Use this spec to close the observational-to-causal gap:

- `hard-numbers.md` gives the current observational floor: dogfood raw **73.9%**, uncensored **97.5%**, hard-fail **2.1%** on the stale exact subset.
- Round 2 killed N1 as a superiority headline; file-locality is diagnostic only.
- N2 survives as the strongest observational behavior: resumed-edit files are reread about **83% all-era / 96% post-May**.
- N3 should be worded carefully: intent preservation is directionally supported by N2 plus judged correct-work cases, but the A/B judge is the proof surface.

Signpost: after live execution is approved, the next implementation artifact is a root manifest plus a branch logger that emits the fields in section 4 and masks arm labels for judges.
