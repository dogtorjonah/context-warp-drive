# Recall Zone Relevance Ranking — Tier 0 → 1b

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

**The right signal is behavioral co-activation**, not structural imports.

## The Closed Loop

```
burst segmentation observes co-activated files
    ↓
relay worker computes behavioral co-activation affinity (ground truth = real touches)
    ↓
supplied as pathAffinity carrier (composite key: anchor\x00zonePath → 0-1 score)
    ↓
pure package ranks recall zones by affinity, falls back to proximity when empty
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
| **0** | Directory proximity + top-K cap | in-package, pure | Always (fallback when no host data) | ✅ Shipped |
| **1** | Behavioral co-activation affinity | worker → carrier | Primary relevance signal; matches multi-cluster reality | ✅ Shipped |
| **1b** | Import-graph distance booster | worker → carrier | Booster/tie-breaker only, never primary | ✅ Shipped |
| **2** | Atlas embeddings / changelog co-change | worker → carrier | Cold-start fallback when behavioral history is sparse | Future |

### How the Tiers Compose

- **Tier 0** (pure package): `orderZoneByProximity` — anchor first, closest
  sibling dirs next, cross-cluster paths last. `ZONE_ENRICHMENT_MAX_PATHS=3`
  caps enrichment (radar + source deltas). Body collection stays uncapped.
  Ships in OSS standalone, zero Atlas coupling.

- **Tier 1** (worker → carrier): `pathAffinity: Map<string, number>` with
  composite `affinityKey(anchor, zonePath)`. `orderZoneByRelevance` ranks by
  affinity when the carrier is populated, falls back to proximity when empty.
  The relay worker builds a co-occurrence graph from burst groups (real touch
  history) and normalizes to 0-1.

- **Tier 1b** (worker → carrier, blended into tier 1): import-graph distance from
  `computeFileSetDistance` is converted to a 0-1 booster signal. Blending:
  `finalScore = max(behavioral, behavioral*0.7 + importBooster*0.3)`. The `max`
  enforces the **booster-only invariant**: import distance can only RAISE a score
  above its behavioral baseline, never lower it. Cross-cluster paths (∞ distance)
  get zero boost without penalty. Cold-start (no behavioral data) gets an
  import-booster signal so paths sharing imports rank above unrelated ones.

### Booster-Only Invariant

The import booster is mathematically prevented from penalizing:

```
distanceToBooster(∞) = 0          // cross-cluster → zero boost
blendScores(b, 0) = max(b, b*0.7) = b   // behavioral preserved
```

This is the invariant that makes tier-1b safe for multi-cluster bursts.

## Implementation

| Component | File | Repo |
|-----------|------|------|
| Tier-0 ordering + cap | `src/foldRecall.ts` | both |
| Tier-1 carrier + relevance | `src/foldRecall.ts` | both |
| Affinity worker | `relay/src/workerPool/handlers/foldRecallAffinity.ts` | voxxo-swarm |
| Task types | `relay/src/workerPool/types.ts` | voxxo-swarm |
| Handler registration | `relay/src/workerPool/worker.ts` | voxxo-swarm |
| Wiring | `relay/src/fcBaseSession.ts` (`enrichFoldRecallIndex`) | voxxo-swarm |
| Tests | `test/foldRecall.test.ts` + `relay/src/__tests__/foldRecallAffinity.test.ts` | both |

### Key Commits

- Standalone tier-0: `060f5a2`
- Canonical tier-0: `22a3bf22`
- Standalone tier-1: `97abd2f`
- Canonical tier-1: `12d1499b`
- Relay tier-1: `4afb483a` + `9285c0c4`
- Relay tier-1b: `5f4a85cf`

### Test Coverage

- Standalone `foldRecall.test.ts`: 81 tests (tier-0 proximity + residency + tier-1 affinity)
- Canonical `foldRecall.test.ts`: 78 tests
- Relay `foldRecallAffinity.test.ts`: 16 tests (9 tier-1 + 7 tier-1b booster invariants)

## Measurement Plan for Future Tuning

1. **Blend weights**: `BEHAVIORAL_WEIGHT=0.7`, `IMPORT_BOOSTER_WEIGHT=0.3` are
   starting values. Instrument: log the distribution of behavioral vs import
   contributions across real sessions. If behavioral dominates >90% of the final
   score, consider lowering behavioral weight. If import booster rarely fires,
   the workspace graph may be too sparse.

2. **Top-K cap**: `ZONE_ENRICHMENT_MAX_PATHS=3` is conservative. If wide bursts
   (5+ paths) show agents re-touching the 4th-ranked sibling frequently, consider
   raising to 4-5. If radar blocks are being silently dropped under pressure,
   consider lowering to 2.

3. **Cold-start warmth**: behavioral affinity needs burst history to warm up.
   Measure how many epochs until `pathAffinity` is populated for typical sessions.
   If cold-start is too long, tier-2 (Atlas embeddings) can provide a cold-start
   signal from changelog co-change patterns.

4. **Proximity sufficiency**: directory proximity alone may be sufficient for
   most sessions. Measure the delta: how often does tier-1 affinity change the
   enrichment ranking vs tier-0 proximity? If <5%, tier-0 alone may be the right
   default and tier-1 can stay opt-in.

---

*Built rail-8d3a390d, June 2026.*
