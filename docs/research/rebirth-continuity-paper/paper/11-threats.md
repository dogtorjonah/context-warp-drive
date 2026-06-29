## 11. Threats to Validity & Limitations

This is the section we wrote first in our own minds and last on the page, because it is where the paper
earns or loses the right to be believed. The results in §5–§7 are strong, and that is exactly why we
spend a full section enumerating the ways they could be wrong, the claims we have already retracted
against ourselves, and the one measurement we set out to make and could not. We organize threats from
the most consequential (we cannot prove causation) to the most structural (the paper is written by the
system it measures), and we state a concrete mitigation or disclosure for each.

### 11.1 The headline limitation: observational, not causal

**Threat.** Every recovery, persistence, and hot-swap number in §5–§7 is *observational*. We measure
what happened across 8,717 rebirths on a live deployment; we do not observe the counterfactual. When a
successor completes an interrupted intent, we cannot prove from the logs that the rebirth *caused* the
completion — the same instance might have completed it anyway under compaction, or the task might have
been easy. A recovered intent and a non-inferior swap are both consistent with "rebirth works" and with
"the corpus is dominated by tasks that recover regardless of mechanism."

**Mitigation.** This is the primary limitation and we frame it as future work, not as a defended claim.
The fix is designed, reviewed, pre-registered, and *not yet run*: the four-arm paired fork-and-compare
of §8 (`controlled-ab-spec.md`), which clones a real interrupted task at its cut point and runs
no-rebirth / same-model-rebirth / hot-swap-rebirth / no-package branches side-by-side with arm labels
blinded from the judge. Pairing removes between-task variance — the precise confound the observational
corpus cannot escape. Until those forks run (they are gated behind explicit operator approval), the
honest standing of §5–§7 is "production behavior at scale, consistent with the causal hypothesis, not
yet a causal test." The *primary* causal target is narrower than a superiority claim: the fork need only
show that rebirth is **not worse** within the pre-registered quality margin. If it clears that gate, the
cost and cache measurements become the reason to prefer it. We do additionally register a *secondary*
directional hypothesis — that rebirth is **superior** on quality, motivated by the long-context degradation
literature (§2.5, §10.2) — but keep it strictly subordinate: it is read only if the primary gate clears, a
null on it changes no headline, and it imports results measured on other systems (§11.11). We report **no
A/B numbers we have not collected.**

What we *have* collected sits one rung below that causal target, and we report it as exactly that: a
controlled **realized-action A/B** (§5.8.2) that holds the model and prompt fixed and varies *only* the
resume artifact — the one non-observational comparison in the paper. Paired across **five boundaries × five
model families** under an identical rubric, it finds **parity**: rebirth and a fair, full-context compaction
summary drive equally correct first actions (≈ **0.89–0.93** each; paired gap within ±0.04, non-significant;
sign test *p* = 0.77). Realized-action non-inferiority therefore **holds as measured parity** — consistent
with the δ = 0.1 margin (it passes on the pooled estimate and on both cluster bootstraps; the reliable-judge
cluster-robust *t*-test is marginal, as five boundary clusters give only four degrees of freedom) but **not a
behavioral win**. This does not discharge §11.1, on two counts: it scores the first move, not the completed
outcome (a correct opening is a *leading indicator* of a faithful trajectory, not proof of one), and it
measures *single-shot* compaction, not the chained summary-of-summary a long session actually accumulates.
What it does establish cuts honestly against easy triumphalism: the §8 task-outcome test is **not pre-ordained
for rebirth at the behavioral level** — a fairly-windowed compaction summary resumes the first action just as
well — so rebirth's case rests on **determinism, cost, and versatility** (§5.8.2), and on the *predicted but
untested* divergence under chained compaction, rather than on out-resuming compaction turn for turn. The new
recursive-summary literature lowers the burden for why that chained arm matters — MMPO names progressive
task-relevant information loss and semantic noise under recursive summaries (arXiv:2605.30159), and
Context-Folding reports gains over summarization-based context management (arXiv:2510.11967) — but it does
not lower the evidentiary bar for claiming a measured win on this substrate. That bar is the matched
telephone test in §8.7.

### 11.2 Construct validity: parser-success is not substantive completion

**Threat.** "Success" throughout §5 is the relay turn parser's completion label
(`turnParser`) — it fires when a turn reaches a completing assistant message that the parser scores as
serving the open intent. A parser label is a proxy. A turn can be marked complete while the work is
shallow, wrong, or merely *claimed* done; conversely a genuinely-finished intent can be mislabeled if
the completing message is unusual. Parser-success ≠ substantive completion.

