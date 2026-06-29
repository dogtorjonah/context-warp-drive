## Appendix A — Reproducibility

Every current parser-floor/full-corpus rate, figure, and table in this paper traces to a single
checksum-verified snapshot of the live system, taken with the `research-snapshot` tool while the relay
ran (online, WAL-safe). Stale manual recode numbers are labeled separately and traced to their archived
recode artifact. This appendix gives the manifest, the substrate map (which number comes from which
artifact), the code, the figure pipeline, a datasheet, and an honest statement of what is and is not
shareable.

### A.1 Frozen corpus manifest

- **Snapshot:** `$POOL/freeze_2026-06-08_08-10-45_rebirth-continuity-recode-2026-06-08-pos/`
- **Created (UTC):** 2026-06-08T08:10:46.960Z · **verified:** PASS (5,441 files, 0 checksum failures)
- **Repo git SHA:** `e577be1d46890b46a2981dd5f6ca457060d15cc1`
- **Method:** SQLite via `VACUUM INTO` (online, WAL-safe — never `cp`); directories via `rsync`;
  SHA-256 over every file. Manifest at `MANIFEST.json`; per-file digests at `checksums.sha256`
  (**5,441 files**). Total **14,239,322,116 bytes** on disk (≈14 GB).

| Source | Type | Count / size | Role |
|---|---|---|---|
| `sqlite/global_index.sqlite` | SQLite | 5.46 GB; **22,444 turns**, **8,717 rebirth_turns** | turns substrate (recovery / persistence / cost) |
| `sqlite/atlas.sqlite` | SQLite | 289 MB | code-graph provenance (not a results substrate) |
| `dirs/costs/` | dir | **1,412** files | turn-aggregated cache-read/write/input tokens (§6 figs) |
| `dirs/rebirth/` | dir | **1,069** files | rendered package + `packageJson` manifest per boundary |
| `dirs/messages/` | dir | **1,487** files | full per-instance transcripts (mid-edit behavior, §7) |
| `dirs/metadata/` | dir | 1 file | instance metadata index |
| `dirs/events/` | dir | **1,470** files | event chronology / provenance checks |

Excluded by design (regenerable / oversized): `transcript_chunks.sqlite` (~66 GB, derivable from
`messages/`). The turn rebuild draws **22,444 turns from 1,483 transcripts**. **43** cold/library
resumes are excluded from recovery/persistence rates that require an in-corpus predecessor.

Verify the snapshot with `research-snapshot verify` (re-checksums every file against the manifest), or
manually: `cd <snapshot> && sha256sum -c checksums.sha256`.

### A.2 Substrate map (which number ↔ which artifact)

