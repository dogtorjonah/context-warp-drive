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
// ── Stemming (pure-CPU morphological normalization) ──
/**
 * Light suffix-stripping stemmer. Collapses inflectional variants so that
 * fold/folded/folding/folds share one canonical stem. Pure string ops — no
 * imports, no model, no corpus lookup — so it respects the FENCE.
 *
 * Strategy: strip common English inflectional suffixes in order from longest
 * to shortest, with a minimum stem length guard (MIN_STEM_LEN) to prevent
 * over-stemming short words (e.g. "is" → "" or "files" → "fi"). Words shorter
 * than the shortest suffix are returned unchanged.
 *
 * This is intentionally NOT a full Porter/Snowball stemmer — those are heavier
 * and would require either a dependency (breaking the fence) or ~200 lines of
 * hand-written rules. This ~30-line function catches 80%+ of the morphological
 * fragmentation quantified in the live store (866 stems with 2+ variants,
 * 2,183 terms split across inflections — rail-2d53647f).
 *
 * Suffixes are ordered longest-first so that multi-suffix words like
 * "rationalization" strip "-ization" before "-ation" would fire.
 */
const MIN_STEM_LEN = 4;
/**
 * Inflectional suffixes in descending-length order for correct greedy
 * stripping (longer suffixes tried first so "rationalization" → "rational"
 * not "rationalizat"). Deduplicated at construction time.
 */
const STEM_SUFFIXES = [
    // 7-char
    'ization', 'ational', 'fulness', 'ousness', 'iveness',
    // 6-char
    'ation', 'ition', 'ement', 'ously', 'izing', 'ising',
    // 5-char
    'ities', 'iness', 'ality',
    // 4-char
    'tion', 'sion', 'ions', 'ized', 'izer', 'izes', 'ings', 'iest', 'edly',
    // 3-char
    'ing', 'ies', 'ied', 'ier', 'ers', 'est', 'ity', 'ize',
    // 2-char
    'ed', 'er', 'es', 'ly',
    // 1-char (plural only)
    's',
];
/**
 * Apply light suffix-stripping stemming. Returns the stem of a single token.
 * Pure function, no side effects, deterministic.
 *
 * Special rules:
 *   -ies → -y  ("queries" → "query", "retries" → "retry")
 *   -ied → -y  ("carried" → "carry")
 *   -es  → -e  ("instances" → "instance", "files" → "file")
 *   -ss  preserved ("compress" stays "compress", not "compres")
 *
 * All other suffixes are stripped directly: "folding" → "fold", "blocked" →
 * "block", "files" → "file", "compressed" → "compress". Imperfections (e.g.
 * "compression" → "compres" vs "compress") are caught by the synonym map.
 */
export function stem(token) {
    if (token.length <= MIN_STEM_LEN)
        return token;
    for (const suffix of STEM_SUFFIXES) {
        if (token.length - suffix.length >= MIN_STEM_LEN && token.endsWith(suffix)) {
            if (suffix === 'ies')
                return token.slice(0, -3) + 'y';
            if (suffix === 'ied')
                return token.slice(0, -3) + 'y';
            // Guard against stripping -es from words ending in -ss/-se (compress →
            // "compres", instances → "instanc"): preserve the 'e' so the stem stays
            // closer to the root surface form.
            if (suffix === 'es') {
                const before = token.slice(0, -2);
                // "instances" → "instance" (preserve e), "tables" → "table"
                return before + 'e';
            }
            // Guard -s on double-s words ("class" → should stay "class", not "clas")
            // and -s on -ss words ("compress" → should not strip s after "ss").
            if (suffix === 's' && token.endsWith('ss'))
                return token;
            return token.slice(0, -suffix.length);
        }
    }
    return token;
}
// ── Synonym Map (pre-computed offline, loaded as static lookup) ──
/**
 * Module-level synonym map. Populated once at init via setSynonymMap() with
 * a pre-computed { stem → Set<stem> } table built offline by embedding the
 * distinctive terms with text-embedding-3-small, building HNSW, and querying
 * k-NN at 0.80+ cosine threshold. See build-synonym-map.py.
 *
 * This is the SAME class of operation as the IDF map: a static lookup table
 * loaded at init, not a search or model call on the recall path. The FENCE
 * holds because the embedding model only breathes during the offline build
 * step, never at tool-boundary recall time.
 *
 * The map operates on STEMS (post-stem()), not surface forms, so both sides
 * of the lookup are normalized before intersection.
 */
let synonymMap = new Map();
/**
 * Synonym expansion cap. Each distinctive query stem expands to at most this
 * many synonym stems, preventing noise explosion on common-but-distinctive
 * terms. Default 3.
 */
const SYNONYM_EXPANSION_CAP = 3;
/**
 * Load a pre-computed synonym map at init time. Keys and values must be stems
 * (not surface forms) — the build script normalizes via the same stem()
 * function. Pass an empty map to disable synonym expansion.
 */
