import { describe, expect, test } from 'vitest';

import {
  deriveEpisodesFromMessages,
  recallEpisodeCards,
  recordEpisodes,
  UNKNOWN_EPISODE_TIME,
  type PortableMessage,
} from '../src/episodes/episodeStore.ts';
import { closeEpisodeStore, createEpisodeStore } from '../src/episodes/sqliteStore.ts';

const sqliteAvailable = await import('better-sqlite3').then(
  () => true,
  () => false,
);

function verdictBurst(body: string, at: string): PortableMessage[] {
  return [
    {
      role: 'tool',
      content: 'edited src/evergreen.ts',
      timestamp: at,
      toolCalls: [{ name: 'Edit', input: { file_path: 'src/evergreen.ts' } }],
    },
    { role: 'assistant', content: `🏁 ${body}`, timestamp: at },
  ];
}

describe('portable episode-store lifetime eligibility', () => {
  test.runIf(sqliteAvailable)('keeps the oldest matching episode eligible beyond the former 200-row window', async () => {
    const db = await createEpisodeStore();
    try {
      const episodes = Array.from({ length: 220 }, (_, index) => deriveEpisodesFromMessages(
        verdictBurst(
          `evergreen checkpoint ${index}`,
          new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
        ),
        { sessionId: 'lifetime' },
      )[0]!).filter(Boolean);
      expect(recordEpisodes(db, episodes)).toEqual({ inserted: 220, skipped: 0 });

      const all = recallEpisodeCards(db, { paths: ['src/evergreen.ts'] });
      expect(all).toHaveLength(220);
      expect(all[0]?.text).toContain('evergreen checkpoint 219');
      expect(all[219]?.text).toContain('evergreen checkpoint 0');

      const rendered = recallEpisodeCards(db, { paths: ['src/evergreen.ts'], limit: 1 });
      expect(rendered).toHaveLength(1);
      expect(rendered[0]?.text).toContain('evergreen checkpoint 219');
    } finally {
      closeEpisodeStore(db);
    }
  });
});

describe('portable episode unknown source time', () => {
  test('seals unknown endpoints without substituting any clock, even when options.now is supplied', () => {
    const untimed: PortableMessage[] = [
      {
        role: 'tool',
        content: 'edited src/untimed.ts',
        toolCalls: [{ name: 'Edit', input: { file_path: 'src/untimed.ts' } }],
      },
      { role: 'assistant', content: '🏁 untimed checkpoint' },
    ];
    const derived = deriveEpisodesFromMessages(untimed, {
      sessionId: 'untimed',
      // Deprecated compatibility option: must be ignored, never substituted.
      now: '2030-01-01T00:00:00.000Z',
    });
    expect(derived).toHaveLength(1);
    expect(derived[0]?.startedAt).toBe(UNKNOWN_EPISODE_TIME);
    expect(derived[0]?.endedAt).toBe(UNKNOWN_EPISODE_TIME);
  });

  test('maps malformed provider time to unknown while preserving valid ISO text', () => {
    const malformed = deriveEpisodesFromMessages(
      verdictBurst('malformed-time checkpoint', 'not-a-provider-time'),
      { sessionId: 'malformed' },
    );
    expect(malformed[0]?.startedAt).toBe(UNKNOWN_EPISODE_TIME);
    expect(malformed[0]?.endedAt).toBe(UNKNOWN_EPISODE_TIME);

    const validSourceText = '2026-07-19T14:00:00.000+02:00';
    const valid = deriveEpisodesFromMessages(
      verdictBurst('valid-time checkpoint', validSourceText),
      { sessionId: 'valid' },
    );
    expect(valid[0]?.startedAt).toBe(validSourceText);
    expect(valid[0]?.endedAt).toBe(validSourceText);
  });

  test('keeps start and end times independently unknown', () => {
    const partial: PortableMessage[] = [
      {
        role: 'tool',
        content: 'edited src/partial.ts',
        toolCalls: [{ name: 'Edit', input: { file_path: 'src/partial.ts' } }],
      },
      { role: 'assistant', content: '🏁 partial checkpoint', timestamp: '2026-07-19T12:00:00.000Z' },
    ];
    const derived = deriveEpisodesFromMessages(partial, { sessionId: 'partial' });
    expect(derived).toHaveLength(1);
    expect(derived[0]?.startedAt).toBe(UNKNOWN_EPISODE_TIME);
    expect(derived[0]?.endedAt).toBe('2026-07-19T12:00:00.000Z');
  });

  test.runIf(sqliteAvailable)('orders recall cards with known source time ahead of unknown time', async () => {
    const db = await createEpisodeStore();
    try {
      const timed = deriveEpisodesFromMessages(
        verdictBurst('source-time checkpoint', '2026-07-19T12:00:00.000Z'),
        { sessionId: 'timed' },
      );
      const untimedMessages: PortableMessage[] = [
        {
          role: 'tool',
          content: 'edited src/evergreen.ts',
          toolCalls: [{ name: 'Edit', input: { file_path: 'src/evergreen.ts' } }],
        },
        { role: 'assistant', content: '🏁 unknown-time checkpoint' },
      ];
      const untimed = deriveEpisodesFromMessages(untimedMessages, { sessionId: 'untimed' });
      const malformed = {
        ...timed[0]!,
        id: 'episode-manual-malformed',
        sessionId: 'malformed-input',
        startedAt: 'malformed-start',
        endedAt: 'malformed-end',
        summary: 'malformed-time checkpoint',
      };
      expect(recordEpisodes(db, [...untimed, malformed, ...timed])).toEqual({ inserted: 3, skipped: 0 });

      const persistedMalformed = db.prepare(
        'SELECT started_at, ended_at FROM episodes WHERE id = ?',
      ).get(malformed.id) as { started_at: string; ended_at: string };
      expect(persistedMalformed).toEqual({
        started_at: UNKNOWN_EPISODE_TIME,
        ended_at: UNKNOWN_EPISODE_TIME,
      });
      // Simulate a legacy row written before persistence validation existed.
      db.prepare('UPDATE episodes SET ended_at = ? WHERE id = ?')
        .run('legacy-malformed-time', malformed.id);

      const cards = recallEpisodeCards(db, { paths: ['src/evergreen.ts'] });
      expect(cards).toHaveLength(3);
      expect(cards[0]?.text).toContain('source-time checkpoint');
      expect(cards.slice(1).map((card) => card.text)).toEqual(expect.arrayContaining([
        expect.stringContaining('unknown-time checkpoint'),
        expect.stringContaining('malformed-time checkpoint'),
      ]));
    } finally {
      closeEpisodeStore(db);
    }
  });
});
