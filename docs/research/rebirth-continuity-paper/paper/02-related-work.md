## 2. Related Work

Our contribution is **empirical performance at deployment scale**, not concept novelty. A small
but growing literature already argues that agents need continuity across context limits and model
changes; what is missing is a measurement, on a live system, of how well same-identity rebirth
actually delivers it — and at what cost. We position against four bodies of work: (i) the emerging
**cross-model continuity / handoff** bar we measure ourselves against; (ii) **agent-memory systems**,
which are adjacent but solve a different problem; (iii) **context compaction and long-horizon
serving**, which is the mechanism rebirth competes with; and (iv) **failure recovery and
checkpoint/restore**, the closest framing to our recovery metric. We then build on a fifth literature we
do *not* compete with — **long-context degradation** (§2.5) — which establishes that a bounded prefix is
intrinsically better for reasoning, and is the foundation for our argument that rebirth improves on
compaction rather than merely matching it.

*Readers who want the mechanism before the positioning can jump ahead to §3 and return here for the map.*

### 2.1 The cross-model continuity and handoff bar

The closest neighbor is **Handoff Debt** (KC & Budathoki, arXiv:2606.02875, 2026-06-01), which
defines *rediscovery cost* — the extra agent events and prompt tokens a successor spends to re-learn
state after a handoff — over 724 runs, 181 handoff points, and 75 tasks, with a Qwen predecessor
handing off to Qwen, Gemma, and Devstral successors. It reports event reductions of 20–59% and token
reductions of 42–63% when a handoff artifact is provided versus a repository-only baseline. Handoff
Debt is the bar we measure against, and it differs from our setting in three load-bearing ways. First,
it is an **inter-agent takeover**: a *new* agent inherits artifacts, whereas rebirth continues the
**same instance object** — its id, file claims, task-rail cursor, and squad role are preserved across
the boundary. Second, its repository-only baseline **cannot know what was actually handed over**, so
rediscovery cost is a one-sided delta; our system records a no-silent-drops **package manifest**, which
gives a ground-truth denominator and therefore a normalized 0–1 continuity score rather than only a
cost difference. Third, our corpus is over **12× larger** (8,717 rebirth arrivals vs 724 runs),
spans **eight engines** rather than three, and is **observational on a live deployment**
rather than constructed.

A second strand treats continuity as portable memory or identity architecture. **Portable Agent Memory**
(Ravindran, arXiv:2605.11032) proposes a protocol for transferring persistent memory across
heterogeneous agents: a five-component memory model, Merkle-DAG provenance, capability-scoped
disclosure, injection-resistant rehydration, JSON-first serialization, a Python SDK with 54 passing
tests, and demonstrations across GPT-4, Claude, Gemini, and Llama. It is a useful portability neighbor,
but it does **not** define an intent-continuity score or report deployment-scale task-continuation
rates. **Persistent Identity in AI Agents** (Menon, arXiv:2604.09588) is architectural: it frames
context overflow as catastrophic forgetting that destroys "continuity of self" and proposes a
multi-anchor memory design (the `soul.py` framework), but specifies identity continuity as an
architecture rather than reporting a measured continuity rate. **Agent Identity Evals** and the
**Stack-Theory** persistence work (Perrier, arXiv:2507.17257; 2603.09043) do offer empirical,
statistically-driven frameworks — an identity-stability eval and a pair of persistence scores — but
they measure whether an agent *behaves like a stable self* across probes, not whether an *interrupted
task* is carried to completion across a context-limit, model-swap handoff. Two further entries frame the strand: a structured survey defines agent identity as
"the continuous relationship between what an AI agent is declared to be and what it is observed to do" and
finds no current standard governs it (**AI Identity**, Otsuka et al., arXiv:2604.23280), while **Identity
as Attractor** (Vasilenko, arXiv:2604.12016) gives representational evidence that a persistent identity is
real — an agent's identity document induces attractor-like convergence in Llama-3.1 and Gemma-2 activation
space. Both bear on *whether* a stable identity exists to be carried; neither measures an interrupted task
carried to completion across a model swap. The attractor result we treat as more than a neighbor, though —
§3.3 **builds on** it as the representational basis for the claim that the same-identity framing rebirth
preserves is functionally load-bearing, not decorative: the foreign key by which both the agent and its whole
swarm keep treating the successor as the same node across the boundary. Across this strand the
pattern is consistent: continuity is measured as identity stability or proposed architecturally, while
the one mechanism we contribute — same-identity continuation **across a live model hot-swap**, where the
same object keeps running under a different model — is reported nowhere as a measured, deployed result.

