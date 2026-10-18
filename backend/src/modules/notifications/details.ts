/**
 * The optional facts a producer may add to a notification beyond what the database holds
 * (SLICE-12 §4.5: the user, the number of attempts, the latest action of a blocked requester).
 * Only these keys exist: they travel as short scalars in the outbox payload (`detail_<key>`) and
 * are rendered with the label below, in this order. Nothing else from a payload reaches a message.
 */
export const NOTIFICATION_DETAIL_LABELS = {
  userId: 'User id',
  userName: 'User',
  attemptCount: 'Attempts',
  latestAction: 'Latest action',
} as const;

export type NotificationDetailKey = keyof typeof NOTIFICATION_DETAIL_LABELS;
export type NotificationDetails = Partial<Record<NotificationDetailKey, string | number>>;

const PREFIX = 'detail_';
/** The outbox payload allows strings of at most 128 characters. */
const MAX_VALUE_LENGTH = 128;

const KEYS = Object.keys(NOTIFICATION_DETAIL_LABELS) as NotificationDetailKey[];

/** The payload keys for `details`: only known keys, strings cut to the payload limit. */
export function detailsToPayload(
  details: NotificationDetails | undefined,
): Record<string, string | number> {
  const payload: Record<string, string | number> = {};
  for (const key of KEYS) {
    const value = details?.[key];
    if (value === undefined) continue;
    payload[`${PREFIX}${key}`] =
      typeof value === 'string' ? value.slice(0, MAX_VALUE_LENGTH) : value;
  }
  return payload;
}

/** Reads back the known details of a payload; anything else is ignored. */
export function detailsFromPayload(
  payload: Readonly<Record<string, unknown>>,
): NotificationDetails {
  const details: NotificationDetails = {};
  for (const key of KEYS) {
    const value = payload[`${PREFIX}${key}`];
    if (typeof value === 'string' || typeof value === 'number') details[key] = value;
  }
  return details;
}
