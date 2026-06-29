# Rebirth Continuity Paper

This directory is the public standalone copy of the rebirth-continuity research preprint and its reproducibility scaffolding.

Included:

- `paper/` — the v1 working preprint sections.
- `figures/` — rendered paper figures plus `make_figures.py`.
- `scripts/` — offline parser/scorer/recode helpers used to derive the reported metrics from a local relay data export.
- `hard-numbers.md`, `corpus-schema-and-design.md`, `controlled-ab-spec.md`, and `confirmatory-test-elaboration.md` — companion design and provenance notes referenced by the paper.

Not included:

- raw real-session transcripts, event streams, cost ledgers, or experiment packets;
- private freeze directories and local research-pool paths;
- operator-private artifacts generated from the live relay corpus.

The current paper framing is intentionally conservative: the production observations and judged replay evidence are consistent with quality non-inferiority versus a fair full-context compaction summary, while the preregistered controlled fork test and chained-compaction test remain the confirmatory work.

To rerun the scripts against a private/local corpus, set the relevant inputs explicitly:

```bash
export RELAY_DATA_DIR=/path/to/relay/data
export FIG_COSTS_DIR=/path/to/frozen/costs
```

The public repo carries the methods, figures, and scrubbed provenance; data release requires a synthetic or otherwise shareable stand-in corpus.
