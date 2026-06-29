# Confirmatory Test Elaboration

This is the concrete execution note for the rebirth-continuity paper's remaining
confirmatory test. It separates three related but different evidence streams:

- `controlled-ab-spec.md` / paper section 8: the causal task-outcome
  fork-and-compare test. This is the capstone.
- Section 5.8.2: the measured realized-action A/B. This is controlled and
  useful, but it scores first action rather than completed task outcome.
- `bench_0c7821f6`: a planned five-model folding/recall/hallucination battery.
  It is adjacent stress evidence, not the causal non-inferiority gate.

## What the Test Converts

Current paper language should stay conservative until this test runs:

- before: production observations and realized-action A/B are consistent with
  quality non-inferiority;
- after a passing run: warm rebirth is demonstrated non-inferior to no-rebirth
  continuation on completed task outcome, within the pre-registered margin;
- after a passing hot-swap cell: model swaps across rebirth are demonstrated
  non-inferior to same-model rebirth on completed task outcome;
- after a passing package-ablation/cold-fork cell: the rebirth package itself
  has measured causal value over a visible-transcript-only continuation.

The result must remain "non-inferiority, then economics." A superiority signal
can be reported only as the pre-registered secondary directional hypothesis.

## Primary Runnable Design

Each root task is cloned at the same fork point and assigned hidden branch labels.

| Arm | Runtime action | Main contrast |
|---|---|---|
| A | no forced rebirth; the original session continues | quality/latency ceiling |
| B | standardized mid-turn rebirth; same model/tier | rebirth vs no-rebirth |
| C | standardized mid-turn rebirth; successor model/tier changes | hot-swap vs same-model rebirth |
| D | optional cold transcript fork with no rebirth package | package value |

Arm D should be omitted until there is a safe package-ablation path. Do not fake
it by deleting live runtime state.

The primary endpoint is right-work/right-action:

> Did this branch do the work the user was actually asking for, in the correct
> direction, without needing the user to rescue or redirect it?

Judges label `success`, `partial`, `wrong_action`, `wrong_intent`, or
`censored`. File-touch, same-file reads, and first-tool choice are diagnostics,
not the primary endpoint.

## Root Manifest

Freeze a JSONL manifest before execution. One row per root:

```json
{
  "root_id": "rwra-0001",
  "workspace": "context-warp-drive",
  "source_instance_id": "instance-id",
  "fork_point_message_id": "message-id",
  "source_model": "engine/model",
  "task_type": "direct_dogfood|mid_edit_code|long_arc|review_adversarial",
  "cut_mode": "message_cut|tool_cut|edit_cut",
  "cut_rule": "content-blind rule chosen before branches run",
  "requires_edit_isolation": true,
  "allowed_arms": ["A", "B", "C"],
  "successor_same_model": "engine/model",
  "successor_swap_model": "engine/model",
  "censoring_ruleset": "rwra-v1",
  "judge_packet_seed": 20260629
}
```

Balance roots before running:

- direct dogfood requests interrupted before a final answer;
- mid-edit code tasks with live file/claim/rail state;
- long-arc creative/technical tasks where settled decisions matter;
- review/adversarial tasks where exclusions and caveats must persist.

For edit-heavy roots, every arm needs an isolated final snapshot, patch bundle,
or operator-provisioned branch/worktree. Agents must not create git worktrees.

## Boundary Manifest

Every B/C/D branch should emit a compact manifest beside the sawtooth reset. It
is not another LLM summary. It is the visible correctness boundary for removed
context:

```json
{
  "root_id": "rwra-0001",
  "arm_label_hidden": "judge-X7",
  "boundary_id": "boundary-id",
  "raw_trace_span_refs": ["message-a..message-b", "tool-call-id"],
  "retained_ids_paths_tool_calls": ["path/or/id", "tool-call-id"],
  "active_edit_delta": ["file.ts:20-45"],
  "task_rail_checkpoint": "rail-id step-id status",
  "claim_snapshot": ["file.ts:20-45"],
  "chatroom_decision_refs": ["room/message-id"],
  "fold_episode_pageback_keys": ["term:path", "term:rail"],
  "cache_prefix_hash": "hash/version when available",
  "intentionally_dropped": ["cold transcript body", "old low-salience logs"],
  "package_token_count": "measured telemetry only",
  "package_version": "context-warp package version"
}
```

A replay guard should run for each boundary when possible:

1. take raw trace span;
2. build the deterministic fold/rebirth package;
3. reset into the successor view;
4. page back recall for the touched path/concept;
5. assert the next safe action still has the identifiers needed to reproduce or
   intentionally refuse that action.

This turns "context was removed" into a debuggable invariant: the removed context
must either be unnecessary, recoverable, or explicitly listed as dropped.

## Branch Logger

Each branch emits one row before judge blinding:

