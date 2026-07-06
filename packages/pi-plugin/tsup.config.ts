import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Native modules and runtime-only deps — never bundle these
  external: [
    'better-sqlite3',
    'fs',
    'path',
    'os',
    'crypto',
    'child_process',
    'worker_threads',
    'url',
  ],
  loader: {
    '.ts': 'ts',
  },
});
