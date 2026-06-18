import { defineConfig } from 'tsup';

// Multi-entry build so the dependency-free core (`context-warp-drive/fold`), the
// model-aware budget resolver (`context-warp-drive/budget`), the episodic layer
// (`context-warp-drive/episodes`, optional better-sqlite3 peer), the glyph
// grammar (`context-warp-drive/glyphs`), Overwatch
// (`context-warp-drive/overwatch`), the portable task rail
// (`context-warp-drive/task-rail`), and provider adapters can each be imported
// in isolation.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    fold: 'src/fold.ts',
    budget: 'src/contextBudget.ts',
    episodes: 'src/episodes.ts',
    glyphs: 'src/glyphs.ts',
    overwatch: 'src/overwatch.ts',
    'task-rail': 'src/taskRail.ts',
    'providers/anthropic': 'src/providers/anthropic.ts',
    'providers/geminiCli': 'src/providers/geminiCli.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // better-sqlite3 is an OPTIONAL peer (only the reference episode store needs
  // it); never bundle it.
  external: ['better-sqlite3'],
});