**Mitigation.** We treat the stricter standard as a pre-stated sensitivity cut rather than burying the
proxy. A "substantive completion" judge — a human or model rater scoring whether the work actually
satisfied the acceptance criterion, not just whether a completing message arrived — folds into the
construct-validity analysis (§4) and into the blinded judging of the §8 A/B, whose **primary outcome is
"right work / right action" judged against the original open intent, never file-touch.** Our headline
is therefore deliberately the conservative parser-*floor* (87%), not the judged rate; if anything the
proxy understates failures of substance, and we say so rather than letting the parser's optimism stand
unqualified.

The §5.3.1 first-turn random audit is also a construct-validity warning, not a cleanup victory lap. Its
blind negative controls were detected at **26 / 30 = 86.7%**, but a manual audit of the four false-cleans
found that the control set itself was imperfect: one task-mismatch donor was another chess-port/review
lane and therefore not a viable negative, one mismatch was viable but soft, and two gutted controls
still leaked positive evidence through metadata (`file_work`, large token counts, file-overlap anchors,
and `files_on_or_after_arrival`) even after the visible work text was emptied. The *single-model*
worry, separately, is partly retired: a cross-model second judge (`gpt-5.4-mini`) re-scored a random
40-packet subset of the real arm and landed within five points of DeepSeek (82.5% vs 87.5% clean, 80%
case agreement), so the base rate is not one model's leniency — but a cross-model judge does nothing to
fix a leaky *control* set. We therefore treat the first-turn audit as corroborating evidence only. It
cannot replace the parser-floor headline, and any future first-turn claim that leans on it must
regenerate the controls with metadata leakage removed and stricter topic/file-disjoint mismatch donors,
and ideally extend the cross-model judge to the full 150-packet arm rather than the 40-packet subset.

### 11.3 Censoring subjectivity — and the staleness that survives it

**Threat (subjectivity).** The lift from the 87% raw floor to the ~98% uncensored rate (§5.1) depends
on a human-applied rule for separating an *operator supersession* (the user changed the ask — a censored
non-event) from an *open intent that was abandoned* (a real failure). That rule is a judgment call. A
more lenient coder inflates the rate; a stricter one deflates it. The 213-row recode that produced the
lift is one analyst's application of one rule.

**Threat (staleness of the uncensored ceiling).** More importantly, the uncensored cells have not fully
kept pace with the substrate. The 2026-06-08 rebuild made the **parser-floor current and full-corpus** —
the 87.5% recovery, 91.3% dogfood, and the persistence rates are computed on the freshly rebuilt 22,444
turns. We also now have a current recode artifact over the 111 suspect rows, but it is not a finished
manual ceiling: the deterministic heuristic estimates 97.2% overall / 97.7% human-direct uncensored
recovery, and a row-level audit finds that **57 of the 111 suspect rows are non-intents** (chatroom-invite
wake events and system messages) that should have been censored before scoring. The old manual uncensored
recode (**98.3% [97.1, 99.0]** overall, **97.6% [95.8, 98.7]** human-intent, and the **~2%**
true-hard-failure figure) is therefore **still a stale ≤May-19 judged subset** and now mainly serves as
historical context. So the single most impressive number in the paper still carries a substrate
asterisk that the headline floor does not.

**Mitigation.** We never present ~98% as the current headline. Every table cell carries an explicit
substrate label — `current parser-floor`, `current heuristic recode`, or `stale ≤May-19 recode` — and the
discipline is stated once and applied throughout: **report the floor, the uncensored estimate, and the
censored cells, and never round to "99%."** The standing recommendation, stated in the reproducibility
appendix, is that the uncensored claim should not be called a *current manual ceiling* until the suspect
rows are hand-adjudicated under the same rule (or a validated automatic recoder reproduces the hand
labels).

### 11.4 Statistical dependence: clustering, effective N, and multiple comparisons

**Threat.** Our data are nested — turns within instances within engines — and rebirths cluster heavily
by instance id: a handful of long-lived instances contribute a disproportionate share of transitions.
Treating each rebirth as an independent Bernoulli trial (naive binomial/Wilson) is therefore false: the
effective N is smaller than the row count, so naive intervals are *too narrow*. Compounding this, we make
comparisons across eight engines (§5.5), so some apparent differences are multiple-comparison artifacts.

