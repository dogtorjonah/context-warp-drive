/**
 * Portable live-source delta builder for standalone hosts.
 *
 * Fills `FoldRecallState.pathSourceDeltas` — the carrier that powers
 * "source changed since fold" recall nudges — without any relay or Atlas
 * dependency. A host calls this after each fold epoch with the set of paths
 * the folded history referenced; the builder snapshots the current on-disk
 * content so `buildFoldRecallContext` can diff it against the historical view.
 *
 * Bounded reads: every file is capped at `maxBytesPerFile` (default 16 KiB).
 * Larger files are truncated and flagged `truncated: true`.
 *
 * Pure I/O helper: no LLM calls, no token estimation, no relay imports.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import type { RecallSourceDelta } from '../foldRecall.ts';

export interface BuildLiveSourceDeltasOptions {
  /**
   * Maximum bytes to read per file. Larger files are truncated and flagged.
   * Default 16 KiB — bounded for main-thread safety.
   */
  readonly maxBytesPerFile?: number;
  /**
   * Prior snapshots from the last epoch, keyed by normalized path. When a
   * path's liveHash is unchanged, `stableSincePrior` is set to true so the
   * recall renderer can suppress repeat nudges for settled files.
   */
  readonly priorHashes?: ReadonlyMap<string, string>;
  /**
   * Optional root directory to resolve relative paths against.
   * Defaults to `process.cwd()`.
   */
  readonly rootDir?: string;
}

export interface BuildLiveSourceDeltasResult {
  /** Normalized path → RecallSourceDelta, ready to assign to FoldRecallState.pathSourceDeltas. */
  readonly deltas: Map<string, RecallSourceDelta>;
  /** Normalized path → liveHash, for passing as priorHashes on the next epoch. */
  readonly currentHashes: Map<string, string>;
  /** Paths that could not be read (deleted, permission denied, etc.). */
  readonly errors: ReadonlyArray<{ path: string; error: string }>;
}

/**
 * Snapshot the current on-disk content of a set of paths and build the
 * `RecallSourceDelta` carrier map for fold recall.
 *
 * Call this after each fold epoch with the paths the folded history
 * referenced. Assign the result to `state.pathSourceDeltas`.
 */
export async function buildLiveSourceDeltas(
  paths: readonly string[],
  options: BuildLiveSourceDeltasOptions = {},
): Promise<BuildLiveSourceDeltasResult> {
  const maxBytes = options.maxBytesPerFile ?? 16_384;
  const prior = options.priorHashes ?? new Map<string, string>();
  const root = options.rootDir ?? process.cwd();

  const deltas = new Map<string, RecallSourceDelta>();
  const currentHashes = new Map<string, string>();
  const errors: Array<{ path: string; error: string }> = [];

  await Promise.all(
    paths.map(async (rawPath) => {
      const normalized = rawPath.replace(/^\.?\//, '');
      const fullPath = normalized.startsWith('/')
        ? normalized
        : `${root}/${normalized}`;
      try {
        const stats = await stat(fullPath);
        if (!stats.isFile()) return; // skip directories, symlinks, etc.

        const buf = await readFile(fullPath);
        const truncated = buf.length > maxBytes;
        const source = truncated ? buf.subarray(0, maxBytes).toString('utf-8') : buf.toString('utf-8');
        const liveHash = createHash('sha256').update(source).digest('hex').slice(0, 16);

        currentHashes.set(normalized, liveHash);
        deltas.set(normalized, {
          path: normalized,
          liveHash,
          liveSource: source,
          truncated: truncated || undefined,
          stableSincePrior: prior.get(normalized) === liveHash || undefined,
        });
      } catch (err) {
        errors.push({
          path: normalized,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  return { deltas, currentHashes, errors };
}
