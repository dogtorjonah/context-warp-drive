## 4. Metrics & Method

This section defines what we measure, on what substrate, and how we keep the measurement honest. The
central design decision is *what continuity even means* for a reborn agent. We arrived at it the hard
way — by first building a behavioral re-discovery metric, discovering that it measured an
over-determined quantity, and pivoting to the axis that is actually carried by the package and nothing
else. We describe that path because the negative result is load-bearing: it is the reason we believe
intent-continuity, not state-continuity, is the right thing to measure.

**The evaluation pipeline, in brief.** Before any number, here is how we get one (Figure B). The live
system runs under rebirth, producing thousands of real rebirth arrivals across eight engines.
We *freeze* that history into a git-pinned corpus and parse every transcript into a `turns` table, where
each turn is labeled with an outcome — `success`, `failure`, `interrupted`, or `rebirth`. Continuity then
reduces to a single question asked of every interrupted intent: did the *same* instance, after a rebirth,
reach a later message that completes it? We answer that question three ways on the same population, each
carrying an explicit substrate label: a conservative machine **parser-floor**, a **heuristic recode**
that censors the cells where the intent was legitimately superseded or externally preempted, and a
**stale ≤May-19 manual recode** retained only as historical context. The discipline
that governs all of §5–§7 is to report the *band, not the point*: the floor, the uncensored rate, and the
censored cells — each with its denominator — and never to round the result up to a single triumphant
figure. The subsections below define each stage precisely.

