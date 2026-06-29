## 8. Forking Methodology & Experimental Design

The results in §5–§7 are **observational**. They measure what happened across 8,717 rebirths on a live
deployment, which is their strength — this is production behavior at scale, not a constructed benchmark.
But observation cannot answer the counterfactual a skeptic rightly insists on: *given the same work and
the same intent, what would have happened without the rebirth?* A recovered intent might have recovered
anyway; a non-inferior swap might be non-inferior only because easy tasks dominate the corpus. This
section presents the design that closes the observational-to-causal gap — a paired controlled fork —
and then makes a methodological argument that the *forking* the design relies on is itself a research
instrument, one this paper already used on itself.

The controlled experiment is **designed, reviewed, and pre-registered, but not yet run**: live forks are
gated behind explicit operator approval. We therefore report it as a frozen protocol and forthcoming
result, and we report **no A/B numbers we have not collected.**

The retrospective corpus and the controlled experiments play different roles. The corpus is the moat:
real operator pressure, real long arcs, real failure modes, and enough scale to discover what should be
measured. The generated/replay experiments are the armor: paired counterfactuals, blinded judgments, and
pre-registered non-inferiority margins. Rewriting this paper as only a synthetic benchmark would make it
cleaner and less interesting; leaving it as only retrospective evidence would make it easier to dismiss.
The workshop version should keep both: **deployment-scale observation to show the phenomenon matters,
controlled forks to show the mechanism is not worse.**

### 8.1 From observation to a counterfactual: the fork-and-compare design

The core idea is simple: clone a real interrupted task at its fork point and run the branches
side-by-side, with branch labels hidden from the judge. Four arms are pre-specified
(`controlled-ab-spec.md`):

| Arm | What happens | The contrast it isolates |
|---|---|---|
| **A — no-rebirth continuation** | the same session continues past the user message; no forced rebirth | quality/latency ceiling (the compaction-only baseline) |
| **B — warm rebirth, same model** | the same message, then a standardized mid-turn rebirth; successor keeps the model | rebirth *vs.* no-rebirth |
| **C — warm rebirth, hot-swap** | as B, but the successor's model/tier changes at the boundary | hot-swap *vs.* same-model rebirth |
| **D — cold transcript fork** (optional) | same visible transcript and message, but **no package** — no Active Edit Delta, no recent-progress trail, no live claim/rail/chatroom cargo | the *value of the package itself* |

The cut is content-blind and pre-registered per root (message-cut, tool-cut, or edit-cut); it is never
moved because a branch looks good or bad. Roots are paired and stratified before running — direct
dogfood, mid-edit code work, long-arc creative/technical work, and review/adversarial work — with a
minimum useful pilot of 30 roots and a paper-grade run of 150–250.

**The primary outcome is "right work / right action," judged against the original open intent — not
file-touch.** This is the single most important design decision, and it is a scar from our own
analysis: an earlier behavioral metric treated touching the right file (or the right rail tool) as
evidence of task resumption, and it was wrong — a successor can re-open the correct file and still be
doing the wrong thing, or complete the intent without re-touching anything (§4.2–§4.4, §11). File-touch,
first-touch targeting, and same-file rereads are retained only as *supporting diagnostics*; they cannot
decide the outcome. Judges are blinded to arm, model, and package size; at least 20% of roots get dual
human review with disagreements adjudicated and kept visible.

Censoring is pre-stated and content-blind — operator supersession and external preemption are excluded
from the uncensored denominator and reported as their own cells; same-intent nudges ("did you fix it?",
"continue") stay in-chain — so the experiment inherits the same floor-and-uncensored discipline as the
observational results (§5.1). Analysis reports paired differences with 95% CIs (McNemar-style discordant
counts for binary success) against pre-registered **non-inferiority margins of 5 percentage points** on
success and 0.25 on a 5-point quality score.

