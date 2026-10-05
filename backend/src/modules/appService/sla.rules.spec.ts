import { SLA_FIELDS, slaOrderingIssues } from './sla.rules.js';

describe('slaOrderingIssues', () => {
  it('accepts resolution equal to or above response for every severity', () => {
    expect(
      slaOrderingIssues({
        P0ResponseSlaMinutes: 5,
        P0ResolutionSlaMinutes: 5,
        P1ResponseSlaMinutes: 10,
        P1ResolutionSlaMinutes: 60,
      }),
    ).toEqual([]);
  });

  it('reports each severity whose resolution is below its response', () => {
    const issues = slaOrderingIssues({
      P0ResponseSlaMinutes: 30,
      P0ResolutionSlaMinutes: 29,
      P2ResponseSlaMinutes: 60,
      P2ResolutionSlaMinutes: 10,
      P3ResponseSlaMinutes: 1,
      P3ResolutionSlaMinutes: 2,
    });
    expect(issues.map((issue) => issue.field)).toEqual([
      'P0ResolutionSlaMinutes',
      'P2ResolutionSlaMinutes',
    ]);
  });

  it('ignores a severity that is only half present (a partial patch)', () => {
    expect(slaOrderingIssues({ P1ResponseSlaMinutes: 999 })).toEqual([]);
    expect(slaOrderingIssues({ P1ResolutionSlaMinutes: 1 })).toEqual([]);
  });

  it('validates stored values merged with a patch', () => {
    const stored = Object.fromEntries(SLA_FIELDS.map((field) => [field, 60]));
    const merged = { ...stored, P1ResponseSlaMinutes: 61 };
    expect(slaOrderingIssues(merged).map((issue) => issue.field)).toEqual([
      'P1ResolutionSlaMinutes',
    ]);
  });
});
