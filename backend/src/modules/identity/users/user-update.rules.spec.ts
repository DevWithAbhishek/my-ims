import { planUserUpdate, type UpdateFacts, type UpdateTarget } from './user-update.rules.js';

const TEAM_A = 'a0000000-0000-4000-8000-00000000000a';
const TEAM_B = 'b0000000-0000-4000-8000-00000000000b';
const LEAD = 'c0000000-0000-4000-8000-00000000000c';

const engineer: UpdateTarget = {
  id: 'e0000000-0000-4000-8000-00000000000e',
  role: 'ENGINEER',
  status: 'ACTIVE',
  teamId: TEAM_A,
  leadId: LEAD,
};
const teamLead: UpdateTarget = { ...engineer, id: LEAD, role: 'TEAM_LEAD', leadId: null };
const admin: UpdateTarget = { ...engineer, role: 'ADMIN', leadId: null };

const noFacts: UpdateFacts = {
  newTeam: null,
  lead: null,
  assignedToUnresolvedIncident: false,
  reportingUsers: 0,
};
const activeTeam = { status: 'ACTIVE' as const };
const activeLead = { role: 'TEAM_LEAD' as const, status: 'ACTIVE' as const, teamId: TEAM_A };

const fails = (code: string, status: number) =>
  expect.objectContaining({ code, statusCode: status });

