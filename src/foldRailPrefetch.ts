import { canonicalizeExtractedPaths, type CanonContext } from './foldPathCanon.ts';
import type { EpisodicRecallCardLike } from './foldEpisodes.ts';

export interface RailPrefetchStepLike {
  id?: string;
  title?: string;
  scope?: string;
  instruction?: string;
}

export interface RailPrefetchExtraction {
  rawPaths: string[];
  paths: string[];
  aliases: Record<string, string[]>;
}

export interface RailPrefetchCache {
  paths: string[];
  aliases: Record<string, string[]>;
  cards: EpisodicRecallCardLike[];
  createdAtMs: number;
  ttlMs: number;
  railId?: string;
  stepId?: string;
}

export interface RailPrefetchPromotion {
  cache: RailPrefetchCache | null;
  cards: EpisodicRecallCardLike[];
  matchedPath?: string;
  expired: boolean;
}

const RAIL_PREFETCH_PATH_TOKEN = /[A-Za-z0-9_@./-]+\.[A-Za-z0-9]+/g;
const DEFAULT_PATH_LIMIT = 24;

function normalizeRailPrefetchPath(raw: string): string {
  return raw.replace(/^\.\/+/, '').replace(/:\d[\d,-]*$/, '').trim();
}

function collectRailPrefetchPathTokens(text: string | undefined, seen: Set<string>, out: string[], limit: number): void {
  if (!text) return;
  for (const match of text.matchAll(RAIL_PREFETCH_PATH_TOKEN)) {
    if (out.length >= limit) return;
    const normalized = normalizeRailPrefetchPath(match[0]);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
}

export function extractRailPrefetchPaths(
  step: RailPrefetchStepLike | null | undefined,
  workspaceArg: string | undefined,
  ctx: CanonContext,
  opts: { pathLimit?: number } = {},
): RailPrefetchExtraction {
  const limit = Math.max(1, opts.pathLimit ?? DEFAULT_PATH_LIMIT);
  const rawPaths: string[] = [];
  const seen = new Set<string>();
  collectRailPrefetchPathTokens(step?.scope, seen, rawPaths, limit);
  collectRailPrefetchPathTokens(step?.instruction, seen, rawPaths, limit);
  if (rawPaths.length === 0) return { rawPaths: [], paths: [], aliases: {} };
  return {
    rawPaths,
    ...canonicalizeExtractedPaths(rawPaths, workspaceArg, ctx),
  };
}

export function createRailPrefetchCache(input: {
  paths: readonly string[];
  aliases?: Record<string, string[]>;
  cards: readonly EpisodicRecallCardLike[];
  createdAtMs: number;
  ttlMs: number;
  railId?: string;
  stepId?: string;
}): RailPrefetchCache | null {
  if (input.paths.length === 0 || input.cards.length === 0 || input.ttlMs <= 0) return null;
  return {
    paths: [...new Set(input.paths)],
    aliases: { ...(input.aliases ?? {}) },
    cards: input.cards.map((card) => ({ ...card })),
    createdAtMs: input.createdAtMs,
    ttlMs: input.ttlMs,
    ...(input.railId ? { railId: input.railId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
  };
}

function railPrefetchPathSet(cache: RailPrefetchCache): Set<string> {
  const paths = new Set(cache.paths);
  for (const path of cache.paths) {
    for (const alias of cache.aliases[path] ?? []) paths.add(alias);
  }
  return paths;
}

export function consumeRailPrefetchCache(
  cache: RailPrefetchCache | null,
  touchPaths: readonly string[],
  nowMs: number,
): RailPrefetchPromotion {
  if (!cache) return { cache: null, cards: [], expired: false };
  const expired = nowMs - cache.createdAtMs > cache.ttlMs;
  if (expired) return { cache: null, cards: [], expired: true };
  const predicted = railPrefetchPathSet(cache);
  const matchedPath = touchPaths.find((path) => predicted.has(path));
  if (!matchedPath) return { cache, cards: [], expired: false };
  return {
    cache: null,
    cards: cache.cards.map((card) => ({ ...card })),
    matchedPath,
    expired: false,
  };
}