<figure>
<svg viewBox="0 0 760 414" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" role="img" aria-label="Evaluation pipeline from live deployment through the turn parser to three honestly-labeled continuity substrates.">
  <defs>
    <marker id="arrowB" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6 z" fill="#475569"/></marker>
    <marker id="arrowBb" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6 z" fill="#2563eb"/></marker>
  </defs>
  <text x="28" y="24" font-size="15" font-weight="700" fill="#1a1a1a">How continuity is measured — methodology before data</text>
  <rect x="20" y="48" width="160" height="74" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="100" y="74" font-size="12.5" font-weight="700" fill="#1a1a1a" text-anchor="middle">Live deployment</text>
  <text x="100" y="94" font-size="10.5" fill="#6b7280" text-anchor="middle">8,717 rebirth arrivals</text>
  <text x="100" y="108" font-size="10.5" fill="#6b7280" text-anchor="middle">8 engines</text>
  <rect x="210" y="48" width="160" height="74" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="290" y="74" font-size="12.5" font-weight="700" fill="#1a1a1a" text-anchor="middle">Frozen corpus</text>
  <text x="290" y="94" font-size="10.5" fill="#6b7280" text-anchor="middle">1,483 transcripts · git-pinned</text>
  <text x="290" y="108" font-size="10.5" fill="#6b7280" text-anchor="middle">+ cache/cost telemetry</text>
  <rect x="400" y="48" width="160" height="74" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="480" y="70" font-size="12.5" font-weight="700" fill="#1a1a1a" text-anchor="middle">Turn parser</text>
  <text x="480" y="88" font-size="9.6" fill="#6b7280" text-anchor="middle">22,444 turns &#8594; outcome &#8712;</text>
  <text x="480" y="101" font-size="9.6" fill="#6b7280" text-anchor="middle">{success, failure,</text>
  <text x="480" y="113" font-size="9.6" fill="#6b7280" text-anchor="middle">interrupted, rebirth}</text>
  <rect x="590" y="48" width="160" height="74" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="670" y="72" font-size="12.5" font-weight="700" fill="#1d4ed8" text-anchor="middle">Continuity test</text>
  <text x="670" y="91" font-size="10.3" fill="#1a1a1a" text-anchor="middle">interrupted &#8594; rebirth</text>
  <text x="670" y="105" font-size="10.3" fill="#1a1a1a" text-anchor="middle">&#8594; same intent done?</text>
  <g stroke="#475569" stroke-width="1.8">
    <line x1="182" y1="85" x2="208" y2="85" marker-end="url(#arrowB)"/>
    <line x1="372" y1="85" x2="398" y2="85" marker-end="url(#arrowB)"/>
    <line x1="562" y1="85" x2="588" y2="85" marker-end="url(#arrowB)"/>
  </g>
  <rect x="20" y="150" width="730" height="30" rx="6" fill="#eef2ff" stroke="#6366f1" stroke-width="1.3"/>
  <text x="385" y="170" font-size="11.5" fill="#3730a3" text-anchor="middle" font-weight="600">Intent-continuity scoring — the same population reported three honest ways</text>
  <line x1="670" y1="122" x2="670" y2="149" stroke="#2563eb" stroke-width="1.6" marker-end="url(#arrowBb)"/>
  <g stroke="#6366f1" stroke-width="1.5">
    <line x1="132" y1="180" x2="132" y2="206" marker-end="url(#arrowBb)"/>
    <line x1="380" y1="180" x2="380" y2="206" marker-end="url(#arrowBb)"/>
    <line x1="628" y1="180" x2="628" y2="206" marker-end="url(#arrowBb)"/>
  </g>
  <rect x="20" y="208" width="225" height="104" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="132" y="230" font-size="12" font-weight="700" fill="#1a1a1a" text-anchor="middle">Parser-floor</text>
  <text x="132" y="258" font-size="22" font-weight="700" fill="#15803d" text-anchor="middle">87.5%</text>
  <text x="132" y="278" font-size="10" fill="#6b7280" text-anchor="middle">[83.4, 91.0] · most conservative</text>
  <text x="132" y="294" font-size="10" fill="#6b7280" text-anchor="middle">any fresh trigger breaks the chain</text>
  <text x="132" y="306" font-size="9.5" fill="#9ca3af" text-anchor="middle">(machine, deterministic)</text>
  <rect x="268" y="208" width="225" height="104" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="380" y="230" font-size="12" font-weight="700" fill="#1a1a1a" text-anchor="middle">Heuristic recode</text>
  <text x="380" y="258" font-size="22" font-weight="700" fill="#15803d" text-anchor="middle">97.2%</text>
  <text x="380" y="278" font-size="10" fill="#6b7280" text-anchor="middle">[95.8, 98.3] · uncensored</text>
  <text x="380" y="294" font-size="10" fill="#6b7280" text-anchor="middle">censors supersession &amp; external</text>
  <text x="380" y="306" font-size="9.5" fill="#9ca3af" text-anchor="middle">(machine, provisional)</text>
  <rect x="516" y="208" width="224" height="104" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="628" y="230" font-size="12" font-weight="700" fill="#1a1a1a" text-anchor="middle">Stale manual recode</text>
  <text x="628" y="252" font-size="11" fill="#b45309" text-anchor="middle">&#8804;May-19 · archived</text>
  <text x="628" y="270" font-size="10" fill="#6b7280" text-anchor="middle">~98.3% uncensored ceiling</text>
  <text x="628" y="285" font-size="10" fill="#6b7280" text-anchor="middle">human-judged, ~74% of history</text>
  <text x="628" y="301" font-size="9.5" fill="#9ca3af" text-anchor="middle">(historical, not current)</text>
  <rect x="20" y="330" width="730" height="64" rx="8" fill="#fffbeb" stroke="#f59e0b" stroke-width="1.4"/>
  <text x="385" y="354" font-size="12" font-weight="700" fill="#92400e" text-anchor="middle">Censoring discipline</text>
  <text x="385" y="374" font-size="10.6" fill="#78350f" text-anchor="middle">Report the floor AND the uncensored rate AND the censored cells — each with its N —</text>
  <text x="385" y="388" font-size="10.6" fill="#78350f" text-anchor="middle">and never collapse the result to a single triumphant "99%."</text>
</svg>
<figcaption><strong>Figure B.</strong> The evaluation pipeline. Live rebirth arrivals are frozen into a git-pinned corpus, parsed into a <code>turns</code> table that labels each turn's outcome, and reduced to one question — did the successor complete the interrupted intent? The same population is then scored three ways with explicit substrate labels: a conservative machine <em>parser-floor</em>, a <em>heuristic recode</em> that censors supersessions and external preemptions, and a <em>stale ≤May-19 manual recode</em> retained only as historical context (§5). No single number is allowed to stand alone.</figcaption>
</figure>

