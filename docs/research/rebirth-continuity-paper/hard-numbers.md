# How good is rebirth, really? — Hard Numbers

*rebirth-continuity paper · consolidated from the parser-review lane. Step-13 refresh completed on 2026-06-04 after teaching the turn parser to ingest rebirth artifact boundaries, then rebuilt after artifact/context envelope false positives were caught. The 2026-06-08 refresh rebuilt the turn layer again to current live data (22,444 turns; 8,717 rebirth arrivals) and emitted recode artifacts under `artifacts/recode-2026-06-08/` in the private analysis workspace. Those artifacts are not included in this public port. Parser-floor counts below are CURRENT unless explicitly labeled stale manual recode. All numbers carry N + 95% CI + a substrate label; headline rates use a nonparametric instance-cluster bootstrap (B=5000, seed 20260608; design effects up to 5.7 for the refreshed §5 rates — see §4.9/§11.4 of the paper).*

---

## The one-paragraph answer

When a task is interrupted mid-flight and a **rebirth** picks it up, the successor carries it to completion **~88% of the time as a current parser-floor** (**780 / 891 actionable roots, 87.5% [83.4, 91.0]**). The human-direct dogfood pattern is now **91.3% [88.8, 93.5]** current parser-floor (**587 / 643**). A current deterministic heuristic recode estimates **97.2%** all-actionable uncensored recovery (788 / 811) and **97.7%** human-direct uncensored recovery (595 / 609), but it is provisional. A DeepSeek-v4-pro-max Judge A vs Gemini Judge B pass covers all 111 suspect rows, yet agreement is low (**40 / 111 exact, κ = 0.205**) and leaves **71** disagreements as `needs_human_adjudication`, so it is a current worklist, not a clean manual ceiling. The old ≤May-19 manual recode remains historical context only. The handoff remains cheap in turns, but not instant: median **1 turn**, about **5 minutes**, and **2 reorientation tool-calls**. And **switching the model across the rebirth shows no penalty detected on the state-continuation metric** (within-engine — itself underpowered and on an over-determined axis; cross-engine more so).

---

## 1. Recovery — interrupted intent → rebirth → completion  `[CURRENT parser-floor]`

The core question: an intent was cut off before the agent could finish; a rebirth lands; does the successor complete the *same* intent?

| Cut | Rate | N |
|---|---|---|
| **Raw floor** (any fresh trigger breaks the chain) | **87.5% [83.4, 91.0]** | 780 / 891 |
| Wake-turn immediate completion | 78% of actionable roots · 89% of recovered | 693 / 891 · 693 / 780 |
| Multihop recovered after wake turn | 11% of recovered | 87 / 780 |
| **Current heuristic uncensored** (provisional; deterministic machine pass) | **97.2% [95.8, 98.3]** | 788 / 811 |
| **Current dual-judge consensus-only** (DeepSeek A × Gemini B; 71 disagreements censored) | **97.9%** | 799 / 816 |
| **Stale manual uncensored** (exclude final censored cells; ≤May-19 recode) | **98.3% [97.1, 99.0]** | 749 / 762 |
| **Stale manual uncensored, human-intent roots** | **97.6% [95.8, 98.7]** | 449 / 460 |
| Stale true hard-failure (churns ≥15 turns, never completes, not superseded) | **~2.0%** | 11 / 538 human · 13 / 920 overall |

**Current recode status (2026-06-08):** `recode_current_rebirth_recovery.py` emits 934 roots, 891 actionable roots, and 111 suspect/parser-broken rows. The deterministic `heuristic_current_recode_v1` pass censors 80 all-actionable cells (36 operator supersessions, 41 external/system preemptions, 3 ambiguous) and leaves 23 hard failures. The independent-judge pass is valid but not converged: DeepSeek Judge A and Gemini Judge B each labeled all 111 suspect rows with no missing roots, but exact agreement is only 36.0% (κ = 0.205), so `adjudicate_current_recode.py` preserves 71 disagreements as `needs_human_adjudication` rather than forcing a false consensus.

