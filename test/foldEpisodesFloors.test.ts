/**
 * foldEpisodesFloors.test.ts — Gate 2 tests for chunking floor primitives.
 *
 * Verifies:
 * 1. Flag-off byte-identical behavior (no floor options = same burst output)
 * 2. Value-floor: gap widening without force-split changes
 * 3. Tap-star floor: bursts with a star pin hold open longer
 * 4. Affinity-floor: high-affinity pairs extend gap; low-affinity don't
 * 5. Voice floor: burst with no voice seals on gap; burst with voice holds
 */
import { describe, it, expect } from 'vitest';
import {
  groupTouchesIntoEpisodes,
  type EpisodeTouch,
  type EpisodeGroupingOptions,
  type EpisodeBurst,
} from '../src/foldEpisodes.ts';
import {
  deriveEpisodesFromMessages,
  type EpisodeCaptureIdentity,
} from '../src/foldEpisodeCapture.ts';
import type { FoldMessage } from '../src/fold.ts';

// --- helpers ---

function makeTouch(
  eventIndex: number,
  path: string,
  kind: 'edit' | 'read' | 'mention' = 'edit',
  tsOffsetMin = 0,
): EpisodeTouch {
  const base = Date.UTC(2026, 0, 1); // fixed epoch for determinism
  return {
    eventIndex,
    path,
    kind,
    ts: new Date(base + tsOffsetMin * 60_000).toISOString(),
  };
}

function toolUse(id: string, path: string): FoldMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] };
}

function toolResult(id: string, content: string): FoldMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}

/** Compare two sets of bursts by their start/end event index ranges. */
function burstRanges(bursts: EpisodeBurst[]): string {
  return bursts.map((b) => `[${b.startEventIndex},${b.endEventIndex}]`).join(' ');
}

/**
 * Two bursts separated by a time gap but within event-gap threshold.
 * Event gap = 3 (under gapEvents=5). Time gap = 30 min (over gapMs=10min).
 * maxBurstMs set high so force-split never fires (tests the gap multiplier only).
 */
const TWO_BURST_TOUCHES: EpisodeTouch[] = [
  makeTouch(0, 'src/a.ts', 'edit', 0),
  makeTouch(1, 'src/b.ts', 'edit', 1),
  // event gap = 3 (< gapEvents=5). time gap = 30 min (> gapMs=10min).
  makeTouch(4, 'src/a.ts', 'edit', 30),
  makeTouch(5, 'src/b.ts', 'edit', 31),
];

const DEFAULT_OPTS: EpisodeGroupingOptions = {
  gapEvents: 5,
  gapMs: 10 * 60 * 1000, // 10 min
  // Override force-split caps so they don't interfere with floor tests.
  // Default maxBurstMs=30min would split at 31min total span.
  maxBurstMs: 120 * 60 * 1000, // 120 min — never triggers in these tests
};

const CAPTURE_ID: EpisodeCaptureIdentity = {
  workspace: 'test',
  instanceId: 'floor-test',
  closedBy: 'epoch',
  nowIso: '2026-01-01T01:00:00.000Z',
};

// --- tests ---

