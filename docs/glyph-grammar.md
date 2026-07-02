# Register-glyph grammar

A one-character convention that turns ordinary assistant messages into a machine-readable trust signal — the substrate that lets episodic recall harvest **durable** memory from a stream of in-progress chatter without an LLM judging each line.

## The five registers

Every assistant message opens with exactly one register glyph:

| Glyph | Register | Meaning | Trust |
|---|---|---|---|
| 🔍 | `in_progress` | investigating, building, partial findings, hypotheses | transient (not final) |
| ▶ | `executing` | tool, edit, test, or batch execution is actively underway | transient (not final) |
| 🏁 | `verdict` | a verified outcome or settled conclusion | **durable**, final |
| ⚠️ | `hazard` | a trap, gotcha, or invariant others must know | **durable**, final |
| ❓ | `blocked` | needs a decision or input to proceed | final, not durable |

When in doubt, a message is `in_progress` (🔍). Tag what the message **is**, not what you hope it becomes.

## Parsing — `parseRegisterGlyph(text, options?)`

Strict, deterministic, first-character parse:

- Reads the glyph at position 0 only. Tolerant of the U+FE0F variation selector (so `⚠️` and `⚠` both match).
- **Rejects** leading whitespace, markdown containers (` ``` `, `>`, `#`, `-`, `*`, `1.`), a missing register, and a **duplicated** register (two glyphs in a row).
- Returns `{ ok, register, glyph, body, classification }` on success, or `{ ok: false, reason, classification }` with a typed failure reason.
- ASCII aliases (`[verdict]`, `[hazard]`, …) are **opt-in** (`{ asciiAliases: true }`) so the runtime contract stays glyph-first and machine-readable.

`classifyAssistantRegister(register)` maps a register to `{ trust, durable, final }`; `stripRegisterGlyph(text)` returns the body with the glyph removed.

## Why episodic recall needs it

Episodic capture mines an agent's burst-final prose into durable memory. Without a register signal, a confident-sounding **mid-investigation hypothesis** (which is often wrong) looks identical to a **verified conclusion** — and gets harvested as fact. The glyph is a coarse trust gate ahead of the shape filter:

- 🔍 / ▶ / ❓ messages **self-exclude** from harvest — in-progress, executing, and blocked work can never masquerade as a verdict.
- 🏁 / ⚠️ messages are eligible, and their register sets the harvested line's **trust tier**: 🏁 → `narration:verdict`, ⚠️ → `narration:hazard`, both promoted into the high-priority ranking tier so a declared conclusion can outrank a routine log line.
- Untagged prose stays a priority-last backstop — behavior is byte-identical at 0% glyph compliance and strictly less noisy above it.

In short: the grammar is what makes the high-frequency commentary channel a *primary* memory source instead of a noisy fallback. It costs one character per message and zero model calls.

## Emitting — the host's half of the contract

Parsing is only half the grammar: a host that never *instructs* its model to open messages with a register glyph gets 0% compliance and the entire trust ladder runs on the untagged backstop. The engine therefore exports the emit contract alongside the parser:

- **`REGISTER_GLYPH_PROMPT_SNIPPET`** — a canonical one-paragraph system-prompt instruction, derived at module load from `REGISTER_GLYPHS` + `REGISTER_DESCRIPTIONS` so the emit wording can never drift from what `parseRegisterGlyph` accepts. Inject it into any system prompt that drives a model through this engine.
- **`buildRegisterGlyphPromptSnippet(descriptions?)`** — same derivation with a replaceable description table (localization / house-style wording); the glyph set always comes from `REGISTER_GLYPHS`.
- **`CARD_GLYPHS`** — the quoted-memory glyphs (✎ ⭐ 💬 🗣 ⌖ Δ ↞ ↠) that must never open fresh speech; the snippet names them as forbidden openers to prevent echo contamination (replayed memory re-harvested as a fresh verdict).

Rule of thumb: if your host calls `parseRegisterGlyph` anywhere, it should be injecting `REGISTER_GLYPH_PROMPT_SNIPPET` somewhere.