### 2.2 Agent-memory systems (adjacent, not the same problem)

A large body of work persists facts an agent can later retrieve. **MemGPT/Letta** (Packer et al.,
arXiv:2310.08560) ships cross-model identity via a `/model` swap, but the continuity is database-
persisted facts that a **fresh agent retrieves** (LoCoMo retrieval ≈74%); it is not same-object
continuation. **Mem0** (arXiv:2504.19413) and **Zep/Graphiti** (arXiv:2501.13956) are model-agnostic
memory layers evaluated by retrieval/judge accuracy (LOCOMO, DMR, LongMemEval) with no mid-task model
swap. These systems answer "can a later agent look up what an earlier one knew?"; rebirth answers
"can the *same* run keep going past the context ceiling, under a possibly different model, without
losing the task?" We therefore explicitly **do not** claim to be the first cross-model memory system —
Letta predates us — and instead claim same-object, mid-task continuity, measured. **CALMem** (Jena et al., arXiv:2605.20724) articulates the problem precisely: "compaction discards history irreversibly; when sessions end, all memory resets to zero" — and responds with an application-layer dual-memory architecture (episodic sliding-window embeddings plus agent-writable structured facts) that keeps effective context unbounded without model modification. It is a close neighbor in motivation; the difference is that CALMem reconstructs relevant history via retrieval on each turn, whereas rebirth continues the *same session object* with a curated handoff package that carries forward the task's irrecoverable in-flight state. Recent scale-conditioned memory evaluation (**arXiv:2605.07313**) and peer-reviewed memory benchmarks
(**MemoryAgentBench** 2507.05257; **AMA-Bench** 2602.22769) reinforce the gap: they evaluate stored-
evidence usability as sessions accumulate, and they do not evaluate cross-model handoff.

### 2.3 Context compaction and long-horizon serving

The mechanism rebirth competes with is **summarization-based compaction**. **Parallel Context
Compaction for Long-Horizon LLM Agent Serving** (arXiv:2605.23296) states the problem precisely:
compaction keeps a conversation bounded but is "inherently lossy," and the blocking summarization call
"stalls agent inference for tens of seconds."

A growing strand makes compaction *agentic* rather than passive: **Active Context Compression** (Verma, arXiv:2601.07190) has the agent itself initiate and steer compression; **Context as a Tool** (Liu et al., arXiv:2512.22087) exposes context operations as explicit tools a SWE agent invokes; **Learning Agent-Compatible Context Management (AdaCoM)** (arXiv:2605.30785) learns agent-compatible management policies; and curation can be trained with RL (Li et al., arXiv:2604.11462). This is the strongest version of the foil — compaction with agency — and it sharpens what rebirth is not: in every variant the operation rewrites the transcript in place, and the agent then reasons over the rewritten artifact. Rebirth changes the *object* of preservation — the successor's prefix is assembled from the system's canonical state, not from any model's rendering of the conversation. Agency over a lossy operation does not make the operation lossless.

