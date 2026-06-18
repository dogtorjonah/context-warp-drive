# Recall Zone Relevance Ranking — Tier 0 → 1 (Tier-1b benched)

## The Problem

When a folded read-burst recall zone fans out across multiple co-folded paths,
the enrichment (radar + source deltas) iterates paths in **arbitrary order** —
whatever order `entry.paths` happened to be in. Under budget pressure, incidental
paths (a one-off `package.json` peek) compete equally with the anchor and its
real siblings for a fixed budget, and which source deltas survive the ~160-char
floor is deterministic by zone-path order, not relevance to what the agent touched.

## Key Architectural Finding: The Import Graph Is the Wrong Graph

Agent read-bursts are empirically **multi-cluster (67-74%)** and **multi-dir
(79-84%)** — agents co-activate files *across* import boundaries the majority of
the time (measured: ~90 transcripts, ~900 real bursts via live
`groupTouchesIntoEpisodes`).

If recall zones were ranked by import-graph distance, the cross-cluster siblings
— the **dominant real case** — would come back as distance ∞ and get squeezed out
*first*. Import distance is **high-precision, low-recall**: when two co-read files
genuinely import each other (~26-33%), it's a strong signal — but it cannot be the
primary ranker for a multi-cluster-dominant phenomenon. Using it as primary would
systematically discard exactly the co-reads that bursts are made of, fighting the
empirics the burst guard was built on.

**The right signal is behavioral co-activation**, not structural imports. This
finding is also why **tier-1b (the import booster) is benched** — see below: the
document's own thesis demotes the import graph to a minority-case tie-breaker, so
it should not be the part that carries the most complexity and risk.

## The Closed Loop

```
burst segmentation observes co-activated files
    ↓
relay worker computes behavioral co-activation affinity (ground truth = real touches)
    ↓
supplied as pathAffinity carrier (composite key: anchor\x00zonePath → 0-1 score)
    ↓
pure package ranks recall zones by affinity, with directory proximity as the
    per-anchor fallback + tie-breaker
    ↓
recall cards ordered by relevance, budget allocated to most-relevant-first
```

### Ground-Truth Guard (Critical)

Learn affinity from what the agent **actually touches/edits** (real tool-use
paths during fold indexing), *not* from what recall chose to surface. Closing
the loop on recall output creates a **self-reinforcing echo chamber**: recall
shows path X → that "proves" affinity to X → it shows X harder. Ground-truth =
the agent's real touches. The worker's `burstGroups` come from fold index
`entry.paths` (extracted from real tool-use calls), never from recall card output.

## Tier Progression

| Tier | Signal | Where | When | Status |
|------|--------|-------|------|--------|
| **0** | Directory proximity + top-K cap | in-package, pure | Always (fallback + tie-breaker) | ✅ Shipped |
| **1** | Behavioral co-activation affinity | worker → carrier | Primary relevance signal; matches multi-cluster reality | ✅ Shipped |
| **1b** | Import-graph distance booster | worker → carrier | Booster/tie-breaker only, never primary | ⏸️ **Benched** (see below) |
| **2** | Atlas embeddings / changelog co-change | worker → carrier | Cold-start fallback when behavioral history is sparse | Future |

### How the Tiers Compose

- **Tier 0** (pure package): `orderZoneByProximity` — anchor first, closest
  sibling dirs next, cross-cluster paths last. `ZONE_ENRICHMENT_MAX_PATHS=3`
  caps enrichment (radar + source deltas). Body collection stays uncapped.
  Ships in OSS standalone, zero Atlas coupling.

- **Tier 1** (worker → carrier): `pathAffinity: Map<string, number>` with
  composite `affinityKey(anchor, zonePath)`. `orderZoneByRelevance` ranks by
  affinity, with **directory proximity as the per-anchor fallback AND tie-breaker**:
  a zone whose anchor has no affinity entries collapses to pure tier-0 proximity
  even when the carrier is non-empty for some *other* anchor (an empty carrier
  short-circuits straight to proximity — byte-identical standalone behavior). The
  relay worker builds a co-occurrence graph from burst groups (real touch history)
  and normalizes to 0-1.

- **Tier 1b** (⏸️ **BENCHED**): the import-graph distance booster
  (`distanceToBooster` / `blendScores`) is retained as pure, unit-tested helpers
  **in the package** (`src/foldRecall.ts`, both repos; the relay worker imports
  them via the shim — single source of truth), but it is **not applied** by the
  live worker — affinity is behavioral-only.

### Why Tier-1b Is Benched

Three independent reasons, in order of severity:

1. **It was dead in production.** The booster needs the impact graph rooted at the
   *session* workspace. `computeFileSetDistance` → `resolveWorkspaceRoot()` reads
   `process.cwd()`, and the worker tried to set it with `process.chdir(cwd)`. But
   the affinity handler runs in a `worker_threads.Worker`, where `process.chdir()`
   throws `ERR_WORKER_UNSUPPORTED_OPERATION` (confirmed, Node v22.22.3). The throw
   was silently caught, so the graph resolved against the relay's fixed startup cwd
   and returned ∞ for every non-relay workspace → booster 0 everywhere. No test
   exercised a real `cwd`, so it passed CI while contributing nothing.

