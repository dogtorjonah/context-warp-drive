/**
 * Fold Terms — tier-2 distinctive-term extraction + IDF-weighted cross-reference.
 *
 * The deferred "tier-2" of episodic recall (see foldRecall.ts ~L516-517, which
 * names term extraction as "deliberately absent in v1"). Where the existing path
 * tiers self-index WORK (the files a burst touched), this self-indexes THOUGHT —
 * pathless cognition — by its own coined vocabulary. It is pure set-intersection
 * + IDF weighting over a BOUNDED candidate set (sealed episodes / categorized
 * stars): the SAME class of operation as the path tiers, and deliberately NOT the
 * boundary corpus-search that was kill-switched in contextRebirthTool.ts
 * (L160 "Kill-switch for the rebirth-package auto-RAG injection lane" / L177
 * "auto-RAG has been injecting low-signal / noisy chunks ... contaminating
 * successor continuity"). Cross-reference is a Set and a loop; search is a model
 * and a corpus. This file is the former and must never become the latter.
 *
 * ── FENCE (load-bearing invariant — enforced by foldTermsFence.test.ts) ──
 * This module imports ONLY the pure `tokenize` helper from sparseVector.ts. It
 * MUST NOT import denseHybridRetrieval / embedStore / chunkStore / sqlite-vec /
 * HNSW or any embedding/inverted-index machinery. Crossing that line re-creates
 * the low-signal noise that got auto-RAG kill-switched.
 *
 * ── Distinctiveness model ──
 * Corpus-common JARGON (e.g. "context", "fold", "system" in this repo) is
 * suppressed by IDF at MATCH time, NOT by a static word list — a hardcoded jargon
 * list would be brittle and workspace-specific. The static stopword sets below
 * remove only GRAMMAR: generic grammatical English (STOPWORDS) and the reserved
 * keywords of programming languages (CODE_STOPWORDS). Rarity does the real work
 * for content words, and it is corpus-relative, so it self-tunes per workspace.
 *
 * ── Why CODE_STOPWORDS exists (and is NOT the jargon list the header forbids) ──
 * IDF provably CANNOT suppress programming keywords on a code-mixed corpus. A
 * keyword like `import` is corpus-RARE (most episodes are non-code), so its IDF is
 * HIGH — measured 2026-06-17 on the live store, `import` (df=36) scored a HIGHER
 * IDF than the genuinely coined term `rebirth` (df=103). Yet `import`/`let`/`const`
 * carry zero topical signal: they are the grammatical FUNCTION WORDS of code, the
 * exact analogue of English "the"/"of". They flooded term-tier recall because
 * every code-working agent's active window contains them, matching every stored
 * code episode. Reserved keywords are a CLOSED, universal, language-level set —
 * not workspace topic jargon — so filtering them is the same category as the
 * English stopword list, not the brittle domain list the header warns against.
 */
import { tokenize } from './persistence/sparseVector.ts';

/**
 * Generic-English grammatical stopwords ONLY. Corpus-common technical jargon is
 * intentionally absent here — it is suppressed by IDF at match time (see file
 * header). Keep this list to function words + contraction stems; no domain terms.
 * (Expanded 2026-06-17, rail-0ed723ef: added missing common prepositions/
 * conjunctions and `n't` contraction stems — e.g. `isn`/`doesn`/`wasn` — that
 * tokenize() emits from "isn't"/"doesn't"/"wasn't" and which were leaking into
 * term-tier recall as pseudo-distinctive fragments.)
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'of', 'a', 'an', 'and', 'or', 'to', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'am', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'he', 'she', 'him',
  'her', 'them', 'us', 'our', 'your', 'their', 'my', 'me', 'if', 'so', 'but',
  'not', 'no', 'yes', 'do', 'does', 'did', 'done', 'have', 'has', 'had', 'having',
  'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must',
  'then', 'than', 'too', 'very', 'just', 'up', 'out', 'off', 'over', 'under',
  'again', 'here', 'there', 'what', 'which', 'who', 'whom', 'how', 'why', 'when',
  'where', 'all', 'any', 'some', 'such', 'more', 'most', 'one', 'two', 'from',
  'into', 'about', 'also', 'only', 'own', 'same', 'each', 'both', 'few', 'now',
  // Prepositions/conjunctions/adverbs missing above — pure grammar, no topic.
  'against', 'between', 'among', 'through', 'throughout', 'during', 'before',
  'after', 'above', 'below', 'within', 'without', 'because', 'while', 'until',
  'unless', 'whether', 'though', 'although', 'however', 'therefore', 'otherwise',
  'instead', 'upon', 'toward', 'towards', 'per', 'via', 'still', 'yet', 'ever',
  'never', 'always', 'often', 'once', 'whose', 'whoever', 'whatever', 'whenever',
  'wherever', 'whichever', 'every', 'either', 'neither', 'nor', 'because',
  // Contraction stems emitted by tokenize() from "n't"/"'ll"/"'re"/"'ve" forms.
  'isn', 'arent', 'aren', 'doesn', 'didn', 'don', 'wasn', 'weren', 'hasn',
  'hadn', 'haven', 'wouldn', 'couldn', 'shouldn', 'mustn', 'needn', 'won',
  'wont', 'cant', 'dont', 'didnt', 'doesnt', 'isnt', 'wasnt',
]);

/**
 * Reserved programming-language keywords — the grammatical function words of CODE.
 * Closed, universal, language-level (TS/JS + common cross-language keywords); NOT
 * workspace topic jargon (see file header for why IDF cannot suppress these). Do
 * NOT add library names, API symbols, or domain nouns here — those are IDF's job.
 * Tokens shorter than the extraction minLen (default 3) are already dropped, but
 * are listed for completeness/clarity.
 */