**Mitigation.** This threat is no longer merely disclosed — it is **computed and corrected.** Every
headline 95% CI in §5 and §7 is now a nonparametric **instance-cluster bootstrap** (resample whole
instances, B = 5,000, seed 20260608), reported alongside its **design effect** and **effective N**
(§4.9). The correction is material, which confirms the threat was real. The recovery floor widens to 87%
**[83, 91]** (deff 3.3). The persistence rates carry the heaviest clustering — design effects up to
**5.7**, an effective N (≈390) against the nominal 2,211 — so their previously tight
intervals were the most misleading and are now honestly **[86, 92]** and **[95, 97]**. The hot-swap
difference widens to **[−8.6, +10.7]** (§7.1), which is precisely what downgrades that cell from "no
penalty" to "underpowered to detect a penalty." One result cuts the other way and is worth stating: the
human-dogfood rate is the *least*-clustered headline (deff **1.2**, effective N ≈556 of 643), so its
**[88, 93]** interval barely moves — the most statistically independent metric in the paper is the exact
dogfood pattern its authors live in. The per-engine breakdown (§5.5) keeps naive intervals with the
multiple comparisons uncorrected; we read it for completeness only and decline to rank engines causally.
The sharpest demonstration that this threat bites is the retraction in §11.5: the original first-utterance
"zero disorientation" claim rested on a tight naive interval whose effective N was a few dozen instances,
and it collapsed once clustering was taken into account.

### 11.5 Claims we retracted, reported against ourselves

Credibility in a self-authored systems paper is bought with retractions, not with a clean story. Two
earlier claims did not survive our own adversarial teardown, and we report them as deletions rather
than quietly dropping them.

**C1 — first-utterance "zero disorientation" — RETRACTED.** An earlier draft claimed that reborn
successors essentially never showed disorientation in their first utterance. It does not hold. The
disorientation detector had near-zero recall (it caught essentially none of the hand-found cases), so
"zero detected" was a measurement failure, not a property of the system. Worse, a hand audit found a
genuinely disoriented successor (instance `8d12cOo-`) that asked for instructions **while holding a
~45K-token package that already contained the active task** — a real counterexample the detector missed
entirely. And the "zero" rate's tight CI was an artifact of the clustering threat in §11.4: the
effective N was on the order of a few dozen, not the row count implied. The claim is withdrawn in full.

**N1 — file-locality as evidence of superior resumption — DEMOTED to diagnostic-only.** An earlier
analysis treated a reborn agent re-touching the "right" file (or re-invoking the right rail tool) as
evidence that it had resumed the task better than a baseline. That inference is invalid: touching the
right file is not doing the right work — a successor can re-open the correct file and still pursue the
wrong action, or complete the intent without re-touching anything. Re-run honestly with a within-instance
non-rebirth baseline, the targeting signal is near parity (post-rebirth first-file-on-target 51.3% vs
49.9% baseline; read-targeting 51.2% vs 38.7% shows rebirth re-grounds attention on the right file more
often, but that is *orientation*, not *completion*). We therefore retain file-touch, first-touch
targeting, and same-file rereads only as **supporting diagnostics that can never decide an outcome** —
the scar that drove the §8 design decision to judge "right work," not file-touch.

### 11.6 An honest negative: ENDURE is not supportable on the current substrate

We proposed a three-clock model of continuity — **ORIENT** (does the successor wake up oriented),
**COMPLETE** (does it finish the interrupted intent), and **ENDURE** (does the work it produces hold up
over time — e.g. the quality of its changelog and rework downstream). Only one of the three is carried
by this paper as a positive result, and we are explicit about the other two:

- **COMPLETE** is the paper's empirical spine (§5) and stands.
- **ORIENT** lost its headline (the C1 retraction, §11.5) and survives only as the targeting
  *diagnostics* of §11.5 — suggestive, not a claim.
- **ENDURE** is an **honest negative.** We attempted to measure post-rebirth durability through the
  Atlas changelog-and-rework record and concluded it is **not supportable on the current substrate**:
  the Atlas annotations are too sparse and too unevenly attributed across instances to separate "the
  reborn agent's work endured" from "nobody happened to touch it again." Rather than manufacture a
  third clock from a substrate that cannot bear it, we report ENDURE as a measurement we could not make
  and flag the substrate enrichment it would require as future work. A negative result honestly stated
  is worth more here than a fabricated positive.

### 11.7 Underpowered cells, stated rather than hidden

**Threat.** The cross-engine hot-swap cell — continuity when the model *family* changes at the boundary
— is underpowered. The point estimate is **−4 points [−12.4, +4.4] at n = 133**: consistent with no penalty,
but the interval is wide enough that a modest real penalty cannot be ruled out. Reading it as
confirmation of cross-engine non-inferiority would overclaim.