### 4.1 The turn as the unit of intention

Our unit of analysis is the **turn**. A turn is a *trigger* — a user message or a wake event, which is
the primitive unit of intention — followed by the sequence of agent work that serves it, terminated by
a *completing assistant message* that fulfills the intent. This is not a post-hoc framing for the
paper; it is how the live system already segments history. The relay's turn detector
(`relay/src/specializedHistory/turnDetector.ts`) treats the turn as the graft unit and the trigger as
the intention primitive, and computes for each turn whether it is a rebirth continuation
(`isRebirthContinuation`) and whether it is incomplete (`isIncomplete`). The same turn abstraction drives the metrics substrate:
`relay/src/persistence/globalIndex/turnParser.ts` parses each transcript into the `turns` table,
assigning every turn a `trigger_type` (e.g. `'rebirth'`) and an `outcome ∈ {success, failure,
interrupted, rebirth}` — the fields the recovery and censoring rules in §4.3–§4.7 operate on.

A rebirth that lands **before** the completing assistant message interrupts a unit of intention: an
intent was opened and the agent died (was reborn) before serving it. The successor inherits that open
intent through the package. The question intent-continuity asks is precisely whether the same instance
then reaches a later completing message that serves *the same* intent.

The turn substrate is the `turns` table in `relay/data/global_index.sqlite` — **22,444 turns**
reconstructed from 1,483 transcripts in the 2026-06-08 rebuild (§4.6). Each turn row carries
`turn_id, instance_id, engine, started_at/ended_at, trigger_type, user_request, ai_result, summary,
files_touched_json, tools_used_json, outcome, token_count, repo_key`.

### 4.2 Why intent, not state, is the metric

We initially designed a behavioral metric, **Score A** (§4.4), that measured how much of the handover
*package* a successor actually used versus how much effort it wasted re-discovering things the package
already contained — a manifest-grounded, normalized analog of Handoff Debt's rediscovery cost. Building
and running it taught us something that reshaped the paper: **state continuity is over-determined.**

The evidence was a pre-registered falsifier that fired. If the package text were the channel carrying
in-flight *state* across the boundary, then successors whose package omitted the relevant file should
recover that state worse. They did not. On the full corpus, successors whose handover *lost* the focus
file continued at a rate no lower than those who kept it (truly-lost 34–41% ≥ captured 25–38%), and
they reached for `git`/working-tree inspection *less*, not more (truly-lost `git`-check 14% vs captured
55%) — the opposite of a filesystem-recovery story. State persists through multiple redundant channels:
the working tree is still on disk, the file is still where it was, and a competent successor re-derives
the edit mechanically. Enriching the package with more *state* bought no measurable continuity.

**Intent is the inverse — but only the part of it never written down.** Here a code fact sharpens an
earlier overstatement: the package builder renders the task-rail **`objective`**, the active step's
**acceptance criteria**, and **pinned decisions** as text, pulled *from* the rail and starred-moment
stores (`formatTaskRailContextForRebirth`, contextRebirthTool.ts). Intent is therefore a **spectrum**,
not a monolith. Its *externalized* part — the railed objective, the criterion already committed, the
decision pinned to a waypoint, the call recorded in chatroom — is **over-determined exactly as state is**
(§3.3): the package pre-renders it for convenience, but the stores would re-serve it regardless. Only its
*un-externalized* part — the open ask still living in the conversation, an emergent "what must not change"
that was never pinned — has no authoritative copy outside the package. This is §3.6's irreducible core
("the open intent and in-flight edits **not yet committed to any store**") restated as a metric boundary:
**the only artifact that carries the *un-externalized* intent across the boundary is the package** — and
that, not intent wholesale, is what intent-continuity isolates as causally package-dependent. The
organizing claim — *the package carries the intent, not the bytes* — survives the correction in its
honest, narrower form: **the package carries the intent the stores do not.** And §5.2 anchors it where it
is actually *measured* on un-externalized intent: the dogfood cohort, a human message cut mid-turn that
lived in no store, served on the successor's first wake turn (524 / 643) before any new input could
re-supply it. Score A is retained as supporting evidence (§4.4); the headline recovery results (§5) are
intent-continuity.

