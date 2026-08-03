import { describe, expect, it } from 'vitest';
import { extractApplyPatchTargetPaths } from '../editMutationTargets.ts';

describe('extractApplyPatchTargetPaths', () => {
  it('returns every update, add, and delete target in first-seen order', () => {
    const input = {
      input: [
        '*** Begin Patch',
        '*** Update File: relay/src/a.ts',
        '@@',
        '-old',
        '+new',
        '*** Add File: relay/src/b.ts',
        '+created',
        '*** Delete File: relay/src/c.ts',
        '*** End Patch',
      ].join('\n'),
    };

    expect(extractApplyPatchTargetPaths(input)).toEqual([
      'relay/src/a.ts',
      'relay/src/b.ts',
      'relay/src/c.ts',
    ]);
  });

  it('normalizes absolute workspace paths and removes normalized duplicates', () => {
    const input = {
      patch: [
        '*** Update File: /home/jonah/voxxo-swarm/relay/src/a.ts',
        '*** Update File: relay/src/a.ts',
        '*** Add File: /home/jonah/voxxo-swarm/relay/src/b.ts',
      ].join('\n'),
    };

    expect(extractApplyPatchTargetPaths(input)).toEqual([
      'relay/src/a.ts',
      'relay/src/b.ts',
    ]);
  });

  it('ignores non-header payload text and malformed inputs', () => {
    expect(extractApplyPatchTargetPaths({
      input: [
        '*** Begin Patch',
        '+*** Update File: payload-only.ts',
        '  *** Add File: indented.ts',
        '*** End Patch',
      ].join('\n'),
    })).toEqual([]);
    expect(extractApplyPatchTargetPaths({ input: 42 })).toEqual([]);
    expect(extractApplyPatchTargetPaths({})).toEqual([]);
  });
});
