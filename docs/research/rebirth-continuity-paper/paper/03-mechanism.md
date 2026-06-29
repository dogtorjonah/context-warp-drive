## 3. The Rebirth Mechanism

Rebirth replaces a session's death with a planned, identity-preserving handoff. This section describes
the mechanism as deployed, then shows it is portable rather than system-specific.

**Rebirth at a glance.** The mechanism is simple to state. An agent runs until something — the agent
itself, an operator, a wave pipeline, or context pressure — decides it should reset. Instead of *ending*
the session, the system **rebirths** it: it assembles a compact **package** from the live session — the
curated messages, the in-flight edit state, the task-rail cursor, the coordination state, and the
agent's own pinned waypoints — and boots a **successor** from that package. The successor is not a new
agent. It is the **same identity** — same instance id, same file claims, same rail position, same squad
role — and it resumes the **same intent** the predecessor had open. Because the package is bounded, the
agent's per-turn context never marches toward a ceiling; it follows a **sawtooth** (Figure A): it climbs,
resets at each rebirth boundary, and climbs again. The rest of this section makes each of those words
precise — the trigger pipeline (§3.1), the fifteen-component package (§3.2), and the exact sense in which
identity is preserved — but the one-line version is the claim the whole paper tests: *the package carries
the intent, not the bytes.*

<figure>
<svg viewBox="0 0 760 452" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" role="img" aria-label="Rebirth keeps an agent's per-turn context bounded in a sawtooth while preserving identity and intent across each boundary.">
  <text x="28" y="26" font-size="15" font-weight="700" fill="#1a1a1a">A. Bounded context — the rebirth sawtooth</text>
  <rect x="70" y="118" width="620" height="70" fill="#eff6ff" opacity="0.7"/>
  <text x="76" y="134" font-size="10.5" fill="#2563eb">bounded prefix</text>
  <line x1="70" y1="50" x2="70" y2="205" stroke="#94a3b8" stroke-width="1.5"/>
  <line x1="70" y1="205" x2="710" y2="205" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="60" y="130" font-size="11" fill="#6b7280" text-anchor="middle" transform="rotate(-90 60 130)">context size</text>
  <text x="390" y="224" font-size="11" fill="#6b7280" text-anchor="middle">time / turns &#8594;</text>
  <line x1="70" y1="62" x2="710" y2="62" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text x="708" y="57" font-size="11" fill="#dc2626" text-anchor="end">context ceiling — degraded reasoning · stall · death</text>
  <path d="M70 185 Q 180 72 660 64" fill="none" stroke="#9ca3af" stroke-width="2.5"/>
  <circle cx="660" cy="64" r="5" fill="#dc2626"/>
  <text x="150" y="46" font-size="11.5" fill="#6b7280">unbounded growth /</text>
  <text x="150" y="60" font-size="11.5" fill="#6b7280">compaction &#8594; death</text>
  <path d="M70 185 L195 124 L195 180 L325 124 L325 180 L455 124 L455 180 L585 124 L585 180 L690 140" fill="none" stroke="#2563eb" stroke-width="2.75" stroke-linejoin="round"/>
  <g stroke="#2563eb" stroke-width="1" stroke-dasharray="3 3" opacity="0.5">
    <line x1="195" y1="124" x2="195" y2="205"/>
    <line x1="325" y1="124" x2="325" y2="205"/>
    <line x1="455" y1="124" x2="455" y2="205"/>
    <line x1="585" y1="124" x2="585" y2="205"/>
  </g>
  <g font-size="11" fill="#2563eb" text-anchor="middle" font-weight="600">
    <text x="195" y="218">&#8635;</text>
    <text x="325" y="218">&#8635;</text>
    <text x="455" y="218">&#8635;</text>
    <text x="585" y="218">&#8635;</text>
  </g>
  <text x="250" y="112" font-size="11.5" fill="#2563eb" font-weight="600">rebirth: bounded sawtooth</text>
  <text x="390" y="240" font-size="10.5" fill="#2563eb" text-anchor="middle">each &#8635; = a rebirth boundary (context resets, identity is kept)</text>
  <text x="28" y="286" font-size="15" font-weight="700" fill="#1a1a1a">B. What crosses each boundary</text>
  <defs><marker id="arrowA" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6 z" fill="#2563eb"/></marker></defs>
  <rect x="40" y="305" width="150" height="92" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="115" y="344" font-size="13" font-weight="600" fill="#1a1a1a" text-anchor="middle">Predecessor</text>
  <text x="115" y="364" font-size="11" fill="#6b7280" text-anchor="middle">approaching</text>
  <text x="115" y="378" font-size="11" fill="#6b7280" text-anchor="middle">the ceiling</text>
  <rect x="290" y="292" width="190" height="118" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="385" y="309" font-size="12" font-weight="700" fill="#1d4ed8" text-anchor="middle">PACKAGE — bounded &amp; curated</text>
  <text x="305" y="327" font-size="10.5" fill="#1a1a1a">• last user + AI messages</text>
  <text x="305" y="342" font-size="10.5" fill="#1a1a1a">• current thread + edit delta</text>
  <text x="305" y="357" font-size="10.5" fill="#1a1a1a">• task rail + cursor</text>
  <text x="305" y="372" font-size="10.5" fill="#1a1a1a">• coordination + squad state</text>
  <text x="305" y="387" font-size="10.5" fill="#1a1a1a">• pinned waypoints</text>
  <text x="305" y="403" font-size="9.6" font-style="italic" fill="#64748b">+ runtime, Atlas, history… (5 of 15, §3.2)</text>
  <rect x="580" y="305" width="150" height="92" rx="8" fill="#f8fafc" stroke="#2563eb" stroke-width="1.5"/>
  <text x="655" y="340" font-size="13" font-weight="600" fill="#1a1a1a" text-anchor="middle">Successor</text>
  <text x="655" y="360" font-size="11" fill="#6b7280" text-anchor="middle">same id ·</text>
  <text x="655" y="374" font-size="11" fill="#6b7280" text-anchor="middle">same intent</text>
  <line x1="192" y1="351" x2="286" y2="351" stroke="#2563eb" stroke-width="2" marker-end="url(#arrowA)"/>
  <text x="239" y="343" font-size="10.5" fill="#2563eb" text-anchor="middle">curate</text>
  <line x1="482" y1="351" x2="576" y2="351" stroke="#2563eb" stroke-width="2" marker-end="url(#arrowA)"/>
  <text x="529" y="343" font-size="10.5" fill="#2563eb" text-anchor="middle">boot</text>
  <text x="385" y="434" font-size="12.5" font-style="italic" fill="#1d4ed8" text-anchor="middle">"the package carries the intent, not the bytes"</text>