A sharper empirical result
narrows what compaction actually buys: **The Complexity Trap** (Lindenbauer et al., arXiv:2508.21433)
shows that for software-engineering agents (OpenHands, Cursor), simply *masking* old observations is as
efficient as — and often better than — expensive LLM summarization, at a fraction of the cost. The lesson
is directly ours: the value of bounding context comes from *removing noise*, not from an elaborate
distillation, which is why a curated package can be small and still lose nothing that matters. **ReSum**
(Wu et al., arXiv:2509.13313) makes the reset itself the lever — periodic summarize-and-reset lets a web
agent explore past the context wall that bounds an un-reset ReAct loop — a reset-neighbor whose gains
foreshadow our sawtooth. **Slipstream** (Chen et al., arXiv:2605.08580) sharpens the same diagnosis —
compaction "runs synchronously on the critical path" with a "structural validation gap," since the
compactor cannot know what the agent will later need — and mitigates it by running compaction
*asynchronously* and validating the candidate summary against the agent's continued reasoning, checking
that it preserves "the agent's forward intent." That last criterion is the compaction literature reaching,
after the fact, for the intent-preservation a rebirth package is built to carry up front.

A convergent 2026 result sharpens the diagnosis from *lossy* to *measurably inferior* — and, tellingly,
arrives at rebirth's own answer. **ComprExIT** (Ye et al., arXiv:2602.03784) finds LLM-as-a-compressor
methods "remain noticeably inferior to using the full context," tracing the gap to "their inability to
preserve contextual information"; **E-mem** (Wang et al., arXiv:2601.21714) names the failure "destructive
de-contextualization" — compressing sequential dependencies into pre-defined structures "severs the
contextual integrity essential for deep reasoning"; and **ContextWeaver** (Wu et al., arXiv:2604.23069) shows
prompt compression "may omit earlier structured information that later steps rely on." A fourth convergent line is **Contextual Memory Virtualisation (CMV)** (Santoni, arXiv:2602.22402), which names exactly what compaction costs — "architectural mappings, trade-off decisions, codebase conventions" accumulate in-session and are lost when the context limit triggers lossy compaction — and responds with a DAG-based state model and a "structurally lossless trimming" algorithm that strips mechanical bloat while preserving every message verbatim. The telling part is
the response: all four abandon lossy summarization for **structured preservation or reconstruction** (explicit
information transmission, uncompressed episodic memory, dependency-structured traces, lossless-trim DAG state). Four independent
groups converged on the conclusion rebirth encodes — *do not summarize the transcript into a lossy blob;
preserve its structure and re-derive on demand* — which is exactly the package's deterministic structured
extraction (§3.2) standing in for an LLM re-interpretation. (We cite these for their motivating findings;
none runs a head-to-head against a same-identity rebirth handoff, which the literature does not contain.)

The closest paper to the *serial compaction* failure mode is **Meta-Cognitive Memory Policy Optimization
for Long-Horizon LLM Agents** (Liu et al., arXiv:2605.30159). It studies memory-augmented agents whose
trajectories are recursively summarized into compact memory, and states the degradation channel in exactly
the form our chained-compaction arm isolates: as interactions unfold, recursive summaries can discard
task-relevant information and introduce semantic noise, pushing the agent's belief away from the latent task
state. A second long-horizon agent result, **Scaling Long-Horizon LLM Agent via Context-Folding** (Sun et
al., arXiv:2510.11967), reports that an active context-folding agent significantly outperforms
summarization-based context-management baselines on Deep Research and SWE tasks while using a much smaller
active context. These papers lower the burden for treating summary-of-summary memory as a serious incumbent
risk. They do **not** prove that rebirth beats chained compaction on this substrate; they justify why §8.7
is the right direct test and why §5.8.2's single-shot parity is the best-case compaction comparison, not the
end of the story.

This literature is our
**foil**: rebirth replaces an in-place, lossy, blocking summarization of the *transcript* with a
boundary that hands a successor a curated **package** — lossy in bytes by construction, but designed to
be loss*less in intent* — and it is precisely the per-turn cost of these two strategies that our cost
model (§9) parameterizes. The OS-level framing this field keeps reaching toward — context management as a virtual memory problem — has been made explicit by **The Missing Memory Hierarchy** (Mason, arXiv:2603.09023), which implements demand paging for LLM context windows and measures 21.8% structural waste across 857 production sessions; our mechanism operates at the application layer rather than the proxy/serving layer, but the systems diagnosis is shared. The industry's informal version of the same idea — Anthropic's long-running-agent harness writing a `claude-progress.txt` for a successor — is an unmeasured precedent we cite
directly; we provide the measurement it lacks.