**Mitigation.** We state it as underpowered, full stop, and we do not let the larger
within-engine result (Δ +1 [−8.6, +10.7], itself underpowered on the over-determined state axis, §7.1) launder the cross-engine cell. The lever to firm it up is named
concretely (§7.2): the intent-continuity (N2) denominator admits the interrupted-root cases that the
mid-edit `C_state` metric cannot see, enlarging the cross-engine sample, and the §8 paired design is
where pairing pays off most. Until then the honest statement is "consistent with non-inferiority, not
yet powered to confirm it."

### 11.8 Selection, survivorship — and who chooses the boundary

**Threat.** The corpus is what the relay happened to log. Some instances are missing transcripts or
events (a transcript was never written, was rotated, or predates a logging change), so any instance that
left no recoverable trace is invisible to us — classic survivorship. The 43 cold/library resumes with no
in-corpus predecessor are an example we can see; the ones we cannot see are the concern. Separately, a
small number of pathological stuck-loop instances were treated as engineering hiccups and excluded
rather than counted as continuity failures.

**Mitigation.** We disclose both and state the **direction of bias.** Missing transcripts most plausibly
omit short-lived or crashed instances, which would bias recovery rates *upward* (we are more likely to
retain instances that lived long enough to do recoverable work) — so the true population rate is
plausibly *below* our floor, which is one more reason we headline the conservative floor and not the
uncensored rate. The stuck-loop exclusions are characterized as a fixable engineering failure mode, not
an inherent property of rebirth; excluding them also biases the rate upward, and we disclose the
reasoning rather than absorbing them silently. The failure anatomy itself now has a measured shape:
§5.3's first-turn-class table shows **83% of all persistence failures (427/514) are wake-ups that
produced no first-turn text** — the corpus's dominant failure mode is a successor that never spoke, not
one that spoke and went wrong. The same table bounds what any text-level audit (§5.3.1) can miss:
text-bearing wake-ups persist at ~99% regardless of length, so the unobserved mass concentrates in the
silent class a text judge structurally cannot score.

**Threat (endogenous boundary timing).** Rebirths are not placed at random moments. Agents self-rebirth
when they judge the moment survivable, wave pipelines fire at phase seams, operators refresh at natural
pauses — and clean-boundary handoffs outnumber interrupt-preceded ones roughly 3:1 in the corpus (§5.3).
The recovery band therefore measures continuity under *mostly well-chosen* boundaries, not under
adversarial timing; a mechanism that worked only when its operator picked good moments would look
similar in these aggregates.

**Mitigation.** Three observations bound the threat rather than dismiss it. First, the cohort with the
*least* agent control over timing — the human-dogfood cut, where a person interrupts mid-turn at a moment
the agent did not choose — recovers at **91.3%**, the *highest* cohort floor in the paper (§5.2), which
cuts directly against well-chosen timing explaining the band. Second, the interrupt-preceded persistence
rate (89.4%) sits only ~6 points below the clean-boundary rate (95.7%), bounding the well-timed-boundary
advantage to single digits on that axis. Third, the §8 Arm-B design cuts at a *standardized,
content-blind* point — the exogenous-timing test this observational corpus cannot supply. The direction
of any residual bias is upward for the headline rates, which is one more reason the conservative floor,
not the censored ceiling, is the headline (§4.7).

### 11.9 External validity: one system, eight engines

**Threat.** All evidence comes from a single deployment (this relay). Eight model engines is *within-
system* replication — the same orchestration substrate, package format, turn parser, and SOP layer
throughout — not cross-system generalization. A different agent platform with a different handoff format
might behave differently. It is also a single-*operator* deployment: eight engines diversify the model at
the boundary, not the human whose interaction style, steering cadence, and task mix shape the corpus.

**Mitigation.** We scope the claims accordingly: the findings are about **long-running multi-agent
systems with persistent session state and structured tool logs**, demonstrated to replicate across eight
heterogeneous backends *within* such a system. We do not claim the numbers transfer to a system that
lacks a curated package or a turn-segmented history; we claim the *mechanism* (a bounded, intent-
preserving handoff resets context without forfeiting continuity) is the transferable idea, and the §8
protocol is written to be reproducible on any platform that can fork a session at a cut point.

### 11.10 Reflexivity: the paper is a dogfood artifact

