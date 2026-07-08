import { describe, expect, it } from 'vitest';

import {
  buildMicroSeedBlock,
  extractMicroSeed,
  renderMicroSeedBlock,
} from '../src/microRebirthSeed.ts';
import type { FoldMessage } from '../src/rollingFold.ts';

const user = (content: string): FoldMessage => ({ role: 'user', content });
const assistant = (content: string): FoldMessage => ({ role: 'assistant', content });

describe('extractMicroSeed', () => {
  it('returns an empty seed for an empty window', () => {
    const seed = extractMicroSeed([]);
    expect(seed).toEqual({ lastAsk: null, inFlight: null, editPaths: [] });
    expect(renderMicroSeedBlock(seed)).toBe('');
    expect(buildMicroSeedBlock([])).toBe('');
  });

  it('picks the NEWEST genuine operator ask and skips ephemeral frames', () => {
    const seed = extractMicroSeed([
      user('fix the churning first please'),
      user('[DIGEST DELTA seq 1-4]\n  * peer: mcp_tool\n[END DIGEST DELTA]'),
      user('then build the micro seed'),
    ]);
    expect(seed.lastAsk).toBe('then build the micro seed');
  });

  it('skips bracketed coordination headers when extracting the ask headline', () => {
    const seed = extractMicroSeed([
      user('[Temporal Context] Session age: 1h\nbuild this bro super important'),
    ]);
    expect(seed.lastAsk).toBe('build this bro super important');
  });

  it('captures the newest assistant headline including transient registers', () => {
    const seed = extractMicroSeed([
      assistant('🏁 done with the last thing'),
      assistant('▶ Checking the counter mutation context before the next edit:'),
    ]);
    expect(seed.inFlight).toBe('▶ Checking the counter mutation context before the next edit:');
  });

  it('accepts Gemini model-role messages with parts arrays', () => {
    const geminiMsg = {
      role: 'model',
      content: null,
      parts: [{ text: '🔍 tracing the floor lifecycle' }],
    } as unknown as FoldMessage;
    const seed = extractMicroSeed([geminiMsg]);
    expect(seed.inFlight).toBe('🔍 tracing the floor lifecycle');
  });

  it('extracts edit paths from Anthropic-style tool_use content blocks', () => {
    const msg: FoldMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/ignored.ts' } },
        { type: 'tool_use', name: 'mcp__voxxo-swarm-bridge__partner_claim_file', input: { path: 'src/b.ts:20-45' } },
      ],
    };
    expect(extractMicroSeed([msg]).editPaths).toEqual(['src/a.ts', 'src/b.ts:20-45']);
  });

  it('extracts edit paths from OpenAI-style tool_calls with JSON string args', () => {
    const msg: FoldMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { function: { name: 'functions.edit_file', arguments: '{"file_path":"relay/src/x.ts"}' } },
        { function: { name: 'write_file', arguments: '{"file_path":"relay/src/y.ts"}' } },
        { function: { name: 'grep_search', arguments: '{"pattern":"foo"}' } },
        { function: { name: 'edit_file', arguments: 'not-json' } },
      ],
    };
    expect(extractMicroSeed([msg]).editPaths).toEqual(['relay/src/x.ts', 'relay/src/y.ts']);
  });

  it('dedupes edit paths preserving first-touch order', () => {
    const seed = extractMicroSeed([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/b.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } },
        ],
      },
    ]);
    expect(seed.editPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('truncates long headlines to the line cap', () => {
    const long = 'x'.repeat(500);
    const seed = extractMicroSeed([user(long)]);
    expect(seed.lastAsk).toHaveLength(200);
    expect(seed.lastAsk?.endsWith('…')).toBe(true);
  });
});

describe('renderMicroSeedBlock', () => {
  it('renders all three lines when present', () => {
    const block = renderMicroSeedBlock({
      lastAsk: 'fix the churning',
      inFlight: '▶ editing FoldSession',
      editPaths: ['src/a.ts', 'src/b.ts'],
    });
    expect(block).toBe(
      '[micro-seed]\n👤 ask: fix the churning\n▶ in flight: ▶ editing FoldSession\n✏ edits: src/a.ts, src/b.ts',
    );
  });

  it('omits empty components and collapses overflow paths', () => {
    const paths = Array.from({ length: 13 }, (_, i) => `src/f${i}.ts`);
    const block = renderMicroSeedBlock({ lastAsk: null, inFlight: null, editPaths: paths });
    expect(block).toContain('✏ edits: ');
    expect(block).toContain('(+3 more)');
    expect(block).not.toContain('👤 ask');
    expect(block).not.toContain('▶ in flight');
  });

  it('is byte-stable for identical input (no timestamps or counters)', () => {
    const messages = [user('same ask'), assistant('▶ same work')];
    expect(buildMicroSeedBlock(messages)).toBe(buildMicroSeedBlock(messages));
  });
});
