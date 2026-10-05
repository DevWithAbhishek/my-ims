export type UserRole = 'ENGINEER' | 'TEAM_LEAD' | 'ADMIN';

/** The authenticated caller, derived from the access token. Populated by the auth guard. */
export interface AuthContext {
  userId: string;
  email: string;
  role: UserRole;
  teamId: string | null;
  sessionId: string;
}
