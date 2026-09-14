import { afterEach, describe, expect, it, vi } from 'vitest';
import { continuityStamp, normalizeContinuityTimestamp } from '../continuityPresentation.ts';

afterEach(() => vi.restoreAllMocks());

describe('continuity timestamp normalization', () => {
  it('preserves parsing and display for offsets, invalid dates, absent times and capture years', () => {
    for (const at of [null, '', 'invalid', '2026-09-12T01:00:00+02:00', '2025-12-31T23:59:59Z', '+010000-01-01T00:00:00Z', '2026-01-02T03:04:05']) {
      for (const reference of [null, 'invalid', '2026-09-12T00:00:00Z', '2025-01-01T00:00:00Z']) {
        const ms = at ? Date.parse(at) : NaN;
        const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
        const refMs = reference ? Date.parse(reference) : NaN;
        const sameYear = Number.isFinite(refMs) && new Date(refMs).toISOString().slice(0, 4) === iso?.slice(0, 4);
        const expected = !at ? 'unknown' : !iso ? at : `${sameYear ? iso.slice(5, 10) : iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
        expect(continuityStamp(at, reference)).toBe(expected);
        expect(normalizeContinuityTimestamp(at)).toBe(iso);
      }
    }
  });

  it('reuses zoned results while leaving host-local parsing live', () => {
    const parse = vi.spyOn(Date, 'parse');
    const zoned = '2037-04-05T06:07:08+03:00';
    expect(normalizeContinuityTimestamp(zoned)).toBe('2037-04-05T03:07:08.000Z');
    expect(normalizeContinuityTimestamp(zoned)).toBe('2037-04-05T03:07:08.000Z');
    expect(parse.mock.calls.filter(([value]) => value === zoned)).toHaveLength(1);
    const local = '2037-04-05T06:07:08';
    normalizeContinuityTimestamp(local);
    normalizeContinuityTimestamp(local);
    expect(parse.mock.calls.filter(([value]) => value === local)).toHaveLength(2);
  });

  it('retains results through bounded-cache eviction', () => {
    const values = Array.from({ length: 8300 }, (_, index) => new Date(Date.UTC(2040, 0, 1) + index * 1000).toISOString());
    for (const value of values) expect(normalizeContinuityTimestamp(value)).toBe(value);
    const parse = vi.spyOn(Date, 'parse');
    expect(normalizeContinuityTimestamp(values[0]!)).toBe(values[0]);
    expect(parse.mock.calls).toEqual([[values[0]]]);
    parse.mockClear();
    expect(normalizeContinuityTimestamp(values[0]!)).toBe(values[0]);
    expect(normalizeContinuityTimestamp(values[8299]!)).toBe(values[8299]);
    expect(parse).not.toHaveBeenCalled();
    for (const value of [values[0]!, values[4096]!, values[8299]!]) expect(normalizeContinuityTimestamp(value)).toBe(value);
  });
});
