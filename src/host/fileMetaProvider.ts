/**
 * Generic file metadata provider interface for standalone hosts.
 *
 * The relay populates `FoldRecallState`'s enrichment carriers
 * (`pathHighlights`, `pathHazards`, `pathAtlasMeta`) through its Atlas
 * worker-pool. Standalone hosts don't have Atlas, but they may have their own
 * metadata source — a `.atlas/` sidecar, a custom registry, or even
 * hand-curated annotations.
 *
 * This module provides:
 *   1. A host-neutral `FileMetaProvider` interface.
 *   2. `populateFoldRecallMeta` — one call that fills all three carrier maps
 *      from any provider implementation.
 *
 * The provider is optional: if a host doesn't supply one, the carriers stay
 * empty and recall degrades to its pre-enrichment (byte-identical) output.
 */

import type {
  AtlasFileMeta,
  FoldRecallState,
  RecallHazard,
  RecallSourceHighlight,
} from '../foldRecall.ts';

/**
 * Host-neutral file metadata. A provider returns whatever it has; null/empty
 * fields mean "not curated" and leave the carrier untouched for that path.
 */
export interface FileMetaEntry {
  /** Workspace-relative path (normalized, no leading ./). */
  readonly path: string;
  /** Curated source highlights (key regions), or empty. */
  readonly highlights?: readonly RecallSourceHighlight[];
  /** Curated hazards, or empty. */
  readonly hazards?: readonly RecallHazard[];
  /** Timeless file purpose (≥30 chars when curated). */
  readonly purpose?: string | null;
  /** Short one-line file identity (≥20 chars when curated). */
  readonly blurb?: string | null;
  /** Canonical tag list, or empty. */
  readonly tags?: readonly string[];
}

/**
 * A host implements this to supply file metadata for recall enrichment.
 * Return `null` for paths the provider has no data for — the carrier for
 * that path stays untouched.
 */
export interface FileMetaProvider {
  /**
   * Resolve metadata for a set of paths. Called once per fold epoch with
   * the paths the folded history referenced. May return partial results.
   */
  resolve(paths: readonly string[]): Promise<ReadonlyMap<string, FileMetaEntry>>;
}

/**
 * Populate the three enrichment carrier maps on a FoldRecallState from a
 * metadata provider. Call this after each fold epoch, before
 * `buildFoldRecallContext`.
 *
 * Only fills carriers for paths the provider returns data for. Paths with
 * no provider entry are left untouched (their prior carrier values, if any,
 * persist — call `clearFoldRecallMeta` first if you want a clean slate).
 */
export async function populateFoldRecallMeta(
  state: FoldRecallState,
  paths: readonly string[],
  provider: FileMetaProvider,
): Promise<void> {
  if (paths.length === 0) return;

  const entries = await provider.resolve(paths);
  if (entries.size === 0) return;

  for (const [normalizedPath, entry] of entries) {
    if (entry.highlights && entry.highlights.length > 0) {
      state.pathHighlights.set(normalizedPath, [...entry.highlights]);
    }
    if (entry.hazards && entry.hazards.length > 0) {
      state.pathHazards.set(normalizedPath, [...entry.hazards]);
    }
    const meta: AtlasFileMeta = {
      path: normalizedPath,
      purpose: entry.purpose ?? null,
      blurb: entry.blurb ?? null,
      tags: entry.tags ? [...entry.tags] : [],
    };
    // Only set if at least one identity field is non-null/empty.
    if (meta.purpose || meta.blurb || meta.tags.length > 0) {
      state.pathAtlasMeta?.set(normalizedPath, meta);
    }
  }
}

/**
 * Clear all enrichment carriers on a FoldRecallState. Useful when switching
 * epochs or resetting state between sessions.
 */
export function clearFoldRecallMeta(state: FoldRecallState): void {
  state.pathHighlights.clear();
  state.pathHazards.clear();
  state.pathSourceDeltas.clear();
  state.pathAffinity.clear();
  state.pathEpisodes.clear();
  state.pathAtlasMeta?.clear();
}