### 4.3 N2 — intent-continuity (two measures)

We operationalize intent-continuity (the metric we label **N2**) as two observational measures computed
off the turn corpus, with no new experiments.

1. **Intent completion (binary).** A rebirth interrupts a unit serving intent *I*. Did the **same
   `instance_id`** later reach a completing assistant message (`outcome=success`) that serves the *same*
   *I*? The rate over interrupted units is the intent-continuation rate. This is the intent analog of a
   recovery metric, on the channel that matters, and it is the basis of the recovery ladder in §5.

2. **Intent re-establishment cost (continuous).** Conditional on the successor serving *I*, how much did
   it spend getting back on the rails before serving it — measured in turns, wall-clock seconds,
   reorientation tool-calls, and input tokens. Low cost is the quantitative form of the subjective
   experience "it never has to reorient." Reported in §5.

**Same-intent matching** is the construct hinge, and we treat it conservatively. Deterministic proxies
come first: no *new superseding* user message between the interrupt and the completion; same
files/repo/rail-step; no relitigation of a settled decision. A sampled LLM-judge plus human spot-check
validates the proxy (§4.8). The critical rule, which directly shapes the denominator, is **supersession
vs. continuation**. A *new* user message that genuinely replaces the open ask means the intent
legitimately changed — that unit is censored, not counted as a failure (§4.7). But a *same-intent
nudge* ("did you fix it?", "go for it") is a continuation of the open intent, not a new one, and stays
in the denominator. Conflating the two is exactly the error that produces a dishonest headline.

### 4.4 Score A — the behavioral companion (supporting)

Score A decomposes "wasted re-discovery" into four sub-signals on [0,1], scored against a ground-truth
denominator. Because the system enforces a **no-silent-drops package manifest** M(T) — we know exactly
what the successor was handed (files in the file-context snapshot and active-edit delta, pinned
decisions, the rail cursor and active step, claims, coordination state) — we can normalize re-discovery
to a fraction rather than report a one-sided cost. The sub-signals: **R_read** (re-read avoidance — did
the successor re-open manifest files without new justification), **R_ret** (redundant-retrieval
avoidance — did acquisitions target information not already in M(T)), **D_con** (decision consistency —
did it honor pinned decisions rather than relitigate them), and **T_pos** (task-position continuity —
did it resume the handed rail step rather than restart). The composite is a weighted sum (default equal
weights), measured in a window of the first ~20 successor tool-actions.

We report Score A honestly as **supporting, not headline**, for two reasons grounded in our own data.
First, several sub-signals have low dynamic range or are partly mechanical: re-opening a file you are
about to edit is normal edit mechanics, not re-discovery, so R_read is near-ceiling and weakly
discriminating, and T_pos is a coarse proxy. Second, and more fundamentally, the over-determination
result (§4.2) means Score A is measuring a multi-channel quantity — it cannot attribute continuity to
the package because state survives by other routes. In the §4.2 spectrum this is sharper still: Score A's
own sub-signals sit at the *over-determined* end — `D_con` scores honoring a **pinned decision** and
`T_pos` resuming the **rail step**, both *externalized* intent the stores re-serve — so Score A
structurally cannot isolate the un-externalized core that N2 targets. The right read of Score A is therefore: it
established the manifest-as-denominator method and surfaced the over-determination finding that
motivated N2. We do not lean the paper's claims on its composite.

### 4.5 C_state — mid-edit state continuation (the hot-swap primary)