### 2.4 Failure recovery and checkpoint/restore

Our recovery metric (§5) has neighbors in agent-reliability work. **MTTR-A** (arXiv:2511.20663)
introduces a Mean Time-to-Recovery for agentic systems — how quickly distributed reasoning recovers
once coherence is lost — which parallels our **re-establishment cost** (median ≈1 turn, ≈5 minutes, 2
reorientation tool-calls) but measures latency of self-correction rather than completion of a carried
intent. **DART** (arXiv:2605.23311) studies semantic recoverability when a structured tool agent fails
mid-execution, weighing full replay against checkpoint restore — the same replay-versus-restore tension
rebirth resolves by carrying intent rather than bytes — and **Robust Agent Compensation** (RAC,
arXiv:2605.03409) adds log-based recovery as a framework extension. Rebirth differs by being a
*planned, routine, identity-preserving* boundary rather than a fault-recovery exception, and by
recovering an **interrupted human or agent intent**, not just a crashed tool call.

### 2.5 The long-context degradation tax (why a bounded prefix is desirable)

The four bodies above are neighbors we position *against*; a fifth literature is one we build *on*. It
explains why a bounded prefix is desirable on the *quality* axis, not only the cost axis — and it is the
foundation under this paper's affirmative argument that rebirth is **better** than compaction, not merely
non-inferior to it. The premise both incumbents share — keep the agent reasoning inside a large context,
whether grown or summarized in place — is itself taxed. **Context Length Alone Hurts LLM Performance
Despite Perfect Retrieval** (Du et al., arXiv:2510.05381) is the load-bearing result: with retrieval held
at perfect, answer quality still drops 13.9–85% as input length grows, so the long context *itself* is the
cost — not a failure to find the needle. **Intelligence Degradation in Long-Context LLMs** (Wang et al.,
arXiv:2601.15300) quantifies the same effect as a >30% (F1 −45.5%) collapse at 40–50% of a model's maximum
length *even when every token stays relevant*. The positional and effective-window literature — **Lost in
the Middle** (Liu et al., arXiv:2307.03172) and **RULER** (Hsieh et al., arXiv:2404.06654) — shows
attention underweights the middle of long inputs and that the usable window runs far below the advertised
one. And the effect is documented on the exact artifact rebirth bounds: **Classifier Context Rot** (Martin
et al., arXiv:2605.12366) finds frontier models miss salient events 2–30× more often in >800K-token *agent
transcripts* — long agent logs lose fidelity that short ones retain. **LongDS-Bench** (Xu et al.,
arXiv:2605.30434) shows the same state-maintenance bottleneck in long-horizon agentic data analysis: the
best evaluated model reaches only 48.45% average accuracy, performance falls by nearly 47 points from early
to late turns, and long-horizon state errors account for most failures. The common thread is not retrieval
alone; it is keeping a correct evolving task state alive across a long interaction.

A sharper strand shows the discarded bytes do not merely dilute, they actively *harm*. **Contextual Drag**
(Cheng et al., arXiv:2602.04288) finds that the presence of failed attempts in the context biases
subsequent generations toward structurally similar errors (10–20% drops, with self-deterioration under
iterative refinement), and **Large Language Models Can Be Easily Distracted by Irrelevant Context** (Shi
et al., arXiv:2302.00093) shows irrelevant tokens degrade reasoning rather than being harmlessly ignored.
At multi-agent scale, the same conditional effect appears in **When Context Hurts** (Vigraham et al., arXiv:2605.04361): across 2,700 multi-agent design runs, the same artifact type improves exploration up to 20× on some tasks and degrades it by up to 46% on others; an irrelevant document sometimes matches every relevant artifact, and direction is predicted by baseline exploration (r = −0.82). Inter-agent context transfer is conditional, which is part of why §6.1 and §8.5 argue for a curated, bounded package rather than maximal injection.
This is the mechanistic reason a clean reset can *beat* continuation: a bloated turn full of abandoned
approaches exerts gravitational pull back toward the ruts the agent already failed in, and the only way to
remove that pull is to leave the context behind — which compaction, summarizing the same transcript in
place, does not fully do.

