/**
 * foldPathCanon.ts — canonical path identity for the episodic engine.
 *
 * The episodic store's join key is "the file touched" — an immutable fact.
 * That fact is only unambiguous when the path is repo-qualified: a bare
 * `src/lib/x.ts` names different files in vet-soap, voxxo-med-ai, and
 * knowledge-chat. This module turns raw extracted tool paths into canonical
 * ABSOLUTE paths — resolved against the toucher's cwd, a bridged workspace
 * root (the tool input's `workspace` argument), or (backfill only) disk
 * existence across known roots — plus the alias forms recall keeps matching
 * so legacy-format store rows stay reachable.
 *
 * Pure CPU, ZERO runtime imports (same residency rule as foldEpisodes.ts).
 * Filesystem access arrives only via the injected `fileExists`: live relay
 * sessions never pass it; the rebuild script passes fs.existsSync.
 */
export interface WorkspaceRoot {
    /** Workspace name (atlas bridge slug, e.g. "vet-soap"). */
    name: string;
    /** Absolute repo root, no trailing slash (e.g. "/home/jonah/vet-soap"). */
    root: string;
}
export interface CanonContext {
    /** The toucher's working directory (absolute). Live-session resolution anchor. */
    cwd?: string;
    roots: readonly WorkspaceRoot[];
    /** Backfill-only disk probe. NEVER provide this on relay boundary paths. */
    fileExists?: (absPath: string) => boolean;
}
export interface CanonResult {
    canonical: string;
    /** Legacy/visibility forms recall should also match (raw + ws-relative). */
    aliases: string[];
}
/** Lexically normalize a path: collapse '', '.', and '..' segments. No fs. */
export declare function lexicalNormalize(p: string): string;
/**
 * Longest-root match: which known workspace contains this absolute path?
 * Returns the workspace name plus the root-relative remainder ('' at root).
 */
export declare function workspaceForPath(absPath: string, roots: readonly WorkspaceRoot[]): {
    name: string;
    rel: string;
} | null;
/**
 * Resolution ladder (decisions fixed, no judgment):
 *  1. '~/'-prefix expands against the home dir inferred from roots; no
 *     inferable home → verbatim passthrough.
 *  2. Absolute → lexical normalize, keep.
 *  3. Relative + cwd → lexical join(cwd, raw).
 *  4. Relative, no cwd, fileExists provided → probe join(root, raw) across
 *     all roots: exactly one hit → that absolute; zero or many → passthrough
 *     raw verbatim (honest ambiguity, matches legacy rows exactly).
 *  5. Otherwise → passthrough raw verbatim.
 * Aliases: raw form (when ≠ canonical) + workspace-relative form (when the
 * canonical lands under a known root). Capped, deduped, never the canonical.
 */
export declare function canonicalizeTouchPath(raw: string, ctx: CanonContext): CanonResult;
/**
 * Batch canonicalization for extracted tool paths. `workspaceArg` is the tool
 * input's `workspace` parameter (bridged atlas_query/atlas_graph calls): when
 * it names a known root, RELATIVE extracted paths re-root against that root
 * instead of cwd — the caller was explicitly addressing that repo, the
 * highest-precision repo signal available. Absolute paths are unaffected.
 * The raw original always survives as an alias so legacy rows keep matching.
 */
export declare function canonicalizeExtractedPaths(paths: readonly string[], workspaceArg: string | undefined, ctx: CanonContext): {
    paths: string[];
    aliases: Record<string, string[]>;
};
