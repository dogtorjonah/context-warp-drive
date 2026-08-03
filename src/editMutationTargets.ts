import { normalizeToolPath } from './rollingFold.ts';

const APPLY_PATCH_FILE_HEADER_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu;

/**
 * Extract every file target named by a Codex V4A `apply_patch` body.
 *
 * The parser returns structured paths in first-seen order. Callers that need a
 * display identity may join the array themselves; storage and attribution code
 * must not inherit a presentation delimiter as part of path identity.
 */
export function extractApplyPatchTargetPaths(input: Record<string, unknown>): string[] {
  const body = typeof input.input === 'string'
    ? input.input
    : typeof input.patch === 'string' ? input.patch : '';
  if (!body) return [];

  const targets: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(APPLY_PATCH_FILE_HEADER_RE)) {
    const normalized = normalizeToolPath(match[1]?.trim() ?? '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    targets.push(normalized);
  }
  return targets;
}