export function setSynonymMap(map) {
    const out = new Map();
    for (const [key, syns] of map) {
        out.set(key, new Set(syns.slice(0, SYNONYM_EXPANSION_CAP)));
    }
    synonymMap = out;
}
/**
 * Whether the synonym map has been loaded. Used by tests and diagnostics.
 */
export function isSynonymMapLoaded() {
    return synonymMap.size > 0;
}
/**
 * Expand a set of query stems through the synonym map. Returns a NEW set
 * containing all original stems plus up to SYNONYM_EXPANSION_CAP synonyms per
 * stem. Pure — does not mutate the input.
 */
function expandWithSynonyms(stems) {
    if (synonymMap.size === 0)
        return new Set(stems);
    const expanded = new Set(stems);
    for (const s of stems) {
        const syns = synonymMap.get(s);
        if (syns === undefined)
            continue;
        for (const syn of syns) {
            if (expanded.size >= stems.size * (1 + SYNONYM_EXPANSION_CAP))
                break;
            expanded.add(syn);
        }
    }
    return expanded;
}
/**
 * Generic-English grammatical stopwords ONLY. Corpus-common technical jargon is
 * intentionally absent here — it is suppressed by IDF at match time (see file
 * header). Keep this list to function words + contraction stems; no domain terms.
 * (Expanded 2026-06-17, rail-0ed723ef: added missing common prepositions/
 * conjunctions and `n't` contraction stems — e.g. `isn`/`doesn`/`wasn` — that
 * tokenize() emits from "isn't"/"doesn't"/"wasn't" and which were leaking into
 * term-tier recall as pseudo-distinctive fragments.)
 */
const STOPWORDS = new Set([
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
const CODE_STOPWORDS = new Set([
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
/**
 * Extract a bounded, deduped set of candidate terms from text. Distinctiveness
 * (rarity) is applied LATER at match time via IDF — here we only strip
 * grammatical stopwords and short tokens, then dedupe. Order is first-seen
 * (deterministic) for stable storage and reproducible matching. Truncation at
 * `cap` is a storage bound; a v2 could rank by local TF before truncating, but
 * first-seen keeps v1 deterministic and cheap.
 */
export function extractDistinctiveTerms(text, opts = {}) {
    const cap = opts.cap ?? 64;
    const minLen = opts.minLen ?? 3;
    if (!text)
        return [];
    const seen = new Set();
    const out = [];
    for (const tok of tokenize(text)) {
        if (tok.length < minLen)
            continue;
        if (STOPWORDS.has(tok) || CODE_STOPWORDS.has(tok))
            continue;
        const s = stem(tok);
        if (seen.has(s))
            continue;
        seen.add(s);
        out.push(s);
        if (out.length >= cap)
            break;
    }
    return out;
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
export function scoreTermOverlap(queryTerms, candTerms, idf, opts = {}) {
    const idfFloor = opts.idfFloor ?? 0.3;
    const unseenIdf = opts.unseenIdf ?? 1.0;
    // Normalize IDF map to stem space. Production maps from
    // idfFromDocumentFrequency are already stemmed (idempotent re-stem here);
    // test/direct maps may carry surface forms. O(|idf|) — negligible for the
    // ~64-200 term maps typical in recall passes.
    const sidf = new Map();
    for (const [k, v] of idf) {
        sidf.set(stem(k), v);
    }
    // Stem candidate terms into a set for intersection.
    const cand = new Set();
    for (const t of candTerms)
        cand.add(stem(t));
    // Stem query terms, then expand through synonym map if loaded.
    const queryStems = new Set();
    for (const t of queryTerms)
        queryStems.add(stem(t));
    const expanded = expandWithSynonyms(queryStems);
    let score = 0;
    let distinctiveCount = 0;
    const matched = [];
    for (const t of expanded) {
        if (!cand.has(t))
            continue;
        const w = sidf.get(t) ?? unseenIdf;
        if (w <= 0)
            continue; // present in ~every doc ⇒ zero signal, never faults
        score += w;
        if (w >= idfFloor)
            distinctiveCount += 1;
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
export function idfFromDocumentFrequency(documentFrequency, totalDocuments) {
    const idf = new Map();
    if (totalDocuments <= 0)
        return idf;
    // Merge document frequencies by stem so that fold(df=202) + folded(df=47)
    // + folding(df=36) → fold(df=285). This makes IDF properly weight the
    // unified concept rather than treating each inflection as separately rare.
    const mergedDf = new Map();
    for (const [term, df] of documentFrequency) {
        const s = stem(term);
        mergedDf.set(s, (mergedDf.get(s) ?? 0) + df);
    }
    for (const [term, df] of mergedDf) {
        idf.set(term, Math.log(totalDocuments / (1 + df)));
    }
    return idf;
}
//# sourceMappingURL=foldTerms.js.map