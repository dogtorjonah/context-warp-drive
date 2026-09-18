import { describe, expect, it } from 'vitest';

import {
  buildRawRebirthSeedFromMessages,
  extractTailEpochConservedRebirthSections,
  renderRawRebirthSeed,
  TAIL_EPOCH_REQUIRED_RENDER_SECTION_IDS,
} from '../rawRebirthSeed.ts';
import {
  parseHistoricalPayloadRecord,
  renderHistoricalPayloadRecord,
} from '../rollingFold.ts';

/**
 * Tail-epoch band #1 absorbs the pinned rebirth package, so the render-mode
 * sections must survive the text round-trip exactly. Everything here guards the
 * recovery anchor: a section is recoverable only through the renderer's
 * single-line `[H1:rebirth-section]` envelope, so arbitrary operator text inside
 * a payload can never close the region early, and an unframed payload declines
 * the fold instead of silently truncating.
 */
describe('extractTailEpochConservedRebirthSections', () => {
  it('recognizes the canonical hard-epoch writer output', () => {
    const packageText = buildRawRebirthSeedFromMessages([
      { role: 'user', content: 'Repair the continuity reader 🧭', tsMs: Date.parse('2026-09-18T00:00:00Z') },
      { role: 'assistant', content: 'The compatibility defect is confirmed.', tsMs: Date.parse('2026-09-18T00:00:01Z') },
    ], { canonicalV6Fallback: true, predecessorName: 'test-agent' });
    expect(packageText).toContain('[REBIRTH-V6-SECTION');
    const conserved = extractTailEpochConservedRebirthSections(packageText);
    expect(conserved.presentSectionIds).toContain('lastUserAiMessages');
    expect(conserved.renderedSectionIds).toContain('lastUserAiMessages');
    expect(conserved.block).toContain('Repair the continuity reader 🧭');
    expect(conserved.block).toContain('The compatibility defect is confirmed.');
  });

  const v6Frame = (id: string, body: string, chars = body.length) =>
    `[REBIRTH-V6-SECTION id=${id} order=1 dir=asc chars=${chars}]\n${body}\n[/REBIRTH-V6-SECTION]`;

  it('conserves current dialogue, boundary and edit frames byte-for-byte', () => {
    const bodies = [
      v6Frame('boundaryAndActiveTask', 'Exact request: fix this 🧭\n[/REBIRTH-V6-SECTION]\nkeep the rest'),
      v6Frame('recentConversation', 'User and assistant evidence\n── Active Edit Delta ──\nquoted header'),
      v6Frame('operatorVault', 'Older operator evidence'),
      `── Active Edit Delta ──\n${v6Frame('activeEditDelta', 'source edit\n')}`,
    ];
    const conserved = extractTailEpochConservedRebirthSections(bodies.join('\n\n'));
    expect(conserved.renderedSectionIds).toEqual([...TAIL_EPOCH_REQUIRED_RENDER_SECTION_IDS]);
    for (const body of bodies) expect(conserved.block).toContain(body.replace(/^── Active Edit Delta ──\n/, ''));
  });

  it.each(['bad-count', 'missing-close', 'malformed-header'])('rejects a %s sibling despite valid dialogue', (damage: string) => {
    const valid = v6Frame('recentConversation', 'Already conserved');
    const broken = damage === 'bad-count'
      ? v6Frame('boundaryAndActiveTask', 'Unrecovered request', 3)
      : damage === 'missing-close'
        ? v6Frame('boundaryAndActiveTask', 'Unrecovered request').replace('[/REBIRTH-V6-SECTION]', '')
        : '[REBIRTH-V6-SECTION id=boundaryAndActiveTask chars=oops]\nUnrecovered request';
    const conserved = extractTailEpochConservedRebirthSections(`${valid}\n${broken}\n${valid}`);
    expect(conserved.presentSectionIds).toContain('lastUserAiMessages');
    expect(conserved.renderedSectionIds).not.toContain('lastUserAiMessages');
    expect(conserved.block).toBe('');
  });

  it('does not credit legacy or current frames quoted inside pointer-only sections', () => {
    const quoted = v6Frame('executionState', `${v6Frame('recentConversation', 'quoted')}\n── Active Edit Delta ──\nnot an edit`);
    expect(extractTailEpochConservedRebirthSections(quoted).presentSectionIds).toEqual([]);
  });

  it('does not credit an empty current dialogue frame', () => {
    const conserved = extractTailEpochConservedRebirthSections(v6Frame('recentConversation', ''));
    expect(conserved.presentSectionIds).toContain('lastUserAiMessages');
    expect(conserved.renderedSectionIds).toEqual([]);
  });

  it('keeps a current heading required when its frame is missing', () => {
    const conserved = extractTailEpochConservedRebirthSections('── Boundary and Active Task ──\ntruncated');
    expect(conserved.presentSectionIds).toContain('lastUserAiMessages');
    expect(conserved.renderedSectionIds).toEqual([]);
  });

  it('conserves the raw hot suffix without interpreting its quoted frames', () => {
    const request = 'Quoted parser input:\n[REBIRTH-V6-SECTION id=activeEditDelta chars=wrong]\n[/RAW-HOT-TAIL]\nKEEP-THIS-TAIL';
    const packageText = buildRawRebirthSeedFromMessages([
      { role: 'user', content: request, tsMs: Date.parse('2026-09-18T00:00:00Z'), sourceIdentity: 'raw-request' },
    ], { canonicalV6Fallback: true, predecessorName: 'test-agent' });
    expect(packageText).toContain('[RAW-HOT-TAIL]');
    const conserved = extractTailEpochConservedRebirthSections(packageText);
    expect(conserved.renderedSectionIds).toContain('lastUserAiMessages');
    expect(conserved.block).toContain(request);
    expect(conserved.block).toContain(packageText.slice(packageText.indexOf('── Raw hot tail ──')));
    const truncated = extractTailEpochConservedRebirthSections(packageText.slice(0, -5));
    expect(truncated.renderedSectionIds).not.toContain('lastUserAiMessages');
  });

  it('conserves the whole live request when the operator pasted a decorated line', () => {
    const request = [
      'Fix the fold. The region I mean is:',
      '── Some Section ──',
      'DO-NOT-LOSE-THIS-REQUIREMENT',
      'and keep my second paragraph too.',
    ].join('\n');
    const packageText = renderRawRebirthSeed({
      predecessorName: 'predecessor',
      triggeringUserMessage: request,
      userMessageTriggered: true,
      activeEditDelta: 'relay/src/example.ts edited',
    });
    expect(packageText).toContain('DO-NOT-LOSE-THIS-REQUIREMENT');

    const conserved = extractTailEpochConservedRebirthSections(packageText);
    // The gate reported both sections rendered, so the block must actually hold
    // them; a truncated copy here would authorize deleting the pinned row.
    expect(conserved.renderedSectionIds).toEqual([...TAIL_EPOCH_REQUIRED_RENDER_SECTION_IDS]);
    expect(conserved.block).toContain('DO-NOT-LOSE-THIS-REQUIREMENT');
    expect(conserved.block).toContain('keep my second paragraph too.');
    expect(conserved.block).toContain('── Some Section ──');
    expect(conserved.block).toContain('relay/src/example.ts edited');
  });

  it('conserves the live request when the operator quoted a render-section header', () => {
    const request = [
      'The section that broke is:',
      '── Active Edit Delta ──',
      'DO-NOT-LOSE-THIS-REQUIREMENT',
    ].join('\n');
    const packageText = renderRawRebirthSeed({
      predecessorName: 'predecessor',
      triggeringUserMessage: request,
      userMessageTriggered: true,
      activeEditDelta: 'relay/src/example.ts edited',
    });

    const conserved = extractTailEpochConservedRebirthSections(packageText);
    expect(conserved.renderedSectionIds).toEqual([...TAIL_EPOCH_REQUIRED_RENDER_SECTION_IDS]);
    expect(conserved.block).toContain('DO-NOT-LOSE-THIS-REQUIREMENT');
    expect(conserved.block).toContain('relay/src/example.ts edited');
  });

  it('conserves the historical variant of the last user + AI messages', () => {
    const packageText = renderRawRebirthSeed({
      predecessorName: 'predecessor',
      lastUserAiMessages: '👤 LAST USER MESSAGE:\nkeep me\n🤖 LAST AI MESSAGE:\nCRITICAL-AI-LINE',
      activeEditDelta: 'relay/src/example.ts edited',
    });
    const conserved = extractTailEpochConservedRebirthSections(packageText);
    expect(conserved.renderedSectionIds).toEqual([...TAIL_EPOCH_REQUIRED_RENDER_SECTION_IDS]);
    expect(conserved.block).toContain('keep me');
    expect(conserved.block).toContain('CRITICAL-AI-LINE');
  });

  it('still separates a header-present-but-empty section from a rendered one', () => {
    const conserved = extractTailEpochConservedRebirthSections([
      '── Last User + AI Messages (READ FIRST) ──',
      renderHistoricalPayloadRecord('rebirth-section', '   '),
      '── Active Edit Delta ──',
      renderHistoricalPayloadRecord('rebirth-section', 'edited'),
    ].join('\n'));
    expect(conserved.presentSectionIds).toContain('lastUserAiMessages');
    expect(conserved.renderedSectionIds).not.toContain('lastUserAiMessages');
    expect(conserved.renderedSectionIds).toContain('activeEditDelta');
  });

  /**
   * The header vocabulary decides which disposition a package gets, and a miss
   * is the SILENT one: an unmatched header means nothing is required, so the
   * package is absorbed and the pinned row deleted with its content unrecovered.
   * Both cases below were measured against the pinned-package corpus — 21 packs
   * carried the singular header, none carried an indented one — so the indented
   * case guards a producer change while the singular case repairs a real loss.
   */
  it('matches a render-section header that carries leading indentation', () => {
    const conserved = extractTailEpochConservedRebirthSections([
      '    ── Active Edit Delta ──',
      renderHistoricalPayloadRecord('rebirth-section', 'INDENTED-SECTION-PAYLOAD'),
    ].join('\n'));

    expect(conserved.presentSectionIds).toEqual(['activeEditDelta']);
    expect(conserved.renderedSectionIds).toEqual(['activeEditDelta']);
    expect(conserved.block).toContain('INDENTED-SECTION-PAYLOAD');
  });

  it('resolves the singular predecessor spelling to lastUserAiMessages', () => {
    const conserved = extractTailEpochConservedRebirthSections([
      '── Last AI Message (READ FIRST) ──',
      renderHistoricalPayloadRecord('rebirth-section', 'LEGACY-SINGULAR-PAYLOAD'),
    ].join('\n'));

    expect(conserved.presentSectionIds).toEqual(['lastUserAiMessages']);
    expect(conserved.renderedSectionIds).toEqual(['lastUserAiMessages']);
    expect(conserved.block).toContain('LEGACY-SINGULAR-PAYLOAD');
  });

  it('leaves the singular header present-but-unrendered when its payload is unframed', () => {
    // The measured shape of the 21 corpus packs: matching the header does not
    // recover anything by itself, it converts a silent absorption into a
    // fail-closed one that the band can then degrade instead of escalate.
    const conserved = extractTailEpochConservedRebirthSections([
      '── Last AI Message (READ FIRST) ──',
      'raw payload written by the unframed producer',
    ].join('\n'));

    expect(conserved.presentSectionIds).toEqual(['lastUserAiMessages']);
    expect(conserved.renderedSectionIds).toEqual([]);
    expect(conserved.block).toBe('');
  });

  /**
   * The envelope is what makes recovery safe: every character of the payload,
   * including lines that look exactly like renderer headers, is JSON-escaped onto
   * one line, so the region cannot be closed early by its own content.
   */
  it('conserves a payload containing renderer-shaped headers verbatim', () => {
    const payload = [
      'first payload',
      '── Cognitive Artifacts (chronological source-stamped cognition) ──',
      '── 2026-07-26 ──',
      'trailing payload',
    ].join('\n');
    const conserved = extractTailEpochConservedRebirthSections([
      '── Active Edit Delta ──',
      renderHistoricalPayloadRecord('rebirth-section', payload),
    ].join('\n'));

    expect(conserved.renderedSectionIds).toEqual(['activeEditDelta']);
    const record = conserved.block.split('\n').at(-1) ?? '';
    expect(parseHistoricalPayloadRecord(record)?.text).toBe(payload);
  });

  /**
   * Fail-closed guard. Renderers emit computed headers
   * (`── ${heading} ──`, `── Hot Trail (N newest events) ──`), so no header
   * whitelist can be complete and no text-boundary rule can be both lossless and
   * precise. A payload without the envelope is therefore unrecoverable: the
   * section stays present-but-unrendered so the coverage gate declines the fold
   * and the pinned package row survives.
   */
  it('declines an unframed payload instead of guessing its end', () => {
    const conserved = extractTailEpochConservedRebirthSections([
      '── Active Edit Delta ──',
      'plain unframed payload',
      '── Cognitive Artifacts (chronological source-stamped cognition) ──',
      'content belonging to another section',
    ].join('\n'));

    expect(conserved.presentSectionIds).toEqual(['activeEditDelta']);
    expect(conserved.renderedSectionIds).toEqual([]);
    expect(conserved.block).toBe('');
  });

  /**
   * `lastUserAiMessages` owns two physical carriers — the live operator request
   * and the historical remainder. Coverage must be proved per occurrence, not per
   * logical id: crediting the id lets the intact remainder vouch for a corrupt
   * live frame, and the gate then authorizes deleting the only full copy of the
   * request it failed to recover.
   */
  it('refuses coverage when one carrier of a section is unrecoverable', () => {
    const request = 'DO-NOT-LOSE-THIS-REQUIREMENT';
    const rendered = renderRawRebirthSeed({
      predecessorName: 'predecessor',
      triggeringUserMessage: request,
      userMessageTriggered: true,
      activeEditDelta: 'relay/src/example.ts edited',
    });
    // Corrupt only the live frame's character receipt; every other carrier stays
    // byte-valid.
    const corrupted = rendered.replace(
      `conserve-region chars=${request.length}]`,
      `conserve-region chars=${request.length + 1}]`,
    );
    expect(corrupted).not.toBe(rendered);
    const packageText = [
      corrupted,
      '── Historical AI / Runtime Remainder ──',
      renderHistoricalPayloadRecord('rebirth-section', 'intact remainder'),
    ].join('\n');

    const conserved = extractTailEpochConservedRebirthSections(packageText);
    expect(conserved.presentSectionIds).toContain('lastUserAiMessages');
    expect(conserved.renderedSectionIds).not.toContain('lastUserAiMessages');
    // The valid sibling carrier must not ride along as a decoy copy either.
    expect(conserved.block).not.toContain('intact remainder');
    expect(conserved.block).not.toContain(request);
  });

  it('never absorbs a following section into a conserved block', () => {
    const packageText = renderRawRebirthSeed({
      predecessorName: 'predecessor',
      triggeringUserMessage: 'plain live request',
      userMessageTriggered: true,
      activeEditDelta: 'relay/src/example.ts edited',
      currentThread: 'CURRENT-THREAD-SENTINEL',
      thinkingTrail: 'ACTIVITY-LOG-SENTINEL',
      packageBudget: 200_000,
    });

    const conserved = extractTailEpochConservedRebirthSections(packageText);
    expect(conserved.renderedSectionIds).toEqual([...TAIL_EPOCH_REQUIRED_RENDER_SECTION_IDS]);
    // Pointer-mode sections are represented by live state, so absorbing them
    // into every band would compound synthetic context epoch after epoch.
    expect(conserved.block).not.toContain('CURRENT-THREAD-SENTINEL');
    expect(conserved.block).not.toContain('ACTIVITY-LOG-SENTINEL');
  });
});