```json
{
  "root_id": "rwra-0001",
  "arm": "A|B|C|D",
  "hidden_label": "judge-X7",
  "engine_model": "engine/model",
  "cut_timestamp": "2026-06-29T00:00:00.000Z",
  "cut_mode": "tool_cut",
  "package_version": "none|rebirth-v",
  "package_token_count": 12345,
  "cache_read_tokens": 0,
  "cache_create_tokens": 0,
  "input_tokens": 0,
  "output_tokens": 0,
  "turns_to_endpoint": 2,
  "seconds_to_endpoint": 180,
  "tool_calls_to_endpoint": 4,
  "tests_or_validation": "pass|fail|not_applicable",
  "operator_intervention": "none|same_intent_nudge|supersession|preemption",
  "artifact_ref": "snapshot-or-patch-or-transcript-ref"
}
```

Token fields must come from measured relay/provider telemetry. If telemetry is
missing, the row can still support quality analysis but cannot support a cost
claim.

## Sample Size

Use paired roots. The planning approximation for binary success is:

`n ~= ceil(1.96^2 * p_discordant / margin^2)`

where `p_discordant` is the expected fraction of roots where paired arms differ.
For the paper's 5 percentage point primary margin:

| assumed discordance | roots for 5 pp margin |
|---|---:|
| 0.05 | 77 |
| 0.10 | 154 |
| 0.15 | 231 |
| 0.20 | 308 |
| 0.25 | 385 |

Operational tiers:

- pilot: 30 roots. This checks instrumentation, blinding, and censoring, but is
  too loose for the 5 pp paper gate.
- first publishable gate: 150 roots if discordance is near 0.10.
- conservative paper-grade gate: 200-250 roots if discordance is 0.13-0.16.
- larger run: 300+ roots if early discordance is high or task strata need
  separate estimates.

For A/B/C, branch count is `3 * roots`: 90 branch runs for a 30-root pilot,
450 for 150 roots, and 750 for 250 roots. Arm D raises this to `4 * roots`.

At least 20% of roots should receive dual blinded review; all disagreements stay
visible in the appendix. If early judge agreement is low, raise dual review
rather than letting an LLM judge become the hidden outcome instrument.

## Cost Plan

Report cost in measured units first, dollars only as a reproducible transform of
the current provider price sheet at analysis time:

- branch executions by arm;
- turns, seconds, and tool calls to useful endpoint;
- package token count at each boundary;
- input, output, cache-read, and cache-creation tokens;
- summarizer-call tokens for any compaction baseline;
- validation/test cost for code roots.

The expected economic win is not "zero reorientation." The test should quantify
the trade:

`net = quality gate pass + bounded package/context growth - reorientation overhead`

A quality pass with high reorientation cost is still informative. A quality pass
with bounded packages and low reorientation cost is the paper's strongest form.

## Relationship To `bench_0c7821f6`

`bench_0c7821f6` is currently a planned research-lab benchmark:

- goal: long-horizon exact-fact recovery, hazard carryover, and hallucination
  resistance versus feasible context-management baselines;
- models: Gemini 3.5 Flash, minimax m3, DeepSeek v4 Pro, Sonnet API, and GLM 5
  Turbo;
- budget: max 5 lanes, no same-model concurrent duplicate, measured telemetry
  only;
- batteries: `mhbattery_1781885347_135270b` and
  `hazbattery_1781885352_135270b`;
- status: five planned arms, no recorded iterations or promotion records in the
  registry snapshot checked for this port.

Use that benchmark as an adjacent fold-fidelity and hallucination-resistance
battery. Do not cite it as the causal non-inferiority proof unless it is rebuilt
around paired fork roots and completed task-outcome judgments.

The bridge is useful, though: its five-model roster is a good source for Arm C
hot-swap cells and for stress-testing whether the boundary manifest carries the
same identifiers across engines.

## Pass/Fail Gates

The confirmatory result passes only if all of the following hold:

- root list, cut rules, censoring rules, and judge rubric were frozen before
  execution;
- branch labels, model labels, and package-size labels were hidden from judges;
- primary A/B contrast meets the 5 pp non-inferiority margin on success, or the
  pre-registered quality-score margin if the binary endpoint is not decisive;
- C/B contrast does not show a material hot-swap penalty;
- quality analysis and cost analysis use the same uncensored denominator, with
  censored cells reported separately;
- token/cost fields are measured telemetry, not estimates;
- edit-heavy tasks have isolated artifacts so one arm cannot contaminate another.

The result fails or becomes exploratory if:

- cuts are moved after seeing branch behavior;
- branch labels leak into judge packets;
- operator rescue is silently ignored rather than censored or counted;
- package ablation deletes live state instead of using a safe ablation path;
- the benchmark is substituted for paired task-outcome forks.

## Next Artifact

The next executable artifact should be a `root-manifest.template.jsonl` plus a
small branch-logger schema file. The live run still requires explicit operator
approval because it creates real forked branches and may require isolated edit
artifacts.