A complementary literature explains why the *form* of the bounded prefix matters, not only its length, and
it is the one that most directly licenses the analogy at the center of our mechanism (§3.6).
Retrieval-augmented generation reduces hallucination by grounding a model's output in authoritative
*external* evidence rather than its lossy internal recall — an effect named outright by **Retrieval
Augmentation Reduces Hallucination in Conversation** (Shuster et al., arXiv:2104.07567) and confirmed at
benchmark scale by **RAGTruth** (Niu et al., arXiv:2401.00396), which calls retrieval grounding "a main
technique for alleviating hallucinations." The benefit is real but *conditional*, and the honest reading is
what makes it useful to us: RAG fails in exactly two ways — **bad retrieval**, where erroneous or biased
evidence *compounds* hallucination (**Debate-Augmented RAG**, Hu et al., arXiv:2505.18581), and
**unfaithfulness**, where the model ignores good evidence and reverts to parametric memory (**FaithfulRAG**,
Zhang et al., arXiv:2506.08938). This is the strand §3.6 builds on: a rebirth package is *retrieval-grounded
continuation* — the successor's prefix is assembled by retrieving the system's own authoritative state —
whereas summarization-based compaction is *summary-grounded continuation*, reasoning over a generated, lossy
artifact that can itself confabulate. The grounded-vs-ungrounded faithfulness gap RAG documents is the
mechanism behind our affirmative argument, and rebirth structurally dodges RAG's dominant failure mode (bad
retrieval) because it retrieves canonical own-state rather than a noisy corpus (§3.6). As with the
degradation literature, we import this as **motivation and mechanism, not as a measured effect on our
substrate** (§11.11).

We are deliberate about how this literature is used, because it cuts toward a claim our own honesty rules
(§4.10, §11) forbid us to assert prematurely. It is cited here as **(i) motivation** — a bounded prefix is
intrinsically desirable, which is why the sawtooth is worth building — and as **(ii) a pre-registered
directional hypothesis** for the §8 fork: the no-rebirth arm carries a long, possibly drag-laden context
at the cut point, so the literature predicts rebirth *may* be not just non-inferior but superior, and §8.1
registers that as a secondary outcome called in advance rather than post-hoc. It is **not** cited as
evidence that we have already shown superiority; our measured headline remains non-inferiority (§4.10).

### 2.6 Position and novelty

We make four claims we believe are defensible and one open flag.

1. **Same-identity continuation.** Not inter-agent takeover (Handoff Debt) and not fresh-agent fact
   retrieval (Letta): the same instance object continues across the boundary, with id, file claims,
   rail cursor, and squad role preserved.
2. **A ground-truth denominator.** The no-silent-drops package manifest tells us exactly what was
   handed over, enabling a normalized intent-continuity score (§4) rather than only a one-sided cost
   delta.
3. **Deployment scale and engine diversity.** 8,717 rebirth arrivals across eight engines,
   measured live and observationally — the largest such measurement we are aware of.
4. **A cost axis.** We measure that rebirth **preserves the prompt-cache prefix** (Anthropic 94.3%
   cache-read; §6) and derive a parameterized cost model (§9), connecting continuity to serving
   economics — an axis the continuity literature does not report.

**Open flag (the peer-reviewed gap).** Every cross-model continuity result above is a preprint with
N between 50 and 724, and the peer-reviewed memory benchmarks do not evaluate cross-model handoff.
Same-identity, cross-model, mid-task continuity at deployment scale is, to our knowledge, unmeasured in
the peer-reviewed record. We position this work as preliminary evidence toward closing that gap, and we
are deliberately conservative about what our observational design can and cannot establish (§8, §11).

*Citation hygiene: every arXiv ID above is carried in `13-references.md` with a [VERIFIED] status and
notes for corrected characterizations, per the arXiv-2026 no-hallucinated-refs rule.*