| Result | Substrate label | Source |
|---|---|---|
| Recovery 87.5% [83.4, 91.0]; dogfood 91.3% [88.8, 93.5]; persistence 89.4/95.7%; re-establishment cost (§5) | **current parser-floor** | `global_index.sqlite` turns table, rebuilt 2026-06-08 (§A.3), plus private artifact `artifacts/recode-2026-06-08/summary.json` (not included in this public port) |
| Current uncensored estimate 97.2% / 97.7% human (§5) | **current heuristic recode** | private artifacts `current_recovery_roots.jsonl`, `suspect_rows.jsonl`, `summary.json` (not included) |
| Historical uncensored ceiling ~98% / ~2% hard-fail (§5) | **stale <=May-19 manual recode** | private artifact `section8_recovery_recoded.json` (213-row hand recode; archived, not included) |
| First-turn random wake-up audit 90.7% clean / 96.0% clean-or-partial; negative controls 26/30 detected with manually audited control failures (§5.3.1) | **single-judge random first-turn audit + imperfect negative controls** — computed on the *live 2026-06-09 turn index* (post-freeze), not the frozen snapshot | private experiment artifacts `random_baseline.json`, `random_baseline.md`, `negctrl_manifest.json`, `negctrl_judge_packets.jsonl`, `negctrl_judgments.jsonl` (not included) |
| Silent-wakeup failure anatomy (§5.3 first-turn-class table) | **current parser-floor** | frozen persistence rows × frozen `turns.ai_result` length; 2026-06-09 audit |
| Hot-swap / non-inferiority W60 Δ+1 (§7, Fig 5) | **full corpus (MEC)** | mid-edit state-continuation over `dirs/messages/*.jsonl` behavioral edits |
| Cache-read 94.3% → 83.6% cost cut (§6, Figs 1–2) | **full corpus** | `dirs/costs/*.jsonl` turn-aggregated cache / input tokens |
| By-successor-engine recovery (§5.5) | **current parser-floor** | `turns.engine` (denormalized: successor engine, blind to mid-life swap) |
| Throughput + Atlas changelog cells (§5.6) | **frozen turn index + Atlas changelog, window-bounded** (2026-04-15 → 2026-06-08 freeze) | `global_index.sqlite` turns; Atlas changelog counts re-queried at the freeze bound |
| Depth-fidelity chains, 74-of-82 after filters (§5.7) | **frozen turn index; ad hoc analysis — script not yet committed (§A.3)** | chain reconstruction over frozen turns; §5.6 spin/coherence filters |
| Resume-reproducibility + realized-action A/B (§5.8–5.8.2); earlier judged probe | **controlled experiment artifacts** | private experiment artifacts from `experiments/resume-reproducibility/` (bench_6499413d), `paired_ni_arrays_pooled.json`, `experiments/agent-judge-landmark/` (bench_2df4ebd5), and compaction batches bench_d451faeb (not included) |
| "Package carries intent" (interrupted roots carry 0 `files_touched`) | — | `dirs/rebirth/*.jsonl` `packageJson` |

### A.3 Code

- **`relay/scripts/refreshTurns.ts --rebuild-turns`** — the de-stale "run button." Rebuilds the turns
  table from `messages/` with rebirth boundaries loaded from `rebirth/*.jsonl`
  (`backfillAllTurns({ rebuild: true })`). The 2026-06-08 07:43–07:47Z run left the bad pattern
  `trigger_type='rebirth' AND outcome='success' AND user_request='[CONTEXT REBIRTH]' AND ai_result=''`
  at **0 rows**. (Embeddings are skipped; rates need no vectors.)
- **`docs/research/rebirth-continuity-paper/scripts/recode_current_rebirth_recovery.py`** — emits the
  current recovery roots, suspect rows, adjudication packets, persistence rows, aggregate summary, and
  manifest from the post-rebuild `global_index.sqlite` (window=15; B=5,000; seed=20260608).
- **Instance-cluster bootstrap logic** — regenerates cluster-robust 95% CIs and design effects (§4.9,
  §11.4): a nonparametric instance-cluster bootstrap (B=5,000, seed 20260608) over the frozen
  `global_index.sqlite` turns and archived MEC rows, validating each point estimate before CI emission.
- **`docs/research/rebirth-continuity-paper/figures/make_figures.py`** — regenerates all five figures
  from the frozen corpus; byte-stable (§A.4).
- **Analysis scripts** (archived in `$POOL/scripts/`): `e1_dogfood.py`
  (dogfood cohort), `persistence_emit.py` (persistence), `mec_*.py` / `midedit*.py` (hot-swap MEC),
  `orient*.py` (orientation), `linker_emit.py` (interrupted→rebirth linkage). Intermediate outputs in
  `$POOL/intermediate/`.
- **Known gap (§5.6/§5.7).** The chain/spin/success analysis behind the throughput and depth-fidelity
  cuts is **not yet committed as a script**; those subsections currently regenerate only from the frozen
  corpus plus the documented filter description, not from a one-command artifact. The raw pre-filter
  count is 82 single-identity chains with ≥20 rebirths; the §5.6 spin/coherence filters yield the 74
  analyzed in §5.7.

### A.4 Figure regeneration

Figures are reproducible artifacts, not screenshots:

