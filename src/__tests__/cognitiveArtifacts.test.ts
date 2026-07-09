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

    it('does not extract in_progress or executing glyphs', () => {
      const messages: FoldMessage[] = [
        { role: 'assistant', content: '🔍 investigating the fold code' },
        { role: 'assistant', content: '▶ applying fix now' },
        { role: 'assistant', content: '🏁 all done' },
      ];
      const artifacts = extractCognitiveArtifacts(messages);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].register).toBe('verdict');
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
        { register: 'verdict', glyph: '🏁', headline: 'PASS — suite complete', messageIndex: 2 },
        { register: 'hazard', glyph: '⚠️', headline: 'sync I/O risk', messageIndex: 5 },
      ]);
      expect(block).toContain('[cognitive');
      expect(block).toContain('↞ msg#2 · verdict');
      expect(block).toContain('🏁 PASS — suite complete');
      expect(block).toContain('↞ msg#5 · hazard');
      expect(block).toContain('⚠️ sync I/O risk');
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
      const parts: string[] = ['[user]\nhello', '[assistant]\nworld'];
      const rawMessages: FoldMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ];
      enrichFoldedBandBody(parts, rawMessages);
      expect(parts.length).toBe(2);
    });

    it('returns the same array reference', () => {
      const parts: string[] = [];
      const rawMessages: FoldMessage[] = [];
      const result = enrichFoldedBandBody(parts, rawMessages);
      expect(result).toBe(parts);
    });
  });
});