const CODE_STOPWORDS: ReadonlySet<string> = new Set([
  'import', 'export', 'default', 'require', 'module', 'const', 'let', 'var',
  'function', 'return', 'async', 'await', 'yield', 'class', 'interface', 'type',
  'enum', 'namespace', 'extends', 'implements', 'public', 'private', 'protected',
  'static', 'readonly', 'abstract', 'override', 'declare', 'void', 'null',
  'undefined', 'true', 'false', 'new', 'delete', 'typeof', 'instanceof', 'keyof',
  'this', 'super', 'throw', 'try', 'catch', 'finally', 'switch', 'case', 'break',
  'continue', 'else', 'for', 'while', 'const', 'let', 'string', 'number',
  'boolean', 'object', 'symbol', 'bigint', 'unknown', 'never', 'any', 'infer',
  'satisfies', 'as', 'from', 'with', 'def', 'elif', 'lambda', 'pass', 'raise',
  'except', 'fn', 'impl', 'pub', 'struct', 'trait', 'mut', 'use', 'self',
]);

export interface ExtractOpts {
  /** Max terms to retain — bounded for storage + match cost. Default 64. */
  cap?: number;
  /**
   * Min token length kept (sparseVector.tokenize already drops length<2; this
   * additionally drops short low-signal tokens). Default 3.
   */
  minLen?: number;
}

/**
 * Extract a bounded, deduped set of candidate terms from text. Distinctiveness
 * (rarity) is applied LATER at match time via IDF — here we only strip
 * grammatical stopwords and short tokens, then dedupe. Order is first-seen
 * (deterministic) for stable storage and reproducible matching. Truncation at
 * `cap` is a storage bound; a v2 could rank by local TF before truncating, but
 * first-seen keeps v1 deterministic and cheap.
 */
export function extractDistinctiveTerms(text: string, opts: ExtractOpts = {}): string[] {
  const cap = opts.cap ?? 64;
  const minLen = opts.minLen ?? 3;
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of tokenize(text)) {
    if (tok.length < minLen) continue;
    if (STOPWORDS.has(tok) || CODE_STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= cap) break;
  }
  return out;
}

export interface OverlapMatch {
  term: string;
  idf: number;
}

export interface OverlapResult {
  /** Sum of IDF weights of all matched terms (idf>0). Scales with ln(corpus). */
  score: number;
  /**
   * Count of matched terms whose IDF >= the distinctiveness floor. This is the
   * scale-INVARIANT gate callers should threshold on (e.g. `>= 2`), because the
   * raw `score` grows with ln(corpusSize) and is not comparable across stores.
   */
  distinctiveCount: number;
  /** Matched terms with their IDF weight, descending by IDF. */
  matched: OverlapMatch[];
}

export interface OverlapOpts {
  /**
   * IDF floor: a matched term counts toward `distinctiveCount` only when its IDF
   * is >= this. Default 0.3 — above the ~0.18 IDF of a term that appears in the
   * large majority of documents, below the IDF of a genuinely rare coined term.
   */
  idfFloor?: number;
  /**
   * Fallback IDF for a matched term absent from the IDF map. A term shared by
   * BOTH query and candidate yet unseen in the corpus is, by construction, rare
   * → treat as distinctive. Default 1.0.
   */
  unseenIdf?: number;
}

/**
 * IDF-weighted set-intersection between a query term set and a candidate term
 * set. Returns the summed weight AND a scale-invariant count of DISTINCTIVE
 * matches (IDF >= floor). Callers should gate recall/selection on
 * `distinctiveCount >= 2` (robust across corpus sizes) rather than on a raw
 * `score` threshold. A term with IDF <= 0 (present in ~every document) carries
 * zero signal and is dropped — this is what stops common-word-only overlap from
 * ever faulting, the precise failure mode that got auto-RAG kill-switched.
 */
export function scoreTermOverlap(
  queryTerms: readonly string[],
  candTerms: readonly string[],
  idf: ReadonlyMap<string, number>,
  opts: OverlapOpts = {},
): OverlapResult {
  const idfFloor = opts.idfFloor ?? 0.3;
  const unseenIdf = opts.unseenIdf ?? 1.0;
  const cand = new Set(candTerms);
  let score = 0;
  let distinctiveCount = 0;
  const matched: OverlapMatch[] = [];
  for (const t of queryTerms) {
    if (!cand.has(t)) continue;
    const w = idf.get(t) ?? unseenIdf;
    if (w <= 0) continue; // present in ~every doc ⇒ zero signal, never faults
    score += w;
    if (w >= idfFloor) distinctiveCount += 1;
    matched.push({ term: t, idf: w });
  }
  matched.sort((a, b) => b.idf - a.idf);
  return { score: Number(score.toFixed(4)), distinctiveCount, matched };
}

/**
 * Convenience: derive an IDF map from per-term document-frequency counts using
 * the same formula as sparseVector.computeIDF — `ln(N / (1 + df))`. Kept here
 * (rather than importing the chunk-corpus IDF) so the cross-reference path has
 * no dependency on the transcript-chunk search store. `N` is the number of
 * sealed episodes; `df` is how many carry the term.
 */
export function idfFromDocumentFrequency(
  documentFrequency: ReadonlyMap<string, number>,
  totalDocuments: number,
): Map<string, number> {
  const idf = new Map<string, number>();
  if (totalDocuments <= 0) return idf;
  for (const [term, df] of documentFrequency) {
    idf.set(term, Math.log(totalDocuments / (1 + df)));
  }
  return idf;
}
