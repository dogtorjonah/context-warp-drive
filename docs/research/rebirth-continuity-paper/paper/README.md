# Rebirth-Continuity Paper

This directory contains the public Markdown working preprint for the rebirth-continuity
research note. The numbered files assemble in order into the paper; the companion
materials one directory up document the reported measurements, corpus boundary, and
designed confirmatory fork test.

The public port keeps the methods, claims, figures, and reproducibility scaffolding while
leaving raw real-session transcripts, event streams, cost ledgers, and private experiment
artifacts out of the repository. The framing is intentionally conservative: the current
evidence is consistent with quality non-inferiority against a fair full-context compaction
summary, while the controlled fork-and-compare test remains the confirmatory causal work.

## Sections

| Order | File | Section | Role |
|---|---|---|---|
| 1 | `00-abstract.md` | Title + Abstract | Summary of the claim, measurements, and deferred confirmatory work |
| 2 | `01-introduction.md` | Introduction | Context-limit problem, rebirth mechanism, and contributions |
| 3 | `02-related-work.md` | Related Work | Compaction, memory, routing, caching, and retrieval neighbors |
| 4 | `03-mechanism.md` | The Rebirth Mechanism | Same-identity successor handoff and package structure |
| 5 | `04-metrics-method.md` | Metrics & Method | Continuity metrics, corpus construction, censoring, and confidence intervals |
| 6 | `05-results-continuity.md` | Results - Continuity & Recovery | Recovery, persistence, re-establishment cost, and depth-fidelity results |
| 7 | `06-results-cost-cache.md` | Results - Cost & Cache | Cache-read rate, input-cost reduction, and provider-sensitive cache economics |
| 8 | `07-results-noninferiority-hotswap.md` | Results - Non-inferiority + Hot-swap | Observational non-inferiority and model-swap tolerance evidence |
| 9 | `08-forking-methodology.md` | Forking Methodology + Experimental Design | Controlled fork-and-compare A/B design and interpretation boundary |
| 10 | `09-cost-model.md` | Parameterized Cost Model | Backend rebirth versus compaction cost model |
| 11 | `10-implications.md` | Discussion / Implications | Systems implications for routing, caching, and long-running agents |
| 12 | `11-threats.md` | Threats to Validity / Limitations | Observational limits, substrate limits, staleness, and construct validity |
| 13 | `12-conclusion.md` | Conclusion | Conservative restatement and next work |
| 14 | `13-references.md` | References | Verified references and citation-provenance notes |
| 15 | `14-appendix-reproducibility.md` | Reproducibility Appendix | Snapshot manifest, public rerun path, and data-availability notes |

## Companion Material

- `../hard-numbers.md` records the reported numeric results and provenance labels.
- `../corpus-schema-and-design.md` explains the frozen corpus schema and privacy boundary.
- `../controlled-ab-spec.md` specifies the designed fork-and-compare causal test.
- `../figures/` contains the rendered figures and figure-generation script.
- `../scripts/` contains the parser, scorer, recode, and adjudication helpers.

Some private draft inputs used during development are not included in this port, including
raw source notes, raw case-study exports, and the real-session artifact bundles named in
the reproducibility appendix.
