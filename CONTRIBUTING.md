# Contributing

Thanks for your interest in Context Warp Drive.

## Development

```bash
npm install
npm run typecheck                # tsc --noEmit
npm test                         # deterministic vitest suite
npm run build                    # tsup bundle
npx tsx examples/benchmark.ts    # the measured benchmark
```

## Ground rules

- **Determinism is the contract.** Identical inputs must produce byte-identical
  output — that is the provider-cache invariant the whole engine rests on. Any
  change that introduces nondeterminism (reading the wall clock directly,
  randomness, unstable ordering in the prepared view) will be rejected. Inject a
  clock (`now: () => number`) instead of calling `Date.now` in engine paths.
- **Keep the core dependency-free.** The fold core (`context-warp-drive/fold`) has
  zero runtime dependencies; `better-sqlite3` is an optional peer used only by the
  reference episodic store. Don't add runtime dependencies to the core.
- **Tests come with changes.** Add or update deterministic tests for any behavioral
  change. CI runs the suite on Node 18, 20, and 22.

## Reporting issues

Open an issue with a minimal reproduction: a small message array plus the prepared
output you got versus what you expected. For benchmark questions, paste the output
of `npx tsx examples/benchmark.ts`.

## License

By contributing, you agree that your contributions are licensed under the project's
MIT License.
