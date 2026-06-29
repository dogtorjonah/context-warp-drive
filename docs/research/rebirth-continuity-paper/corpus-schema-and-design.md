# Corpus Schema & Dataset Design — s3 (experimental design) + s4 (parser spec)

*rail-7950db67. Author: instrumented agent lane, 2026-06-03. Schema verified first-hand against the operator-private live corpus.*

## 0. Why this doc exists
The transition-detection + manifest schema was hard-won by direct reconnaissance. Banking it so **no successor re-derives it** (dogfooding the paper's own thesis). Doubles as the reviewer-facing **Datasheet** (methods-rigor item D — reproducibility without raw data).

## 1. Corpus layout (verified 2026-06-03; `RELAY_DATA_DIR=<operator-private relay data root>`)
| Path | Size | What |
|---|---|---|
| `rebirth/*.jsonl` | 972 files, 838 MB | **One JSONL line = one rebirth transition.** ~10,450 lines = transition population N. |
| `rebirth-spool/` | 136 MB | Spilled package text when inline `packageText` was truncated/empty. |
| `rebirth-continuity/*.json` | 958 files | Per-identity continuity **contract** (NOT a score): `{version, workspace, instanceName, identityNarrative, continuityContract{identityKey, renameBehavior, role, engine, lastRecordedFocus}}`. Existing relay scaffolding — a persistence/identity *anchor* (resembles Menon 2604.09588 multi-anchor). Feeds `warmContinuity`. **Not a measurement — Score A remains the novel contribution.** |
| `events/<instanceId>.jsonl` | 1312 files, 2.5 GB | Canonical event stream per instance (all rebirths of one ID share the file). Predecessor + successor behavior. |
| `messages/<instanceId>.jsonl` | 1329 files, 3.2 GB | Full transcripts (fallback / text-level checks). |
| `archived/instances.json` | 2.9 MB | Archive/resume catalog. `metadata/index.json` (418 KB). |
| `stars/ thoughts/ edits/ costs/` | — | Auxiliary per-instance state. |

Join key throughout: **`instanceId`**. A rebirth record's transition behavior lives in that instance's `events/<instanceId>.jsonl`, split at the rebirth timestamp `t`.

## 2. Rebirth transition record (`rebirth/*.jsonl` line)
`t` (epoch ms) · `instanceId` (8ch) · `instanceName` · `reason` (trigger) · `predecessorStatus` · `packageChars` (int — RICHNESS) · `packageText` (rendered string) · `packageJson` (**structured manifest — parse this, not the text**).

## 3. Manifest M(T) = `packageJson` (packageVersion 4) → Score A denominators
| Field | Score A role |
|---|---|
| `runtimeModel{predecessor, successor, changed}` | **Model-swap flag** (`changed=true`) + engine/tier pair. Clean, no regex. |
| `atlasCrossRef` (~15K chars) | "File Context" handoff snapshot = files/symbols handed over → **R_read denominator**. |
| `activeEditDelta` | In-flight files → **justified re-open set** (re-opening these is NOT re-discovery). |
| `taskRailContext` | Rail cursor + active step → **T_pos denominator**. |
| `warmContinuity` (+ `rebirth-continuity` contract `lastRecordedFocus`) | Decision/focus continuity input. |
| `coordinationState`, `chatroomMembership` | Coordination denominator. |
| `workspaceContext{currentCwd, currentWorkspace}` | **Operator env-change detector** — the Case Study 0 confound: tag a workspace/cwd change as an *input*, never score it as re-discovery. |
| `userMessageTriggered` (bool) | Whether a user message triggered the rebirth (shifts T_pos expectation). |
| `lastUserAiMessages`, `currentThread`, `thinkingTrail` | Textual handover (D_con + "info already present" checks). |
| `rebirthCadence`, `rebirthHistory`, `squadThoughts`, `predecessorThought` | Context; some empty in v4 records. |

## 4. Behavioral event stream (`events/<id>.jsonl`, discriminator = **`ty`**; payload = `p`)
| `ty` | Key payload fields | Use |
|---|---|---|
| `tool_call_start` | `canonicalToolName`, `rawToolName`, `input`, `toolCallId` | **Primary signal source.** |
| `tool_call_result` | `canonicalToolName`, `output`, `status` | Success/error of acquisitions. |
| `edit_provenance` | `filePath`, `toolName`, `diffHash`, `succeeded` | Edits → **justify a re-open** of that file. |
| `turn_result` | `inputTokens`, `outputTokens`, `contextWindow`, `cost`, `duration`, `turns` | **Token/cost comparator** (Handoff-Debt-style). |
| `text_delta` / `text_complete` | `text` | Assistant text (D_con relitigation checks). |
| `extension_event` | `extensionType`, `payload` | Thoughts, tap_star, etc. |
| `error` | `message` | Inverse-error-rate success proxy. |

### Action → sub-signal mapping
- **R_read** (re-read avoidance): `tool_call_start` `canonicalToolName=Read`, `input.file_path ∈ atlasCrossRef files`, AND not justified by an `edit_provenance`/`partner_claim_file` on that path in-window. `R_read = 1 − unjustified_rereads / manifest_files`.
- **R_ret** (redundant-retrieval avoidance): `canonicalToolName ∈ {atlas_query, Grep, Glob, WebSearch, WebFetch, tap_instance_messages, chatroom(read)}` whose target already ∈ manifest text. `R_ret = 1 − retrievals_in_manifest / total_early_acquisitions`.
- **T_pos** (task-position continuity): first `task_rail` action resumes the handed `taskRailContext` step? `partner_claim_file` re-claims handed claims? vs restart/replan. `{0,0.5,1}`.
- **D_con** (decision consistency): successor text/decisions contradict pinned decisions in manifest (`warmContinuity`/starred). Hardest → s6 LLM-judge on a sample; deterministic heuristic = re-opened a settled topic.

## 5. Window
K = 20 successor `tool_call_start` events after `t` (per s2 default; sensitivity-tested in s8).

## 6. Experimental conditions (s3) — grounded in REAL distributions (sampled 2,903 transitions / 200 files)
- **Trigger class** (`reason`): wave-protocol (decompose 963 / review+fix / shoot-rail / improve / investigate / load-rail), `manual UI trigger` (525, operator-initiated), `turn-threshold-next-user-message` (485, auto-cadence), `compact` (19), `resume`/`restore` (cold — rebuilt from disk, rare: ~36/~3), `watchdog-rebirth-timer`, `evolution-chamber-wave-N` (automated), plus free-text human/agent context-pressure reasons.
- **Richness** (`packageChars`): continuous warm↔cold gradient. **Primary H1 axis.**
- **`predecessorStatus`**: idle (2433, clean boundary) vs **working** (406, mid-task — the demanding case) vs stopped/compacting/hibernated/error.
- **Model swap** (`runtimeModel.changed`): same-model vs cross-model — the headline phenomenon (~984 swaps corpus-wide per s1 count).
- **Operator env change** (`workspaceContext` delta): tagged as **input/confound**, not penalized.

### Hypotheses
- **H1 (the package works):** Score A ↑ and re-discovery cost ↓ as `packageChars` ↑ (warm > cold).
- **H2 (cross-model holds — HEADLINE):** model-swap transitions ≈ same-model on Score A (no significant continuity penalty from hot-swap). ⚠ Confound to control: are cross-model swaps concentrated in rich/automated wave rebirths? Stratify by `packageChars` + trigger class.
- **H3 (mid-task is harder):** `working`-status transitions show lower T_pos than `idle`, but a rich package mitigates the gap.
- **H4 (meets/beats the bar):** warm-vs-cold re-discovery reduction ≥ Handoff Debt (−20–59% events / −42–63% tokens); TCS-style task ratio in the 0.83–0.92+ band.

## 7. Parser output: `transitions.jsonl` (one row per transition; s4 deliverable)
```
{transition_id, instanceId, t, reason, trigger_class, predecessorStatus, packageChars,
 model_pred, model_succ, model_swapped, workspace_changed, user_triggered,
 manifest: {files[], rail_step, rail_active, claims[], pinned_decisions[], coord_present},
 window: {n_actions, reads[], retrievals[], rail_actions[], claims[], edits[],
          tokens_in, tokens_out, cost, errors, turns},
 raw_signals: {manifest_file_count, rereads_of_manifest, unjustified_rereads,
               early_acquisitions, retrievals_in_manifest, resumed_rail, reclaimed}}
```
Scorer (s5) consumes this → R_read, R_ret, T_pos, D_con, composite Score A, + Handoff-Debt/TCS comparators. Parser is pure offline read of `rebirth/` + `events/`; **no relay code, no writes to relay data.** Heavy full-corpus pass runs via `nohup` (per AGENTS.md long-running-scripts rule).

## 8. Honest risks (surfaced for s8)
- **Cold-baseline thinness:** `resume`/`restore` (true cold-from-disk) are rare (~40 total in sample). The warm-vs-cold contrast may lean on the `packageChars` gradient + spooled-empty packages rather than a clean "no-context" arm — which is exactly the Option-A asterisk, and could pull Option B (controlled cold baseline) forward if H1's cold end is too thin.
- **H2 confounding** (above) — the headline claim needs careful stratification, not a raw mean comparison.
