/**
 * context-warp-drive/episodes — durable episodic recall.
 *
 * Two layers:
 *   1. The turnkey PORTABLE store (flat exports below): derive sealed episodes
 *      from a message window, persist them, and page path-triggered recall cards
 *      back in — with a one-call SQLite reference store (`createEpisodeStore`,
 *      optional `better-sqlite3` peer). Start here.
 *   2. The advanced episodic engine (namespaced `richEpisodes`,
 *      `richEpisodeCapture`, `episodePathCanon`): chain cards with chapters /
 *      Δ-lines / bookends, narration mining, the boundary-injection state
 *      machine, epoch-seam capture, and canonical path identity. Bring your own
 *      store (see docs/architecture.md). Namespaced to avoid type-name
 *      collisions (both layers define `EpisodeMember`).
 */

// 1. Turnkey portable episodic recall.
export * from './episodes/episodeStore.ts';
export {
  createEpisodeStore,
  closeEpisodeStore,
  EPISODE_SCHEMA,
  type CreateEpisodeStoreOptions,
} from './episodes/sqliteStore.ts';

// 2. Advanced: rich episodic engine (namespaced).
export * as richEpisodes from './foldEpisodes.ts';
export * as richEpisodeCapture from './foldEpisodeCapture.ts';
export * as episodePathCanon from './foldPathCanon.ts';
