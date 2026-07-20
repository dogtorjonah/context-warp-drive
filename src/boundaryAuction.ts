/**
 * Pure boundary auction core.
 *
 * Callers keep their legacy per-channel render path unless the feature flag is
 * explicitly enabled. When enabled, channels submit pre-costed nominations and
 * this module spends one shared char budget across every source.
 */

export const BOUNDARY_AUCTION_FLAG = 'VOXXO_BOUNDARY_AUCTION';
export const BOUNDARY_AUCTION_COMPAT_FLAG = 'WARP_BOUNDARY_AUCTION';

export type BoundaryAuctionPressureLevel = 'healthy' | 'warning' | 'critical' | 'auto_compact';

export const BOUNDARY_AUCTION_DEFAULT_SOURCE_ORDER = [
  'fold-recall',
  'episodic-chain',
  'active-pin',
  'ambient-atlas',
] as const;

export type BoundaryAuctionKnownSource = typeof BOUNDARY_AUCTION_DEFAULT_SOURCE_ORDER[number];

export type BoundaryAuctionRender = string | ((charBudget: number) => string | null | undefined);

export interface BoundaryAuctionNomination<Payload = unknown> {
  /** Stable item id for diagnostics; falls back to input order when omitted. */
  id?: string;
  /** Channel name, e.g. fold-recall, episodic-chain, active-pin, ambient-atlas. */
  source: string;
  /** Lower tiers win before value is considered. */
  tier: number;
  /** Higher value wins within the same tier. */
  value: number;
  /** Rendered cost in characters, including any channel-local header/body. */
  chars: number;
  /** Pre-rendered text or a budget-aware pure render function. */
  render: BoundaryAuctionRender;
  /**
   * Commit visibility/accounting only after this nomination wins selection.
   * Omitted nominations never invoke the hook. Failures are isolated so
   * observability cannot break provider context assembly.
   */
  onSelected?: () => void;
  /** Caller-owned payload carried through decisions. */
  payload?: Payload;
}

export interface BoundaryAuctionBudget {
  pressure: BoundaryAuctionPressureLevel;
  requestedCharBudget: number;
  charBudget: number;
}

export interface BoundaryAuctionSelectOptions {
  charBudget: number;
  pressure?: BoundaryAuctionPressureLevel;
  sourceOrder?: readonly string[];
  separator?: string;
  maxItems?: number;
  autoCompactCharBudget?: number;
}

export interface BoundaryAuctionRunOptions extends BoundaryAuctionSelectOptions {
  enabled?: boolean;
  env?: Record<string, string | undefined>;
  /**
   * Exact legacy output from the caller's existing per-channel render path.
   * Returned byte-for-byte when the auction is disabled.
   */
  legacyText?: string;
}

export type BoundaryAuctionSkipReason = 'budget' | 'max_items';

export interface BoundaryAuctionDecision<Payload = unknown> {
  id: string;
  source: string;
  tier: number;
  value: number;
  chars: number;
  rank: number;
  cost: number;
  selected: boolean;
  skipped?: BoundaryAuctionSkipReason;
  nomination: BoundaryAuctionNomination<Payload>;
}

export interface BoundaryAuctionSelection<Payload = unknown> {
  budget: BoundaryAuctionBudget;
  selected: BoundaryAuctionDecision<Payload>[];
  omitted: BoundaryAuctionDecision<Payload>[];
  decisions: BoundaryAuctionDecision<Payload>[];
  chars: number;
}

export interface BoundaryAuctionResult<Payload = unknown> extends BoundaryAuctionSelection<Payload> {
  enabled: boolean;
  text: string;
}

interface RankedNomination<Payload> {
  nomination: BoundaryAuctionNomination<Payload>;
  inputIndex: number;
  sourceRank: number;
  id: string;
  tier: number;
  value: number;
  chars: number;
}

function truthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true;
    default:
      return false;
  }
}

export function resolveBoundaryAuctionEnabled(
  env: Record<string, string | undefined> = {},
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  return truthyFlag(env[BOUNDARY_AUCTION_FLAG]) || truthyFlag(env[BOUNDARY_AUCTION_COMPAT_FLAG]);
}