</svg>
<figcaption><strong>Figure A.</strong> Rebirth replaces session death with a planned, identity-preserving handoff. Instead of context growing monotonically toward a ceiling (gray) — where reasoning degrades and summarization stalls — the per-turn prefix follows a bounded <em>sawtooth</em> (blue): it climbs, resets at each rebirth boundary, and climbs again. At every boundary the successor inherits a bounded, curated <strong>package</strong> — not the raw transcript — and continues as the <em>same identity</em>, serving the <em>same intent</em>.</figcaption>
</figure>

*Terminology note: we use "rebirth," not "reincarnation," deliberately. "Reincarnation" already names an
established and unrelated idea in reinforcement learning — reusing prior computation (e.g., a learned
policy) to accelerate training rather than starting tabula rasa (Agarwal et al., "Reincarnating
Reinforcement Learning," arXiv:2206.01626; Formanek et al., "Selective Reincarnation," arXiv:2304.00977).
That is reuse of computation across training runs; rebirth is continuity of one identity across a context
boundary at inference time — a different concept on a different axis.*

### 3.1 Lifecycle

A rebirth proceeds through a fixed pipeline. A trigger calls `executeContextRebirth`, which invokes
`prepareRebirthBuild` to assemble the successor's package from live session state **outside** the
execution queue, so the builds of concurrent rebirths can overlap; the resulting build is then handed to
`commitRebirthSwap`, which is enqueued through `enqueueRebirthExecution` so that the session *swaps* are
serialized (default concurrency 1) against the relay's other work; the swap then atomically replaces the
running session with its successor via `manager.rebirthSession`. The swap is atomic by design: the
successor does not exist as a half-initialized peer of its predecessor, and the predecessor's
coordination commitments (file claims, task-rail cursor, squad role) are **retained automatically** — the
swap reuses the same instance object and id, and these commitments are keyed by instance id in external
stores, so they are never released or re-created. No window therefore exists in which two instances both
believe they own the same work.

Six distinct triggers drive this same pipeline, which is itself part of the contribution — rebirth is
a single mechanism with many entry points, not a special case:

1. **Agent self-rebirth** — an agent calls the `self_rebirth` tool to refresh its own context
   (normal priority). This is the common case and the one this paper's agents use.
2. **Operator-initiated** — a control-priority `POST /api/x/rebirth` (Bearer-authenticated, able to
   move the successor into a worktree), letting a human refresh or redirect an agent.
3. **Bulk** — many agents reborn together, e.g. for a fleet-wide refresh.
4. **Wave / phase machinery** — a long-running pipeline advances an agent through task-rail phases by
   rebirthing it between them, which is how multi-phase work runs unattended.
5. **Automatic context-pressure** — the system rebirths an agent as it approaches the ceiling.
6. **Library resume** — a previously archived instance is resumed from its stored state.

### 3.2 The package

The successor does not inherit the raw transcript. It inherits a **package** — a curated, bounded
bundle of exactly the state needed to continue. Because this paper's central claim is that the package
carries the *intent*, the contents of the package are not a detail to gesture at — they are the thing
being claimed — so we enumerate them in full, each under the name the system itself uses and with a plain
explanation of what that name means. A package is assembled from up to fifteen components, grouped below
by the job each one does:

| Job it does | Component (the system's name for it) | What it is, and why the successor receives it |
|---|---|---|
| **The live request and the unfinished work** | **Last user + AI messages** | The single most recent user message and the agent's most recent reply, flagged "read first," so the successor sees the freshest exchange immediately — carried word-for-word, never summarized. |
| | **Current thread** | The recent back-and-forth around that exchange, including the specific message that triggered the handoff, so the open request is unambiguous. |
| | **Active Edit Delta** | The files the predecessor was in the middle of changing — what was being written, and to which file — marked *authoritative* so the successor neither repeats nor overwrites work already underway. ("Delta" = the in-flight change itself, not the whole file.) |
| | **Runtime model** | Which AI model ran the predecessor, which model runs the successor, whether that changed, and how long the predecessor ran — the record that makes a mid-task change of model explicit. |
| **The plan and the workspace** | **Task rail** | The agent's ordered checklist of steps — its plan: the overall objective, the step it is on now, and the conditions that count that step as done. ("Rail" = the steps run on a fixed track the agent advances along.) |
| | **Workspace context** | The directory and code branch the work is taking place in. |
| | **Atlas file context** | For each file in play, a short summary pulled from *Atlas* — the project's standing, queryable index of the whole codebase: the file's purpose, its known pitfalls, and how it connects to other files — so the successor understands the code without re-reading it from scratch. |
| **Memory and history** | **Starred moments** | Points the predecessor deliberately pinned ("starred") for itself along the way: decisions it made, things it discovered, course corrections, and traps to avoid. |
| | **Activity log** (the "thinking trail") | A time-ordered trace of the predecessor's recent actions and reasoning, shown at decaying detail — the newest entries in full, older ones as short snippets, the oldest as one-line markers. |
| | **Lifetime changelog arc** | The running list of code changes this agent has actually committed over its lifetime, each with a one-line description of what it did. |
| | **Rebirth history** | A log of the agent's own earlier rebirths, so the successor can see the lineage it is continuing. |
| **Coordination with other agents** | **Chatroom membership** | Which shared message channels ("chatrooms") this agent belongs to and uses to coordinate with other agents working at the same time. |
| | **Coordination state** | Its place in the wider effort: which other agents it is working alongside, and which files it has *claimed* — reserved — so that no one else edits them at the same moment. |
| | **Squad awareness** | Brief current-status lines published by the other agents on its team (its "squad"). |
| | **Calibration notes** | Any notes left by a partner agent assigned to check or "calibrate" this agent's work. |

Two properties of *how* the package is delivered matter for the claims that follow. First, it is
**conditional, not a fixed template**: each component above is included only when it actually exists, so
an agent working alone carries none of the four coordination components, and one that was not mid-edit
carries no unfinished-edits component — the successor is handed what is real, not a padded form. Second,
delivery is separated from construction. The package is built outside the relay's hot path, written as a
spooled artifact with an integrity hash, then read back by the relay and delivered to the successor as the
bounded opening handoff prompt. The "fetch it only when you need it" principle (§3.6) therefore applies to
the long tail beyond that bounded handoff: if a detail is missing, the successor uses ordinary recovery tools
to re-read the predecessor's transcript (*tap*) or re-query Atlas (the codebase index), rather than carrying
every older turn in the prompt. The audit and reproducibility claim is the deterministic rendering of the
handoff artifact itself, which §5.8 contrasts against summarization, whose concrete details vary across runs.

This curation is the crux. Compaction asks "how do I shrink the transcript?"; rebirth asks "what does
the successor need to keep going?" The two are not the same. The package carries the **intent-bearing
prose verbatim** — the literal user messages and the recent thread, never summarized — alongside the
**structured state** — the file *claims* (its reserved files), the *task rail*, the *Active Edit Delta*,
and *Atlas* (the codebase index), each named in the table above — that conversation prose alone cannot
make authoritative; what it does *not* carry in full is the long tail of *older* activity, which is
bounded by the gradient described next and otherwise left in the durable stores. When a detail beyond the
window is missing, the successor can *tap* its predecessor's transcript — re-read it on demand — to
recover it, so the package is a working set, not a lossy summary, and recovery of the long tail is
on-demand rather than pre-paid.

**How the package stays bounded without summarizing.** A reader could mistake "bounded package, not the
raw transcript" for "an LLM summary of the transcript." It is neither: the package is a *deterministic,
structured rendering of the transcript's own event stream*, and three mechanisms keep it bounded while
preserving fidelity where it matters. **(1) Windowing** — the activity log scans a rolling window of the
most recent events (≈300 canonical events / ≈500 messages by default), not the whole history; older
events remain in the durable stores, tap-recoverable. **(2) A fidelity gradient** — within that window
the trail renders *every* event at a tier that decays with age: the newest ~5% in full detail (*hot*),
the next ~18% as truncated snippets (*warm*), and the oldest ~77% as one-line breadcrumbs (*cold*) —
with, in the verbose setting, **no silent drops: every event in the window renders** at some fidelity.
**(3) Graduation to pointers** — an in-flight edit renders as a full diff, but an edit already committed
to a durable store (Atlas, git) collapses to a one-line pointer, since the content is recoverable there. A
verbosity setting governs the trade: the default *lean* mode renders only the hot tier of the trail (older
tiers staying tap-recoverable), while *verbose* renders the full gradient. Crucially, the verbosity knob
touches only the activity trail and ancillary context — **the intent carriers (user messages, current
thread, in-flight edit diffs) render in full regardless.** This is precisely what makes the package "lossy
in bytes" (windowed and gradient-compressed) yet "lossless in intent" (the ask and the live work are
verbatim): the two clauses describe two different parts of one package, not a single lossy summary.

The byte-level determinism this rendering buys — the same boundary state always rendering to the same package
— is not merely an architectural nicety. §5.8 turns it into a measured contrast: re-compacting the *same*
transcript with the same model and prompt reshuffles ~70–90% of its concrete file-and-identifier detail from
one run to the next, while the package reproduces identically. A mechanism you can audit, fork (§8), and
cache (§6) needs a state that is the same every time you derive it; summarization does not provide one.

### 3.3 Same identity, not a fresh agent

The defining property — and the one that separates rebirth from inter-agent handoff and from
fresh-agent memory retrieval — is that the successor **is the same instance**. Its instance id is
preserved. Its file claims carry over. Its task-rail cursor points at the same step. Its squad role and
chatroom memberships are intact. From the perspective of every other agent and of the operator, the
instance did not change; it continued. This is why we can define continuity against a ground-truth
denominator (§4): there is no ambiguity about *whose* intent was carried, because the carrier and the
carried are the same object across the boundary.

This same-identity property is not bookkeeping — it is the precondition for the paper's central mechanism.
§4.2's load-bearing result is that the successor's *state* is **over-determined**: recoverable from the
filesystem, the rail, the chatroom, and Atlas rather than carried in the package. But that recovery works
only because those external stores are **keyed by instance id**. The claims the successor can reclaim are the
ones filed under *its* id; the rail it resumes is the one bound to *its* id; the squad role it re-enters is
*its* role. The instance id is the **foreign key** that makes the externalized state addressable — strip it
and over-determination collapses, because the successor can no longer tell which of the system's state is its
own. Identity preservation and the lean package are therefore two faces of one mechanism: the package stays
small *because* the preserved identity keeps the rest of the state recoverable.

The same key opens a second lock that single-agent framings miss. In a swarm, an instance's identity is also
its **position in the coordination graph** — the file claims other agents route around, the squad lane they
expect it to hold, the chatroom threads it is mid-conversation in, the `@mention` address that reaches it, the
rail step its teammates are blocked on. Because the successor keeps the id, none of that has to be rebuilt: no
teammate re-learns who it is, no claim is renegotiated, no squad role is reassigned, no in-flight conversation
is dropped. Rebirth therefore preserves not only the agent's continuity with **itself** but the swarm's
continuity with the **agent** — to every peer, the same instance simply kept going, so the shared coordination
state is undisturbed. A fresh-agent handoff cannot offer this: a new id is a new node in the graph, and every
edge — every claim, role, thread, and mention — must be re-formed. This is the multi-agent reason rebirth
composes with coordination where lossy compaction or a notes-handoff to a new agent would force the whole
squad to re-coordinate around the replacement. (That the identity is carried as a full document rather than a
bare id number is not incidental — an identity document induces attractor-like convergence in a model's
activation space (Vasilenko, arXiv:2604.12016), so the framing is representationally active, not inert text.)
In our system this identity framing is **entangled** with the rest of the package, so we do not isolate its
causal contribution here — §8.5 registers the ablation (F0) that would.

### 3.4 Model passthrough and the hot-swap

The boundary is also where the **model can change**. Because the successor is launched fresh from the
package, the engine and model that run it need not match the predecessor's: the same instance can be
reborn under a different model (a *hot-swap*). The package is model-agnostic — it is structured state,
not model-specific activations — so a Claude predecessor can hand to a Codex successor, or vice versa,
with the task intact. §7 measures whether this costs continuity (it shows no detected within-engine
penalty; cross-family is underpowered), and §10 argues why a backend that could route each turn to the
cheapest adequate model is an economic lever that compaction cannot offer.

### 3.5 Portability: an existence proof on vanilla Claude Code CLI

Rebirth could be dismissed as an artifact of our particular relay. It is not. We reproduce it as
`brain-mcp`, a thin layer over the **vanilla Claude Code CLI**: a wrapper counts the session's cadence,
and at the boundary it relaunches the CLI and hands the successor a progress package — the same
relaunch-plus-handoff shape as the full system, with model passthrough preserved. `brain-mcp` requires
no privileged access to the model and no modification of the CLI; it is a protocol wrapped around an
ordinary agent runtime. This matters for the paper's central implication: if rebirth is a thin protocol
over a CLI agent, then a model provider — who controls the runtime far more deeply than a wrapper does —
could fire it **every turn, on the backend, invisibly**. The user would see a session that runs forever
with no visible compaction; the provider would see bounded, highly cacheable per-turn context. The
mechanism we measure here is, in that sense, a small and portable thing — which is exactly why its
implications are large.

*Locus note: `brain-mcp` is a separate standalone repository (`~/brain-mcp`), not part of the
voxxo-swarm tree; the cadence counter, respawn request, wrapper relaunch/model passthrough, and handoff
builder described here live across `src/io/respawn.ts`, `src/tools/brain_rebirth.ts`,
`bin/brain-claude`, and `src/package/build.ts`. The in-tree `docs/brain-mcp-design.md` is the design
note, not the implementation.*

### 3.6 Rebirth as stateless compute over over-determined state

The reason a thin protocol suffices — and the principle the rest of the paper rests on — is that **rebirth
is stateless compute over over-determined state.** The durable state of the work (files on disk, the Atlas
index, the task rail, the chatroom, file claims) is *externalized* to authoritative stores that outlive the
boundary; the agent does not carry that state across a rebirth, it **pages** it on demand — the
retrieval-beats-stuffing result of the long-context-vs-RAG literature (arXiv:2501.01880) applied to a
handoff: state a successor can fetch on demand never had to be carried. This reframes the package
precisely: it is **retrieval-grounded continuation** — RAG over the agent's *own* authoritative state — and
that framing earns the analogy's upside while escaping its usual failure mode. Retrieval grounding reduces
hallucination by anchoring generation in external evidence rather than lossy recall (arXiv:2104.07567,
arXiv:2401.00396), but it fails when the *retrieval* is wrong: noisy or conflicting documents compound error
(arXiv:2505.18581). A rebirth package's "retrieval" is not over a noisy corpus where relevance is
uncertain — it is over the small, canonical, exactly-relevant stores of the agent's own work (the rail step,
the file claim, the edit delta), keyed by instance id and authoritative *by construction*, so RAG's dominant
failure mode is structurally minimized. The residual RAG risk — *unfaithfulness*, a successor that ignores
its retrieved context and reverts to parametric priors (arXiv:2506.08938) — is real but shared by every
context-management strategy, summarization included. The analogy is exact at one further joint: the package
is the *prefetched* working set, assembled on a fixed schedule, while the on-demand **tap** (a successor
pulling a missing detail from its predecessor's transcript, §3.2) is the genuinely query-conditioned
retrieval — RAG in the strict sense — so the system runs both a scheduled prefetch and a lazy query against
one durable backing store. The contrast with the incumbent is then sharp: summarization-based compaction is
*summary-grounded*, reasoning over a generated, lossy artifact that can itself confabulate, where rebirth
re-anchors each successor to the source of truth. The package therefore holds only
the **irreducible** — the open intent and the in-flight edits not yet committed to any
store — and otherwise serves as pointers to everything else. It is the systems pattern of a stateless
request handler over a durable backing store: the handler is torn down and re-instantiated between requests
(the rebirth), while the state persists outside it and is read back as needed (§3.2's working set).

Two consequences follow, and they are the spine of §5 and §6. **Continuity is preserved because state is
not lost at the boundary, only externalized and re-served** — the successor re-derives state from the store
rather than reconstructing it from memory, which is also *why* the §4.2 file-touch metric is confounded:
the state was recoverable regardless of the package, so re-touching the right file is weak evidence of
carried intent. This has a sibling in the degradation literature: holding state in-context is not free
even when its contents are perfectly recoverable (arXiv:2510.05381), so paging it back into a short prefix
is not merely *as good as* carrying an ever-growing one — it is cheaper to reason over. **The boundary is cheap because the agent pages bounded state instead of carrying an
unbounded transcript** — the page-versus-carry distinction behind the §6/§9 cost model.

The principle carries a realization condition we state rather than assume: it holds only to the degree the
stores are **authoritative, fresh, and cheap to query**. A successor that pages *stale* state acts on a lie
— the agentic failure mode of *premature exploitation*, acting on prior knowledge before verifying it
against the current environment (arXiv:2605.16143) — which is exactly why the package marks the Active Edit
Delta *authoritative* (§3.2), the one slice where trust must not be deferred — and a successor that must *expensively* reconstruct has merely relocated the
cost, not removed it. So over-determination of state is Janus-faced: it is a measurement **confound** (§4.2)
and a forking **limit** (§10.6 — siblings share one filesystem), but first an **enabling** property — it is
what lets the package stay lean and the boundary stay cheap, and it is the architecture, not a trick, that
the implications in §10 build on.
