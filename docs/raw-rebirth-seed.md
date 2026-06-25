# Raw Rebirth Seed

The raw rebirth seed is the deterministic wake package for a hard epoch. It is computed from the provider trace and host-supplied trace sections. It does not call a model, read files, query a database, or summarize.

Use it when your runtime needs to reset the provider-visible context while preserving the exact continuity that can be reconstructed from the trace.

## Fast Path

```ts
import { buildRawRebirthSeedFromMessages } from 'context-warp-drive/raw-rebirth-seed';

const seed = buildRawRebirthSeedFromMessages(history, {
  predecessorName: 'agent-before-reset',
  includeTrailingUserTurn: false,
  workspaceContext: {
    currentCwd: process.cwd(),
    currentWorkspace: 'my-agent-runtime',
  },
  activeEditDelta: 'Files claimed for editing: src/parser.ts',
  taskRailContext: '[Task rail] Fix parser regression',
});
```

`history` is your raw provider-shaped message array. The helper understands the same `FoldMessage` shape used by `FoldSession`: Anthropic string/content blocks, OpenAI-style `tool_calls` plus `tool` messages, and Gemini-like `model` roles.

Set `includeTrailingUserTurn: false` when you will later merge the live user turn into the hard-epoch message with `buildHardEpochSeedView()` or `FoldSession.prepare()`. Set it to `true` only when this raw seed is the complete prompt body and no separate live-turn merge will happen.

## FoldSession Default

`FoldSession` uses the raw rebirth seed as the default hard-epoch seed. When measured token pressure reaches the configured pressure ceiling and no host override is passed, `prepare()` computes this seed from the local trace and returns a single provider-safe user message.

```ts
const session = new FoldSession({
  pressureCeiling: 120_000,
  rawHardEpochSeedMaxChars: 200_000,
});

const outcome = session.prepare(history, {
  measuredInputTokens: previousUsage.input_tokens,
});
```

You can still pass `hardEpochSeed` when your host has a richer renderer. The package fallback is intentionally deterministic and trace-local.

## Full Renderer

Use `renderRawRebirthSeed()` when you already have relay-like sections.

```ts
import { renderRawRebirthSeed } from 'context-warp-drive/raw-rebirth-seed';

const seed = renderRawRebirthSeed({
  predecessorName: 'source-agent',
  packageBudget: 200_000,
  lastUserAiMessages,
  currentThread,
  rawTraceCoordinateCloset,
  activeEditDelta,
  taskRailContext,
  workspaceContext: {
    currentCwd: '/repo',
    currentWorkspace: 'my-runtime',
  },
  thinkingTrail,
});
```

Default section budgets mirror the relay-style raw hard-epoch policy:

| Section | Default chars |
|---|---:|
| Last User + AI Messages | 50,000 |
| Current Thread | 50,000 |
| Raw Trace Coordinate Closet | 8,000 |
| Active Edit Delta | 50,000 |
| Task Rail Context | 12,000 |
| Episodic Cross-Reference | 12,000 |
| Lineage Glyph Log | 4,000 |
| File Context | 25,000 |
| Workspace Context | 1,500 |
| Starred Moments | 50,500 |
| Activity Log | 40,000 |
| Lifetime Changelog Arc | 10,000 |
| Chatroom Membership | 4,000 |
| Coordination State | 2,500 |
| Squad Awareness | 4,000 |
| Delegated Work | 2,500 |

The global package budget defaults to 200,000 characters. Character budgets are size clamps only; they are not token telemetry and should not be used for billing or pressure gauges.

## Relay Parity Boundaries

The renderer mirrors the portable part of the relay wake package: section headings, default budgets, allocation priority, render order, Coordinate Closet newest-first extraction, current-thread duplication, activity trail, workspace context, and orientation footer.

The package does not gather relay-only enrichment. It will not read Atlas, task rails, chatrooms, active file claims, archived instances, or episodic stores. If your runtime has those sections, compute them in your host and pass their rendered strings to `renderRawRebirthSeed()`.

Identical inputs produce the same seed. To get the same seed across runtimes, pass the same normalized trace messages, same section strings, same predecessor/runtime metadata, and same budget options.