**How the stale judged floor lifted to ~98% (213-row recode, by the superseded-vs-open rule):** among the 213 parser-broken rows, the first-break labels were `same_intent_nudge_or_reask` 87 (e.g. "did you fix it?", "go for it" — *these are continuations, not failures*), `operator_supersession_new_intent` 24, `external_chat_or_system_preemption` 98, and `ambiguous` 4 (87+24+98+4 = 213); a separate `no_success_in_window` 9 is a distinct break mode outside the 213 (never completed in window). The 87 same-intent nudges were followed forward: 51 later completed, 4 later hard-churned, 26 later ended in operator supersession, and 6 later ended ambiguous. Final recode censor cells were 50 operator supersessions, 98 external preemptions, and 10 ambiguous rows.
**Sensitivity (ambiguous human rows):** all-fail 95.5% [93.3, 97.1] → all-success 97.7% [95.9, 98.7].
**Claim discipline:** report the floor *and* the uncensored rate *and* the censored cells. **Not "99%" — ~98% uncensored.**

## 2. Dogfood cohort — a person's message, cut mid-turn, rebirth recovers it  `[CURRENT parser-floor]`

Human-direct pattern: `user_message` → turn interrupted, no completing AI response → next turn is a rebirth arrival → did the successor serve the original ask?

- **Human-direct (a person typed it, got cut, rebirth picked up):** **91.3% [88.8, 93.5]** current parser-floor (587 / 643 actionable; N_raw=686).
- Immediate (the wake turn itself completed it): 524 / 643 actionable roots (82%) · 524 / 587 recovered roots (89%). This is a stricter one-turn-success slice, not the floor.
- **Re-establishment cost: median 1 turn · 330s · 33K tokens · 2 reorientation tool-calls.**
- Chatroom/agent-relayed roots (agent→agent, *not* human dogfood, kept separate): 78% [65.1, 88.4], 193 / 248.
- **Face validity** (real rows, cut mid-turn, then rebirth-recovered): *"Tap your partner. He said he found the root cause." · "Did you fix it?" · "Do you see Atlas tools?"*
- **Current heuristic uncensored dogfood recode:** **97.7% [96.3, 98.8]** (595 / 609), provisional machine pass.
- **Current dual-judge consensus-only dogfood:** **98.7%** (606 / 614), but only after censoring unresolved judge disagreements; not a final human-adjudicated ceiling.
- **Stale manual uncensored dogfood recode:** the ≤May-19 exact subset reached **97.5% [95.6, 98.6]** uncensored recovery (433 / 444), with **2.1%** true hard-fail (11 / 517). This remains historical, not the current claim.
- **Stale censored cells:** 48 operator supersession + 15 external preemption + 10 ambiguous. Same-intent nudges were followed forward: 51 later recovered; 4 later hard-churned; 31 later reached a censored endpoint.

## 3. Persistence — any rebirth handoff → carried work continues to done  `[CURRENT parser-floor]`

Distinct from recovery: no intent was *cut*; did the carried workstream persist through the handoff?

- **Interrupt-preceded** (n=2,211): **89.4% [86.0, 92.3]** persist to same-intent success (1,977 / 2,211; immediate 1,659).
- **Clean-boundary** (deliberate/manual rebirth, n=6,463): **95.7% [94.6, 96.7]** — cleaner handoffs continue *more* reliably (6,183 / 6,463; immediate 5,056). *This thread is a clean-boundary case.*
- Population: 8,717 `trigger_type='rebirth'` arrivals after artifact-backed boundary detection and clean rebuild; 43 cold/library resumes have no in-corpus predecessor.

## 4. Re-establishment cost — how expensive is continuity  `[CURRENT parser-floor]`

- **Recovered roots:** median **1 turn · 297s · 30K tokens · 2 reorientation tool-calls.**
- **Dogfood recovered roots:** median **1 turn · 330s · 33K tokens · 2 reorientation tool-calls.**
- **Multihop recovery** (n=87): median 2 turns · 522s · 43K tokens · 3 reorientation tool-calls.

## 5. Hot-swap — does changing the model across the rebirth cost continuity?  `[FULL CORPUS — not stale]`

