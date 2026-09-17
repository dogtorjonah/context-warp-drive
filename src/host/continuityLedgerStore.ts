/**
 * Async standalone persistence for Context Warp continuity-ledger captures.
 *
 * The ledger file is content-free: it stores chronology, placement, handles,
 * char counts, and SHA-256 proofs, never source bodies. Exact canonical source
 * bytes live in a separate append-only source file addressed by the recovery
 * handles. Source rows are written first, so a ledger row is never advertised
 * before its authoritative backing bytes are durable.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  sha256ContinuityLedgerVerbatim,
  type ContinuityLedgerCaptureRecord,
  type ContinuityLedgerLifecycle,
  type ContinuityLedgerPlacement,
} from '../rebirthPackageV6.ts';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Newest capture histories retained per owner (bounded retention). */
const DEFAULT_CAPTURE_HISTORY_LIMIT = 16;

export interface StandaloneContinuityLedgerStoreOptions {
  /** Content-free append-only JSONL path. */
  readonly ledgerPath: string;
  /** Exact source JSONL path. Defaults to `${ledgerPath}.sources`. */
  readonly sourcePath?: string;
  /**
   * Capture-specific history JSONL path. Defaults to `${ledgerPath}.captures`.
   * History is what keeps an older capture's membership answerable after a
   * later capture restamps or retires the same unit.
   */
  readonly captureHistoryPath?: string;
  /** Newest capture histories retained per owner. Defaults to 16. */
  readonly captureHistoryLimit?: number;
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Declared truncation of a delivered body. A rendered placement carrying a
 * projection is still a genuine omission: only part of the source reached the
 * reader, so the row is preserved with its projection proof rather than retired.
 */
export type StandaloneContinuityProjection = {
  readonly mode: 'truncated';
  readonly algorithm: 'head-clamp';
  readonly version: number;
  readonly storedChars: number;
  readonly storedBytes: number;
  readonly sourceChars: number;
  readonly sourceBytes: number;
};

export interface StandaloneContinuityLedgerRow {
  readonly ownerInstanceId: string;
  readonly captureId: string;
  readonly workspace: string | null;
  readonly lifecycle: ContinuityLedgerLifecycle;
  readonly captureSourceStartIndex: number | null;
  readonly captureSourceEndIndexExclusive: number | null;
  readonly captureSourceFirstTime: string | null;
  readonly captureSourceLastTime: string | null;
  readonly unitId: string;
  readonly kind: string;
  readonly sectionId: string;
  readonly sourceProvenanceId: string;
  readonly sourceIdentityAuthority: 'exact' | 'synthetic-position';
  readonly sourceIndex: number | null;
  readonly sourceInstanceId: string | null;
  readonly sourceTime: string | null;
  readonly sourceEndTime: string | null;
  readonly eraKey: string | null;
  readonly tier: string;
  readonly tierBasis: string;
  readonly placement: ContinuityLedgerPlacement;
  /** Present only when the stored verbatim is a prefix of a longer source. */
  readonly projection?: StandaloneContinuityProjection | null;
  readonly claim: string;
  readonly chars: number;
  readonly sha256: string;
  readonly origin: 'declared' | 'heuristic' | null;
  readonly recover: string;
  readonly recordedAt: string;
}

interface StandaloneContinuitySourceRow {
  readonly ownerInstanceId: string;
  readonly captureId: string;
  readonly sourceIndex: number | null;
  readonly unitId: string;
  readonly sourceProvenanceId: string;
  readonly chars: number;
  readonly sha256: string;
  readonly verbatim: string;
  readonly recordedAt: string;
}

export interface StandaloneContinuityLedgerQuery {
  readonly ownerInstanceId: string;
  readonly captureId?: string;
  readonly lifecycle?: ContinuityLedgerLifecycle;
  readonly unitIds?: readonly string[];
  readonly offset?: number;
  readonly limit?: number;
}

/**
 * Membership receipt for a capture-addressed fetch. Absent on owner-wide
 * pages, where current inventory is the question being asked.
 *
 * `complete` means a retained capture snapshot answered the query; its frozen
 * membership never shrinks when a later capture restamps or retires a unit.
 * `unavailable` means no snapshot is retained — an older capture can then
 * never read as a successful empty inventory. `legacy-capture` names a capture
 * whose durable rows still exist without a retained snapshot (recorded before
 * history existed, or aged out of it); `no-snapshot` means the store has no
 * evidence of that capture at all.
 */
export interface StandaloneContinuityCaptureMembership {
  readonly status: 'complete' | 'incomplete' | 'unavailable';
  /** Frozen membership size; present only when a snapshot answered. */
  readonly recordedUnits: number | null;
  /** Rows this call returned, after lifecycle/unit filters and paging. */
  readonly returnedUnits: number;
  /** Units this capture refused at write time (0 for a clean capture). */
  readonly rejectedUnits: number;
  /** Why membership is unavailable; absent when a snapshot answered. */
  readonly reason?: 'legacy-capture' | 'no-snapshot';
}

export interface StandaloneContinuityLedgerPage {
  readonly rows: readonly StandaloneContinuityLedgerRow[];
  readonly total: number;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly captureMembership?: StandaloneContinuityCaptureMembership;
}

/**
 * One capture's frozen membership: the immutable ledger rows that capture
 * stored as inventory, with the proofs (sha256, chars, recover handle) needed
 * to answer and recover them independently of the current omission state.
 * Rendered removals and excluded sections are never members — they were never
 * inventory. Source bytes stay in the append-only, capture-keyed source file.
 */
export interface StandaloneContinuityCaptureSnapshot {
  readonly kind: 'capture-snapshot';
  /** Full submitted-input proof; absent on legacy snapshots, whose retries fail closed. */
  readonly inputSha256?: string;
  readonly ownerInstanceId: string;
  readonly captureId: string;
  readonly recordedAt: string;
  readonly lifecycle: ContinuityLedgerLifecycle;
  readonly captureSourceStartIndex: number | null;
  readonly captureSourceEndIndexExclusive: number | null;
  readonly captureSourceFirstTime: string | null;
  readonly captureSourceLastTime: string | null;
  readonly rows: readonly StandaloneContinuityLedgerRow[];
  /** Units this capture refused; a non-zero count makes it incomplete. */
  readonly rejectedUnits: number;
}

/**
 * A rendered placement is a removal signal, never inventory: it is appended as
 * a tombstone so replay reproduces the removal, and it never carries a row's
 * metadata or a source body.
 */
interface StandaloneContinuityRemovalEntry {
  readonly kind: 'removal';
  readonly ownerInstanceId: string;
  readonly captureId: string;
  readonly unitId: string;
  readonly unitKind: string;
  readonly recordedAt: string;
}

export interface StandaloneContinuityLedgerRecordResult {
  readonly recorded: number;
  readonly replaced: number;
  /** Current-inventory rows retired by rendered placements; never stored. */
  readonly removed?: number;
  readonly rejected: readonly { readonly unitId: string; readonly reason: string }[];
}

export interface StandaloneContinuityRecovery {
  readonly row: StandaloneContinuityLedgerRow;
  readonly verbatim: string;
}

export type StandaloneContinuityHandleResult =
  | { readonly action: 'index' | 'fetch'; readonly page: StandaloneContinuityLedgerPage }
  | { readonly action: 'recover'; readonly recovery: StandaloneContinuityRecovery | null };

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value!)));
}

function boundedOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value!));
}

function ledgerKey(ownerInstanceId: string, kind: string, unitId: string): string {
  return `${ownerInstanceId}\u0000${kind}\u0000${unitId}`;
}

function sourceIndexKey(ownerInstanceId: string, captureId: string, sourceIndex: number): string {
  return `${ownerInstanceId}\u0000${captureId}\u0000${sourceIndex}`;
}

function sourceUnitKey(ownerInstanceId: string, captureId: string, unitId: string): string {
  return `${ownerInstanceId}\u0000${captureId}\u0000${unitId}`;
}

/** Owner-scoped capture identity used by history and by the observed-capture set. */
function captureOwnerKey(ownerInstanceId: string, captureId: string): string {
  return `${ownerInstanceId}\u0000${captureId}`;
}

/** Preserve array order (including removals) while ignoring object key insertion order. */
function captureInputSha256(record: ContinuityLedgerCaptureRecord): string {
  const canonical = JSON.stringify(record, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    }
    return value;
  });
  // Only the digest is persisted; source bodies never enter the capture ledger.
  return sha256ContinuityLedgerVerbatim(canonical);
}

function chronologicalRows(
  left: StandaloneContinuityLedgerRow,
  right: StandaloneContinuityLedgerRow,
): number {
  const leftTime = left.sourceTime ?? left.sourceEndTime;
  const rightTime = right.sourceTime ?? right.sourceEndTime;
  if (leftTime !== rightTime) {
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return leftTime.localeCompare(rightTime);
  }
  const leftIndex = left.sourceIndex ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = right.sourceIndex ?? Number.MAX_SAFE_INTEGER;
  return leftIndex - rightIndex
    || left.kind.localeCompare(right.kind)
    || left.unitId.localeCompare(right.unitId);
}

function jsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length > 0 ? '\n' : '');
}

async function readJsonLines(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const values: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // A torn final append is quarantined. Earlier complete rows remain usable.
    }
  }
  return values;
}

function isLedgerRow(value: unknown): value is StandaloneContinuityLedgerRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<StandaloneContinuityLedgerRow>;
  return typeof row.ownerInstanceId === 'string'
    && typeof row.captureId === 'string'
    && typeof row.unitId === 'string'
    && typeof row.kind === 'string'
    && typeof row.sourceProvenanceId === 'string'
    && typeof row.sha256 === 'string'
    && typeof row.chars === 'number'
    && typeof row.recover === 'string';
}

function isSourceRow(value: unknown): value is StandaloneContinuitySourceRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<StandaloneContinuitySourceRow>;
  return typeof row.ownerInstanceId === 'string'
    && typeof row.captureId === 'string'
    && (row.sourceIndex === null || Number.isSafeInteger(row.sourceIndex))
    && typeof row.unitId === 'string'
    && typeof row.sha256 === 'string'
    && typeof row.chars === 'number'
    && typeof row.verbatim === 'string';
}

function isCaptureSnapshot(value: unknown): value is StandaloneContinuityCaptureSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<StandaloneContinuityCaptureSnapshot>;
  return snapshot.kind === 'capture-snapshot'
    && typeof snapshot.ownerInstanceId === 'string'
    && typeof snapshot.captureId === 'string'
    && typeof snapshot.recordedAt === 'string'
    && Array.isArray(snapshot.rows)
    && snapshot.rows.every(isLedgerRow);
}

function isRemovalEntry(value: unknown): value is StandaloneContinuityRemovalEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StandaloneContinuityRemovalEntry>;
  return entry.kind === 'removal'
    && typeof entry.ownerInstanceId === 'string'
    && typeof entry.captureId === 'string'
    && typeof entry.unitId === 'string'
    && typeof entry.unitKind === 'string'
    && typeof entry.recordedAt === 'string';
}

function parseHandle(handle: string): { tool: string; args: Record<string, string | number> } {
  const firstSpace = handle.indexOf(' ');
  const tool = firstSpace < 0 ? handle : handle.slice(0, firstSpace);
  let rest = firstSpace < 0 ? '' : handle.slice(firstSpace + 1);
  const args: Record<string, string | number> = {};
  while (rest.trim()) {
    rest = rest.trimStart();
    const match = /^([a-z_][a-z0-9_]*)=("(?:\\.|[^"\\])*"|[^\s]+)/iu.exec(rest);
    if (!match) throw new Error(`invalid continuity-ledger handle suffix: ${rest}`);
    const key = match[1]!;
    const encoded = match[2]!;
    args[key] = encoded.startsWith('"')
      ? JSON.parse(encoded) as string
      : /^-?\d+$/u.test(encoded)
        ? Number(encoded)
        : encoded;
    rest = rest.slice(match[0].length);
  }
  return { tool, args };
}

