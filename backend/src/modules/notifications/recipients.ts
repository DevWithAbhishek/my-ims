import { catalogEntry, type NotificationEventType } from './catalog.js';

/** Facts read at enqueue time that the recipient rules refer to. */
export type RecipientContext = {
  teamId: string | null;
  subjectUserId: string | null;
  resolvedById: string | null;
  level3Id: string | null;
  fallbackAdminId: string | null;
};

/** Which active users to look up: members of one team, named users, and/or every Admin. */
export type RecipientQuery = {
  teamId: string | null;
  userIds: string[];
  allAdmins: boolean;
};

/** Turns the event's rule (SLICE-09 §4.3) into the lookup to run; pure. */
export function planRecipientQuery(
  eventType: NotificationEventType,
  context: RecipientContext,
): RecipientQuery {
  const query: RecipientQuery = { teamId: null, userIds: [], allAdmins: false };
  const named = (id: string | null) => {
    if (id !== null) query.userIds.push(id);
  };

  for (const source of catalogEntry(eventType).recipients) {
    switch (source) {
      case 'TEAM_MEMBERS':
        query.teamId = context.teamId;
        break;
      case 'SUBJECT_USER':
        named(context.subjectUserId);
        break;
      case 'RESOLVED_BY':
        named(context.resolvedById);
        break;
      case 'LEVEL3':
        named(context.level3Id);
        break;
      case 'FALLBACK_ADMIN':
        named(context.fallbackAdminId);
        break;
      case 'ALL_ADMINS':
        query.allAdmins = true;
        break;
    }
  }
  query.userIds = [...new Set(query.userIds)];
  return query;
}
