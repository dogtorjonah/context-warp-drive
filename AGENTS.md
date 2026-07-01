# Context Warp Drive

Standalone public package for the Infinite Context Warp Engine — deterministic, zero-LLM rolling-fold context compaction. Published at `github.com/dogtorjonah/context-warp-drive`.

## Dual-Repo Architecture

This repo (`/home/jonah/context-warp-drive/`) is the **standalone public copy** of the Context Warp engine. The **production copy** lives inside the Voxxo Swarm monorepo at `/home/jonah/voxxo-swarm/packages/context-warp/src/`, where it's consumed via re-export shims from `relay/src/`.

**🚨 Any change to a Context Warp file that applies to both repos must be edited in both places.** The two repos have diverged — not all files are shared, and the voxxo-swarm copy has relay-specific extensions.

### Shared files (edit in BOTH repos)

| File | Purpose |
|------|---------|
| `src/foldEpisodes.ts` | Episodic memory engine |
| `src/foldRecall.ts` | Ambient page-in for folded context |
| `src/foldFreeze.ts` | Cache-hot freeze / snapshot |
| `src/foldBirthHydration.ts` | CLI transcript hydration for birth-fold reconstruction |
| `src/rollingFold.ts` | Core rolling-fold compaction |
| `src/foldPathCanon.ts` | Path canonicalization |
| `src/contextBudget.ts` | Model-aware budget resolver |
| `src/foldEpisodeCapture.ts` | Episode extraction from transcripts |
| `src/foldTerms.ts` | Distinctive term extraction |
| `src/contextWindow.ts` | Model context window registry |
| `src/glyphs.ts` | Register glyph grammar |
| `src/episodes/episodeStore.ts` | Episode store (SQLite) |
| `src/episodes/sqliteStore.ts` | SQLite store adapter |

### Files that exist in BOTH repos but have DIVERGED

These files differ between the two repos due to relay-specific extensions in voxxo-swarm. When editing these, port applicable logic but verify against both copies — don't blindly overwrite either direction.

### voxxo-swarm-only (no standalone mirror)

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