Mid-edit STATE-continuation metric, within-captured, model-swap vs same-model:

- **W60: SWAP 28% vs SAME 27% → Δ +1 [−8.6, +10.7]. W150: Δ +3.5 [−6.1, +13.7]. → No detected penalty — but underpowered on the over-determined state axis (cluster CIs; §7.1).**
- **Cross-engine** (different model *families*): Δ −4 [−12.4, +4.4], n=133 (W150 Δ −4.5 [−13.3, +4.5]) → **underpowered**; a modest penalty can't be ruled out. The §8 intent denominator is the lever to firm this.
- Honest claim: *no penalty detected on captured state-continuation*, not formal non-inferiority and never "swap is better." (The sample's earlier +20pt @W60 regressed to +1 on full corpus — caught by verification.)

## 6. By successor-instance engine — recovery rate  `[CURRENT parser-floor]`

⚠️ **Successor-instance engine, NOT a mid-life hot-swap** (`turns.engine` is denormalized → blind to swaps). Do **not** read this ranking as a swap effect; claude-lowest is task-mix/label-strictness confounded.

codex 90% [86, 93] n=295 · claude 92% [88, 94] n=252 · deepseek 88% [82, 92] n=144 · glm 72% [62, 79] n=106 · gemini 87% [75, 94] n=53 · minimax 89% [67, 97] n=18 · claude-api 91% [62, 98] n=11 · claude-interactive 71% [36, 92] n=7 · kimi 80% [38, 96] n=5.

---

## Caveats — what these numbers are and are not

- **Refresh scope:** §1–4, 6 are current parser-floor values from the repaired 2026-06-08 rebuild. The final rebuild ran 2026-06-08T07:43Z–07:47Z with `--rebuild-turns`, recreated 22,444 turns from 1,483 transcripts, and left the exact bad pattern `trigger_type='rebirth' AND outcome='success' AND user_request='[CONTEXT REBIRTH]' AND ai_result=''` at **0 rows**. Embeddings were skipped because rates/counts do not need vectors; semantic turn search vectors need a separate embedding refresh after a rebuild.
- **Manual recode scope:** the current machine heuristic is provisional, and the current dual-judge pass is a low-agreement worklist (71 disagreements). The historical ~98% uncensored / ~2% true-hard-fail claims remain the stale ≤May-19 judged subset; none should be called a current manual ceiling until the disagreements are human-adjudicated under the same rule.
- **`success` = parser-success** (`turnParser` label). A stricter "substantive completion" judge is the sensitivity cut (folds into s6 construct-validity).
- **Observational, not causal.** These measure *what happened*, not *what would have happened without rebirth*. The clean causal proof is the **fork-and-compare** experiment (same message, one branch rebirthed mid-turn, one not, compare outputs) — banked as the controlled experiment. The dogfood cohort (§2) is the observational version already sitting in the logs.
- **Intent same-ness** rests on `[CONTEXT REBIRTH]` package continuity (interrupted roots carry 0 files_touched) — i.e. the package *is* the link, which is the paper's "irreplaceable cargo" thesis, evidenced.

## Provenance

Computed this session (2026-06-08) on an operator-private relay data export plus `global_index.sqlite`. Refresh path: `relay/scripts/refreshTurns.ts --rebuild-turns` -> `backfillAllTurns({ rebuild: true })` with rebirth boundaries loaded from `$RELAY_DATA_DIR/rebirth/*.jsonl`; final run window 2026-06-08T07:43Z-07:47Z, no embeddings. Current artifacts were emitted in the private analysis workspace under `artifacts/recode-2026-06-08/` (`current_recovery_roots.jsonl`, `current_persistence_rows.jsonl`, `suspect_rows.jsonl`, `judge_packets.jsonl`, `summary.json`, `run_manifest.json`, `judge-a-deepseek.labels.jsonl`, `judge-b.labels.jsonl`, `adjudicated_recode.jsonl`, `disagreements.jsonl`, `adjudication_summary.json`) and are intentionally not included in this public port. Historical artifact retained for comparison: an operator-private stale <=May-19 manual recode.
