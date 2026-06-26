/**
 * Portable behavioral path-affinity builder for standalone hosts.
 *
 * Fills `FoldRecallState.pathAffinity` — the tier-1 co-activation carrier
 * that helps recall rank zone paths by behavioral relevance rather than pure
 * proximity — without the relay's worker-pool machinery.
 *
 * The model is simple: when paths are touched together in the same tool-boundary
 * burst (an edit+read pair, a multi-file investigation, etc.), they co-activate.
 * We count co-occurrences and normalize to 0-1.
 *
 * Keyed by composite `affinityKey(anchor, zonePath)` — the same key shape
 * `orderZoneByRelevance` consumes — so this drops straight into
 * `state.pathAffinity`.
 *
 * Pure CPU, deterministic for identical inputs.
 */

/**
 * Composite affinity key matching the relay's `affinityKey(anchor, zonePath)`.
 * The anchor is the triggering path; the zonePath is the candidate recall path.
 */
export function affinityKey(anchor: string, zonePath: string): string {
  return `${anchor}\x00${zonePath}`;
}

/**
 * Decompose an affinity key back into (anchor, zonePath).
 */
export function splitAffinityKey(key: string): { anchor: string; zonePath: string } {
  const idx = key.indexOf('\x00');
  if (idx < 0) return { anchor: key, zonePath: key };
  return { anchor: key.slice(0, idx), zonePath: key.slice(idx + 1) };
}

export interface BuildPathAffinityOptions {
  /**
   * Minimum co-activation count to produce a carrier entry. Below this the
   * pair is too noisy to be useful. Default 1.
   */
  readonly minCoActivations?: number;
  /**
   * Decay exponent applied to older co-activations (0 = no decay, 1 = linear).
   * Default 0 (all co-activations weighted equally — simple and stable).
   */
  readonly decayExponent?: number;
  /**
   * Whether to include self-affinity (anchor === zonePath). Default false —
   * self-affinity is trivially 1.0 and adds no ranking signal.
   */
  readonly includeSelf?: boolean;
}

/**
 * Build the path-affinity carrier map from a sequence of tool-boundary
 * touch sets. Each element in `touchedPathSets` is the set of paths touched
 * at a single tool boundary (one agent turn's file reads/edits).
 *
 * Assign the result to `state.pathAffinity`.
 */
export function buildPathAffinity(
  touchedPathSets: ReadonlyArray<ReadonlySet<string>>,
  options: BuildPathAffinityOptions = {},
): Map<string, number> {
  const minCoActivations = options.minCoActivations ?? 1;
  const decayExponent = options.decayExponent ?? 0;
  const includeSelf = options.includeSelf ?? false;

  const rawCounts = new Map<string, number>();
  const totalSets = touchedPathSets.length;

  touchedPathSets.forEach((pathSet, setIdx) => {
    const paths = Array.from(pathSet);
    // Co-activation decay: older sets contribute less (optional).
    const recencyWeight = decayExponent > 0
      ? Math.pow(1 - (totalSets - 1 - setIdx) / Math.max(totalSets, 1), decayExponent)
      : 1;

    for (let i = 0; i < paths.length; i++) {
      for (let j = 0; j < paths.length; j++) {
        if (i === j && !includeSelf) continue;
        const key = affinityKey(paths[i], paths[j]);
        rawCounts.set(key, (rawCounts.get(key) ?? 0) + recencyWeight);
      }
    }
  });

  // Normalize: find max, divide by it to produce 0-1 scores.
  let maxCount = 0;
  for (const count of rawCounts.values()) {
    if (count > maxCount) maxCount = count;
  }

  const result = new Map<string, number>();
  if (maxCount === 0) return result;

  for (const [key, count] of rawCounts) {
    if (count >= minCoActivations) {
      result.set(key, count / maxCount);
    }
  }

  return result;
}

/**
 * Convenience: extract touch sets from an array of tool-input records.
 * Each tool call is expected to carry `path`, `paths`, `file_path`, or
 * similar keys. This is a best-effort extraction; hosts with richer
 * tool schemas should build their own touch sets and pass them directly.
 */
export function touchSetsFromToolInputs(
  toolInputs: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ReadonlySet<string>> {
  const TOUCH_KEYS = ['path', 'paths', 'file', 'files', 'file_path', 'filePath', 'cwd', 'workdir'] as const;

  return toolInputs.map((input) => {
    const touched = new Set<string>();
    for (const key of TOUCH_KEYS) {
      const val = input[key];
      if (typeof val === 'string' && val.trim()) {
        touched.add(val.replace(/^\.?\//, ''));
      } else if (Array.isArray(val)) {
        for (const v of val) {
          if (typeof v === 'string' && v.trim()) touched.add(v.replace(/^\.?\//, ''));
        }
      }
    }
    return touched;
  });
}