The hot-swap question (§7) — does changing the model across the boundary cost continuity? — needs a
within-boundary behavioral measure that does not depend on the unreliable session status label. We use
**C_state (MEC-strict): mid-edit state continuation.** The denominator is *behavioral*, not
label-based: the predecessor edited a code file within its last *L* edit actions **and** was mid-flight
at the boundary, where mid-flight means the predecessor's final turn did not close cleanly (no terminal
assistant message — e.g. a relay restart or user interrupt, both of which mislabel a mid-task agent as
"idle"). The focus file `primary_F` is the most-recent edited file. C_state asks whether the successor
continues editing `primary_F` within the window. We report endpoint tiers without collapsing them:
`strict_C_edit` (edits `primary_F`) is the headline, `prep_then_edit` a sensitivity cut, and
`source_or_claim_only` is orientation — explicitly *not* counted as success. Windows are **W60**
(primary) and **W150** (sensitivity); W20 is too tight. Using a behavioral mid-flight denominator both
sharpens precision and recovers false-idle mid-edits, which is what gives the underpowered cross-engine
swap cell what little power it has (§7).

**The measures at a glance.** The four operationalizations above, with the denominator each is
computed over, its primary endpoint, the substrate it runs on, and its role in the paper:

| Measure | Question it answers | Denominator | Primary endpoint | Substrate | Role |
|---|---|---|---|---|---|
| **N2 — intent completion** (§4.3) | Did the *same instance* later serve the *same* open intent? | interrupted actionable roots | completing assistant message (`outcome=success`) | current parser-floor | **headline** (§5.1–5.2) |
| **N2 — re-establishment cost** (§4.3) | What did the successor spend getting back on the rails before serving it? | recovered roots | turns · seconds · reorientation calls · input tokens | current parser-floor | headline (§5.4) |
| **C_state — mid-edit state continuation** (§4.5) | Does the successor keep editing the mid-flight file across the boundary? | behavioral mid-flight edits (label-independent) | edits `primary_F` within W60 (W150 sensitivity) | full-corpus | **hot-swap primary** (§7) |
| **Score A — re-discovery avoidance** (§4.4) | How much of the handed package did the successor use vs. re-discover? | no-silent-drops manifest M(T) | R_read · R_ret · D_con · T_pos composite | — | supporting only (§4.4) |

### 4.6 Corpus

The corpus is the live deployment itself, observed — not constructed. After artifact-backed boundary
detection and a clean rebuild, it comprises **8,717 `trigger_type='rebirth'` arrivals** (43 additional
cold library/resume boots have no in-corpus predecessor and are excluded from continuity rates). The
corpus spans **eight model engines** — Claude, Codex/GPT, DeepSeek, GLM, Gemini, MiniMax, Kimi, and
Claude API/interactive variants (`turns.engine` records the successor side of each boundary, §A.2/§A.5). The substrate is layered: full transcripts (`messages/`), per-instance
canonical event streams (`events/`), turn-aggregated cost and cache telemetry (`costs/`), structured rebirth
boundary records (`rebirth/*.jsonl`, one line per transition, carrying the rendered package and a
structured `packageJson` manifest), and the derived `turns` table (`global_index.sqlite`).

The entire corpus is **frozen and checksum-verified** for reproducibility: a consistent online snapshot
(SQLite via `VACUUM INTO`, directories via `rsync`, SHA-256 over every artifact) taken at git
`e577be1d46890b46a2981dd5f6ca457060d15cc1`, 5,441 files / 14 GB, with a `MANIFEST.json` and
`checksums.sha256` (Appendix A). Every number in this paper carries an explicit **substrate label**:
*CURRENT parser-floor* (from the repaired 2026-06-08 rebuild), *CURRENT heuristic recode* (a
deterministic provisional machine pass), *STALE ≤May-19 manual recode* (a hand-judged subset retained only as
historical context — labeled stale wherever it appears, never presented as current),
or *FULL-CORPUS* (the hot-swap state metric, which is not time-bounded).

**The frozen corpus.** The current parser-floor and full-corpus rates trace to this checksum-verified
snapshot; stale manual recodes are labeled separately wherever they appear:

