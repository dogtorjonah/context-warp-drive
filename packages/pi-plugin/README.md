# Context Warp Drive — Pi Extension

A [Pi](https://github.com/earendil-works/pi-mono) extension that replaces Pi's default LLM-summarization compaction with **deterministic context folding** from [Context Warp Drive](https://github.com/dogtorjonah/context-warp-drive).

Zero LLM summarization calls. Hybrid tail/hard epoch support. Provider-cache-hot reuse. Infinite context.

## How It Works

1. **`context` event** fires before each LLM call with the current message array. The extension converts Pi messages → CWD FoldMessages, runs the fold engine, and returns the folded array. Pi replaces the provider-bound context with the returned messages — no in-place mutation needed.

2. **`message_end` event** captures measured token usage from each `AssistantMessage`. Pi's `Usage` type includes `input`, `output`, `cacheRead`, and `cacheWrite` — covering all major providers. These real measurements drive the fold engine's pressure-ceiling and tail-epoch decisions.

3. **`session_before_compact` event** is a safety net: if Pi's native compaction somehow triggers, we cancel it. With CWD keeping context bounded every turn, native compaction should never fire — but this prevents double-compaction.

## Installation

### Option 1: Copy the built file

```bash
# Build
cd packages/pi-plugin
npm run build

# Global extension
cp dist/index.js ~/.pi/agent/extensions/context-warp-drive.js

# Or project-local
cp dist/index.js .pi/extensions/context-warp-drive.js
```

### Option 2: Install as npm package

```bash
pi install npm:pi-plugin-context-warp-drive
```

### Option 3: With custom options

```typescript
// ~/.pi/agent/extensions/context-warp-drive.ts
import { createPlugin } from 'pi-plugin-context-warp-drive';

export default (pi) => createPlugin(pi, {
  pressureCeiling: 200_000,
  runway: 50_000,
  debug: true,
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pressureCeiling` | `number` | `150_000` | Measured input tokens that triggers a hard epoch (full reseed with continuity seed) |
| `runway` | `number` | `45_000` | Preferred runway in tokens after a tail-epoch append |
| `minRunway` | `number` | `30_000` | Hard minimum runway required before a tail-epoch append |
| `freeze` | `boolean` | `true` | Enable provider-cache freeze (byte-identical prefix reuse) |
| `recall` | `boolean` | `true` | Inject a fold-state hint into the system prompt |
| `debug` | `boolean` | `false` | Verbose logging of fold decisions to stderr |

## Why CWD Instead of Pi's Native Compaction?

| Feature | Pi Native | CWD Extension |
|---------|-----------|---------------|
| Approach | LLM summarization | Deterministic structural folding |
| LLM calls per compaction | 1+ | 0 |
| Context loss | Lossy (summarizer may drop details) | Lossless skeletons + Coordinate Closet literals |
| Cache preservation | Broken on every compaction | Preserved across folds (tail epochs) |
| Deterministic | No | Yes |

## Community Alternatives

- [`pi-context-manager`](https://github.com/catlain/pi-context) — LLM distillation of tool results
- [`pi-context`](https://github.com/ttttmr/pi-context) — Checkpoint-based context

CWD's deterministic zero-LLM fold beats both on cost, reliability, and cache efficiency.

## License

MIT