Because the contrast is paired, the same design that tests non-inferiority can detect its opposite. Arm A is
not a neutral control — it is the **long-context arm**: the session continues past the cut without resetting,
so by the deeper checkpoints it carries exactly the accumulated, possibly drag-laden context the degradation
literature implicates (arXiv:2510.05381 finds reasoning falls even under perfect retrieval; arXiv:2602.04288
finds prior errors in the context bias later steps toward repeating them; §2.5). We therefore pre-register, as
a **secondary directional hypothesis kept strictly separate from the primary non-inferiority test**, that the
quality difference may *favor* rebirth — a superiority signal, not merely a null. The separation is the
discipline: registered in advance, a lift is a called shot rather than a post-hoc story, and its absence costs
the non-inferiority headline nothing. The primary claim stays *not worse*; the secondary, literature-motivated
claim is *possibly better*, and only the paired Arm-A contrast can settle it.

The cross-engine cell — the one §7.2 flagged as
underpowered observationally — is precisely where the paired design pays off: pairing removes
between-task variance, so far fewer roots are needed to resolve a swap penalty than the observational
n = 133 implies.

### 8.2 The Mandelbrot temporal-trace lane

Aggregate non-inferiority tests whether the swap has a detectable continuity penalty; it does not show
what temporal model-orchestration *feels* like across a real arc. As a pre-registered rich case study
(not a substitute for the statistical table), one concrete task — a Mandelbrot-zoomer build with 5–10
checkpoints — is run as
Arm A (same-session), Arm B (same-model rebirth at each checkpoint), and Arm C (model-swapped rebirth at
each checkpoint, rotating phase-appropriate models: a planning model, an execution model, a review
model). Each checkpoint is judged for arc preservation, useful next action, and design-decision
retention. The statistical table addresses non-inferiority; this lane shows the lived shape of one
evolving trace followed across model swaps without resetting its direction.

### 8.3 Forking as a research instrument

The deeper methodological point is that the fork is not only the *object* of study — it is the *tool* of
study, and this paper is its own demonstration. The same primitive that lets one task be cloned into A/B
arms lets a working agent be **forked into a panel of parallel reviewers**: an implementer continues
while forked copies independently red-team the result, each in its own context window, coordinating only
through the shared chatroom and file-claim surfaces. This is a cheap way to manufacture *parallel
counterfactuals* — multiple independent readings of the same artifact, produced concurrently rather than
serially.

We used it on this work. The metric apparatus and numbers behind §4–§7 were not accepted on the
author's say-so; they were torn down by a forked adversarial squad (lanes A–D in the `#parser-review`
room) running tautology, counterfactual, causality, and uncensoring critiques in parallel. That panel
is the reason several headline claims in this paper are *weaker* than the first draft: a first-utterance
"zero disorientation" metric was **retracted** when a fork found a real disoriented case its detector had
scored as clean and showed the metric was near-tautological; a superiority reading of file-locality was
**demoted to a diagnostic**; the +20-point hot-swap effect was **regressed to +1** on the full corpus
(§7.3). Each of those corrections is the instrument working — an adversary with its own context window
catching an error the author was motivated to miss.

That cheapness rests on how little it costs a fork to reorient. Across the research forks we can trace in
the turn index, the **initial trigger was the coordination surface the method already relies on** — a
mention or directive in the shared research chatroom, not a cold spawn — and reorientation was near-instant:
**7 of 9 were productive on their first turn** (a tool call or a file edit), inheriting the package and
acting rather than re-investigating, with forks branched from a shared checkpoint reorienting *identically*
(the expected signature of splitting one package into N successors). The branches also **composed the other
primitives** — several hot-swapped model (claude→codex) and then rebirthed on their own lineage, stacking
fork, swap, and rebirth on a single branch; a forked reviewer that softened this very section's overclaims
was one such claude→codex fork. This is a reorientation-*cost* reading on a partial
sample (9 of 16 research forks are turn-indexed): it shows the fork acted immediately on inherited context —
the pre-condition the §8.1 experiment assumes — not that the action was right, which remains the §8.1
right-work outcome, not something we read from a first-turn tool call.

The fork-and-compare experiment in §8.1 and the
forked-reviewer methodology here are the same capability pointed at two targets: one at the phenomenon,
one at the paper about it. That capability is itself an *implication* of rebirth, not only a method: §10.6
draws it out as a deployment primitive — the branch operator that a reproducible, cache-stable package makes
cheap, and whose honest limit (forks share one filesystem) is the same over-determined-state boundary at §4.2.

### 8.4 Status and what closing the gap requires

