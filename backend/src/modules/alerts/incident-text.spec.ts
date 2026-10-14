import { deriveIncidentText } from './incident-text.js';

const text = (name: string | null, summary: string | null, description: string | null) =>
  deriveIncidentText({ name, summary, description });

describe('deriveIncidentText', () => {
  it('uses the name as title; description and summary are joined by a blank line', () => {
    expect(text('cpu high', 'sum', 'desc')).toEqual({
      title: 'cpu high',
      description: 'desc\n\nsum',
    });
  });

  it('uses the summary as title when the name is absent', () => {
    expect(text(null, 'sum', 'desc')).toEqual({ title: 'sum', description: 'desc\n\nsum' });
    expect(text(null, 'sum', null)).toEqual({ title: 'sum', description: 'sum' });
  });

  it('skips absent parts of the description', () => {
    expect(text('n', null, 'desc')?.description).toBe('desc');
    expect(text('n', 'sum', null)?.description).toBe('sum');
    expect(text('n', 'sum', '')?.description).toBe('sum');
  });

  it('gives an empty (not missing) description when both parts are absent', () => {
    expect(text('n', null, null)).toEqual({ title: 'n', description: '' });
  });

  it('cannot open an incident without a name and a summary', () => {
    expect(text(null, null, 'desc')).toBeNull();
    expect(text(null, null, null)).toBeNull();
  });
});