2. **The thesis demotes it.** This very document argues the import graph is the
   *wrong* graph for a multi-cluster-dominant phenomenon — import distance is
   high-precision/low-recall and can only matter for the minority of in-cluster
   co-reads. The booster is, by design, the lowest-value signal; it should not be
   the part that carries the most complexity and risk.

3. **No relevance telemetry.** Nothing measured whether ranking by affinity ever
   beats proximity, so there was never evidence the booster's marginal nudge helped.

The booster's math is still correct and worth keeping for reference:

```
distanceToBooster(∞) = 0          // cross-cluster → zero boost
blendScores(b, 0) = max(b, b*0.7) = b   // behavioral preserved (booster-only)
```

**Revival preconditions:** (a) instrument tier-1 and show it changes enrichment
ranking vs tier-0 proximity often enough to matter (Measurement Plan #4);
(b) thread the impact-graph root **explicitly** through `computeFileSetDistance`
(add a `root` param defaulting to `process.cwd()`), **never** via `process.chdir`
(which cannot work in a worker thread, and would race the shared worker pool even
if it could). Until then the retained helpers + their tests document the math.

## Implementation

| Component | File | Repo |
|-----------|------|------|
| Tier-0 ordering + cap | `src/foldRecall.ts` | both |
| Tier-1 carrier + relevance (proximity fallback/tie-break) | `src/foldRecall.ts` | both |
| Tier-1b booster math (benched, pure: `distanceToBooster`/`blendScores`) | `src/foldRecall.ts` | both |
| Affinity worker (tier-1 behavioral; imports benched helpers via shim) | `relay/src/workerPool/handlers/foldRecallAffinity.ts` | voxxo-swarm |
| Task types (`cwd` reserved/unused) | `relay/src/workerPool/types.ts` | voxxo-swarm |
| Handler registration | `relay/src/workerPool/worker.ts` | voxxo-swarm |
| Wiring (no cwd; carrier rebuilt per epoch) | `relay/src/fcBaseSession.ts` (`enrichFoldRecallIndex`) | voxxo-swarm |
| Tests | `test/foldRecall.test.ts` + `relay/src/__tests__/foldRecallAffinity.test.ts` | both |

### Key Commits

- Standalone tier-0: `060f5a2`
- Canonical tier-0: `22a3bf22`
- Standalone tier-1: `97abd2f`
- Canonical tier-1: `12d1499b`
- Relay tier-1: `4afb483a` + `9285c0c4`
- Relay tier-1b (now benched): `5f4a85cf`
- Review fixes (F7 + bench + F6): rail-307ad5cf

### Test Coverage

- Standalone `foldRecall.test.ts`: 89 tests (tier-0 proximity + residency + tier-1 affinity + F7 cold-zone fallback + 7 benched tier-1b helper invariants)
- Canonical `foldRecall.test.ts`: 86 tests
- Relay `foldRecallAffinity.test.ts`: 16 tests (9 tier-1 behavioral handler tests + 7 benched tier-1b helper invariants; helpers imported from the package)

## Measurement Plan for Future Tuning

1. **Blend weights (tier-1b revival only)**: `BEHAVIORAL_WEIGHT=0.7`,
   `IMPORT_BOOSTER_WEIGHT=0.3` are starting values for the benched booster. Before
   reviving, instrument the distribution of behavioral vs import contributions on
   real sessions. If behavioral dominates >90% of the final score, the booster is
   not worth its complexity; if it rarely fires, the workspace graph is too sparse.

2. **Top-K cap**: `ZONE_ENRICHMENT_MAX_PATHS=3` is conservative. If wide bursts
   (5+ paths) show agents re-touching the 4th-ranked sibling frequently, consider
   raising to 4-5. If radar blocks are being silently dropped under pressure,
   consider lowering to 2.

3. **Cold-start warmth**: behavioral affinity needs burst history to warm up.
   Measure how many epochs until `pathAffinity` is populated for typical sessions.
   If cold-start is too long, tier-2 (Atlas embeddings) can provide a cold-start
   signal from changelog co-change patterns.

4. **Proximity sufficiency (tier-1b revival gate)**: directory proximity alone may
   be sufficient for most sessions. Measure the delta: how often does tier-1
   affinity change the enrichment ranking vs tier-0 proximity? If <5%, tier-0 alone
   is the right default, tier-1 stays opt-in, and tier-1b should NOT be revived.
   This is the precondition gate for un-benching tier-1b.

---

## Review Fixes (rail-307ad5cf, June 2026)

A predecessor review (opus-4.8) found and fixed:

- **F7 — proximity fallback regression:** `orderZoneByRelevance` used insertion
  index as its tie-breaker, so once the carrier held *any* entry, a behaviorally
  cold zone lost tier-0 proximity and reverted to arbitrary (alphabetical entry)
  order. Fixed: directory proximity is now the universal tie-breaker + per-anchor
  fallback. Regression test added in both repos.
- **Tier-1b benched** (see "Why Tier-1b Is Benched"): worker stripped to
  behavioral-only; `cwd` no longer passed; booster helpers retained as benched.
- **F6 — carrier growth/staleness:** the affinity `.then` now rebuilds (clears
  before repopulating) the `pathAffinity` carrier each epoch instead of merging,
  bounding it to the current epoch and dropping stale composite keys.

*Built rail-8d3a390d, June 2026; reviewed + corrected rail-307ad5cf.*