To be explicit about epistemic standing: §5–§7 are the observational evidence and they are real; the A/B
protocol above is the causal proof and it is **designed and frozen, not executed**. Of the observational
behaviors, the one that most directly anticipates the A/B primary outcome is intent-anchored: resumed
in-flight edits are re-engaged at a high rate (≈83% across all eras, ≈96% post-May; §4), and the dogfood
recovery floor (§5.2) is the observational shadow of the experiment's right-work/right-action judge.
What the controlled run adds is the missing denominator — Arm A — that turns "the successor finished
87–91% of the time" into "the successor finished within X points of what *no rebirth at all* would have
achieved, at a bounded fraction of the context cost." When the operator approves execution, the next
artifact is a frozen root manifest plus a branch logger that emits the §4-spec fields and masks arm
labels for the judges. An ungated offline precursor — counterfactual replay against the recorded next
action (§8.6) — already yields a first action-level signal on the frozen corpus while the live forks await
that approval.

### 8.5 Controlled experiment battery

The fork-and-compare design is the statistical spine, but the workshop paper benefits from a compact
battery that tests the same thesis from several angles. Each experiment has the same decision logic:
first test quality non-inferiority, then read cost/cache/latency as the economic consequence.

| # | Experiment | What it isolates | Primary endpoint |
|---|---|---|---|
| 1 | **Normal continuation vs. rebirth fork** | Whether a bounded reset is non-inferior to no reset on the same root | right-work success and 5-point quality |
| 2 | **Summary-compaction baseline** | Whether rebirth beats the incumbent lossy/blocking context strategy | quality, dropped-intent errors, latency |
| 3 | **Fresh-agent handoff baseline** | Same-identity continuation vs. "new agent reads notes" | rediscovery cost, rail/claim drift, completion |
| 4 | **Package ablation** | Which cargo is load-bearing: the *irrecoverable* core (open intent + Active Edit Delta) vs *recoverable* primitives (rail, claims, chatroom, Atlas, waypoints) a successor can re-derive | quality delta per removed primitive, paired with reorientation cost |
| 5 | **Every-turn rebirth stress** | The frontier hypothesis: bounded re-grounding every turn | non-inferiority plus cache-read stability |
| 6 | **Context-pressure threshold sweep** | How often rebirth should fire before overhead dominates | cost-quality frontier over trigger thresholds |
| 7 | **Cross-model hot-swap matrix** | Model/tier routing under one identity | swap-minus-same quality and recovery cost |
| 8 | **Mandelbrot temporal-trace build** | Long-arc design continuity, not toy completion | checkpoint-level arc preservation |
| 9 | **Coordination and forced-failure stress** | Claims, rails, chatroom decisions, mid-edit interrupts | duplicate edits, lost decisions, recovered intents |
| 10 | **Prompt-cache and billing replay** | Whether measured cache/cost follows the §9 model | cache-read rate, billed input, predicted vs. observed cost |

The first four are the minimum publishable causal set: mechanism, incumbent baseline, identity baseline,
and ablation. Experiment 2 is where the affirmative claim is adjudicated head-to-head: it pits rebirth
directly against summarization-based compaction — the incumbent this paper argues against (§2.3, §10.1) — on
quality and dropped-intent errors, not only latency, so a win there is the direct evidence that a bounded,
intent-preserving reset *dominates* lossy summarization rather than merely matching it. Experiment 3, the
fresh-agent-handoff baseline, is the companion test against the "new agent reads notes" pattern (the handoff
debt of §1, §2.1). The every-turn stress and billing replay are the landmark-facing pair. The Mandelbrot lane
is not there to inflate N; it is the visible demonstration that the integrated primitives preserve a
living design arc rather than merely clearing benchmark tasks.

