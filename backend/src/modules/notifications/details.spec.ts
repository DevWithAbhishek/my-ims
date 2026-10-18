import { detailsFromPayload, detailsToPayload } from './details';
import { renderMessage } from './templates';

describe('notification details', () => {
  it('round-trips the known keys through the payload', () => {
    const payload = detailsToPayload({
      userId: 'u1',
      userName: 'Ada',
      attemptCount: 4,
      latestAction: 'POST /incidents/x/investigations',
    });
    expect(payload).toEqual({
      detail_userId: 'u1',
      detail_userName: 'Ada',
      detail_attemptCount: 4,
      detail_latestAction: 'POST /incidents/x/investigations',
    });
    expect(detailsFromPayload(payload)).toEqual({
      userId: 'u1',
      userName: 'Ada',
      attemptCount: 4,
      latestAction: 'POST /incidents/x/investigations',
    });
  });

  it('cuts long strings to the payload limit and ignores unknown payload keys', () => {
    expect(detailsToPayload({ userName: 'a'.repeat(300) }).detail_userName).toHaveLength(128);
    expect(detailsFromPayload({ detail_other: 'x', userName: 'y', kind: 'k' })).toEqual({});
    expect(detailsToPayload(undefined)).toEqual({});
  });

  it('renders the details after the facts, one line each', () => {
    const { text } = renderMessage(
      'INVESTIGATION_REQUEST_BLOCKED',
      { teamName: 'Platform' },
      { userName: 'Ada', attemptCount: 4, latestAction: 'Requested an investigation' },
    );
    expect(text).toContain('Team: Platform');
    expect(text).toContain('User: Ada');
    expect(text).toContain('Attempts: 4');
    expect(text).toContain('Latest action: Requested an investigation');
  });

  it('renders no detail lines when there are none', () => {
    expect(renderMessage('INVESTIGATION_REQUEST_BLOCKED', {}).text).not.toContain('Attempts');
  });
});