function nonNegativeInteger(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizedValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function boundaryAuctionPressureBudget(
  charBudget: number,
  pressure: BoundaryAuctionPressureLevel = 'healthy',
  autoCompactCharBudget = 800,
): BoundaryAuctionBudget {
  const requestedCharBudget = nonNegativeInteger(charBudget);
  const autoCompactBudget = nonNegativeInteger(autoCompactCharBudget, 800);
  let budget: number;
  switch (pressure) {
    case 'healthy':
      budget = requestedCharBudget;
      break;
    case 'warning':
      budget = Math.floor(requestedCharBudget / 2);
      break;
    case 'critical':
      budget = Math.floor(requestedCharBudget / 4);
      break;
    case 'auto_compact':
      budget = Math.min(autoCompactBudget, Math.floor(requestedCharBudget / 4));
      break;
  }
  return { pressure, requestedCharBudget, charBudget: budget };
}

function buildSourceRanks<Payload>(
  nominations: readonly BoundaryAuctionNomination<Payload>[],
  sourceOrder: readonly string[],
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (let i = 0; i < sourceOrder.length; i++) {
    const source = sourceOrder[i];
    if (!ranks.has(source)) ranks.set(source, i);
  }
  let next = sourceOrder.length;
  for (const nomination of nominations) {
    if (!ranks.has(nomination.source)) {
      ranks.set(nomination.source, next);
      next += 1;
    }
  }
  return ranks;
}

function rankNominations<Payload>(
  nominations: readonly BoundaryAuctionNomination<Payload>[],
  sourceOrder: readonly string[],
): RankedNomination<Payload>[] {
  const sourceRanks = buildSourceRanks(nominations, sourceOrder);
  return nominations
    .map((nomination, inputIndex): RankedNomination<Payload> => ({
      nomination,
      inputIndex,
      sourceRank: sourceRanks.get(nomination.source) ?? Number.MAX_SAFE_INTEGER,
      id: nomination.id ?? `${nomination.source}:${inputIndex}`,
      tier: nonNegativeInteger(nomination.tier, Number.MAX_SAFE_INTEGER),
      value: normalizedValue(nomination.value),
      chars: nonNegativeInteger(nomination.chars),
    }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.value !== b.value) return b.value - a.value;
      if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
      return a.inputIndex - b.inputIndex;
    });
}

export function rankBoundaryAuctionNominations<Payload = unknown>(
  nominations: readonly BoundaryAuctionNomination<Payload>[],
  sourceOrder: readonly string[] = BOUNDARY_AUCTION_DEFAULT_SOURCE_ORDER,
): BoundaryAuctionNomination<Payload>[] {
  return rankNominations(nominations, sourceOrder).map((ranked) => ranked.nomination);
}

export function selectBoundaryAuctionNominations<Payload = unknown>(
  nominations: readonly BoundaryAuctionNomination<Payload>[],
  options: BoundaryAuctionSelectOptions,
): BoundaryAuctionSelection<Payload> {
  const separator = options.separator ?? '\n\n';
  const maxItems = options.maxItems === undefined
    ? Number.MAX_SAFE_INTEGER
    : nonNegativeInteger(options.maxItems);
  const budget = boundaryAuctionPressureBudget(
    options.charBudget,
    options.pressure,
    options.autoCompactCharBudget,
  );
  const ranked = rankNominations(nominations, options.sourceOrder ?? BOUNDARY_AUCTION_DEFAULT_SOURCE_ORDER);
  const selected: BoundaryAuctionDecision<Payload>[] = [];
  const omitted: BoundaryAuctionDecision<Payload>[] = [];
  const decisions: BoundaryAuctionDecision<Payload>[] = [];
  let chars = 0;

  for (let rank = 0; rank < ranked.length; rank++) {
    const item = ranked[rank];
    const separatorCost = selected.length === 0 ? 0 : separator.length;
    const cost = item.chars + separatorCost;
    const base = {
      id: item.id,
      source: item.nomination.source,
      tier: item.tier,
      value: item.value,
      chars: item.chars,
      rank,
      cost,
      nomination: item.nomination,
    };
    if (selected.length >= maxItems) {
      const decision: BoundaryAuctionDecision<Payload> = { ...base, selected: false, skipped: 'max_items' };
      omitted.push(decision);
      decisions.push(decision);
      continue;
    }
    if (chars + cost > budget.charBudget) {
      const decision: BoundaryAuctionDecision<Payload> = { ...base, selected: false, skipped: 'budget' };
      omitted.push(decision);
      decisions.push(decision);
      continue;
    }
    const decision: BoundaryAuctionDecision<Payload> = { ...base, selected: true };
    selected.push(decision);
    decisions.push(decision);
    chars += cost;
  }

  return { budget, selected, omitted, decisions, chars };
}

function renderNomination(nomination: BoundaryAuctionNomination, charBudget: number): string {
  const rendered = typeof nomination.render === 'function'
    ? nomination.render(charBudget)
    : nomination.render;
  const text = rendered ?? '';
  if (text.length > 0) {
    try {
      nomination.onSelected?.();
    } catch { /* fail-open: selection accounting must never break the boundary */ }
  }
  return text;
}

export function runBoundaryAuction<Payload = unknown>(
  nominations: readonly BoundaryAuctionNomination<Payload>[],
  options: BoundaryAuctionRunOptions,
): BoundaryAuctionResult<Payload> {
  const enabled = resolveBoundaryAuctionEnabled(options.env, options.enabled);
  const budget = boundaryAuctionPressureBudget(
    options.charBudget,
    options.pressure,
    options.autoCompactCharBudget,
  );

  if (!enabled) {
    const text = options.legacyText ?? '';
    return {
      enabled: false,
      budget,
      selected: [],
      omitted: [],
      decisions: [],
      chars: text.length,
      text,
    };
  }

  const selection = selectBoundaryAuctionNominations(nominations, options);
  const separator = options.separator ?? '\n\n';
  const text = selection.selected
    .map((decision) => renderNomination(decision.nomination, decision.chars))
    .filter((rendered) => rendered.length > 0)
    .join(separator);

  return {
    enabled: true,
    ...selection,
    chars: text.length,
    text,
  };
}
