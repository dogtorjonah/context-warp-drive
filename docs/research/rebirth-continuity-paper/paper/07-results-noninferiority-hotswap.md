## 7. Results — Non-inferiority and Model Hot-Swap

The most distinctive thing rebirth can do is also the thing a reviewer will most doubt: continue the
*same* running instance under a *different model*. An agent can be reborn across a model swap — the same
instance object, same id, same task-rail cursor, now executing under a new backend. The question is
whether that swap costs continuity. We frame it the way a clinical trial frames a non-inferiority claim:
a point estimate and confidence interval against a margin, with the explicit goal of showing *not
worse*, never *better*.

### 7.1 Within-engine model swap shows no detected penalty (on the over-determined axis)

**Swapping the model at the rebirth boundary shows no detected continuity penalty: in-flight work continues at 28% versus 27% for same-model rebirths, a +1-point difference whose interval straddles zero.**

Our swap metric is **mid-edit state-continuation** (`C_state`, §4), measured within captured cases: an
agent is mid-edit, a rebirth lands, and we ask whether the in-flight edit is continued — comparing swap
(model changes at the boundary) against same-model rebirths. At a 60-event window, **swap continues 28%
vs same-model 27% — a difference of +1 point [−8.6, +10.7]**; at a 150-event window the difference is
**+3.5 [−6.1, +13.7]** (95% CIs are instance-cluster bootstrap on the difference, §4.9). Both intervals
straddle zero.

Two cautions keep this from being over-read. First, **`C_state` sits on the over-determined axis.** §4.2
is the paper's load-bearing negative result: in-flight *state* survives a rebirth through redundant
channels — the working tree, the file still on disk, a competent successor's mechanical re-derivation —
so continuing a mid-edit is only weakly attributable to the package, and it is precisely the axis on
which non-inferiority is nearly *guaranteed*. Our best-populated swap cell therefore measures the
dimension least able to expose a penalty; a null here is expected, not reassuring. Second, once the
cluster-robust interval is used, even this cell is honestly **"underpowered to detect a within-engine
penalty,"** not evidence of "no penalty": [−8.6, +10.7] comfortably admits a continuity cost of several
points in either direction. What we can defend is narrow — across captured within-engine swaps we see
*no detected* penalty on the over-determined state axis, with intervals too wide to confirm true
non-inferiority.

The axis that *would* be informative is the one rebirth can actually lose: **intent**-continuity (N2,
§4.3), which is causally package-dependent (§4.2). A real swap penalty is far likelier to surface as a
failure to carry the *intent* across a model change than as a failure to keep typing into a file that is
still open on disk. The package-design literature sharpens why: under-specification regresses
*specifically across model or prompt changes* (arXiv:2505.13360), so a package too thin to fully carry the
intent should reveal its deficit precisely at a hot-swap boundary — which makes intent-continuity across a
model change not merely the informative axis but the one most sensitive to a lean-package failure, and the
over-determined `C_state` cell the one least able to expose it. §7.2 names the N2 denominator as the lever that enlarges the swap sample; the sharper
implication of the over-determination result is that the *right* hot-swap experiment measures
intent-continuity across the boundary — which is exactly what the §8 paired fork is built to do.

### 7.2 Cross-engine swap is underpowered — stated, not hidden

**Across model *families* the swap difference is −4 points [−12.4, +4.4] — consistent with no penalty, but the sample is too small to confirm it.**

Swapping across model *families* (e.g. a Claude predecessor to a Codex successor) is where we have the
least data, and we will not overclaim it. The cross-engine difference is **−4 points [−12.4, +4.4]** at
n = 133 (W150: **−4.5 [−13.3, +4.5]**) — consistent with no penalty, but the interval is wide enough that
a modest penalty cannot be ruled out. This cell is **underpowered**, full stop. The lever to firm it up is the intent-continuity
(N2) denominator (§4): it admits the interrupted-root cases that `C_state` cannot see, enlarging the
cross-engine sample. Until then, the honest statement is "consistent with non-inferiority, not yet
powered to confirm it."

