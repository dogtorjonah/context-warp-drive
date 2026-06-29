## References

*Citation hygiene (arXiv-2026 no-hallucinated-refs rule). Every arXiv ID cited in the body is listed
below with a verification status. **[VERIFIED]** = exact title, first author, and topic confirmed
against the live arXiv abstract page by direct fetch/search (2026-06-04 for the original set; 2026-06-06
for the rebirth-vs-compaction additions; 2026-06-06 for the retrieval-grounding and compaction-inferiority additions; 2026-06-07 for the KV/prefix-cache and
model-routing additions; 2026-06-09 for the recursive-summary and long-horizon-state additions; 2026-06-10 for the agentic-compaction-agency, caching-economics, and context-interference additions). **All 61
verification-labeled arXiv references listed below**
(60 `[VERIFIED]` entries plus one `[VERIFIED — corrected]` Datasheets entry) were confirmed as real,
on-topic papers; one survey-supplied ID was found wrong and corrected, two in-text characterizations
were corrected during assembly, seven references were added and verified the same way in a later
corpus-scrutiny review, twelve more were added and verified in a rebirth-vs-compaction citation pass
(notes R1–R5), four more in a retrieval-grounding pass (note R6), three more in a compaction-inferiority pass (note R7), five more in a KV/prefix-cache & model-routing pass (note R8), three more in a recursive-summary/long-horizon-state pass (note R9), and eight more in a deep-pass agentic-compaction-agency, caching-economics, and context-interference pass (note R10). First-author/short-title form is used here; full author lists are restored when this is
converted to a real `.bib` at LaTeX-packaging time.*

### Cross-model continuity & handoff (§1, §2.1)

- **[VERIFIED]** KC, D. & Budathoki, A. *Handoff Debt: The Rediscovery Cost When Coding Agents Take Over
  Interrupted Tasks.* arXiv:2606.02875 (Jun 2026). — Closest neighbor; the bar we measure against.
- **[VERIFIED]** Ravindran, S. K. *Portable Agent Memory: A Protocol for Cryptographically-Verified
  Memory Transfer Across Heterogeneous AI Agents.* arXiv:2605.11032 (May 2026). — See note R1 for the
  corrected §2.1 characterization.
- **[VERIFIED]** Menon, P. G. *Persistent Identity in AI Agents: A Multi-Anchor Architecture for
  Resilient Memory and Continuity.* arXiv:2604.09588 (Apr 2026).
- **[VERIFIED]** Perrier, E. *Agent Identity Evals: Measuring Agentic Identity.* arXiv:2507.17257 (2025).
- **[VERIFIED]** Perrier, E. *Time, Identity and Consciousness in Language Model Agents* (Stack Theory;
  AAAI 2026 Spring Symposium). arXiv:2603.09043 (Mar 2026).
- **[VERIFIED]** Otsuka, T., Toyoda, K. & Leung, A. *AI Identity: Standards, Gaps, and Research Directions
  for AI Agents.* arXiv:2604.23280 (Apr 2026). — Survey/gap-analysis; defines agent identity as the
  declared-vs-observed correspondence and finds no current standard governs it. Cited in §2.1.
- **[VERIFIED]** Vasilenko, V. *Identity as Attractor: Geometric Evidence for Persistent Agent
  Architecture in LLM Activation Space.* arXiv:2604.12016 (Apr 2026). — Representational evidence
  (Llama-3.1, Gemma-2) that an identity document induces attractor-like geometry. Cited in §2.1.

### Agent-memory systems (§2.2)

- **[VERIFIED]** Packer, C. et al. *MemGPT: Towards LLMs as Operating Systems.* arXiv:2310.08560 (2023).
- **[VERIFIED]** Chhikara, P. et al. *Mem0: Building Production-Ready AI Agents with Scalable Long-Term
  Memory.* arXiv:2504.19413 (2025).
- **[VERIFIED]** Rasmussen, P. et al. *Zep: A Temporal Knowledge Graph Architecture for Agent Memory.*
  arXiv:2501.13956 (2025).
- **[VERIFIED]** Shao, J. et al. *When Stored Evidence Stops Being Usable: Scale-Conditioned Evaluation
  of Agent Memory.* arXiv:2605.07313 (May 2026).
- **[VERIFIED]** Hu, Y. et al. *Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions*
  (MemoryAgentBench). arXiv:2507.05257 (2025). — See note R2.
