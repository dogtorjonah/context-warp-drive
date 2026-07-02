# Context Warp Drive

Standalone public package for the Infinite Context Warp Engine — deterministic, zero-LLM rolling-fold context compaction. Published at `github.com/dogtorjonah/context-warp-drive`.

## Dual-Repo Architecture

This repo (`/home/jonah/context-warp-drive/`) is the **standalone public copy** of the Context Warp engine. The **production copy** lives inside the Voxxo Swarm monorepo at `/home/jonah/voxxo-swarm/packages/context-warp/src/`, where it's consumed via re-export shims from `relay/src/`.

**🚨 Any change to a Context Warp file that applies to both repos must be edited in both places.** The two repos have diverged — not all files are shared, and the voxxo-swarm copy has relay-specific extensions.

### Shared files (edit in BOTH repos)

| File | Purpose |
|------|---------|
| `src/fold.ts` | Shared public fold-engine barrel |
| `src/rollingFold.ts` | Core rolling-fold compaction |
| `src/foldFreeze.ts` | Cache-hot freeze / snapshot |
| `src/foldRecall.ts` | Ambient page-in for folded context |
| `src/foldTerms.ts` | Distinctive term extraction |
| `src/foldEpisodes.ts` | Episodic memory engine |
| `src/foldEpisodeCapture.ts` | Episode extraction from transcripts |
| `src/foldPathCanon.ts` | Path canonicalization |
| `src/contextBudget.ts` | Model-aware budget resolver |
| `src/contextWindow.ts` | Model context window registry |
| `src/glyphs.ts` | Register glyph grammar |
| `src/rawRebirthSeed.ts` | Trace-only rebirth seed renderer |
| `src/session/FoldSession.ts` | Provider-agnostic fold/freeze orchestrator |
| `src/userMessageVault.ts` | User/assistant vault blocks used by FoldSession |
| `src/episodes.ts` | Portable episode-store barrel plus rich-engine namespaces |
| `src/episodes/episodeStore.ts` | Portable episode derivation, persistence, and recall API |
| `src/episodes/sqliteStore.ts` | SQLite store adapter |
| `src/persistence/sparseVector.ts` | Sparse-vector helpers mirrored with relay/package parity |
| `src/persistence/transcriptTypes.ts` | Trimmed transcript type subset shared with the package |
| `src/types/better-sqlite3.d.ts` | Optional peer typing shim for the SQLite adapter |

### Files that exist in BOTH repos but have DIVERGED

| File | Status |
|------|--------|
| None currently | The shared files above were reconciled byte-identical as of the parity pass. Remaining differences are classified as standalone-only, package-only, relay-only, or public-package identity files. |

### Standalone↔relay live pair (no packages/context-warp mirror)

| File | Status |
|------|--------|
| `src/foldBirthHydration.ts` | Byte-identical live pair with `/home/jonah/voxxo-swarm/relay/src/foldBirthHydration.ts` (no packages/context-warp mirror) — edit both copies together. |

### Standalone-only (no packages/context-warp mirror)

| File | Status |
|------|--------|
| `src/episodes/runtime.ts` | Host-neutral runtime wrapper over the portable episode store; synchronous store calls must stay out of relay event-loop paths. |
| `src/taskRail.ts` | Bundled pure task-rail state machine; keep watched with `/home/jonah/voxxo-swarm/packages/task-rail/src/{types,lifecycle,drafts,execution}.ts`. |
| `src/host/*`, `src/providers/*`, `examples/*` | Public standalone harnesses and provider loops. |
| `docs/research/rebirth-continuity-paper/*` | Public research-paper materials and scripts. |

### voxxo-swarm-only (no standalone mirror)

- `packages/context-warp/src/overwatch.ts` and `src/__tests__/overwatch.test.ts` — package/relay-only oversight surface.
- `packages/context-warp/data/synonym-map.json`, `scripts/build-synonym-map.py`, and `docs/*.html` — production-derived artifacts intentionally omitted from the public standalone repo.
- `relay/src/fcBaseSession.ts` — session manager (recall dispatch, env gating, term-recall tier)
- `relay/src/workerPool/handlers/foldEpisodes.ts` — worker thread handlers (chainScore, recall orchestration, SQLite I/O)
- `relay/src/contextWarpGovernor.ts` — adaptive governor
- All `relay/src/` session/governor/pipeline logic

## Coding Conventions

- **ESM throughout** — all imports use `.ts` extensions. This package uses `tsup` for bundling.
- **Determinism is the contract** — identical inputs must produce byte-identical output. Inject clocks (`now: () => number`); never call `Date.now` in engine paths.
- **Core is dependency-free** — the fold core has zero runtime dependencies. `better-sqlite3` is an optional peer for the episodic store only.
- **Tests come with changes** — add or update deterministic vitest tests for any behavioral change.
- **TypeScript strict** — no `any` without justification.

## Build & Test

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run build         # tsup bundle
```
