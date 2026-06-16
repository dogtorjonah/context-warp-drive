# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-16

Initial public release — extracted from a production multi-agent system.

### Added

- **Rolling fold** (`foldContext`) + **Coordinate Closet** — deterministic page-out
  that skeletonizes older turns while conserving salient identifiers verbatim.
- **Fold freeze** (`evaluateFoldFreeze`) — byte-identical cache-hot prefix reuse so
  the provider prompt cache stays warm between epochs.
- **Fold recall** (`buildFoldRecallContext`) — ambient page-in of folded content
  when the agent re-touches a path.
- **Episodic recall** (`context-warp-drive/episodes`) — durable cross-session memory.
- **Glyph grammar** (`context-warp-drive/glyphs`) — register-tagged messages that
  power episodic narration harvesting.
- **`FoldSession`** — one-call orchestrator wiring fold + freeze into any
  function-calling loop.
- Provider-agnostic message handling: Anthropic content blocks, OpenAI `tool_calls`,
  and Gemini `parts`.
- 277-test deterministic suite and a measured benchmark (`examples/benchmark.ts`)
  comparing the engine against truncation and LLM summarization.

[0.1.0]: https://github.com/dogtorjonah/context-warp-drive/releases/tag/v0.1.0