describe('groupTouchesIntoEpisodes — floor primitives', () => {
  describe('1. flag-off byte-identical', () => {
    it('produces same bursts with no floor options as with empty floor options', () => {
      const base = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, DEFAULT_OPTS);
      const withEmptyFloors = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, {
        ...DEFAULT_OPTS,
        valueFloorPaths: [],
        tapStarFloorEventIndexes: [],
        affinityFloor: {},
      });
      expect(burstRanges(withEmptyFloors)).toBe(burstRanges(base));
    });

    it('produces same bursts with undefined floors as with no floors', () => {
      const implicit = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, DEFAULT_OPTS);
      const explicit = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, {
        ...DEFAULT_OPTS,
        valueFloorPaths: undefined,
        valueFloorGapMultiplier: undefined,
        tapStarFloorEventIndexes: undefined,
        tapStarFloorGapMultiplier: undefined,
        affinityFloor: undefined,
        affinityGapThreshold: undefined,
        affinityGapMultiplier: undefined,
      });
      expect(burstRanges(explicit)).toBe(burstRanges(implicit));
    });
  });

  describe('2. value-floor gap widening', () => {
    it('holds a value-floor burst open past the default gap', () => {
      // Without value floor: two separate bursts (30 min > 10 min gap)
      const noFloor = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, DEFAULT_OPTS);
      expect(noFloor.length).toBe(2);

      // With value floor on src/a.ts, multiplier 4.0: gap threshold = 40 min > 30 min
      const withFloor = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, {
        ...DEFAULT_OPTS,
        valueFloorPaths: ['src/a.ts'],
        valueFloorGapMultiplier: 4.0,
      });
      expect(withFloor.length).toBe(1);
    });

    it('does not widen when multiplier is ≤ 1', () => {
      const withFloor = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, {
        ...DEFAULT_OPTS,
        valueFloorPaths: ['src/a.ts'],
        valueFloorGapMultiplier: 1.0,
      });
      expect(withFloor.length).toBe(2);
    });

    it('force-split caps are unchanged', () => {
      // Long continuous burst; force-split should fire regardless of value floor
      const longBurst: EpisodeTouch[] = [];
      for (let i = 0; i < 20; i++) {
        longBurst.push(makeTouch(i, 'src/val.ts', 'edit', i));
      }
      const result = groupTouchesIntoEpisodes(longBurst, {
        ...DEFAULT_OPTS,
        maxBurstEvents: 10,
        valueFloorPaths: ['src/val.ts'],
        valueFloorGapMultiplier: 100,
      });
      expect(result.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('3. tap-star floor', () => {
    it('holds a burst with a star pin open longer than default gap', () => {
      const noStar = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, DEFAULT_OPTS);
      expect(noStar.length).toBe(2);

      const withStar = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, {
        ...DEFAULT_OPTS,
        tapStarFloorEventIndexes: [0],
        tapStarFloorGapMultiplier: 4.0, // 10 × 4 = 40 min > 30 min
      });
      expect(withStar.length).toBe(1);
    });

    it('star priority overrides value floor', () => {
      // Both value and star set; star multiplier wins
      const touches: EpisodeTouch[] = [
        makeTouch(0, 'src/a.ts', 'edit', 0),
        makeTouch(2, 'src/a.ts', 'edit', 25),
      ];
      const result = groupTouchesIntoEpisodes(touches, {
        ...DEFAULT_OPTS,
        valueFloorPaths: ['src/a.ts'],
        valueFloorGapMultiplier: 2.0, // 10 × 2 = 20 min threshold
        tapStarFloorEventIndexes: [0],
        tapStarFloorGapMultiplier: 4.0, // 10 × 4 = 40 min threshold
      });
      // 25 min gap: star holds (40), value would seal (20). Star wins → 1 burst.
      expect(result.length).toBe(1);
    });
  });

  describe('4. affinity-floor', () => {
    it('extends gap when affinity score ≥ threshold', () => {
      // a.ts → a.ts affinity = 0.9. Threshold 0.5, multiplier 4.0
      // 30 min gap: under 40 (10×4) → one burst
      const result = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, {
        ...DEFAULT_OPTS,
        affinityFloor: {
          'src/a.ts': { 'src/a.ts': 0.9 },
        },
        affinityGapThreshold: 0.5,
        affinityGapMultiplier: 4.0,
      });
      expect(result.length).toBe(1);
    });

    it('does NOT extend gap when affinity score < threshold', () => {
      const result = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, {
        ...DEFAULT_OPTS,
        affinityFloor: {
          'src/a.ts': { 'src/a.ts': 0.3 },
        },
        affinityGapThreshold: 0.5,
        affinityGapMultiplier: 4.0,
      });
      expect(result.length).toBe(2);
    });

    it('empty affinityFloor = byte-identical to no affinityFloor', () => {
      const without = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, DEFAULT_OPTS);
      const empty = groupTouchesIntoEpisodes(TWO_BURST_TOUCHES, {
        ...DEFAULT_OPTS,
        affinityFloor: {},
      });
      expect(burstRanges(empty)).toBe(burstRanges(without));
    });

    it('deriveEpisodesFromMessages threads affinityFloor into grouping', () => {
      const messages: FoldMessage[] = [
        toolUse('tu1', 'src/a.ts'),
        toolResult('tu1', 'a'),
        toolUse('tu2', 'src/b.ts'),
        toolResult('tu2', 'b'),
      ];
      const timestamps = [
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:01.000Z',
        '2026-01-01T00:30:00.000Z',
        '2026-01-01T00:30:01.000Z',
      ];

      const without = deriveEpisodesFromMessages(messages, 0, CAPTURE_ID, {
        sealTrailing: true,
        timestamps,
      });
      const empty = deriveEpisodesFromMessages(messages, 0, CAPTURE_ID, {
        sealTrailing: true,
        timestamps,
        affinityFloor: {},
      });
      const withAffinity = deriveEpisodesFromMessages(messages, 0, CAPTURE_ID, {
        sealTrailing: true,
        timestamps,
        affinityFloor: {
          'src/a.ts': { 'src/b.ts': 1 },
        },
      });

      expect(without.episodes.length).toBe(2);
      expect(empty.episodes.map((e) => e.members.map((m) => m.path))).toEqual(
        without.episodes.map((e) => e.members.map((m) => m.path)),
      );
      expect(withAffinity.episodes.length).toBe(1);
      expect(withAffinity.episodes[0]?.members.map((m) => m.path)).toEqual(['src/a.ts', 'src/b.ts']);
    });
  });

  describe('5. voice floor invariants', () => {
    const VOICE_TOUCHES: EpisodeTouch[] = [
      makeTouch(0, 'src/a.ts', 'edit', 0),
      makeTouch(1, 'src/b.ts', 'read', 1),
      // event gap = 3, time gap = 30 min
      makeTouch(4, 'src/c.ts', 'edit', 30),
    ];

    it('voiceless burst seals on gap (no voiceFloor)', () => {
      const result = groupTouchesIntoEpisodes(VOICE_TOUCHES, DEFAULT_OPTS);
      expect(result.length).toBe(2);
    });

    it('voiceFloor holds burst open when voice exists in range', () => {
      // With voiceFloor + voice at event 0: burst 1 has voice, should seal normally
      const result = groupTouchesIntoEpisodes(VOICE_TOUCHES, {
        ...DEFAULT_OPTS,
        voiceFloor: true,
        voiceEventIndexes: [0],
      });
      expect(result.length).toBe(2);
    });

    it('voiceFloor prevents voiceless burst from sealing on gap when voice data exists elsewhere', () => {
      // Voice floor is enabled with a voice annotation at event 10 (in burst 2).
      // Burst 1 (events 0-1) has no voice in its range → voice floor holds it open
      // → it absorbs burst 2's touch (event 4) where voice at event 10 is in range.
      // The voice floor check: burstHasVoice([0,1], prevBurstEnd=0, voiceIdxSet={10})
      // → voice at event 10 is NOT in [0,1] → no voice → hold open.
      // Then at event 4: current=[0,1,4], burstHasVoice checks event 10 in [0,4]? No.
      // So it keeps holding until voice arrives or force-split fires.
      // With 3 touches total and no force-split, result should be 1 burst.
      const result = groupTouchesIntoEpisodes(VOICE_TOUCHES, {
        ...DEFAULT_OPTS,
        voiceFloor: true,
        voiceEventIndexes: [10], // voice exists at event 10 (beyond our touches)
      });
      // Voice floor holds burst 1 open since no voice in [0,1] or [0,4]
      expect(result.length).toBe(1);
    });
  });
});