**Threat.** This paper was researched, drafted, and revised by agents running inside the very system it
measures — across rebirths and model swaps, on the rail it describes. That is rhetorically powerful and
methodologically hazardous: the authors are not neutral, the measurement apparatus and the measured
phenomenon share a codebase, and a system that wrote a flattering paper about itself is exactly what a
skeptic should distrust.

**Mitigation.** We disclose the reflexivity plainly and lean on the safeguards that make it auditable
rather than asking for trust: a **frozen, checksum-verified reproducible corpus** (§4.6, appendix) so any
reviewer can recompute every number; **pre-registered falsifiers** (the over-determination test in §4.2
that *fired against our preferred story*); **retractions against ourselves** (§11.5) including the
deletion of the most quotable early claim; and a **gated, blinded, pre-registered A/B** (§8) whose
numbers we deliberately have *not* generated. The reflexive origin is real and we do not hide it; the
defense is that the work is built to be checked, and was checked — by the same forking instrument it
advocates, turned on its own conclusions.

### 11.11 The superiority argument imports results measured on other systems

**Threat.** §10.2 and the secondary directional hypothesis (§4.10, §8.1) argue that rebirth may be not
merely non-inferior but *better* than its incumbents, on the grounds that long context degrades reasoning
intrinsically. That argument leans on a literature (arXiv:2510.05381, arXiv:2601.15300, arXiv:2602.04288;
§2.5) measured on *other* models, benchmarks, and context regimes — not on this relay's agents at this
relay's context lengths. Importing it is an inference, not a measurement: our agents might operate below the
lengths where degradation bites, or our task mix might be unusually robust to it, in which case the predicted
quality lift would not materialize and rebirth would be merely non-inferior — with a bounded, controllable,
cache-stable cost structure — rather than *better* on task quality.

**Mitigation.** We quarantine the claim structurally rather than asking for trust. The superiority hypothesis
is *secondary* and *directional*, pre-registered separately from the primary non-inferiority test (§8.1)
precisely so a null on it costs the headline nothing — the paper's load-bearing claim is non-inferiority,
which needs no degradation result to stand. The one piece of *our own* evidence pointed at the question —
§5.7's flat fidelity across rebirth depth — is reported as a *shadow consistent with* the direction, not a
controlled test, because the depth axis varies rebirth count rather than the unbounded counterfactual. And
where we *did* run a controlled head-to-head on our own system — the §5.8.2 realized-action A/B — rebirth and
a fair, full-context compaction summary **reached parity** on first-action correctness; so the superiority case
explicitly does *not* rest on out-resuming compaction behaviorally, only on determinism, cost, versatility,
and a chained-compaction divergence we predict but have not yet measured. External serial-memory evidence
supports the prediction but cannot promote it to a result. The
honest standing is that we argue the direction from external evidence plus one suggestive in-corpus pattern;
the §8 Arm-A contrast is the only thing that converts the argument into a measurement on our own system.

### 11.12 The live cache reproduction is n = 1, one night, one model family

**Threat.** §6.5's live reproduction is a single self-applied boundary, placed in a single night's
distribution of twelve boundaries on one model family, with receipts trustworthy only after a same-day
pricing fix — calibration-grade evidence, not a corpus claim, and reflexive in the §11.10 sense: the
measuring agent is the measured agent, reading its own receipts.

**Mitigation.** We scope §6.5 explicitly (n = 1 in n = 12, one night, one family, post-fix receipts only)
and let the corpus-level §6.2 carry the headline; §6.5's role is to upgrade the aggregate to a row-level
demonstration and to calibrate per-boundary-type bands, not to widen any claim. The reflexivity is
mitigated the same way as §11.10's: the rows are on disk (`relay/data/costs/`), the warm-share arithmetic
is a one-line ratio, and any reviewer can recompute the table from the named ledger.

---

**Summary.** The strongest thing rebirth has going for it — that it is measured at scale on a live
system — is also its central weakness, because scale on a live system is observational. We have been
deliberate about not letting the size of the corpus substitute for a causal test, about labeling every
number's substrate, about retracting what did not hold, and about reporting the clock (ENDURE) we could
not make tick. What remains after all of that — a current, conservative, full-corpus 87% recovery floor
with no detected within-engine hot-swap penalty — is, we argue, exactly the kind of claim that survives
its own threats section. The next claim is clear and still unearned: non-inferior quality under controlled
bounded resets — and, as a registered secondary bet, the *superior* quality the degradation literature
predicts but our substrate has not yet confirmed. That is the gate between an impressive deployment study and
a frontier-serving argument.