describe('planUserUpdate', () => {
  describe('plain fields', () => {
    it('updates the name without revoking sessions', () => {
      expect(planUserUpdate(engineer, { name: 'New' }, noFacts)).toEqual({
        data: { name: 'New' },
        revokeSessions: false,
      });
    });

    it('revokes sessions when a password is provided', () => {
      const plan = planUserUpdate(engineer, { password: 'longenough1' }, noFacts);
      expect(plan).toEqual({ data: {}, revokeSessions: true });
    });

    it('treats a role, team or status equal to the current value as no change', () => {
      const plan = planUserUpdate(
        engineer,
        { role: 'ENGINEER', status: 'ACTIVE', teamId: TEAM_A },
        { ...noFacts, newTeam: activeTeam },
      );
      expect(plan).toEqual({ data: {}, revokeSessions: false });
    });
  });

  describe('teamId', () => {
    it('rejects a missing or deactivated team with 403 INVALID_ACTION', () => {
      for (const newTeam of [null, { status: 'DEACTIVATED' as const }]) {
        expect(() => planUserUpdate(engineer, { teamId: TEAM_B }, { ...noFacts, newTeam })).toThrow(
          fails('INVALID_ACTION', 403),
        );
      }
    });

    it('changing team clears the lead and revokes sessions', () => {
      const plan = planUserUpdate(
        engineer,
        { teamId: TEAM_B },
        { ...noFacts, newTeam: activeTeam },
      );
      expect(plan).toEqual({ data: { teamId: TEAM_B, leadId: null }, revokeSessions: true });
    });

    it('setting a team on a user without one needs no incident check', () => {
      const unassigned = { ...engineer, teamId: null, leadId: null };
      const plan = planUserUpdate(
        unassigned,
        { teamId: TEAM_A },
        { ...noFacts, newTeam: activeTeam, assignedToUnresolvedIncident: true },
      );
      expect(plan.data).toEqual({ teamId: TEAM_A });
    });

    it('rejects moving a user who is acknowledgedBy an unresolved incident', () => {
      expect(() =>
        planUserUpdate(
          engineer,
          { teamId: TEAM_B },
          { ...noFacts, newTeam: activeTeam, assignedToUnresolvedIncident: true },
        ),
      ).toThrow(fails('USER_ASSIGNED_CURRENTLY', 409));
    });

    it('rejects moving a Team Lead who still has engineers', () => {
      expect(() =>
        planUserUpdate(
          teamLead,
          { teamId: TEAM_B },
          { ...noFacts, newTeam: activeTeam, reportingUsers: 2 },
        ),
      ).toThrow(fails('CONFLICT_STILL_HAS_ENGINEERS', 409));
    });

    it('validates a leadId sent in the same request against the resulting team', () => {
      const lead = { ...activeLead, teamId: TEAM_B };
      const plan = planUserUpdate(
        engineer,
        { teamId: TEAM_B, leadId: LEAD },
        { ...noFacts, newTeam: activeTeam, lead },
      );
      expect(plan.data).toEqual({ teamId: TEAM_B });
      expect(() =>
        planUserUpdate(
          engineer,
          { teamId: TEAM_B, leadId: LEAD },
          { ...noFacts, newTeam: activeTeam, lead: activeLead },
        ),
      ).toThrow(fails('INVALID_ACTION', 403));
    });
  });

  describe('leadId', () => {
    it('accepts an active Team Lead of the same team', () => {
      const unled = { ...engineer, leadId: null };
      const plan = planUserUpdate(unled, { leadId: LEAD }, { ...noFacts, lead: activeLead });
      expect(plan).toEqual({ data: { leadId: LEAD }, revokeSessions: false });
    });

    it.each([
      ['missing', null],
      ['deactivated', { ...activeLead, status: 'DEACTIVATED' as const }],
      ['not a Team Lead', { ...activeLead, role: 'ENGINEER' as const }],
      ['in another team', { ...activeLead, teamId: TEAM_B }],
    ])('rejects a lead that is %s', (_name, lead) => {
      expect(() => planUserUpdate(engineer, { leadId: LEAD }, { ...noFacts, lead })).toThrow(
        fails('INVALID_ACTION', 403),
      );
    });

    it('rejects a leadId for an Admin, for a Team Lead and when the user has no team', () => {
      expect(() =>
        planUserUpdate(admin, { leadId: LEAD }, { ...noFacts, lead: activeLead }),
      ).toThrow(fails('INVALID_ACTION', 403));
      expect(() =>
        planUserUpdate(teamLead, { leadId: LEAD }, { ...noFacts, lead: activeLead }),
      ).toThrow(fails('INVALID_ACTION', 403));
      const teamless = { ...engineer, teamId: null, leadId: null };
      expect(() =>
        planUserUpdate(teamless, { leadId: LEAD }, { ...noFacts, lead: activeLead }),
      ).toThrow(fails('INVALID_ACTION', 403));
    });

    it('rejects a leadId that would make an engineer a Team Lead of someone in the same request', () => {
      expect(() =>
        planUserUpdate(
          engineer,
          { role: 'TEAM_LEAD', leadId: LEAD },
          { ...noFacts, lead: activeLead },
        ),
      ).toThrow(fails('INVALID_ACTION', 403));
    });

    it('rejects a user as their own lead', () => {
      const demoting = { ...teamLead };
      expect(() =>
        planUserUpdate(
          demoting,
          { role: 'ENGINEER', leadId: LEAD },
          { ...noFacts, lead: activeLead },
        ),
      ).toThrow(fails('INVALID_ACTION', 403));
    });
  });

  describe('role', () => {
    it('forbids any role change on an Admin', () => {
      expect(() => planUserUpdate(admin, { role: 'ENGINEER' }, noFacts)).toThrow(
        fails('INVALID_ACTION', 403),
      );
    });

    it('still lets an Admin be updated in other fields', () => {
      const plan = planUserUpdate(
        admin,
        { name: 'Root', status: 'DEACTIVATED', teamId: TEAM_B },
        { ...noFacts, newTeam: activeTeam },
      );
      expect(plan.data).toEqual({ name: 'Root', status: 'DEACTIVATED', teamId: TEAM_B });
      expect(plan.revokeSessions).toBe(true);
    });

    it('ENGINEER → TEAM_LEAD clears the lead and revokes sessions', () => {
      expect(planUserUpdate(engineer, { role: 'TEAM_LEAD' }, noFacts)).toEqual({
        data: { role: 'TEAM_LEAD', leadId: null },
        revokeSessions: true,
      });
    });

    it('TEAM_LEAD → ENGINEER is allowed without engineers and rejected with them', () => {
      expect(planUserUpdate(teamLead, { role: 'ENGINEER' }, noFacts).data).toEqual({
        role: 'ENGINEER',
      });
      expect(() =>
        planUserUpdate(teamLead, { role: 'ENGINEER' }, { ...noFacts, reportingUsers: 1 }),
      ).toThrow(fails('CONFLICT_STILL_HAS_ENGINEERS', 409));
    });

    it('any role change is rejected while acknowledgedBy an unresolved incident', () => {
      for (const [target, role] of [
        [engineer, 'TEAM_LEAD'],
        [teamLead, 'ENGINEER'],
      ] as const) {
        expect(() =>
          planUserUpdate(target, { role }, { ...noFacts, assignedToUnresolvedIncident: true }),
        ).toThrow(fails('USER_ASSIGNED_CURRENTLY', 409));
      }
    });
  });

  describe('status', () => {
    it('deactivates and reactivates, revoking sessions', () => {
      expect(planUserUpdate(engineer, { status: 'DEACTIVATED' }, noFacts)).toEqual({
        data: { status: 'DEACTIVATED' },
        revokeSessions: true,
      });
      const inactive = { ...engineer, status: 'DEACTIVATED' as const };
      expect(planUserUpdate(inactive, { status: 'ACTIVE' }, noFacts).data).toEqual({
        status: 'ACTIVE',
      });
    });

    it('rejects deactivating a user acknowledgedBy an unresolved incident', () => {
      expect(() =>
        planUserUpdate(
          engineer,
          { status: 'DEACTIVATED' },
          { ...noFacts, assignedToUnresolvedIncident: true },
        ),
      ).toThrow(fails('USER_ASSIGNED_CURRENTLY', 409));
    });

    it('reactivating an assigned user is allowed', () => {
      const inactive = { ...engineer, status: 'DEACTIVATED' as const };
      expect(() =>
        planUserUpdate(
          inactive,
          { status: 'ACTIVE' },
          { ...noFacts, assignedToUnresolvedIncident: true },
        ),
      ).not.toThrow();
    });

    it('rejects deactivating a Team Lead who still has engineers', () => {
      expect(() =>
        planUserUpdate(teamLead, { status: 'DEACTIVATED' }, { ...noFacts, reportingUsers: 3 }),
      ).toThrow(fails('CONFLICT_STILL_HAS_ENGINEERS', 409));
    });
  });

  describe('precedence', () => {
    it('USER_ASSIGNED_CURRENTLY wins when both 409s apply', () => {
      expect(() =>
        planUserUpdate(
          teamLead,
          { status: 'DEACTIVATED' },
          { ...noFacts, assignedToUnresolvedIncident: true, reportingUsers: 2 },
        ),
      ).toThrow(fails('USER_ASSIGNED_CURRENTLY', 409));
    });

    it('403 INVALID_ACTION is reported before any 409', () => {
      expect(() =>
        planUserUpdate(
          teamLead,
          { teamId: TEAM_B },
          { ...noFacts, newTeam: null, assignedToUnresolvedIncident: true, reportingUsers: 2 },
        ),
      ).toThrow(fails('INVALID_ACTION', 403));
    });
  });
});
