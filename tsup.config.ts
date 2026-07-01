import { defineConfig } from 'tsup';

// Multi-entry build so the dependency-free core (`context-warp-drive/fold`), the
// model-aware budget resolver (`context-warp-drive/budget`), the episodic layer
// (`context-warp-drive/episodes`, optional better-sqlite3 peer), the glyph
// grammar (`context-warp-drive/glyphs`), the portable task rail
// (`context-warp-drive/task-rail`), raw rebirth seed rendering
// (`context-warp-drive/raw-rebirth-seed`), and provider/CLI adapters can each
// be imported in isolation.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    fold: 'src/fold.ts',
    budget: 'src/contextBudget.ts',
    episodes: 'src/episodes.ts',
    glyphs: 'src/glyphs.ts',
    'task-rail': 'src/taskRail.ts',
    'raw-rebirth-seed': 'src/rawRebirthSeed.ts',
    'providers/anthropic': 'src/providers/anthropic.ts',
    'providers/geminiCli': 'src/providers/geminiCli.ts',
    'providers/codexCli': 'src/providers/codexCli.ts',
    'providers/claudeCli': 'src/providers/claudeCli.ts',
    'host/claudeCliLoop': 'src/host/claudeCliLoop.ts',
    'host/claudeTmuxLoop': 'src/host/claudeTmuxLoop.ts',
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
