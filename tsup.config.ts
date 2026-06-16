import { defineConfig } from 'tsup';

// Multi-entry build so the dependency-free core (`context-warp-drive/fold`), the
// episodic layer (`context-warp-drive/episodes`, optional better-sqlite3 peer), and
// the glyph grammar (`context-warp-drive/glyphs`) can each be imported in isolation.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    fold: 'src/fold.ts',
    episodes: 'src/episodes.ts',
    glyphs: 'src/glyphs.ts',
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