The ablation (#4) is pre-registered around a **recoverable-vs-irrecoverable** split. Its load-bearing-core
hypothesis is that the package's irreducible cargo is the *irrecoverable* subset — the open intent and the
Active Edit Delta, the only state with no authoritative external copy — while the *recoverable* primitives
(rail, claims, chatroom, Atlas, waypoints) trade reorientation cost for correctness, not quality, because a
successor can re-derive them on demand. The pre-registered direction is therefore that F1 (no Active Edit
Delta) bites and F2–F6 raise re-derivation cost without lowering quality. A further arm isolates the question
§3.3 raises: an **identity-framing ablation** (F0) strips the explicit same-identity cue — *"you are the
continuation of instance X; these are your claims, your rail, your role"* — while leaving the package's cargo
intact, testing whether the identity framing does causal work or is inert. The §3.3 binding-key argument
makes a *specific*, falsifiable prediction: F0 should bite on **coordination** correctness — duplicate edits,
mis-owned claims, a successor that cannot resolve which externalized state is its own, peers forced to
re-establish who it is — more than on single-agent output quality. A companion size sweep locates the
**lean-package floor**: observationally ~5–20K tokens, below which reliability drops and degenerate spin
appears — the under-specification wall, where a too-thin package regresses across the very model/prompt
changes a rebirth introduces (arXiv:2505.13360) — and above which richer packages add only a few points of
next-turn productivity while inviting the opposite failure, *premature exploitation*: a successor acting on a
rich package's stale conclusions before re-verifying them against the live environment (arXiv:2605.16143).
The floor thus has two walls, and the package-design literature names both. This is §3.6's
over-determined-state principle made testable — the full protocol is Experiment 4 in the companion design
doc. The deployment already runs a coarse, uncontrolled version of this test: the production default
renders the package in *lean* mode — only the hot tier of the activity trail, with the older warm/cold
tiers trimmed but left tap-recoverable (§3.2) — an implicit standing bet that the trimmed context is
recoverable-not-load-bearing. That the swarm sustains its 87% recovery floor under that default is weak
corroboration of the bet; Experiment 4 is what would settle it rigorously, by toggling the tiers under a
blinded quality judge rather than inferring from aggregate production rates.

### 8.6 Counterfactual replay: an offline, ungated path to the action-level counterfactual

§8.1's fork-and-compare is the clean causal test, but it is gated behind operator approval and reports no
numbers because it has not been run. There is a second route to a counterfactual that needs no live fork at
all — only the corpus and the real package builder — and it exploits a free ground truth the deployment
already recorded: **at every real boundary, the predecessor's actual next action is on disk.** If we
reconstruct the package as-of that boundary and hand it to the same model, we can ask the §8.1 primary
question — *does the successor take the right next action?* — against the recorded action as the answer key,
with no branch to label and no judge to blind.

**Method.** For a real historical boundary we (1) reconstruct the rebirth package offline with the
production package builder (`emit_policy_packages`), cut at the **exact question-arrival timestamp** so the
predecessor's answer and its next action are held out — the leakage-free discipline of §4.7 applied to a
single moment; (2) spawn a fresh successor on the **same model engine**, force-siloed, handed only that
package; and (3) compare its first action to the recorded one. Selection is the integrity gate: a candidate
counts only if the file its recorded first action read is **byte-frozen** — git-verified to carry no
post-cutoff commits and no working-tree edits — so the replayed successor reads the same bytes the
predecessor did. This is §5.7's frozen-world rule narrowed to the one file the next action touches.

**Selection is the binding constraint, and it is itself a finding.** The corpus is a *live* repository, so
most of what an agent read at a boundary has since changed. A 75-candidate cross-engine census over 14
workspaces yielded only **8** boundaries whose recorded first-action file was still frozen; **50 of 75**
failed on post-cutoff commits alone, and full-*turn* freeze (every file the turn touched, unchanged) was
rarer still — **2 of 21** audited. Clean counterfactual replay is therefore scarce by construction, and the
survivors skew toward read-and-answer turns that leave their target untouched — the same survivorship
caveat §11.8 raises, made quantitative.

**Pilot result.** As a method-establishing pilot — *not* a population estimate — we replayed **three**
frozen boundaries on their original engines (two Codex, one DeepSeek; Claude is excluded because the agent
spawn path forces subscription billing rather than the API, an instrument limit, not a result). Scoped to
the **first action only**, the successor reproduced the recorded action in **2 EXACT** cases (it read the
same file the predecessor read — `ecosystem.config.cjs`, on both Codex cutoffs) and **1 NEAR** (the DeepSeek
successor read a *sibling* file in the recorded directory — `SUPABASE-BASELINE.md` where the record was
`MOBILE-BASELINE.md` — then globbed for the folder), with **no misses**. Given only the reconstructed
package, the model went to the same file or the right neighborhood.

**What this is and is not.** It is the §8.1 primary outcome measured offline, on free ground truth, at the
cheapest granularity — and it is *not* a result. n = 3; the two Codex cases are the same instance and file at
two cutoffs (≈ two distinct situations, not three); and — the caveat §4.2 makes mandatory — a first-action
**file** match is *action selection*, a necessary precursor to right-work, not right-work itself: a
successor can open the right file and still do the wrong thing. Decisively interpreting even an EXACT rate
further needs the **sampling-noise floor** the live forks supply — how often the same model, from the
*identical* full context, repeats its own first action (the d(A,A′) anchor of §8.1). Until that floor is
measured, 2-of-3 EXACT is *consistent with* "the package is a near-sufficient statistic for the next action"
but cannot be attributed to the package over ordinary model determinism. The method's value is that it is
**ungated and runnable today** on the frozen corpus — a cheap precursor that can be scaled to inform the
powered live fork, not replace it. The selection, freeze-audit, package-reconstruction, and scoring scripts
are under `experiments/counterfactual-replay/`.

### 8.7 Chained-compaction telephone test: the direct serial-data arm

The literature now gives us a narrower prior than "summaries are lossy." Recursive-summary memory work
reports exactly the failure mode a long agent would face — repeated summaries can shed task-relevant facts and
inject semantic noise as they recurse (arXiv:2605.30159) — while context-folding results show that avoiding
summarization-based context management can outperform it on long-horizon agent tasks (arXiv:2510.11967).
That prior lowers the experimental bar but does not erase it. If the paper wants to claim that rebirth beats
**serial** compaction on this system, the required measurement is a matched chained-compaction arm.

**Design.** Reuse the same historical boundaries already powering §5.8.1–§5.8.2. For each instance chain,
construct three artifacts at each boundary `k`: `R_k`, the deterministic rebirth package emitted by the
production package builder; `C_full,k`, a single-shot full-transcript compaction summary up to the cutoff
(the fair, best-case compaction arm §5.8.2 already approximates); and `C_chain,k`, a serial summary built the
way a long-running compacted session would actually accumulate it:

```text
C_chain,0 = compact(transcript segment 0)
C_chain,k = compact(C_chain,k-1 + transcript segment k)
```

The segment boundaries are the real rebirth boundaries, so depth is matched: a depth-20 rebirth package is
compared to a depth-20 chained summary, not to a fresh one-shot summary with privileged access to the whole
history. The compaction prompt, model, budget, and temperature are fixed; multiple independent chains per
boundary measure summary-generation variance separately from response-sampling variance.

**Endpoints.** The first endpoint is **artifact fidelity slope**: concrete identifiers, file paths,
`file:line` anchors, active rail steps, current acceptance criteria, and pinned decisions retained relative to
the boundary oracle. The second is **behavioral first-action correctness** under the same blind rubric as
§5.8.2: feed each artifact plus the next user message to the same responder models and score whether the
first action resumes the live intent. The third, for a smaller live-fork sample if operator approval is given,
is **task-outcome correctness** — not just the first action, but whether the branch completes the original
intent. Analysis is paired by boundary and model, clustered by original instance, with the load-bearing test
being the depth interaction: `R_k` should stay flat with depth (§5.7 already suggests this), while `C_chain,k`
is predicted to lose artifact fidelity and then behavioral correctness as summaries recurse.

**What current data is enough for.** We do **not** need this arm to cite against serial-summary risk: the
external literature already establishes recursive summaries as a plausible degradation channel, and our own
§5.7/§5.8 data already show non-decay plus deterministic reproducibility for rebirth. That is enough for the
paper's present, defensible claim: rebirth maintains fidelity across deep production chains and matches
single-shot compaction on first-action quality while avoiding compaction's stochastic artifact-generation
layer. We **do** need this arm for the stronger claim: rebirth beats serial compaction, on this substrate, at
matched depth. The clean next experiment is therefore not another broad observational scrape; it is this
telephone arm over the existing five boundaries first, then a powered expansion to 30-50 boundaries once the
pipeline and judge agreement are stable.
