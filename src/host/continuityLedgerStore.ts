/**
 * Async standalone persistence for Context Warp continuity-ledger captures.
 *
 * The ledger file is content-free: it stores chronology, placement, handles,
 * char counts, and SHA-256 proofs, never source bodies. Exact canonical source
 * bytes live in a separate append-only source file addressed by the recovery
 * handles. Source rows are written first, so a ledger row is never advertised
 * before its authoritative backing bytes are durable.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  sha256ContinuityLedgerVerbatim,
  type ContinuityLedgerCaptureRecord,
  type ContinuityLedgerLifecycle,
  type ContinuityLedgerPlacement,
} from '../rebirthPackageV6.ts';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface StandaloneContinuityLedgerStoreOptions {
  /** Content-free append-only JSONL path. */
  readonly ledgerPath: string;
  /** Exact source JSONL path. Defaults to `${ledgerPath}.sources`. */
  readonly sourcePath?: string;
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
}

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

export interface StandaloneContinuityLedgerPage {
  readonly rows: readonly StandaloneContinuityLedgerRow[];
  readonly total: number;
  readonly offset: number;
  readonly nextOffset: number | null;
}

export interface StandaloneContinuityLedgerRecordResult {
  readonly recorded: number;
  readonly replaced: number;
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
  private readonly now: () => Date;
  private readonly rowsByUnit = new Map<string, StandaloneContinuityLedgerRow>();
  private readonly rowsBySourceIndex = new Map<string, StandaloneContinuityLedgerRow>();
  private readonly rowsBySourceUnit = new Map<string, StandaloneContinuityLedgerRow>();
  private readonly sourcesByUnit = new Map<string, StandaloneContinuitySourceRow>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: StandaloneContinuityLedgerStoreOptions) {
    this.ledgerPath = options.ledgerPath;
    this.sourcePath = options.sourcePath ?? `${options.ledgerPath}.sources`;
    this.now = options.now ?? (() => new Date());
  }

  static async open(
    options: StandaloneContinuityLedgerStoreOptions,
  ): Promise<StandaloneContinuityLedgerStore> {
    const store = new StandaloneContinuityLedgerStore(options);
    await Promise.all([
      mkdir(dirname(store.ledgerPath), { recursive: true }),
      mkdir(dirname(store.sourcePath), { recursive: true }),
    ]);
    const [ledgerValues, sourceValues] = await Promise.all([
      readJsonLines(store.ledgerPath),
      readJsonLines(store.sourcePath),
    ]);
    for (const value of sourceValues) {
      if (!isSourceRow(value)) continue;
      store.sourcesByUnit.set(
        sourceUnitKey(value.ownerInstanceId, value.captureId, value.unitId),
        value,
      );
    }
    for (const value of ledgerValues) {
      if (!isLedgerRow(value)) continue;
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
    const all = [...this.rowsByUnit.values()]
      .filter((row) => row.ownerInstanceId === query.ownerInstanceId)
      .filter((row) => query.captureId === undefined || row.captureId === query.captureId)
      .filter((row) => query.lifecycle === undefined || row.lifecycle === query.lifecycle)
      .filter((row) => unitIds === null || unitIds.has(row.unitId))
      .sort(chronologicalRows);
    const offset = boundedOffset(query.offset);
    const limit = boundedLimit(query.limit);
    const rows = all.slice(offset, offset + limit);
    const nextOffset = offset + rows.length < all.length ? offset + rows.length : null;
    return { rows, total: all.length, offset, nextOffset };
  }

  private async persistRecord(
    record: ContinuityLedgerCaptureRecord,
  ): Promise<StandaloneContinuityLedgerRecordResult> {
    const ownerInstanceId = record.ownerInstanceId.trim();
    const captureId = record.captureId.trim();
    if (!ownerInstanceId || !captureId) throw new Error('continuity-ledger record requires owner and capture id');
    const recordedAt = this.now().toISOString();
    const ledgerRows: StandaloneContinuityLedgerRow[] = [];
    const sourceRows: StandaloneContinuitySourceRow[] = [];
    const rejected: Array<{ unitId: string; reason: string }> = [];
    let replaced = 0;

    for (const unit of record.units) {
      const unitId = unit.unitId.trim();
      if (!unitId) {
        rejected.push({ unitId: '(missing)', reason: 'missing-unit-id' });
        continue;
      }
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
      };
      if (this.rowsByUnit.has(ledgerKey(ownerInstanceId, unit.kind, unitId))) replaced += 1;
      ledgerRows.push(row);
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

    if (sourceRows.length > 0) await appendFile(this.sourcePath, jsonLines(sourceRows), 'utf8');
    if (ledgerRows.length > 0) await appendFile(this.ledgerPath, jsonLines(ledgerRows), 'utf8');
    for (const source of sourceRows) {
      this.sourcesByUnit.set(sourceUnitKey(ownerInstanceId, captureId, source.unitId), source);
    }
    for (const row of ledgerRows) {
      this.rowsByUnit.set(ledgerKey(ownerInstanceId, row.kind, row.unitId), row);
      this.rowsBySourceUnit.set(sourceUnitKey(ownerInstanceId, captureId, row.unitId), row);
      if (row.sourceIndex !== null) {
        this.rowsBySourceIndex.set(
          sourceIndexKey(ownerInstanceId, captureId, row.sourceIndex),
          row,
        );
      }
    }
    return { recorded: ledgerRows.length, replaced, rejected };
  }
}
