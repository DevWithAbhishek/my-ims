import { hasNoAllowedContext, projectPostmortemInput } from './postmortem.allowlist.js';

describe('postmortem allow-list', () => {
  const source = {
    description: 'The checkout was down',
    severity: 'P1' as const,
    comments: [
      { title: 'First look', description: 'pool exhausted' },
      { title: null, description: 'restarted' },
    ],
  };

  it('projects exactly description, severity and the comments (title, description)', () => {
    const input = projectPostmortemInput({
      ...source,
      resolutionSummary: 'MUST-NOT-LEAK',
      alertPayload: { a: 1 },
      createdById: 'MUST-NOT-LEAK',
    } as typeof source);
    expect(Object.keys(input).sort()).toEqual(['comments', 'description', 'severity']);
    expect(input.description).toBe('The checkout was down');
    expect(input.severity).toBe('P1');
    expect(input.comments.map((c) => JSON.parse(c))).toEqual([
      { title: 'First look', description: 'pool exhausted' },
      { title: null, description: 'restarted' },
    ]);
    expect(JSON.stringify(input)).not.toContain('MUST-NOT-LEAK');
  });

  it('comment objects carry nothing but title and description', () => {
    const input = projectPostmortemInput({
      ...source,
      comments: [{ title: 't', description: 'd', authorId: 'MUST-NOT-LEAK' } as never],
    });
    expect(JSON.parse(input.comments[0]!)).toEqual({ title: 't', description: 'd' });
  });

  it.each([
    ['no description, no comments', { ...source, description: '', comments: [] }, true],
    ['blank description, no comments', { ...source, description: '  \n', comments: [] }, true],
    ['a description only', { ...source, comments: [] }, false],
    ['comments only', { ...source, description: '' }, false],
    ['both', source, false],
  ])('hasNoAllowedContext: %s', (_name, value, expected) => {
    expect(hasNoAllowedContext(value)).toBe(expected);
  });
});
