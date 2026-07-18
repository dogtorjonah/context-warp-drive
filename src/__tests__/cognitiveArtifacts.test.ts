import { describe, it, expect } from 'vitest';
import {
  extractCognitiveArtifacts,
  renderCognitiveBlock,
  enrichFoldedBandBody,
} from '../cognitiveArtifacts.ts';
import type { FoldMessage } from '../rollingFold.ts';

describe('cognitiveArtifacts', () => {
  describe('extractCognitiveArtifacts', () => {
    it('extracts verdict glyph from assistant message', () => {
      const messages: FoldMessage[] = [
        { role: 'user', content: 'check the code' },
        { role: 'assistant', content: '🏁 **Done** — suite complete, no bugs found' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('verdict');
      expect(artifacts[0].glyph).toBe('🏁');
      expect(artifacts[0].headline).toContain('Done');
      expect(artifacts[0].messageIndex).toBe(1);
    });

    it('extracts hazard glyph from assistant message', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '⚠️ sync I/O risk in adminRoutes line 4042' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('hazard');
    });

    it('extracts blocked glyph from assistant message', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '❓ relay restart required before endpoint activates' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('blocked');
    });

    it('admits short in_progress/executing narrations as transient flow notes by default', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '🔍 investigating the fold code' },
        { role: 'assistant', content: '▶ applying fix now' },
        { role: 'assistant', content: '🏁 all done' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(3);
      expect(artifacts.map((a) => a.trust)).toEqual(['transient', 'transient', 'durable']);
      expect(artifacts[0].register).toBe('in_progress');
      expect(artifacts[0].glyph).toBe('🔍');
      expect(artifacts[1].register).toBe('executing');
      expect(artifacts[1].glyph).toBe('▶');
      expect(artifacts[2].register).toBe('verdict');
    });

    it('uses set_thought text as a clean fallback for a tool-only window', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '⟨tool set_thought {"thought":"Checking ledger immutability before the next fold"}⟩' },
        { role: 'assistant', content: '⟨tool result set_thought: accepted⟩' },
        { role: 'assistant', content: '⟨tool mcp__voxxo-core__atlas_query {"action":"lookup"}⟩' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({
        register: 'untagged',
        glyph: '💭',
        headline: 'Checking ledger immutability before the next fold',
        messageIndex: 0,
        trust: 'transient',
      });
      expect(artifacts[0].headline).not.toContain('⟨tool');
    });

    it('reads thought tools from structured provider shapes and dedupes repeats', () => {
      const messages = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'set_thought', input: { thought: 'Tracing the live caller' } }],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ function: { name: 'set_thought', arguments: '{"thought":"Tracing the live caller"}' } }],
        },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'tap_star', args: { note: 'Checking Gemini parity' } } }],
          content: null,
        },
      ] as unknown as FoldMessage[];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts.map((artifact) => artifact.headline)).toEqual([
        'Tracing the live caller',
        'Checking Gemini parity',
      ]);
      expect(artifacts.map((artifact) => artifact.messageIndex)).toEqual([1, 2]);
      expect(artifacts.every((artifact) => artifact.glyph === '💭')).toBe(true);
    });

    it('prefers genuine glyph speech over a thought-tool fallback', () => {
      const messages: FoldMessage[] = [{
        role: 'assistant',
        content: [
          { type: 'text', text: '🏁 Verified against the live ledger' },
          { type: 'tool_use', name: 'set_thought', input: { thought: 'Older working note' } },
        ],
      }];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('verdict');
      expect(artifacts[0].headline).toContain('Verified against the live ledger');
    });

    it('drops generic compact tool echoes instead of treating them as narration', () => {
      const messages: FoldMessage[] = [
        {
          role: 'assistant',
          content: '⟨tool mcp__voxxo-core__atlas_query {"action":"lookup"}⟩\n⟨tool result atlas_query: source text⟩',
        },
      ];
      expect(extractCognitiveArtifacts(messages)).toHaveLength(0);
    });

    it('excludes the transient lane entirely when includeFlowNotes is false', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '🔍 investigating the fold code' },
        { role: 'assistant', content: '▶ applying fix now' },
        { role: 'assistant', content: 'Single mount, always embedded.' },
        { role: 'assistant', content: '🏁 all done' },
      ];
      const artifacts = extractCognitiveArtifacts(messages, { includeFlowNotes: false });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('verdict');
      expect(artifacts[0].trust).toBe('durable');
      expect(extractCognitiveArtifacts([
        { role: 'assistant', content: '⟨tool set_thought {"thought":"transient only"}⟩' },
      ], { includeFlowNotes: false })).toHaveLength(0);
    });

    it('skips user messages', () => {
      const messages: FoldMessage[] = [
        { role: 'user', content: '🏁 this should not be extracted' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(0);
    });

    it('skips empty content', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '' },
        { role: 'assistant', content: null },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(0);
    });

    it('handles structured content (array of text parts)', () => {
      const messages: FoldMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '🏁 PASSED — all tests green' },
          ],
        },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('verdict');
    });

    it('extracts artifacts from Gemini role:model + parts shape', () => {
      // Gemini FC stores assistant output as { role: 'model', parts: [{ text }] }
      const messages = [
        { role: 'user', content: 'check this' },
        { role: 'model', parts: [{ text: '🏁 Gemini verdict survives fold' }] },
      ] as unknown as FoldMessage[];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('verdict');
      expect(artifacts[0].glyph).toBe('🏁');
      expect(artifacts[0].headline).toContain('Gemini verdict');
    });

    it('caps at newest MAX_ARTIFACTS (20)', () => {
      const messages: FoldMessage[] = [];
      for (let i = 0; i < 30; i++) {
        messages.push({ role: 'assistant', content: `🏁 result number ${i}` });
      }
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(20);
      expect(artifacts.map((artifact) => artifact.messageIndex)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 10),
      );
      expect(artifacts[0].headline).toContain('result number 10');
      expect(artifacts[19].headline).toContain('result number 29');
    });

    it('returns artifacts in chronological order', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '🏁 first verdict' },
        { role: 'user', content: 'ok' },
        { role: 'assistant', content: '⚠️ then a hazard' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(2);
      expect(artifacts[0].messageIndex).toBeLessThan(artifacts[1].messageIndex);
    });

    it('returns empty for empty messages array', () => {
      expect(extractCognitiveArtifacts([])).toHaveLength(0);
    });

    it('truncates headline at MAX_HEADLINE_CHARS', () => {
      const longText = '🏁 ' + 'x'.repeat(300);
      const messages: FoldMessage[] = [
        { role: 'assistant', content: longText },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].headline.length).toBeLessThanOrEqual(200);
    });
  });

  describe('renderCognitiveBlock', () => {
    it('renders artifacts as [cognitive] block with provenance', () => {
      const block = renderCognitiveBlock([
        { register: 'verdict', glyph: '🏁', headline: 'PASS — suite complete', messageIndex: 2, trust: 'durable' },
        { register: 'hazard', glyph: '⚠️', headline: 'sync I/O risk', messageIndex: 5, trust: 'durable' },
      ]);
      expect(block).toContain('[cognitive');
      expect(block).toContain('artifact=cognitive-waypoints class=synthesized-history');
      expect(block).toContain('source=fold-window:message#2..fold-window:message#6 n=4');
      expect(block).toContain('authority=historical-background');
      expect(block).toContain('host=embedded-message-suffix representation=alias');
      expect(block).toContain('↞ msg#2 · verdict');
      expect(block).toContain('🏁 PASS — suite complete');
      expect(block).toContain('↞ msg#5 · hazard');
      expect(block).toContain('⚠️ sync I/O risk');
      expect(block).not.toContain('transient flow notes');
    });

    it('adds the unverified-caveat line when transient flow notes are present', () => {
      const block = renderCognitiveBlock([
        { register: 'verdict', glyph: '🏁', headline: 'PASS', messageIndex: 1, trust: 'durable' },
        { register: 'untagged', glyph: '·', headline: 'Single mount, always embedded.', messageIndex: 3, trust: 'transient' },
      ]);
      expect(block).toContain(
        '— 🔍/▶/·/💭 lines are transient flow notes: unverified mid-flow narration, not conclusions —',
      );
      expect(block).toContain('↞ msg#3 · untagged');
      expect(block).toContain('· Single mount, always embedded.');
    });

    it('returns empty string for no artifacts', () => {
      expect(renderCognitiveBlock([])).toBe('');
    });
  });

  describe('formatCognitiveArtifactProvenance', () => {
    it('renders source message index and register', async () => {
      const { formatCognitiveArtifactProvenance } = await import('../cognitiveArtifacts.ts');
      expect(formatCognitiveArtifactProvenance({
        register: 'blocked',
        glyph: '❓',
        headline: 'relay restart required',
        messageIndex: 7,
        trust: 'durable',
      })).toBe('↞ msg#7 · blocked');
    });
  });

  describe('enrichFoldedBandBody', () => {
    it('appends cognitive block when artifacts are found', () => {
      const parts: string[] = ['[user]\ncheck it', '[assistant]\nhere is my work'];
      const rawMessages: FoldMessage[] = [
        { role: 'user', content: 'check it' },
        { role: 'assistant', content: '🏁 done, all good' },
      ];
      enrichFoldedBandBody(parts, rawMessages);
      expect(parts.length).toBe(3);
      expect(parts[2]).toContain('[cognitive');
      expect(parts[2]).toContain('🏁');
    });

    it('does not append anything when no artifacts found', () => {
      const parts: string[] = ['[user]\nhello', '[assistant]\n(api error)'];
      const rawMessages: FoldMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'API Error: 529 Overloaded' },
      ];
      enrichFoldedBandBody(parts, rawMessages);
      expect(parts.length).toBe(2);
    });

    it('forwards includeFlowNotes=false so a notes-only window appends no block', () => {
      const parts: string[] = [];
      const rawMessages: FoldMessage[] = [
        { role: 'assistant', content: 'short untagged diagnosis line' },
      ];
      enrichFoldedBandBody(parts, rawMessages, { includeFlowNotes: false });
      expect(parts.length).toBe(0);
      enrichFoldedBandBody(parts, rawMessages);
      expect(parts.length).toBe(1);
      expect(parts[0]).toContain('· short untagged diagnosis line');
    });

    it('returns the same array reference', () => {
      const parts: string[] = [];
      const rawMessages: FoldMessage[] = [];
      const result = enrichFoldedBandBody(parts, rawMessages);
      expect(result).toBe(parts);
    });
  });

  describe('transient flow-note lane', () => {
    it('admits short untagged narration with the · glyph and untagged register', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: 'Single mount, always `embedded`. Checking the tab set:' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('untagged');
      expect(artifacts[0].glyph).toBe('·');
      expect(artifacts[0].trust).toBe('transient');
      expect(artifacts[0].headline).toContain('Single mount');
    });

    it('drops long transient narrations (> 240 source chars)', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '🔍 ' + 'y'.repeat(300) },
        { role: 'assistant', content: 'z'.repeat(300) },
      ];
      expect(extractCognitiveArtifacts(messages)).toHaveLength(0);
    });

    it('never admits card-glyph-opened text (echo-contamination guard)', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '⌖ src/file.ts:20-45' },
        { role: 'assistant', content: '↞ msg#4 · verdict' },
        { role: 'assistant', content: '🗣 quoted moment from recall' },
      ];
      expect(extractCognitiveArtifacts(messages)).toHaveLength(0);
    });

    it('never admits host-synthetic error surrogates', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: 'API Error: 529 Overloaded. Try again in a moment.' },
        { role: 'assistant', content: '[Request interrupted by user]' },
      ];
      expect(extractCognitiveArtifacts(messages)).toHaveLength(0);
    });

    it('never admits leading-whitespace or markdown-container text', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '  indented quoted junk' },
        { role: 'assistant', content: '> quoted block' },
        { role: 'assistant', content: '# heading only' },
      ];
      expect(extractCognitiveArtifacts(messages)).toHaveLength(0);
    });

    it('caps flow notes at newest 6 without displacing durables', () => {
      const messages: FoldMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'assistant', content: `🔍 note number ${i}` });
      }
      messages.push({ role: 'assistant', content: '🏁 final verdict' });
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(7);
      const notes = artifacts.filter((a) => a.trust === 'transient');
      expect(notes).toHaveLength(6);
      expect(notes[0].headline).toContain('note number 4');
      expect(notes[5].headline).toContain('note number 9');
      expect(artifacts.filter((a) => a.trust === 'durable')).toHaveLength(1);
      expect(artifacts.map((a) => a.messageIndex)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    });
  });
});
