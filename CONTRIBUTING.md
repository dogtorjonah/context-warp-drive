# Contributing to Context Warp Drive

Thanks for your interest in contributing! This is a solo project, but all contributions are welcome.

## Getting Started

```bash
git clone https://github.com/dogtorjonah/context-warp-drive.git
cd context-warp-drive
npm install        # builds dist/ automatically via prepare script
npm test           # runs the 380+ deterministic test suite
```

## Development Workflow

1. Fork the repo and create a branch from `main`
2. Make your changes — keep them focused and minimal
3. Run `npm test` to verify all tests pass
4. If adding new functionality, add tests
5. Submit a PR with a clear description of what and why

## Areas Where Help Is Welcome

- **Python SDK** — the engine is TypeScript; a Python port would unlock a huge audience
- **New provider adapters** — Rust CLI, additional LLM CLIs
- **Benchmark extensions** — longer sessions, different workload types, head-to-head comparisons
- **Documentation** — examples, use cases, architecture deep-dives
- **Bug reports** — file an issue with a reproducible test case

## Code Style

- TypeScript strict mode — no `any` without justification
- ESM imports use `.ts` extensions
- Zero runtime dependencies in the core engine (`src/fold/`)
- `better-sqlite3` is an optional peer dependency only

## Testing

The engine's correctness contract is its test suite. Every fold, freeze, recall, and task rail operation has deterministic tests. If you change behavior, update or add tests accordingly.

```bash
npm test                    # full suite
npx vitest run src/__tests__/fold/   # just the fold engine
```

## Questions?

Open a GitHub Discussion or an issue. I'll respond as fast as I can.