| Layer | What it holds | Count / size |
|---|---|---|
| Rebirth arrivals | `trigger_type='rebirth'` boundary events — the unit of study | **8,717** (+43 cold library resumes, excluded from rates) |
| Turns | reconstructed units of intention (`global_index.sqlite`) | **22,444** from **1,483** transcripts |
| Transcripts | full per-instance message streams (`messages/`) | 1,487 JSONL files (1,483 contributed turns) |
| Cost / cache telemetry | turn-aggregated cache-read/write/input tokens (`costs/`) | 1,412 instance logs |
| Rebirth boundary records | rendered package + structured `packageJson` manifest (`rebirth/*.jsonl`) | one line per transition |
| Predecessor engines | Claude · Codex/GPT · DeepSeek · GLM · Gemini · MiniMax · Kimi · Claude-API/interactive | 8 families |
| Freeze | `VACUUM INTO` (SQLite) + `rsync` (dirs) + SHA-256, with `MANIFEST.json` + `checksums.sha256` | git `e577be1`, 5,441 files / 14 GB |

### 4.7 Censoring discipline — the 74%→98% lesson

The single most important methodological commitment in this paper is how we handle the ambiguous case
where *a fresh trigger arrives before the open intent is served*. There is a tempting dishonest move
here — quietly drop every such case as "not really a failure" and report the survivors — and it inflates
the headline by more than twenty points. We refuse it, and we report the full ladder instead.

- The **raw floor** counts *any* fresh trigger arriving before completion as breaking the chain. It is a
  deliberate conservative lower bound; it under-counts true continuity because it treats a legitimate
  user pivot as a failure.
- The **uncensored rate** excludes the final censor cells that are genuinely *not the successor failing*
  or cannot be safely assigned as successes: **operator supersession** (the user changed the ask — the
  intent legitimately ended), **external/system preemption** (an agent or system event interrupted, not
  a continuity loss), and **ambiguous rows**. Each excluded case is enumerated, not waved away.
- Ambiguous cases are kept *visible* and reported as a sensitivity band (all-fail vs. all-success).

The discipline is therefore: **report the floor AND the uncensored rate AND the censored cells, each
with its N.** We never collapse this to a single triumphant figure. The honest headline is the current
floor (§5) with uncensored rates shown alongside, each substrate explicitly labeled — explicitly **not
"99%."** The name "74%→98% lesson" records the history: an earlier stale floor of ~74% rose to ~98%
only after proper censoring, and the temptation to report the ceiling as the result is exactly what
this discipline exists to prevent.

### 4.8 Construct validity

Construct validity — does the metric measure the thing it claims to — is the foremost reviewer risk for
a behavioral continuity score, and we address it on four axes (cf. construct validity in LLM evaluation,
arXiv:2602.15532).