- **[VERIFIED]** Zhao, Y. et al. *AMA-Bench: Evaluating Long-Horizon Memory for Agentic Applications.*
  arXiv:2602.22769 (Feb 2026). — See note R2.
- **[VERIFIED]** Jena, R. N. et al. *CALMem: Application-Layer Dual Memory for Conversational AI.*
  arXiv:2605.20724 (May 2026). — States the problem this work shares: "compaction discards history
  irreversibly; when sessions end, all memory resets to zero"; responds with an application-layer
  dual-memory architecture (episodic sliding-window embeddings + agent-writable structured facts). Close
  neighbor in motivation; differs by reconstructing relevant history via retrieval each turn rather than
  continuing the same session object (§2.2). See note R10.

### Context compaction & long-horizon serving (§1, §2.3, §10)

- **[VERIFIED]** Cim, M., Topcu, B., Das, C. & Kandemir, M. T. *Parallel Context Compaction for
  Long-Horizon LLM Agent Serving.* arXiv:2605.23296 (May 2026). — The compaction foil; source of the
  "stalls inference for tens of seconds" claim.
- **[VERIFIED]** Verma, N. *Active Context Compression: Autonomous Memory Management in LLM Agents*
  (Focus). arXiv:2601.07190 (Jan 2026).
- **[VERIFIED]** Yi, L. *Learning Agent-Compatible Context Management for Long-Horizon Tasks* (AdaCoM).
  arXiv:2605.30785 (May 2026).
- **[VERIFIED]** Chen, Z., Pan, R., Dai, Y. & Netravali, R. *Slipstream: Trajectory-Grounded Compaction
  Validation for Long-Horizon Agents.* arXiv:2605.08580 (May 2026). — Compaction foil neighbor (§2.3):
  runs compaction asynchronously and validates that a candidate summary preserves "the agent's forward
  intent."
- **[VERIFIED]** Liu, Z. et al. *Meta-Cognitive Memory Policy Optimization for Long-Horizon LLM Agents.*
  arXiv:2605.30159 (May 2026). — Direct recursive-summary-memory neighbor: long-horizon agents recursively
  summarize trajectories into memory, and ambiguous recursive summaries can discard task-relevant information
  and introduce semantic noise. Cited for the serial-compaction risk and the §8.7 telephone design; not a
  rebirth head-to-head. See note R9.
- **[VERIFIED]** Sun, W. et al. *Scaling Long-Horizon LLM Agent via Context-Folding.* arXiv:2510.11967
  (2025). — Reports a context-folding agent matching/outperforming ReAct while using a much smaller active
  context and significantly outperforming summarization-based context-management baselines. Cited as an
  external motivation for testing chained compaction directly (§2.3, §5.8, §8.7). See note R9.
- **[VERIFIED]** Lindenbauer, T. et al. *The Complexity Trap: Simple Observation Masking Is as Efficient
  as LLM Summarization for Agent Context Management.* arXiv:2508.21433 (2025). — For SE agents
  (OpenHands/Cursor), simply masking old observations matches or beats expensive LLM summarization at
  lower cost; independent corroboration that the value is in *removing noise*, not elaborate distillation
  — i.e. "curate the working set, don't summarize the transcript" (§2.3, §10.2).
- **[VERIFIED]** Wu, X. et al. *ReSum: Unlocking Long-Horizon Search Intelligence via Context
  Summarization.* arXiv:2509.13313 (2025). — Periodic summarize-and-reset lets a web agent explore past a
  context wall that bounds ReAct (+4.5%); a reset-neighbor showing the sawtooth benefit in others' results
  (§2.3).
- **[VERIFIED]** Ye, J., Yan, H., Shen, Z., Chang, H., Mao, Y. & He, Y. *Fix the Structural Bottleneck:
  Context Compression via Explicit Information Transmission* (ComprExIT). arXiv:2602.03784 (Feb 2026). —
  Finds LLM-as-a-compressor methods "remain noticeably inferior to using the full context" because of "their
  inability to preserve contextual information" — the spine of the §2.3 claim that summarization-compaction
  loses task-relevant signal, not just bytes. See note R7.
- **[VERIFIED]** Wang, K., Lin, Y., Lou, J., Zhou, Z., Suvonov, B. & Li, J. *E-mem: Multi-agent based
  Episodic Context Reconstruction for LLM Agent Memory.* arXiv:2601.21714 (Jan 2026). — Names compression's
  failure "destructive de-contextualization": compressing sequential dependencies into pre-defined
  structures "severs the contextual integrity essential for deep reasoning." Answers with uncompressed
  episodic reconstruction — convergent with rebirth's preserve-and-re-derive (§2.3, §3.2).
