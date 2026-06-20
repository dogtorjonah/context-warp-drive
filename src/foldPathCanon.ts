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

const MAX_ALIASES = 3;

/** Lexically normalize a path: collapse '', '.', and '..' segments. No fs. */
export function lexicalNormalize(p: string): string {
  const absolute = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return (absolute ? '/' : '') + out.join('/');
}

function homeDirFromRoots(roots: readonly WorkspaceRoot[]): string | null {
  for (const r of roots) {
    const m = /^(\/home\/[^/]+)\//.exec(`${r.root}/`);
    if (m) return m[1];
  }
  return null;
}

/**
 * Longest-root match: which known workspace contains this absolute path?
 * Returns the workspace name plus the root-relative remainder ('' at root).
 */
export function workspaceForPath(
  absPath: string,
  roots: readonly WorkspaceRoot[],
): { name: string; rel: string } | null {
  let best: WorkspaceRoot | null = null;
  for (const r of roots) {
    if (absPath === r.root || absPath.startsWith(`${r.root}/`)) {
      if (!best || r.root.length > best.root.length) best = r;
    }
  }
  if (!best) return null;
  return { name: best.name, rel: absPath === best.root ? '' : absPath.slice(best.root.length + 1) };
}

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
export function canonicalizeTouchPath(raw: string, ctx: CanonContext): CanonResult {
  let working = raw;
  if (working.startsWith('~/')) {
    const home = homeDirFromRoots(ctx.roots);
    if (!home) return { canonical: raw, aliases: [] };
    working = home + working.slice(1);
  }

  let canonical: string;
  if (working.startsWith('/')) {
    canonical = lexicalNormalize(working);
  } else if (ctx.cwd !== undefined && ctx.cwd.startsWith('/')) {
    canonical = lexicalNormalize(`${ctx.cwd}/${working}`);
  } else if (ctx.fileExists) {
    const hits: string[] = [];
    for (const r of ctx.roots) {
      const candidate = lexicalNormalize(`${r.root}/${working}`);
      if (ctx.fileExists(candidate)) {
        hits.push(candidate);
        if (hits.length > 1) break;
      }
    }
    canonical = hits.length === 1 ? hits[0] : raw;
  } else {
    canonical = raw;
  }

  const aliases: string[] = [];
  const push = (a: string): void => {
    if (a.length > 0 && a !== canonical && !aliases.includes(a) && aliases.length < MAX_ALIASES) {
      aliases.push(a);
    }
  };
  push(raw);
  if (canonical.startsWith('/')) {
    const ws = workspaceForPath(canonical, ctx.roots);
    if (ws && ws.rel.length > 0) push(ws.rel);
  }
  return { canonical, aliases };
}

/**
 * Batch canonicalization for extracted tool paths. `workspaceArg` is the tool
 * input's `workspace` parameter (bridged atlas_query/atlas_graph calls): when
 * it names a known root, RELATIVE extracted paths re-root against that root
 * instead of cwd — the caller was explicitly addressing that repo, the
 * highest-precision repo signal available. Absolute paths are unaffected.
 * The raw original always survives as an alias so legacy rows keep matching.
 */
export function canonicalizeExtractedPaths(
  paths: readonly string[],
  workspaceArg: string | undefined,
  ctx: CanonContext,
): { paths: string[]; aliases: Record<string, string[]> } {
  const wsRoot = workspaceArg !== undefined
    ? ctx.roots.find((r) => r.name === workspaceArg)?.root
    : undefined;
  const out: string[] = [];
  const aliases: Record<string, string[]> = {};
  for (const raw of paths) {
    const isRelative = !raw.startsWith('/') && !raw.startsWith('~/');
    const effective = wsRoot !== undefined && isRelative ? `${wsRoot}/${raw}` : raw;
    const result = canonicalizeTouchPath(effective, ctx);
    const merged = result.aliases.slice();
    if (raw !== result.canonical && !merged.includes(raw)) merged.push(raw);
    if (!out.includes(result.canonical)) {
      out.push(result.canonical);
      aliases[result.canonical] = merged.slice(0, MAX_ALIASES);
    } else {
      const existing = aliases[result.canonical];
      for (const a of merged) {
        if (!existing.includes(a) && existing.length < MAX_ALIASES) existing.push(a);
      }
    }
  }
  return { paths: out, aliases };
}