/** Async, append-only standalone ledger plus separate exact source store. */
export class StandaloneContinuityLedgerStore {
  private readonly ledgerPath: string;
  private readonly sourcePath: string;
  private readonly captureHistoryPath: string;
  private readonly captureHistoryLimit: number;
  private readonly now: () => Date;
  private readonly rowsByUnit = new Map<string, StandaloneContinuityLedgerRow>();
  private readonly rowsBySourceIndex = new Map<string, StandaloneContinuityLedgerRow>();
  private readonly rowsBySourceUnit = new Map<string, StandaloneContinuityLedgerRow>();
  private readonly sourcesByUnit = new Map<string, StandaloneContinuitySourceRow>();
  /** Per-owner frozen capture memberships, oldest first, bounded by the limit. */
  private readonly capturesByOwner = new Map<string, StandaloneContinuityCaptureSnapshot[]>();
  /** `${owner}\0${capture}` keys for captures the durable rows prove existed. */
  private readonly observedCaptureKeys = new Set<string>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: StandaloneContinuityLedgerStoreOptions) {
    this.ledgerPath = options.ledgerPath;
    this.sourcePath = options.sourcePath ?? `${options.ledgerPath}.sources`;
    this.captureHistoryPath = options.captureHistoryPath ?? `${options.ledgerPath}.captures`;
    this.captureHistoryLimit = Number.isFinite(options.captureHistoryLimit)
      && (options.captureHistoryLimit ?? 0) > 0
      ? Math.floor(options.captureHistoryLimit!)
      : DEFAULT_CAPTURE_HISTORY_LIMIT;
    this.now = options.now ?? (() => new Date());
  }

  static async open(
    options: StandaloneContinuityLedgerStoreOptions,
  ): Promise<StandaloneContinuityLedgerStore> {
    const store = new StandaloneContinuityLedgerStore(options);
    await Promise.all([
      mkdir(dirname(store.ledgerPath), { recursive: true }),
      mkdir(dirname(store.sourcePath), { recursive: true }),
      mkdir(dirname(store.captureHistoryPath), { recursive: true }),
    ]);
    const [ledgerValues, sourceValues, historyValues] = await Promise.all([
      readJsonLines(store.ledgerPath),
      readJsonLines(store.sourcePath),
      readJsonLines(store.captureHistoryPath),
    ]);
    for (const value of sourceValues) {
      if (!isSourceRow(value)) continue;
      store.observedCaptureKeys.add(captureOwnerKey(value.ownerInstanceId, value.captureId));
      store.sourcesByUnit.set(
        sourceUnitKey(value.ownerInstanceId, value.captureId, value.unitId),
        value,
      );
    }
    // Ledger entries replay in file order: a rendered placement is a tombstone,
    // so a later removal deletes the row an earlier capture stored and is never
    // itself inventory. This is what keeps eviction-only true across restarts.
    for (const value of ledgerValues) {
      if (value && typeof value === 'object' && 'entryType' in value
        && value.entryType === 'capture-identity' && 'ownerInstanceId' in value
        && typeof value.ownerInstanceId === 'string' && 'captureId' in value
        && typeof value.captureId === 'string') {
        store.observedCaptureKeys.add(captureOwnerKey(value.ownerInstanceId, value.captureId));
        continue;
      }
      if (isRemovalEntry(value)) {
        store.observedCaptureKeys.add(captureOwnerKey(value.ownerInstanceId, value.captureId));
        store.applyRemoval(value);
        continue;
      }
      if (!isLedgerRow(value)) continue;
      store.observedCaptureKeys.add(captureOwnerKey(value.ownerInstanceId, value.captureId));
      // Legacy eviction-only cleanup: files written before this policy may hold
      // episode rows (never inventory) and rendered rows (removal signals).
      // Replaying them as inventory would resurrect exactly what the policy
      // deletes, so they are filtered here instead.
      if (value.kind === 'episode' || value.sectionId === 'episodeChapterIndex') continue;
      if (value.placement === 'rendered'
        && (value.projection === undefined || value.projection === null)) {
        store.applyRemoval({
          kind: 'removal',
          ownerInstanceId: value.ownerInstanceId,
          captureId: value.captureId,
          unitId: value.unitId,
          unitKind: value.kind,
          recordedAt: value.recordedAt,
        });
        continue;
      }
      store.rowsByUnit.set(ledgerKey(value.ownerInstanceId, value.kind, value.unitId), value);
      store.rowsBySourceUnit.set(
        sourceUnitKey(value.ownerInstanceId, value.captureId, value.unitId),
        value,
      );
      if (value.sourceIndex !== null) {
        store.rowsBySourceIndex.set(
          sourceIndexKey(value.ownerInstanceId, value.captureId, value.sourceIndex),
          value,
        );
      }
    }
    for (const value of historyValues) {
      if (!isCaptureSnapshot(value)) continue;
      const rows = store.capturesByOwner.get(value.ownerInstanceId) ?? [];
      rows.push(value);
      store.capturesByOwner.set(value.ownerInstanceId, rows);
    }
    // Retention is a read-time bound as well: an over-long legacy history is
    // trimmed in memory here and rewritten by the next compaction.
    for (const [ownerInstanceId, rows] of store.capturesByOwner) {
      rows.sort((left, right) => (
        left.recordedAt.localeCompare(right.recordedAt)
        || left.captureId.localeCompare(right.captureId)
      ));
      store.capturesByOwner.set(ownerInstanceId, rows.slice(-store.captureHistoryLimit));
    }
    return store;
  }

  renderIndexHandle(ownerInstanceId: string): string {
    return `continuity_ledger action="index" owner=${JSON.stringify(ownerInstanceId)}`;
  }

  renderRecoveryHandle(
    ownerInstanceId: string,
    captureId: string,
    sourceIndex: number,
  ): string {
    return `continuity_ledger action="recover" owner=${JSON.stringify(ownerInstanceId)} capture_id=${JSON.stringify(captureId)} source_index=${sourceIndex}`;
  }

  renderUnitRecoveryHandle(
    ownerInstanceId: string,
    captureId: string,
    unitId: string,
  ): string {
    return `continuity_ledger action="recover" owner=${JSON.stringify(ownerInstanceId)} capture_id=${JSON.stringify(captureId)} unit_id=${JSON.stringify(unitId)}`;
  }

  /**
   * Validate, hash, and queue a capture. All filesystem work uses promises and
   * runs behind a per-store write chain; callers may fire-and-forget then flush.
   */
  record(record: ContinuityLedgerCaptureRecord): Promise<StandaloneContinuityLedgerRecordResult> {
    let resolveResult!: (value: StandaloneContinuityLedgerRecordResult) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<StandaloneContinuityLedgerRecordResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const operation = this.writeQueue.then(async () => {
      try {
        resolveResult(await this.persistRecord(record));
      } catch (error) {
        rejectResult(error);
      }
    });
    this.writeQueue = operation.catch(() => {});
    return result;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  index(query: StandaloneContinuityLedgerQuery): StandaloneContinuityLedgerPage {
    return this.page(query);
  }

  fetch(query: StandaloneContinuityLedgerQuery): StandaloneContinuityLedgerPage {
    return this.page(query);
  }

  recover(
    ownerInstanceId: string,
    captureId: string,
    sourceIndex: number,
  ): StandaloneContinuityRecovery | null {
    const row = this.rowsBySourceIndex.get(
      sourceIndexKey(ownerInstanceId, captureId, sourceIndex),
    );
    return row ? this.recoverUnit(ownerInstanceId, captureId, row.unitId) : null;
  }

  recoverUnit(
    ownerInstanceId: string,
    captureId: string,
    unitId: string,
  ): StandaloneContinuityRecovery | null {
    const key = sourceUnitKey(ownerInstanceId, captureId, unitId);
    const row = this.rowsBySourceUnit.get(key);
    const source = this.sourcesByUnit.get(key);
    if (!row || !source) return null;
    if (source.unitId !== row.unitId || source.sourceProvenanceId !== row.sourceProvenanceId) return null;
    if (source.chars !== row.chars || source.verbatim.length !== row.chars) return null;
    if (source.sha256 !== row.sha256) return null;
    if (sha256ContinuityLedgerVerbatim(source.verbatim) !== row.sha256) return null;
    return { row, verbatim: source.verbatim };
  }

  async executeHandle(handle: string): Promise<StandaloneContinuityHandleResult> {
    const parsed = parseHandle(handle);
    if (parsed.tool !== 'continuity_ledger') throw new Error(`unsupported recovery tool: ${parsed.tool}`);
    const action = parsed.args.action;
    const ownerInstanceId = parsed.args.owner;
    if (typeof action !== 'string' || typeof ownerInstanceId !== 'string' || !ownerInstanceId) {
      throw new Error('continuity-ledger handle requires action and owner');
    }
    if (action === 'index' || action === 'fetch') {
      const page = this.page({
        ownerInstanceId,
        ...(typeof parsed.args.capture_id === 'string' ? { captureId: parsed.args.capture_id } : {}),
        ...(typeof parsed.args.unit_id === 'string' ? { unitIds: [parsed.args.unit_id] } : {}),
        ...(typeof parsed.args.offset === 'number' ? { offset: parsed.args.offset } : {}),
        ...(typeof parsed.args.limit === 'number' ? { limit: parsed.args.limit } : {}),
      });
      return { action, page };
    }
    if (action === 'recover') {
      const captureId = parsed.args.capture_id;
      const sourceIndex = parsed.args.source_index;
      const unitId = parsed.args.unit_id;
      if (typeof captureId !== 'string') {
        throw new Error('continuity-ledger recover handle requires capture_id');
      }
      if (typeof unitId === 'string' && unitId) {
        return { action, recovery: this.recoverUnit(ownerInstanceId, captureId, unitId) };
      }
      if (typeof sourceIndex !== 'number' || !Number.isSafeInteger(sourceIndex)) {
        throw new Error('continuity-ledger recover handle requires unit_id or source_index');
      }
      return { action, recovery: this.recover(ownerInstanceId, captureId, sourceIndex) };
    }
    throw new Error(`unsupported continuity-ledger action: ${action}`);
  }

  private page(query: StandaloneContinuityLedgerQuery): StandaloneContinuityLedgerPage {
    const unitIds = query.unitIds ? new Set(query.unitIds) : null;
    const offset = boundedOffset(query.offset);
    const limit = boundedLimit(query.limit);
    if (query.captureId !== undefined) {
      const snapshot = this.findCaptureSnapshot(query.ownerInstanceId, query.captureId);
      if (!snapshot) {
        // Never a successful empty: membership is declared unavailable, and the
        // reason separates a capture whose durable rows exist without a retained
        // snapshot from one this store never observed at all.
        const observed = this.observedCaptureKeys.has(
          captureOwnerKey(query.ownerInstanceId, query.captureId),
        );
        return {
          rows: [],
          total: 0,
          offset,
          nextOffset: null,
          captureMembership: {
            status: 'unavailable',
            recordedUnits: null,
            returnedUnits: 0,
            rejectedUnits: 0,
            reason: observed ? 'legacy-capture' : 'no-snapshot',
          },
        };
      }
      // A retained snapshot answers from its frozen membership, independent of
      // current inventory, so a later capture's restamp or retirement can never
      // shrink an older capture's answer.
      const all = snapshot.rows
        .filter((row) => query.lifecycle === undefined || row.lifecycle === query.lifecycle)
        .filter((row) => unitIds === null || unitIds.has(row.unitId));
      const rows = all.slice(offset, offset + limit);
      const nextOffset = offset + rows.length < all.length ? offset + rows.length : null;
      return {
        rows,
        total: all.length,
        offset,
        nextOffset,
        captureMembership: {
          // A capture that refused units can never advertise a complete
          // inventory; the members it did store are still returned.
          status: snapshot.rejectedUnits > 0 ? 'incomplete' : 'complete',
          recordedUnits: snapshot.rows.length,
          returnedUnits: rows.length,
          rejectedUnits: snapshot.rejectedUnits,
        },
      };
    }
    const all = [...this.rowsByUnit.values()]
      .filter((row) => row.ownerInstanceId === query.ownerInstanceId)
      .filter((row) => query.lifecycle === undefined || row.lifecycle === query.lifecycle)
      .filter((row) => unitIds === null || unitIds.has(row.unitId))
      .sort(chronologicalRows);
    const rows = all.slice(offset, offset + limit);
    const nextOffset = offset + rows.length < all.length ? offset + rows.length : null;
    return { rows, total: all.length, offset, nextOffset };
  }

  private findCaptureSnapshot(
    ownerInstanceId: string,
    captureId: string,
  ): StandaloneContinuityCaptureSnapshot | null {
    const rows = this.capturesByOwner.get(ownerInstanceId) ?? [];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const candidate = rows[index]!;
      if (candidate.captureId === captureId) return candidate;
    }
    return null;
  }

  /**
   * Apply one rendered-removal tombstone. The unit leaves current inventory, and
   * only the tombstone's own capture loses capture-keyed entries: every other
   * capture keeps its frozen history, its capture-keyed rows, and its source
   * bytes, so an older capture's answer and recovery never shrink.
   */
  private applyRemoval(entry: StandaloneContinuityRemovalEntry): void {
    this.rowsByUnit.delete(ledgerKey(entry.ownerInstanceId, entry.unitKind, entry.unitId));
    const key = sourceUnitKey(entry.ownerInstanceId, entry.captureId, entry.unitId);
    const captureRow = this.rowsBySourceUnit.get(key);
    this.rowsBySourceUnit.delete(key);
    if (captureRow && captureRow.sourceIndex !== null) {
      const indexKey = sourceIndexKey(entry.ownerInstanceId, entry.captureId, captureRow.sourceIndex);
      if (this.rowsBySourceIndex.get(indexKey) === captureRow) this.rowsBySourceIndex.delete(indexKey);
    }
    this.sourcesByUnit.delete(key);
  }

  private async persistRecord(
    record: ContinuityLedgerCaptureRecord,
  ): Promise<StandaloneContinuityLedgerRecordResult> {
    const ownerInstanceId = record.ownerInstanceId.trim();
    const captureId = record.captureId.trim();
    if (!ownerInstanceId || !captureId) throw new Error('continuity-ledger record requires owner and capture id');
    const recordedAt = this.now().toISOString();
    // Capture identity is immutable: the first recording of (owner, capture)
    // owns its membership and its exact bytes. An identical retry is a no-op; a
    // divergent record is declared and writes nothing, so no later capture can
    // append a second snapshot or overwrite frozen recovery bytes.
    const frozen = this.findCaptureSnapshot(ownerInstanceId, captureId);
    if (frozen) {
      if (frozen.inputSha256 === captureInputSha256(record)) {
        return { recorded: 0, replaced: 0, removed: 0, rejected: [] };
      }
      return {
        recorded: 0,
        replaced: 0,
        removed: 0,
        rejected: [{ unitId: '(capture)', reason: `capture-id-conflict:${captureId}` }],
      };
    }
    if (this.observedCaptureKeys.has(captureOwnerKey(ownerInstanceId, captureId))) {
      // An observed identity stays reserved even after its snapshot ages out of
      // retention: its durable rows and recovery bytes remain addressable, so
      // reusing the id would silently fork a second history under an identity
      // that readers still resolve against.
      return {
        recorded: 0,
        replaced: 0,
        removed: 0,
        rejected: [{ unitId: '(capture)', reason: `capture-id-reuse-after-expiry:${captureId}` }],
      };
    }
    const ledgerEntries: Array<StandaloneContinuityLedgerRow | StandaloneContinuityRemovalEntry> = [];
    const sourceRows: StandaloneContinuitySourceRow[] = [];
    const rejected: Array<{ unitId: string; reason: string }> = [];
    let replaced = 0;
    let removed = 0;

    for (const unit of record.units) {
      const unitId = unit.unitId.trim();
      if (!unitId) {
        rejected.push({ unitId: '(missing)', reason: 'missing-unit-id' });
        continue;
      }
      // Eviction-only: episode rows are never ledger inventory, so they are
      // neither stored, counted, nor recovered from this store.
      if (unit.kind === 'episode' || unit.sectionId === 'episodeChapterIndex') continue;
      const sha256 = sha256ContinuityLedgerVerbatim(unit.verbatim);
      if (sha256 !== unit.sha256.toLowerCase()) {
        rejected.push({ unitId, reason: 'sha256-mismatch' });
        continue;
      }
      const sourceIndex = unit.sourceIndex;
      if (sourceIndex !== null && (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0)) {
        rejected.push({ unitId, reason: 'invalid-source-index' });
        continue;
      }
      // A rendered placement is a removal signal — unless it carries a
      // projection: a truncated delivery is a genuine omission, so its row is
      // stored with the projection proof and only a FULL delivery retires it.
      if (unit.placement === 'rendered' && unit.projection == null) {
        ledgerEntries.push({
          kind: 'removal',
          ownerInstanceId,
          captureId,
          unitId,
          unitKind: unit.kind,
          recordedAt,
        });
        removed += 1;
        continue;
      }
      const recover = this.renderUnitRecoveryHandle(ownerInstanceId, captureId, unitId);
      const row: StandaloneContinuityLedgerRow = {
        ownerInstanceId,
        captureId,
        workspace: record.workspace,
        lifecycle: record.lifecycle,
        captureSourceStartIndex: record.sourceStartIndex,
        captureSourceEndIndexExclusive: record.sourceEndIndexExclusive,
        captureSourceFirstTime: record.sourceFirstTime,
        captureSourceLastTime: record.sourceLastTime,
        unitId,
        kind: unit.kind,
        sectionId: unit.sectionId,
        sourceProvenanceId: unit.sourceProvenanceId,
        sourceIdentityAuthority: unit.sourceIdentityAuthority,
        sourceIndex,
        sourceInstanceId: unit.sourceInstanceId,
        sourceTime: unit.sourceTime,
        sourceEndTime: unit.sourceEndTime,
        eraKey: unit.eraKey,
        tier: unit.tier,
        tierBasis: unit.tierBasis,
        placement: unit.placement,
        claim: unit.claim,
        chars: unit.verbatim.length,
        sha256,
        origin: unit.origin,
        recover,
        recordedAt,
        ...(unit.projection ? { projection: unit.projection } : {}),
      };
      if (this.rowsByUnit.has(ledgerKey(ownerInstanceId, unit.kind, unitId))) replaced += 1;
      ledgerEntries.push(row);
      sourceRows.push({
        ownerInstanceId,
        captureId,
        sourceIndex,
        unitId,
        sourceProvenanceId: unit.sourceProvenanceId,
        chars: unit.verbatim.length,
        sha256,
        verbatim: unit.verbatim,
        recordedAt,
      });
    }

    // Source rows first: a ledger row is never durable before the bytes behind
    // its handle. Removals ride the ledger stream in processing order so replay
    // applies them where they happened.
    if (sourceRows.length > 0) await appendFile(this.sourcePath, jsonLines(sourceRows), 'utf8');
    if (ledgerEntries.length > 0) await appendFile(this.ledgerPath, jsonLines(ledgerEntries), 'utf8');
    else {
      // Empty and wholly rejected captures have no rows to reserve their ID
      // after snapshot expiry. Keep only their identity, never source bodies.
      await appendFile(this.ledgerPath, jsonLines([{
        entryType: 'capture-identity', ownerInstanceId, captureId, recordedAt,
        sourceFirstTime: record.sourceFirstTime, sourceLastTime: record.sourceLastTime,
      }]), 'utf8');
    }
    for (const source of sourceRows) {
      this.sourcesByUnit.set(sourceUnitKey(ownerInstanceId, captureId, source.unitId), source);
    }
    this.observedCaptureKeys.add(captureOwnerKey(ownerInstanceId, captureId));
    const storedRows: StandaloneContinuityLedgerRow[] = [];
    for (const entry of ledgerEntries) {
      if ('unitKind' in entry) {
        this.applyRemoval(entry);
        continue;
      }
      storedRows.push(entry);
      this.rowsByUnit.set(ledgerKey(ownerInstanceId, entry.kind, entry.unitId), entry);
      this.rowsBySourceUnit.set(sourceUnitKey(ownerInstanceId, captureId, entry.unitId), entry);
      if (entry.sourceIndex !== null) {
        this.rowsBySourceIndex.set(
          sourceIndexKey(ownerInstanceId, captureId, entry.sourceIndex),
          entry,
        );
      }
    }
    await this.appendCaptureSnapshot(record, ownerInstanceId, captureId, recordedAt, storedRows, rejected.length);
    return { recorded: storedRows.length, replaced, rejected, removed };
  }

  /**
   * Append this capture's frozen membership and enforce bounded retention.
   * Membership is written once and never mutated, so an older capture keeps
   * answering after a later capture restamps or retires the same unit.
   */
  private async appendCaptureSnapshot(
    record: ContinuityLedgerCaptureRecord,
    ownerInstanceId: string,
    captureId: string,
    recordedAt: string,
    rows: readonly StandaloneContinuityLedgerRow[],
    rejectedUnits: number,
  ): Promise<void> {
    const snapshot: StandaloneContinuityCaptureSnapshot = {
      kind: 'capture-snapshot',
      inputSha256: captureInputSha256(record),
      ownerInstanceId,
      captureId,
      recordedAt,
      lifecycle: record.lifecycle,
      captureSourceStartIndex: record.sourceStartIndex,
      captureSourceEndIndexExclusive: record.sourceEndIndexExclusive,
      captureSourceFirstTime: record.sourceFirstTime,
      captureSourceLastTime: record.sourceLastTime,
      rows,
      rejectedUnits,
    };
    const history = this.capturesByOwner.get(ownerInstanceId) ?? [];
    history.push(snapshot);
    const overflowed = history.length > this.captureHistoryLimit;
    this.capturesByOwner.set(
      ownerInstanceId,
      overflowed ? history.slice(-this.captureHistoryLimit) : history,
    );
    if (!overflowed) {
      await appendFile(this.captureHistoryPath, jsonLines([snapshot]), 'utf8');
      return;
    }
    // Retention overflow rewrites the bound file atomically (tmp + rename). The
    // rewrite is bounded by the per-owner limit, so compaction cannot grow with
    // the number of captures ever recorded.
    const retained = [...this.capturesByOwner.values()]
      .flat()
      .sort((left, right) => (
        left.recordedAt.localeCompare(right.recordedAt)
        || left.captureId.localeCompare(right.captureId)
      ));
    const tempPath = `${this.captureHistoryPath}.tmp`;
    await writeFile(tempPath, jsonLines(retained), 'utf8');
    await rename(tempPath, this.captureHistoryPath);
  }
}