- **[VERIFIED]** Wu, Y., Zhang, Y., Ghosh, S., Basu, S., Deoras, A., Huan, J. & Gupta, G. *ContextWeaver:
  Selective and Dependency-Structured Memory Construction for LLM Agents.* arXiv:2604.23069 (Apr 2026). —
  Prompt compression "may omit earlier structured information that later steps rely on"; builds a
  dependency-structured trace instead — a third independent 2026 group choosing structure-preservation over
  summarization (§2.3).
- **[VERIFIED]** Santoni, C. *Contextual Memory Virtualisation: DAG-Based State Management and
  Structurally Lossless Trimming for LLM Agents* (CMV). arXiv:2602.22402 (Feb 2026). — Names exactly
  what compaction costs: "architectural mappings, trade-off decisions, codebase conventions" are lost at
  the context limit; responds with DAG-based state and a "structurally lossless trimming" algorithm that
  preserves every message verbatim. Fourth independent group converging on structure-preservation over
  summarization (§2.3). See note R10.
- **[VERIFIED]** Liu, S. et al. *Context as a Tool: Context Management for Long-Horizon SWE-Agents*
  (CAT). arXiv:2512.22087 (Dec 2025). — Elevates context management to a callable tool in the agent's
  decision loop; active-compaction-agency strand (§2.3). See note R10.
- **[VERIFIED]** Li, X. et al. *Escaping the Context Bottleneck: Active Context Curation for LLM Agents
  via Reinforcement Learning.* arXiv:2604.11462 (Apr 2026). — RL-trained ContextCurator decoupled from
  TaskExecutor; curation can be trained with RL, active-compaction-agency strand (§2.3). See note R10.
- **[VERIFIED]** Wu, Y. et al. *ContextBudget: Budget-Aware Context Management for Long-Horizon Search
  Agents* (BACM-RL). arXiv:2604.01664 (Apr 2026). — Formulates context management as a sequential
  decision problem under a token budget constraint with curriculum RL; complements the §9 steady-state
  cost model (budget-constrained compression within a window vs. unbounded-session prefix bound). See
  note R10.
- **[VERIFIED]** Mason, T. *The Missing Memory Hierarchy: Demand Paging for LLM Context Windows.*
  arXiv:2603.09023 (Mar 2026). — Frames the context window as L1 cache in an absent memory hierarchy;
  implements demand paging with a measured 0.025% fault rate and 21.8% structural waste across 857
  production sessions. Systems-level diagnosis shared with §2.3; our mechanism operates at the
  application layer. See note R10.

### Long-context degradation & contextual interference (§1, §2.5, §3.6, §5.7, §10.2)

- **[VERIFIED]** Du, Y. et al. *Context Length Alone Hurts LLM Performance Despite Perfect Retrieval.*
  arXiv:2510.05381 (2025). — Even when retrieval is perfect, reasoning degrades 13.9–85% as input length
  grows; the load-bearing cite that the *long context itself* is the cost (not a retrieval failure),
  grounding §2.5, the §3.6 over-determination argument, and the §10.2 quality axis.
- **[VERIFIED]** Wang, W. et al. *Intelligence Degradation in Long-Context LLMs: Critical Threshold
  Determination via Natural Length Distribution Analysis.* arXiv:2601.15300 (Jan 2026). — Catastrophic
  collapse (>30% task drop; F1 −45.5%) at 40–50% of the maximum context length, *even when information
  stays relevant* (§2.5, §10.2).
- **[VERIFIED]** Liu, N. F. et al. *Lost in the Middle: How Language Models Use Long Contexts.*
  arXiv:2307.03172 (2023). — Canonical positional degradation: mid-context information is underweighted
  (§2.5).
- **[VERIFIED]** Hsieh, C.-P. et al. *RULER: What's the Real Context Size of Your Long-Context Language
  Models?* arXiv:2404.06654 (2024). — Effective context window ≪ advertised window; supports the sawtooth
  keeping the per-turn prefix in the good regime (§2.5).
