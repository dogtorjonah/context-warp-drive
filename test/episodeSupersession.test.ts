import { describe, expect, test } from 'vitest';

import {
  deriveEpisodesFromMessages,
  extractSupersededEpisodeIds,
  hasSupersessionTable,
  recallEpisodeCards,
  recordEpisodes,
  supersedeEpisodes,
  SUPERSEDES_MARKER,
} from '../src/episodes/episodeStore.ts';
import type { PortableMessage } from '../src/episodes/episodeStore.ts';
import { closeEpisodeStore, createEpisodeStore } from '../src/episodes/sqliteStore.ts';

// better-sqlite3 is an OPTIONAL peer dependency — the sqlite-backed tests skip
// cleanly in checkouts that don't install it (e.g. the standalone drive repo).
const sqliteAvailable = await import('better-sqlite3').then(
  () => true,
  () => false,
);

function verdictBurst(path: string, body: string, at: string): PortableMessage[] {
  return [
    { role: 'tool', content: `edited ${path}`, timestamp: at, toolCalls: [{ name: 'Edit', input: { file_path: path } }] },
    { role: 'assistant', content: `🏁 ${body}`, timestamp: at },
  ];
}

describe('verdict supersession', () => {
  test('extractSupersededEpisodeIds parses marker and ASCII forms, deduplicated', () => {
    const text = [
      `Confirmed the real cause. ${SUPERSEDES_MARKER} episode-aabbccdd11223344`,
      'This supersedes episode-ffee998877665544 and again',
      `${SUPERSEDES_MARKER}: episode-aabbccdd11223344`,
    ].join('\n');
    expect(extractSupersededEpisodeIds(text)).toEqual([
      'episode-aabbccdd11223344',
      'episode-ffee998877665544',
    ]);
    expect(extractSupersededEpisodeIds('plain verdict, no refs')).toEqual([]);
  });

  test('derived episodes carry supersedes from durable annotation bodies', () => {
    const episodes = deriveEpisodesFromMessages(
      verdictBurst('src/a.ts', `fixed for real ${SUPERSEDES_MARKER} episode-1234567890abcdef`, '2026-07-02T10:00:00Z'),
      { sessionId: 's' },
    );
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.supersedes).toEqual(['episode-1234567890abcdef']);
  });

  test.runIf(sqliteAvailable)('superseded episodes stop surfacing in recall', async () => {
    const db = await createEpisodeStore();
    try {
      const [oldEpisode] = deriveEpisodesFromMessages(
        verdictBurst('src/shared.ts', 'old verdict: cause is X', '2026-07-01T10:00:00Z'),
        { sessionId: 's' },
      );
      expect(oldEpisode).toBeDefined();
      recordEpisodes(db, [oldEpisode!]);

      let cards = recallEpisodeCards(db, { paths: ['src/shared.ts'] });
      expect(cards.map((c) => c.episodeId)).toEqual([oldEpisode!.id]);

      // Newer verdict retires the old one via glyph marker at record time.
      const [newEpisode] = deriveEpisodesFromMessages(
        verdictBurst('src/shared.ts', `actual cause is Y ${SUPERSEDES_MARKER} ${oldEpisode!.id}`, '2026-07-02T10:00:00Z'),
        { sessionId: 's' },
      );
      recordEpisodes(db, [newEpisode!]);

      cards = recallEpisodeCards(db, { paths: ['src/shared.ts'] });
      expect(cards.map((c) => c.episodeId)).toEqual([newEpisode!.id]);
    } finally {
      closeEpisodeStore(db);
    }
  });

  test.runIf(sqliteAvailable)('explicit supersedeEpisodes API is idempotent and self-migrating on legacy stores', async () => {
    const db = await createEpisodeStore();
    try {
      // Simulate a legacy store created before the sidecar table existed.
      db.prepare('DROP TABLE episode_supersessions').run();
      expect(hasSupersessionTable(db)).toBe(false);

      const [episode] = deriveEpisodesFromMessages(
        verdictBurst('src/legacy.ts', 'legacy verdict', '2026-07-01T10:00:00Z'),
        { sessionId: 's' },
      );
      recordEpisodes(db, [episode!]);

      // Legacy path: recall works without the table (no throw, no exclusion).
      expect(recallEpisodeCards(db, { paths: ['src/legacy.ts'] })).toHaveLength(1);

      // Explicit retirement creates the table on demand.
      expect(supersedeEpisodes(db, [{ episodeId: episode!.id, reason: 'manual' }])).toBe(1);
      expect(hasSupersessionTable(db)).toBe(true);
      // Idempotent: second retirement records nothing new.
      expect(supersedeEpisodes(db, [{ episodeId: episode!.id, reason: 'manual' }])).toBe(0);

      expect(recallEpisodeCards(db, { paths: ['src/legacy.ts'] })).toHaveLength(0);
    } finally {
      closeEpisodeStore(db);
    }
  });

  test('an episode never supersedes itself via its own marker', () => {
    // A verdict body quoting its own id (echo case) must not self-retire.
    const messages = verdictBurst('src/self.ts', `noting ${SUPERSEDES_MARKER} episode-0000000000000000`, '2026-07-02T10:00:00Z');
    const [episode] = deriveEpisodesFromMessages(messages, { sessionId: 's' });
    expect(episode?.supersedes ?? []).not.toContain(episode?.id);
  });
});
