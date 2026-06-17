import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Resolve relative `.js` import specifiers to their sibling `.ts` source. The
 * engine files use `.js` specifiers that point at `.ts` files (ESM source-first
 * convention, mirrored from the relay), so the test transformer must map them.
 */
function preferTypeScriptSourceSiblings() {
  return {
    name: 'prefer-typescript-source-siblings',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) {
        return null;
      }
      const importerPath = importer.split('?')[0] ?? importer;
      const tsCandidate = path.resolve(path.dirname(importerPath), source.replace(/\.js$/, '.ts'));
      return existsSync(tsCandidate) ? tsCandidate : null;
    },
  };
}

export default defineConfig({
  plugins: [preferTypeScriptSourceSiblings()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
  },
});
