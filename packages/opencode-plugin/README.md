# opencode-plugin-context-warp-drive

> Deterministic context folding for [OpenCode](https://opencode.ai) — zero LLM summarization calls, hybrid tail/hard epoch support, provider-cache-hot reuse.

## What It Does

Replaces OpenCode's default LLM-summarization compaction with [Context Warp Drive](https://github.com/dogtorjonah/context-warp-drive)'s deterministic rolling-fold engine:

- **Zero LLM summarization calls** — CWD folds context deterministically, never calls the LLM to summarize
- **Provider cache stays hot** — byte-identical frozen prefix reuse means prompt cache reads at 0.1× on every cache-hit turn
- **Hybrid epoch mode** — tail epochs (append-only, cache-warm) delay hard epochs (full reseed with continuity seed) as long as possible
- **Measured token telemetry** — uses real provider input-token counts, not character-count estimates
- **Coordinate Closet** — preserves exact literals (file paths, IDs, values) from folded turns
- **Per-session isolation** — each OpenCode session gets its own FoldSession and token telemetry

## Installation

### From source

```bash
cd packages/opencode-plugin
npm install
npm run build
```

Then add the built plugin to your OpenCode config (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./path/to/context-warp-drive/packages/opencode-plugin/dist/index.js"]
}
```

### With options

```json
{
  "plugin": [
    ["./path/to/context-warp-drive/packages/opencode-plugin/dist/index.js", {
      "pressureCeiling": 150000,
      "runway": 45000,
      "minRunway": 30000,
      "freeze": true,
      "recall": true,
      "debug": false
    }]
  ]
}
```

> **Note:** The exact config-tuple syntax and option parsing follow OpenCode's `ConfigPlugin.pluginOptions` loader. Verify against your OpenCode version's config schema if unsure.

## Configuration

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pressureCeiling` | number | 150000 | Measured input tokens before a hard epoch triggers |
| `runway` | number | 45000 | Preferred remaining runway after a tail-epoch append |
| `minRunway` | number | 30000 | Hard minimum runway before a tail epoch can proceed |
| `freeze` | boolean | true | Enable provider-cache freeze (byte-identical prefix reuse) |
| `recall` | boolean | true | Inject a fold-state hint into the system prompt |
| `debug` | boolean | false | Log fold decisions to stderr |

## How It Works

```
OpenCode session runner
  │
  ├─ 1. Load session messages from history
  ├─ 2. Build LLM request (system + messages + tools)
  ├─ 3. Check native compaction → SKIPPED (context is under threshold)
  ├─ 4. Fire "experimental.chat.messages.transform"
  │     └─ CWD plugin:
  │        ├─ Convert OC messages → CWD FoldMessages (with index map)
  │        ├─ FoldSession.prepare()
  │        │   ├─ Below threshold → hot reuse (cache fully warm)
  │        │   ├─ Threshold + runway → tail epoch (append band, cache warm)
  │        │   └─ Pressure ceiling → hard epoch (full reseed, cache cold)
  │        └─ Splice folded output → OC messages array (in-place mutation)
  ├─ 5. Stream provider response
  └─ 6. Fire "event" with usage telemetry
       └─ CWD plugin captures measuredInputTokens (keyed by session ID)
```

### Key Design Decisions

**Pre-emptive folding, not compaction replacement.** The plugin doesn't fight OpenCode's compaction system — it makes it never fire. By folding messages down every turn via `messages.transform`, OpenCode's own threshold check sees a context that's always under limit, so its LLM summarization code becomes dead code.

**In-place array mutation.** OpenCode discards the transform hook's return value and keeps using its local array reference. The plugin must `splice` the existing `output.messages` array to replace its contents — property reassignment would be silently discarded.

**Active-window passthrough.** The fold block (folded turns) is synthesized as text messages, but the unfolded active window is passed through as ORIGINAL OpenCode message objects. This preserves tool calls, tool results, file/image parts, and reasoning byte-identical.

**Per-session state.** OpenCode runs main and subagent sessions through one plugin instance. Each session gets its own `FoldSession` and measured-token telemetry, keyed by session ID derived from message metadata.

### Tail Epochs vs Hard Epochs

The plugin uses CWD's full hybrid mode:

- **Tail epoch** — when the measured tokens approach the threshold but sufficient runway remains, CWD appends a fold band to the frozen prefix. The prefix stays byte-identical, so the provider cache reads at 0.1×. This is the cache-efficient path.

- **Hard epoch** — when measured tokens reach the pressure ceiling or runway is exhausted, CWD reseeds the entire context with a compact continuity seed. The cache goes cold but all information is preserved via the Coordinate Closet.

The decision is made entirely by `FoldSession.prepare()` based on the measured `inputTokens` from the provider response. OpenCode doesn't know or care which epoch type fired.

### Native Compaction Safety

If OpenCode's native compaction somehow triggers (e.g., a resumed overweight session), the plugin does NOT replace the summarization prompt with a no-op. Instead, it pushes CWD's fold state as additional context for the summarization call, and lets auto-continue proceed normally. This ensures the session survives gracefully even in edge cases.

## Architecture

The plugin has two source files:

- `src/index.ts` — the plugin export with OpenCode hooks (per-session state, transform, event, system, compacting)
- `src/adapter.ts` — bidirectional message format mapping (OC ↔ CWD) with active-window passthrough and token telemetry extraction

The CWD engine is bundled at build time via tsup from `../../../src/` relative imports — no separate `context-warp-drive` npm dependency is needed.

## License

MIT