- **[VERIFIED]** Martin, S. et al. *Classifier Context Rot: Monitor Performance Degrades with Context
  Length.* arXiv:2605.12366 (May 2026). — Frontier models miss dangerous actions 2–30× more often in
  >800K-token *agent transcripts* — the exact long-transcript fidelity loss the sawtooth bounds (§2.5,
  §5.7).
- **[VERIFIED]** Xu, K. et al. *LongDS-Bench: On the Failure of Long-Horizon Agentic Data Analysis.*
  arXiv:2605.30434 (May 2026). — Long-horizon agentic data-analysis benchmark; best model reaches only
  48.45% average accuracy, drops nearly 47 points from early to late turns, and long-horizon errors account
  for 52%--69% of failures. Cited for the state-maintenance bottleneck (§2.5). See note R9.
- **[VERIFIED]** Cheng, Y. et al. *Contextual Drag: How Errors in the Context Affect LLM Reasoning.*
  arXiv:2602.04288 (Feb 2026). — Failed attempts in the context bias subsequent generations toward
  structurally similar errors (10–20% drops, self-deterioration under iterative refinement); the
  mechanism by which a clean reset can *beat* continuation (§2.5, §8.1, §10.2).
- **[VERIFIED]** Shi, F. et al. *Large Language Models Can Be Easily Distracted by Irrelevant Context.*
  arXiv:2302.00093 (2023). — Irrelevant tokens degrade reasoning, not just slow it; companion to
  contextual drag (§2.5).