<figure>
<svg viewBox="0 0 760 344" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" role="img" aria-label="Forest plot of the paper's difference estimates: four hot-swap cells and the controlled rebirth-versus-compaction A/B, all with cluster-robust 95 percent confidence intervals straddling zero.">
  <text x="28" y="24" font-size="15" font-weight="700" fill="#1a1a1a">F. The difference estimates in one view — every interval straddles zero</text>
  <text x="28" y="42" font-size="10.5" fill="#6b7280">Percentage-point differences · cluster-robust 95% CIs · positive favors the swap / rebirth arm</text>
  <g font-size="9" fill="#9ca3af" text-anchor="middle">
    <text x="250" y="60">&#8722;15</text>
    <text x="323.3" y="60">&#8722;10</text>
    <text x="396.7" y="60">&#8722;5</text>
    <text x="470" y="60">0</text>
    <text x="543.3" y="60">+5</text>
    <text x="616.7" y="60">+10</text>
    <text x="690" y="60">+15</text>
  </g>
  <g stroke="#e5e7eb" stroke-width="1">
    <line x1="250" y1="68" x2="250" y2="256"/>
    <line x1="323.3" y1="68" x2="323.3" y2="256"/>
    <line x1="396.7" y1="68" x2="396.7" y2="256"/>
    <line x1="543.3" y1="68" x2="543.3" y2="256"/>
    <line x1="616.7" y1="68" x2="616.7" y2="256"/>
    <line x1="690" y1="68" x2="690" y2="256"/>
  </g>
  <line x1="470" y1="68" x2="470" y2="256" stroke="#94a3b8" stroke-width="1.5"/>
  <g font-size="10.5" fill="#374151" text-anchor="end">
    <text x="240" y="96">within-engine swap &#8722; same (W60)</text>
    <text x="240" y="128">within-engine swap &#8722; same (W150)</text>
    <text x="240" y="160">cross-engine swap &#8722; same (W60, n = 133)</text>
    <text x="240" y="192">cross-engine swap &#8722; same (W150)</text>
    <text x="240" y="236">rebirth &#8722; compaction, first action (&#167;5.8.2)</text>
  </g>
  <g stroke="#1f2937" stroke-width="1.5">
    <line x1="343.9" y1="92" x2="626.9" y2="92"/><line x1="343.9" y1="88" x2="343.9" y2="96"/><line x1="626.9" y1="88" x2="626.9" y2="96"/>
    <line x1="380.5" y1="124" x2="671" y2="124"/><line x1="380.5" y1="120" x2="380.5" y2="128"/><line x1="671" y1="120" x2="671" y2="128"/>
    <line x1="288.1" y1="156" x2="534.5" y2="156"/><line x1="288.1" y1="152" x2="288.1" y2="160"/><line x1="534.5" y1="152" x2="534.5" y2="160"/>
    <line x1="274.9" y1="188" x2="536" y2="188"/><line x1="274.9" y1="184" x2="274.9" y2="192"/><line x1="536" y1="184" x2="536" y2="192"/>
    <line x1="308.7" y1="232" x2="528.7" y2="232"/><line x1="308.7" y1="228" x2="308.7" y2="236"/><line x1="528.7" y1="228" x2="528.7" y2="236"/>
  </g>
  <circle cx="484.7" cy="92" r="4.5" fill="#2563eb"/>
  <circle cx="521.3" cy="124" r="4.5" fill="#2563eb"/>
  <circle cx="411.3" cy="156" r="4.5" fill="#2563eb"/>
  <circle cx="404" cy="188" r="4.5" fill="#2563eb"/>
  <circle cx="411.3" cy="232" r="4.5" fill="#16a34a"/>
  <g font-size="9.5" fill="#1f2937" text-anchor="middle">
    <text x="484.7" y="80">+1.0</text>
    <text x="521.3" y="112">+3.5</text>
    <text x="411.3" y="144">&#8722;4.0</text>
    <text x="404" y="176">&#8722;4.5</text>
    <text x="411.3" y="220">&#8722;4.0</text>
  </g>
  <line x1="40" y1="206" x2="720" y2="206" stroke="#e5e7eb" stroke-width="1"/>
  <line x1="323.3" y1="212" x2="323.3" y2="248" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="323.3" y="262" font-size="9" fill="#dc2626" text-anchor="middle">&#948; = &#8722;10 pp</text>
  <rect x="20" y="272" width="720" height="44" rx="8" fill="#eef2ff" stroke="#c7d2fe" stroke-width="1.3"/>
  <text x="380" y="290" font-size="10.6" font-weight="700" fill="#3730a3" text-anchor="middle">The four swap cells are underpowered, not exonerated — wide intervals admit modest penalties either way (&#167;7.1&#8211;&#167;7.2).</text>
  <text x="380" y="306" font-size="10.5" fill="#4338ca" text-anchor="middle">The controlled A/B row passes its pre-registered &#948; = 0.1 non-inferiority gate: parity, the designed win condition (&#167;5.8.2).</text>
</svg>
<figcaption><strong>Figure F.</strong> Every difference estimate the paper computes, on one axis. The four hot-swap cells (blue) straddle zero with wide cluster-robust intervals — read as <em>no detected penalty</em>, never <em>no penalty</em>. The controlled realized-action A/B (green) lands at −4 pp [−11, +4] against its pre-registered non-inferiority margin of δ = −10 pp (dashed): parity, the outcome the non-inferiority design was built to detect. Positive values favor the swap / rebirth arm.</figcaption>
</figure>

### 7.3 A calibration win, reported against ourselves

**We caught ourselves: an early result showing swap *better* by +20 points was a small-sample artifact that collapsed to +1 on the full corpus.**

An earlier draft of this result, computed on a sample rather than the full corpus, showed swap
*outperforming* same-model by **+20 points** at the 60-event window. On the full corpus that gap
regressed to **+1**. We report this because it is the discipline working: the apparent +20 was a
small-sample artifact, caught by re-running on the full population before it reached a claim. It is the
reason the headline is "no detected penalty" and never "swap is better" — a phrase the data has already
tried to tempt us into once.

### 7.4 The hot-swap existence proof

**One identity rode five engines across sixteen live model swaps while continuing a single line of work — an existence proof, not a controlled test.**

Beyond the aggregate, a single qualitative case makes the mechanism concrete. One identity
(iid `VHOKudnK`) threads **five distinct engines across sixteen live model swaps** while continuing one
line of work. It is not a controlled comparison and we do not treat it as one; it is an
*existence proof* — the same instance object survived repeated, heterogeneous model changes and kept
going, which is precisely the capability the aggregate non-inferiority result says is not penalized.
Hot-swap, in this framing, is a **temporal model-orchestration axis**: an operator can change the
backend mid-task the way a bandleader changes a soloist mid-piece, and the piece continues.

### 7.5 Opus→Codex in practice: continuity preserved, and a reviewer that caught us

**In the specific Opus→Codex direction the swap is operationally clean: 10 of 12 successors do real work on their very first post-swap turn.**

The cross-engine cell of §7.2 is underpowered as a *quality* test, but the deployment still answers a
narrower, answerable question about the specific Opus→Codex direction: when an Opus agent's work is
continued under Codex — by an in-place rebirth swap or a forked reviewer — is the swap *operationally*
usable, and does the new perspective help? Across the **17 Opus→Codex swaps** we can identify (9 forked
reviewers, 8 in-place rebirth swaps; 12 turn-indexed), the answer is yes on both counts, **descriptively**:
**10 of 12 are productive on their first post-swap turn** (near-instant reorientation, no cold restart),
~72% of post-swap turns do real work, and they edit **690 files** in aggregate. The swapped Codex
successor inherits the package and continues rather than floundering — `quantum-falcon` alone edited 241
files across an in-place Opus→Codex rebirth swap.

The sharper evidence is self-referential. Among these Opus→Codex forks is `9eRO`, whose corrections are
recorded in this paper's own changelog: it removed a "well-powered" overstatement from §7.1 and softened
the §8 methodology overclaims (the pass that also demoted the dominance / zero-cost framing). The swapped
Codex perspective, in a fresh context, did not merely *avoid* a penalty — it **caught and corrected this
paper's own overclaims**. That is the §8.3 forked-reviewer mechanism realized in exactly the direction this
section measures: a Codex reader red-teaming an Opus author's numbers.

We keep the boundary explicit. This is **observational reorientation-and-actionability evidence, not a
powered quality verdict**: it shows the Opus→Codex swap is usable and that the cross-context reading can
help, but the aggregate cross-engine effect remains the underpowered **−4 [−12.4, +4.4]** of §7.2, and the
headline is unchanged — *no detected penalty, not superiority*. Five of the 17 swaps (including two
high-volume Knowledge Kraken forks that are not turn-indexed) fall outside this descriptive sample, so even
the operational read is partial.
