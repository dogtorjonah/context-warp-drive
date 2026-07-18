import { describe, expect, test } from 'vitest';

import {
  deriveEpisodesFromMessages,
  recallEpisodeCards,
  recordEpisodes,
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