- **Face validity.** Each measure maps to an intuitive behavioral meaning, and the recovered units are
  real rows a reader can inspect: a message cut mid-turn ("Did you fix it?", "Tap your partner — he found
  the root cause", "Do you see Atlas tools?") followed by a reborn successor that serves exactly that ask.
- **Hand-validation.** On a 50-row sample, **49/50** units were correctly classified as engaged (the
  successor took up the handed intent) and **49/49** re-read decisions matched human judgment — a
  calibration check on the deterministic classifier, not a claim of perfect recall on the full corpus.
- **Convergent.** Intent-continuity moves with a Handoff-Debt-style re-discovery delta and a TCS-style
  completion ratio computed on the same data — different operationalizations of continuity that should,
  and do, agree.
- **Discriminant.** Continuity varies independently of session length and package token count; we control
  both so the score is not a proxy for "longer session" or "bigger package."
- **Sensitivity.** The metric responds where it should — to package richness (warm vs. cold handover)
  and to model swap — and is stable where it should be.

Two honest limits scope these claims. `outcome=success` is a **parser label**, not a semantic judge of
"substantive completion"; a stricter LLM-judge of fulfillment is reported as a sensitivity cut rather
than the headline. And same-intent matching, while deterministic-first, ultimately rests on a sampled
judge for the hardest cases — which is why the supersession-vs-continuation rule (§4.7) is stated as a
bright line rather than left to discretion.

### 4.9 Statistical inference: cluster-robust confidence intervals

Rebirth units are not independent. They cluster hard within `instance_id`: a single long-lived instance
contributes many rebirths that share its task, engine, operator, and codebase, so each of its rows
carries far less than one row's worth of independent information. Naive binomial/Wilson intervals, which
treat every rebirth as an independent Bernoulli trial, therefore *understate* uncertainty. We report
each headline 95% CI as a **nonparametric instance-cluster bootstrap** — resample whole instances (not
rows) with replacement, B = 5,000, seed 20260608 — and beside each we report the **design effect**
deff = Var_cluster / Var_naive and the **effective N** = N / deff. The design effects are large enough
to be a finding in their own right:

| Metric (§) | k / n | point | naive 95% | cluster-robust 95% | deff | n_eff |
|---|---|---|---|---|---|---|
| Recovery floor (§5.1) | 780 / 891 | 87.5% | [85.2, 89.6] | **[83.4, 91.0]** | 3.3 | 274 |
| Dogfood, human-direct (§5.2) | 587 / 643 | 91.3% | [88.9, 93.2] | **[88.8, 93.5]** | **1.2** | 556 |
| Dogfood, agent-relayed (§5.2) | 193 / 248 | 77.8% | [72.2, 82.5] | **[65.1, 88.4]** | 5.1 | 48 |
| Persistence, interrupt-preceded (§5.3) | 1,977 / 2,211 | 89.4% | [88.1, 90.6] | **[86.0, 92.3]** | 5.7 | 390 |
| Persistence, clean-boundary (§5.3) | 6,183 / 6,463 | 95.7% | [95.1, 96.1] | **[94.6, 96.7]** | 4.8 | 1,355 |

Two readings matter. The **persistence** rates are the most heavily clustered (deff up to **5.7**: an
effective N of ≈390 against 2,211 nominal), so their tight naive intervals were the
most misleading and the widened cluster-robust intervals are the honest ones. Conversely, the
**human-dogfood** rate is the *least*-clustered headline (deff **1.2**, effective N 556 of 643): a
person's interrupted message is close to an independent trial, so its interval barely moves — the most
statistically independent metric in the paper happens to be the exact pattern this paper's authors live
in, which we count as a strength rather than an accident. The hot-swap difference intervals (§7) are
computed the same way, bootstrapped on the swap-minus-same difference; the per-engine breakdown (§5.5)
retains naive intervals and is read for completeness, not inference. Point estimates and denominators
are unchanged throughout — clustering widens intervals, it does not move the rates — and every point
estimate regenerates exactly from the frozen corpus via `instance_bootstrap.py` (Appendix A.3).

### 4.10 The decision rule: non-inferiority, then economics

The experimental burden for rebirth is **not superiority**. A bounded reset does not have to produce
better answers than an uninterrupted long-context run to be valuable. It has to stay inside a
pre-specified **non-inferiority margin** on the work itself — same open intent, right action, acceptable
quality — while delivering a bounded, cache-stable prefix. Only after that quality gate is met do the
cost and cache measurements in §6 and the model in §9 become decisive.

This is why the controlled fork in §8 treats "right work / right action" as the primary outcome and
pre-registers non-inferiority margins (5 percentage points on binary success, 0.25 on a 5-point quality
score). We additionally pre-register a **secondary directional hypothesis**, kept strictly separate from
the primary non-inferiority test so a null cannot be laundered into a win: because the no-rebirth arm
carries a long, possibly drag-laden context at the cut point, the long-context-degradation literature
(arXiv:2510.05381, arXiv:2602.04288; §2.5) predicts rebirth may be not merely non-inferior but *superior*
on quality — registered in advance so that a lift, if it appears, is a called shot rather than a post-hoc
story, and its absence costs the headline nothing. The observational corpus establishes that rebirth is
real deployment behavior at scale and
identifies the failure modes worth testing; it does not by itself prove the non-inferiority gate. The
paper's causal claim will stand or fall on that gate. If the gate holds, the claim is powerful precisely
because it is modest: **bounded context with no detectable quality loss is already a win.**