- **[VERIFIED]** Vigraham, S. et al. *When Context Hurts: Examining the Dual Role of Retrieved Context
  in Multi-Agent Systems.* arXiv:2605.04361 (May 2026). — Crossover effect across 2,700 multi-agent
  design runs: same artifact type improves exploration up to 20× on some tasks, degrades it up to 46%
  on others; an irrelevant document sometimes matches every relevant artifact; direction predicted by
  baseline exploration (r = −0.82). Grounds §6.1/§8.5 curated-package rationale. Pre-verified
  2026-06-10, golden-sphinx (log #31). See note R10.

### Context selection, retrieval & package design (§3.6, §6.1, §7, §8.5)

- **[VERIFIED]** Li, X. et al. *Long Context vs. RAG for LLMs: An Evaluation and Revisits.*
  arXiv:2501.01880 (2025). — Selective retrieval matches or beats stuffing the window; grounds §3.6's
  "the successor *pages* state on demand rather than carrying it" as the RAG-vs-long-context result
  applied to handoff.
- **[VERIFIED]** Yang, C. et al. *What Prompts Don't Say: Understanding and Managing Underspecification in
  LLM Prompts.* arXiv:2505.13360 (2025). — Under-specified prompts are 2× as likely to regress, and the
  regression is specifically *across model or prompt changes* (>20% drops); grounds the lean-package floor
  (§6.1, §8.5) and predicts the hot-swap sensitivity of a too-thin package (§7).
- **[VERIFIED]** Ye, Z. et al. *Look Before You Leap: Autonomous Exploration for LLM Agents.*
  arXiv:2605.16143 (May 2026). — Agents fail from *premature exploitation* — acting on prior knowledge
  before acquiring environment-specific information; grounds the §3.6 stale-state realization condition
  and the upper edge of the package-size band (a too-rich package invites action on stale conclusions).

### Retrieval grounding & faithfulness (§2.5, §3.6, §10.2)

- **[VERIFIED]** Shuster, K., Poff, S., Chen, M., Kiela, D. & Weston, J. *Retrieval Augmentation Reduces
  Hallucination in Conversation.* arXiv:2104.07567 (2021). — Canonical result that grounding generation in
  retrieved external evidence substantially reduces hallucination versus parametric recall; grounds the
  §3.6 "package as retrieval-grounded continuation" framing and the §10.2 fidelity axis.
- **[VERIFIED]** Niu, C. et al. *RAGTruth: A Hallucination Corpus for Developing Trustworthy
  Retrieval-Augmented Language Models.* arXiv:2401.00396 (2023, rev. 2024). — Confirms retrieval grounding is
  "a main technique for alleviating hallucinations," *and* documents the residual unsupported/contradictory
  claims that persist — i.e. the benefit is real but conditional (§2.5, §10.2).
- **[VERIFIED]** Hu, W. et al. *Removal of Hallucination on Hallucination: Debate-Augmented RAG.*
  arXiv:2505.18581 (2025; ACL 2025). — RAG's first failure mode: erroneous/biased retrieval *compounds*
  hallucination — the failure rebirth structurally sidesteps by retrieving authoritative own-state rather
  than a noisy corpus (§2.5, §3.6).
- **[VERIFIED]** Zhang, Q. et al. *FaithfulRAG: Fact-Level Conflict Modeling for Context-Faithful
  Retrieval-Augmented Generation.* arXiv:2506.08938 (2025). — RAG's second failure mode: models ignore good
  retrieved context and revert to parametric memory — a faithfulness risk rebirth shares with every
  context-management strategy (§2.5, §3.6).

### Prefix-cache serving economics (§6, §9)

- **[VERIFIED]** Lumer, A. et al. *Don't Break the Cache: Evaluating Prompt Caching Strategies for
  Multi-Turn Agentic LLM Applications.* arXiv:2601.06007 (Jan 2026). — First systematic evaluation of
  prompt caching for multi-turn agentic workloads; measures 41–80% API-cost and 13–31% TTFT savings
  across three providers; shows the benefit is fragile: strategies that perturb cache blocks can erase
  or even invert it. The caching-economics stakes §6.2 measures are grounded in this literature; rebirth
  extends the "don't break the cache" principle across the most disruptive session event. Pre-verified
  2026-06-10, golden-sphinx (log #31). See note R10.
- **[VERIFIED]** Gim, I. et al. *Prompt Cache: Modular Attention Reuse for Low-Latency Inference.*
  arXiv:2311.04934 (2023, rev. 2024). — Precomputes and reuses the attention states of recurring prompt
  segments (system messages, templates, shared documents); the foundational mechanism behind §6.2's
  static-prefix surviving the rebirth boundary. See note R8.
- **[VERIFIED]** Kwon, W. et al. *Efficient Memory Management for Large Language Model Serving with
  PagedAttention.* arXiv:2309.06180 (2023). — vLLM's PagedAttention manages the KV cache as paged virtual
  memory with near-zero waste and flexible sharing within and across requests; the serving substrate the
  §9.8 κ abstraction sits on top of. See note R8.
- **[VERIFIED]** Zheng, L. et al. *SGLang: Efficient Execution of Structured Language Model Programs.*
  arXiv:2312.07104 (2023, rev. 2024). — Introduces RadixAttention, which makes cross-request reuse of a
  shared prefix *automatic* — the exact mechanism that keeps the large static prefix cached across every
  turn and rebirth (§6.2, §9.8), and the "radix prefix cache" the agentic-serving work below extends. See
  note R8.
- **[VERIFIED]** Norgren, V. *Stateful Inference for Low-Latency Multi-Agent Tool Calling.*
  arXiv:2605.26289 (May 2026). — The serving-side sibling to §9: "85–95% of the prompt is unchanged,"
  converting per-turn O(n) serving compute into an O(Δ) delta-only KV cache. κ abstracts the billing
  surface; this paper attacks the serving/KV-reuse layer underneath it.
- **[VERIFIED]** Ma, B., Eitzinger, J. & Koestler, H. *Leyline: KV Cache Directives for Agentic
  Inference.* arXiv:2606.01065 (May 2026). — Serving-side cache splice/trim under policy-driven context
  edits; orthogonal to and composes with the §9 context-bound P̄ lever.

### Model routing & cost-aware model selection (§10.5)

- **[VERIFIED]** Ding, D. et al. *Hybrid LLM: Cost-Efficient and Quality-Aware Query Routing.*
  arXiv:2404.14618 (2024). — A router assigns each query to a small or large model by predicted difficulty,
  with the quality level tunable at test time (up to 40% fewer large-model calls at no quality drop); the
  per-query form of the per-turn model-selection lever rebirth exposes (§10.5). See note R8.
- **[VERIFIED]** Ong, I. et al. *RouteLLM: Learning to Route LLMs with Preference Data.*
  arXiv:2406.18665 (2024, rev. 2025). — Learned routers dynamically select between a stronger and a weaker
  LLM at inference (>2× cost reduction); notably the routers transfer "even when the strong and weak models
  are changed at test time" — the routing-side echo of §7's hot-swap continuity (§10.5). See note R8.

### Failure recovery & checkpoint/restore (§2.4, §5)

- **[VERIFIED]** Or, B. *MTTR-A: Measuring Cognitive Recovery Latency in Multi-Agent Systems.*
  arXiv:2511.20663 (Nov 2025). — Recovery-latency neighbor; a structural template for this paper.
- **[VERIFIED]** Yang, K. et al. *DART: Semantic Recoverability for Structured Tool Agents.*
  arXiv:2605.23311 (May 2026).
- **[VERIFIED]** Perera, S. et al. *Robust Agent Compensation (RAC): Teaching AI Agents to Compensate.*
  arXiv:2605.03409 (May 2026).

### Method & datasheet (§4, Appendix A)

- **[VERIFIED]** Kearns, R. O. et al. *Quantifying Construct Validity in Large Language Model
  Evaluations.* arXiv:2602.15532 (Feb 2026). — Construct-validity framing for §4.
- **[VERIFIED — corrected]** Gebru, T., Morgenstern, J., Vecchione, B., Vaughan, J. W., Wallach, H.,
  Daumé III, H. & Crawford, K. *Datasheets for Datasets.* arXiv:**1803.09010** (2018). — Datasheet
  template (Appendix A). The survey seed listed a wrong arXiv ID (a paper unrelated to datasheets), which
  was corrected this session. See note R3.

### Terminology disambiguation (§3)

- **[VERIFIED]** Agarwal, R., Schwarzer, M., Castro, P. S., Courville, A. & Bellemare, M. G.
  *Reincarnating Reinforcement Learning: Reusing Prior Computation to Accelerate Progress.*
  arXiv:2206.01626 (2022). — Source of the RL term "reincarnation" (reuse prior computation, not tabula
  rasa); §3 distinguishes "rebirth" from it.
- **[VERIFIED]** Formanek, C., Tilbury, C. R., Shock, J., Tessera, K. & Pretorius, A. *Selective
  Reincarnation: Offline-to-Online Multi-Agent Reinforcement Learning.* arXiv:2304.00977 (2023). —
  Multi-agent reincarnation; same RL sense disambiguated in §3.

### Non-arXiv / informal precedents

- Anthropic. *Claude Code / long-running-agent harness* — the `claude-progress.txt` successor
  progress-file pattern. Informal industry precedent (no paper); cited in §1 and §2.3 as the unmeasured
  practice this work measures.
- `brain-mcp` (this work) — a portable rebirth wrapper over the vanilla Claude Code CLI; described in §3.
  Software artifact, not a publication.

---

### Verification notes (honest status)

- **R1 — §2.1 in-text correction.** §2.1 previously stated that Ravindran (2605.11032) "defines a Task
  Continuity Score … on 50 tasks across Claude-3.5, GPT-4-Turbo, and Gemini-1.5-Pro, reporting TCS of
  0.83–0.92." The verified paper defines **no such metric**: it is a protocol for
  cryptographically-verified memory transfer (Merkle-DAG provenance, capability-based access control,
  injection-resistant rehydration), demonstrated across GPT-4/Claude/Gemini/Llama with a 54-test
  reference SDK. The body now describes the paper's real contribution.
- **R2 — §2.2 wording correction.** Neither MemoryAgentBench (2507.05257) nor AMA-Bench (2602.22769)
  evaluates cross-model handoff; §2.2 now says "do not evaluate cross-model handoff" rather than
  the previous stronger wording.
- **R3 — Datasheets ID corrected.** The seed list supplied a wrong arXiv ID, unrelated to datasheets, for
  Gebru et al. *Datasheets for Datasets*; the real ID is **1803.09010** (2018), confirmed by search. The
  bad ID has been removed.
- **R4 — Review additions (corpus-scrutiny pass, 2026-06-04).** Seven references were added after assembly
  during an adversarial review against the local AI arXiv corpus (~620K paper rows): the prefix-cache serving pair
  (2605.26289, 2606.01065) placing the §9 cost model in its serving-economics context; the Slipstream
  compaction foil (2605.08580); the reincarnation-RL disambiguation pair (2206.01626, 2304.00977); and two
  identity-strand entries (2604.23280, 2604.12016). Each was confirmed real, exact-title, and on-topic
  against both the corpus and the live arXiv abstract page (with first author) on 2026-06-04 — the same
  standard as the originals. The earlier "17 body-cited" figure counted only the §2 related-work set; that
  pass brought the running total to 26 verification-labeled arXiv references. Final human verification
  remains an external review gate.
- **R5 — Rebirth-vs-compaction citation pass (2026-06-06).** Twelve references were added to support the
  affirmative argument that rebirth *dominates* compaction (not merely matches it) and to place citation
  markers across the full paper: the long-context degradation cluster (2510.05381, 2601.15300, 2307.03172,
  2404.06654, 2605.12366, 2602.04288, 2302.00093), establishing that a bounded prefix is intrinsically
  better, not only cheaper; two compaction neighbors (2508.21433, observation-masking ≈ summarization;
  2509.13313, ReSum summarize-and-reset); and the package-design/retrieval set (2501.01880, 2505.13360,
  2605.16143). Each was confirmed exact-title, first-author, and on-topic against **both** the local AI
  arXiv corpus and the live arXiv abstract page on 2026-06-06 — the same standard as the originals,
  bringing the total to 38 verification-labeled arXiv references. Final human verification remains an
  external review gate.
- **R6 — Retrieval-grounding citation pass (2026-06-06).** Four references were added to support the §3.6
  reframing of the rebirth package as *retrieval-grounded continuation* (RAG over the agent's own
  authoritative state) and the §10.2 fidelity axis: the canonical retrieval-reduces-hallucination result
  (2104.07567, Shuster et al.) and the RAGTruth corpus (2401.00396, Niu et al.) for the grounded-vs-ungrounded
  benefit, plus the two documented RAG failure modes — bad retrieval *compounding* error (2505.18581, Hu et
  al.) and context-*unfaithfulness* (2506.08938, Zhang et al.) — used to scope the analogy honestly: rebirth
  dodges the first by construction (it retrieves canonical own-state, not a noisy corpus), and shares the
  second with every context strategy. Each was confirmed exact-title, first-author, and date against the
  **live arXiv abstract page by direct fetch** on 2026-06-06 and cross-checked against the local AI arXiv
  corpus — the same standard as the originals — bringing the total to **42**. The analogy is imported as
  mechanism, not as a measured effect on our substrate (§11.11). Final human verification remains an
  external review gate.
- **R7 — Compaction-inferiority citation pass (2026-06-06).** Three references were added to §2.3 to sharpen
  the anti-compaction case from "lossy" to **measurably inferior on task-relevant information**, and to record
  the convergent 2026 finding that independent groups abandoned LLM-summarization for structured
  preservation/reconstruction — the same insight rebirth's deterministic structured extraction encodes (§3.2).
  ComprExIT (2602.03784, Ye et al.): LLM-compressors "noticeably inferior to using the full context" from
  "inability to preserve contextual information." E-mem (2601.21714, Wang et al.): compression causes
  "destructive de-contextualization." ContextWeaver (2604.23069, Wu et al.): compression "omit[s] earlier
  structured information that later steps rely on." Each was confirmed exact-title, first-author, and date
  against the **live arXiv abstract page by direct fetch** on 2026-06-06 and cross-checked against the local
  AI arXiv corpus — the same standard as the originals — bringing the total to **45**. HONEST SCOPE: all three
  propose their *own* context-management methods; we cite their **motivating findings** (summarization loses
  structured information), not a head-to-head against a rebirth handoff, which the literature does not contain.
  Final human verification remains an external review gate.
- **R8 — KV/prefix-cache foundations & model-routing pass (2026-06-07).** Five references were added to
  ground two claims that previously rested on assertion or on 2026 agentic-serving neighbors alone.
  *Prefix-cache foundations* (§6.2, §9.8): **Prompt Cache** (2311.04934, Gim et al.) for the static-segment
  attention reuse behind §6.2's cache survival, and the two now-standard serving systems
  **PagedAttention/vLLM** (2309.06180, Kwon et al.) and **RadixAttention/SGLang** (2312.07104, Zheng et al.)
  as the machinery underneath §9.8's κ abstraction — the mechanisms the Norgren (2605.26289) and Leyline
  (2606.01065) agentic work specializes. *Model routing* (§10.5): **Hybrid LLM** (2404.14618, Ding et al.)
  and **RouteLLM** (2406.18665, Ong et al.) for the per-turn model-selection lever, positioned as the
  per-query routing the literature optimizes versus rebirth's per-turn-under-one-identity form; RouteLLM's
  transfer "when the strong and weak models are changed at test time" is cited as the routing-side echo of
  the §7 hot-swap result. Each was confirmed exact-title, first-author, and date against the **live arXiv
  abstract page by direct fetch** on 2026-06-07, bringing the total to **50** verification-labeled arXiv
  references. HONEST SCOPE: these are imported as *mechanism and motivation* — the foundational caching
  systems and the routing methods are not run on this paper's substrate; we cite them to place the κ
  abstraction (§9) and the model-selection lever (§10.5) in their established serving/routing literatures.
  Final human verification remains an external review gate.
- **R9 — Recursive-summary and long-horizon-state pass (2026-06-09).** Three references were added after the
  serial-compaction design review. **MMPO** (2605.30159, Liu et al.) is the closest direct neighbor for
  recursive summary memory: it explicitly motivates optimization by the risk that recursive summaries discard
  task-relevant information and introduce semantic noise as interactions unfold. **Context-Folding**
  (2510.11967, Sun et al.) reports significant gains over summarization-based context-management baselines on
  long-horizon agent tasks while using a smaller active context. **LongDS-Bench** (2605.30434, Xu et al.) adds
  a state-maintenance benchmark where long-horizon errors dominate failures. Each was confirmed exact-title,
  first-author, date, and abstract-topic against the **live arXiv export API** on 2026-06-09 using
  `citation-verify`. HONEST SCOPE: these papers justify treating serial compaction as a serious risk and
  motivate the §8.7 telephone test; they are **not** evidence that rebirth has already beaten chained
  compaction on this substrate.
- **R10 — Deep-pass agentic-compaction-agency, caching-economics, and context-interference pass (2026-06-10).** Eight references were added following a deep-pass audit of the literature gap map (research-log rebirth-continuity-paper #31). *Agentic-compaction-agency cluster (§2.3):* the single-sentence treatment of the active-strand foil was replaced with a full paragraph covering the four papers that make compaction agentic — **Active Context Compression** (2601.07190, Verma, already cited from R5), **Context as a Tool** (2512.22087, Liu et al.), **AdaCoM** (2605.30785, Yi, already cited from R7), and RL-based curation (2604.11462, Li et al.) — plus the sharp closing argument that agency over a lossy operation does not make the operation lossless. **CMV** (2602.22402, Santoni) was added as the fourth independent group choosing structure-preservation over summarization; the §2.3 convergence paragraph now reads "Four independent groups." *Caching economics (§6.2, §9.8):* **Don't Break the Cache** (2601.06007, Lumer et al.) was added as the primary literature anchor for §6.2's cache-survival result and §9.8's billing model, establishing the caching-economics stakes the rebirth result sits within. *Context interference (§2.5):* **When Context Hurts** (2605.04361, Vigraham et al.) was added to the harm strand, grounding the curated-package rationale with the crossover-effect evidence at multi-agent scale. *Adjacent-memory (§2.2):* **CALMem** (2605.20724, Jena et al.) added as a close-in-motivation neighbor whose problem statement ("compaction discards history irreversibly; sessions reset to zero") is quotable. *Cost model (§9.7):* **ContextBudget** (2604.01664, Wu et al.) added as a budget-constrained-compression complement to the steady-state ratio analysis. *Systems framing (§2.3):* **The Missing Memory Hierarchy** (2603.09023, Mason) added for the demand-paging/L1-cache diagnosis the compaction literature reaches toward. All 8 IDs confirmed exact-title, first-author, date, and abstract-topic via `citation-verify verify_arxiv` on 2026-06-10; 2601.06007 and 2605.04361 additionally pre-verified via live arXiv page fetch (full abstract) and logged in research-log #31 on 2026-06-10. **Dropped candidates:** *Chimera* (Ni et al., Mar 2026 — heterogeneous-serving scheduling; no argumentative gap in §9.8 beyond existing Norgren/Leyline; not cited in body) and *Traceability and Accountability in Role-Specialized Multi-Agent LLM Pipelines* (Barrak, Oct 2025 — inter-agent role pipelines; §2.1 already comprehensive; not cited in body). Neither ID is listed in the reference set since they are not body-cited. **HONEST SCOPE:** all ten added papers are cited for their **motivating findings** or as **neighbors**; none runs a head-to-head comparison against same-identity rebirth, which the literature still does not contain. This pass brings the total to **61** verification-labeled arXiv references.

- **Surveyed but not cited.** Several survey neighbors are intentionally **not** load-bearing to the
  argument and are omitted from both the body and this list (e.g. RE-TRAC, plus other
  entries in the working prior-art notes). They are not referenced and are not verified here.
- **Provenance.** IDs were surfaced by the step-2 prior-art survey (three agents) plus a semantic pass;
  every body-cited ID was then independently confirmed against the live arXiv abstract page on
  2026-06-04 before assembly. The final human verification is an external review gate.