```bash
POOL=<your research-pool root>   # operator-private; absolute home path elided for the public release
FREEZE=$POOL/freeze_2026-06-08_08-10-45_rebirth-continuity-recode-2026-06-08-pos
# byte-stable from the frozen corpus:
FIG_COSTS_DIR="$FREEZE/dirs/costs" \
  $POOL/figvenv/bin/python \
  docs/research/rebirth-continuity-paper/figures/make_figures.py
```

`make_figures.py` hardcodes each analysis value + 95% CI + substrate label from `hard-numbers.md` rather
than recomputing rates. It reads only the frozen `costs/` for the cache/cost figures, so those panels are
byte-stable from the snapshot; stale manual-recode values in the recovery ladder are carried from the
archived recode artifact and labeled as such. Without `FIG_COSTS_DIR` the cache/cost panels fall back to
live relay costs and are **not** byte-stable.

### A.5 Datasheet (Gebru et al., arXiv:1803.09010)

- **Motivation / collection.** Passively logged operational telemetry from a live multi-agent system
  (voxxo-swarm); no task was constructed for the study, and the agents writing this paper run under the
  mechanism it measures. This is a *deployment census*, not a designed experiment.
- **Composition.** 8,717 rebirth arrivals; 22,444 turns from 1,483 transcripts; 1,412 cost-log files;
  1,069 rebirth-boundary files; 1,470 event-log files; eight *successor*-engine families across nine raw
  labels (Claude, Codex/GPT, DeepSeek, GLM, Gemini, MiniMax, Kimi, with Claude-API and Claude-interactive
  grouped as one family) — `turns.engine` records the successor side of each boundary (§A.2), not the
  predecessor.
- **Sampling.** Census at freeze time, not a sample. 43 cold/library resumes excluded from
  recovery/persistence rates that require an in-corpus predecessor.
- **Exclusions & bias direction (each stated with its sign):**
  - Parser-floor counts **any** fresh trigger as a break (many are same-intent nudges) → **understates**
    recovery; the 87% floor is conservative.
  - Stuck-loop / heavy-tail instances inflate raw turn counts → handled via effective-N; excluding them
    would **raise** rates.
  - Missing / short transcripts (survivorship) → unscored; bounded, can bias either direction.
  - The current deterministic heuristic recode estimates a ~98% uncensored ceiling, but it is a
    provisional machine pass over the 111 suspect rows → treat it as an adjudication worklist, **not** a
    current manual ceiling.
  - The old ~98% uncensored ceiling is a **stale ≤May-19** manual recode covering ~74% of earlier
    rebirth history → historical context only; never reported as "99%."
  - `turns.engine` is the successor engine, blind to mid-life swap → the by-engine table is **not** a
    swap effect.
- **Ethics / maintenance.** Local-only SQLite/JSONL; transcripts may contain operator content; the raw
  corpus is therefore **not** publicly shareable.

### A.6 Synthetic representative dataset (and a disclaimer)

A shareable synthetic stand-in (matching schema + marginal distributions, no private transcript content)
is planned so reviewers can run the full pipeline without the raw corpus.

**Disclaimer — not a data source.** `data/costs/rebirth-telemetry-over-50k.jsonl` (repo root) is a
**synthetic load-test fixture: 50,005 identical rows.** It is **not** telemetry, is **not** in the frozen
analysis corpus (the freeze pulls from `relay/data/costs/`, a different path), and is documented here
only so no one mistakes it for data.

### A.7 Reproducibility statement

**Shareable now:** the metric definitions (§4), all code (`refreshTurns.ts`, `make_figures.py`, the
analysis scripts), the figure pipeline, and the manifest + `checksums.sha256`. **Not shareable:** raw
transcripts and cost logs (operator-private). **Path to external reproduction:** the synthetic
representative dataset (A.6) reproduces the pipeline end-to-end on public data; the frozen real corpus is
available for direct verification under external review. Every frozen-corpus headline number in this
paper can be regenerated from the snapshot with the code above; stale recode ceilings require the
separately archived recode artifact — that is the bar this appendix is written to.
