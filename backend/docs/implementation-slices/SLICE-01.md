# SLICE-01 — Identity, Authentication & Team Isolation

## 1. Purpose
Authenticate users, own users/teams/roles, and produce the verified request context (`userId`, `email`, `role`, `teamId`, `sessionId`) that every other slice uses for role checks and team isolation. Provide the admin APIs for teams and users.

## 2. Scope
### In Scope
- Auth endpoints A1–A4 (login, refresh with rotation, logout, logout-all), JWT access tokens, refresh-token cookie, `UserSession` management, login/refresh rate limiting.
- Identity endpoints T1–T4 (teams) and U1–U4 (users).
- The authentication guard and reusable authorization helpers consumed by all later slices.
- A seed script that creates `ADMIN` users (Admins are never created through the API).

### Out of Scope
Alert-source authentication (SLICE-03); services/policies (SLICE-02); incident endpoints; password reset, email verification, user self-service profile, `GET /auth/me` (none exist); any DELETE.

## 3. Dependencies
Requires from SLICE-00: validated config (`JWT_SECRET`, token expiries), Prisma client, Redis client, error envelope, request id. Reads (never writes) the `Incident` and `AppService` tables for conflict checks (T4, U4); those tables exist in the schema.

**Contract provided to other slices:** an `authenticate` middleware that verifies the Bearer JWT and sets request context; `requireRoles(...)`; a helper that rejects `teamId = null` callers with `403 INVALID_ACTION`; a helper that compares a resource's `teamId` with the caller's and throws `403 TEAM_ACCESS_DENIED`. Exposed through the module's `index.ts`.

## 4. Capability Behavior

**Tokens.** Access token: JWT (symmetric, signed with `JWT_SECRET`), lifetime 15 min, claims `userId`, `email`, `role`, `teamId` (uuid or `null`), `sessionId`, `exp`. Refresh token: 7 days, opaque, delivered only as cookie `ims_refresh_cookie` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/v1/auth`, `Max-Age=604800`), value contains the `sessionId`. Login/refresh return the access token in the response header `Authorization: Bearer <accessToken>`, the refresh token in `Set-Cookie`, and body `{ "data": { "tokenType": "Bearer", "expiresIn": 900 } }`. No token ever appears in a body.

**Guard.** Verifies signature and `exp`; does **not** query the database. Role/team/status changes take effect for access tokens at next refresh. To bound this, the server revokes **all sessions of a user in the same transaction** when an Admin changes that user's `role`, `teamId`, `password` or `status`, and when a team deactivation nulls the user's `teamId`. `ACCOUNT_DEACTIVATED` is returned only by login and refresh.

**Sessions.** One `UserSession` per login: `refreshTokenHash` (hash only; never the raw token), `lastRefreshHash`, `ip`, `userAgent`, `lastIp`, `lastSeen`, `revoked`, `expiresIn` (= refresh-token expiry). Refresh rotation: validate cookie → session exists, not revoked, not expired, token hash equals `refreshTokenHash` → issue new access + refresh token; set `lastRefreshHash ← old refreshTokenHash`, `refreshTokenHash ← new`, `lastSeen`, `lastIp`, new `expiresIn`. A presented token whose hash equals `lastRefreshHash` is **reuse**: revoke **all** sessions of that user and return `401 INVALID_REFRESH_TOKEN`.

**Rate limiting (Redis).** A1: 10 req/min keyed IP + email. A2: 10 req/min keyed IP + email + `sessionId`. Violation → `429 RATE_LIMITED` with `Retry-After`; each next violation escalates the block: 10 min → 20 min → 60 min → 4 h → block IP. A successful login/refresh resets that key's counter. Ladder memory and the duration of the final IP block are implementation-defined; a block ends automatically when its window passes.

**Team-null rule.** A non-Admin with `teamId = null` receives `403 INVALID_ACTION` on T3, U2, U3 (own-team endpoints); Admins are exempt.

**Admin scope.** An Admin may administer any team (teams, users). Incident data scope for Admins is limited to their own team (enforced in incident slices).

**Seed.** An idempotent (by email) seed script creates `ADMIN` users. Credentials are supplied via environment/config at run time, never committed.

## 5. Domain & Data Context
`Team`: `id` uuid(v7) PK, `name` unique, `status` (`ACTIVE|DEACTIVATED`, default `ACTIVE`), `createdAt`, `updatedAt`.
`User`: `id`, `name`, `email` unique (stored lower-case; indexed), `passwordHash`, `role` (`ENGINEER|TEAM_LEAD|ADMIN`, default `ENGINEER`), `status` (default `ACTIVE`), `teamId` nullable FK→Team, `leadId` nullable self-FK→User (the user's Team Lead), timestamps; index `(teamId, leadId)`.
`UserSession`: `id`, `refreshTokenHash`, `lastRefreshHash?`, `ip?`, `userAgent?`, `lastIp?`, `lastSeen?`, `revoked` (default false), `expiresIn` datetime, `userId` FK→User, timestamps.
Read-only: `Incident(status, acknowledgedById, teamId)`, `AppService(teamId)`.
Invariants: a user has exactly one role and at most one team and at most one lead; `leadId` references an `ACTIVE` `TEAM_LEAD` of the same team; Admins never have a `leadId`; team and email are unique.

## 6. API Contract
Envelope, headers, pagination, error format per `AGENTS.md` §6. All bodies Zod-strict. Every endpoint can additionally return `500 INTERNAL_ERROR` / `503 DEPENDENCY_UNAVAILABLE`.

**A1 `POST /auth/login`** — public. Body `{ email (valid, ≤72, lower-cased before lookup), password (8–24) }`. `200` with headers/body per §4. Errors: `422 VALIDATION_FAILED`, `400 BAD_REQUEST`, `401 INVALID_CREDENTIALS` (unknown email or wrong password — same response, similar timing; always run a hash verification), `403 ACCOUNT_DEACTIVATED` (password correct, user `DEACTIVATED`), `429 RATE_LIMITED`. One `UserSession` insert in one transaction; no idempotency.

**A2 `POST /auth/refresh`** — refresh cookie only; body ignored. `200`, same shape as A1 (new access header + new cookie). Errors: `401 INVALID_REQUEST` (cookie absent), `401 INVALID_REFRESH_TOKEN` (invalid, expired, revoked, or reused → also revokes all user sessions), `403 ACCOUNT_DEACTIVATED`, `429 RATE_LIMITED`. New claims are read from the database. Session update in one transaction.

**A3 `POST /auth/logout`** — Bearer. Revokes the session named by the token's `sessionId`, clears the cookie. `200 { data: { message: "Logged out successfully" } }`. Already-revoked session with a valid token → same `200`. Errors: `401 UNAUTHENTICATED`. The access token stays valid until `exp`.

**A4 `POST /auth/logout-all`** — as A3 but revokes every non-revoked session of the caller.

**T1 `POST /identity/teams`** — `ADMIN`. Body `{ name (1–50) }`. `201 TeamResponse` (`status ACTIVE`). Errors: `422`, `400`, `401`, `403 FORBIDDEN_ROLE`, `409 DUPLICATE_TEAM`.

**T2 `GET /identity/teams`** — `ADMIN` only. Query `limit` (default 10, max 50), `offset` (0), `orderBy` (`name|createdAt`, default `name`), `sort` (`asc|desc`, default `asc`). `200 TeamResponse[]` + `{ limit, offset, hasMore }`; empty → `[]`. Errors: `422`, `401`, `403 FORBIDDEN_ROLE`.

**T3 `GET /identity/teams/:teamId`** — `ADMIN` any team; `ENGINEER`/`TEAM_LEAD` own team only. `200 TeamResponse`. Errors: `422` (malformed id), `401`, `403 INVALID_ACTION` (non-Admin with `teamId = null`), `403 TEAM_ACCESS_DENIED`, `404 TEAM_NOT_FOUND`.

**T4 `PATCH /identity/teams/:teamId`** — `ADMIN`. Body `{ name? (1–50), status? ACTIVE|DEACTIVATED }`, at least one field (empty → `422`). `200 TeamResponse`. Errors: `422`, `400`, `401`, `403 FORBIDDEN_ROLE`, `404 TEAM_NOT_FOUND`, `409 DUPLICATE_TEAM`, `409 TEAM_WITH_OPEN_INCIDENT` (deactivating while the team has unresolved incidents), `403 INVALID_ACTION` (deactivating while services are still attached; they must be reassigned first). If both blockers apply → `409 TEAM_WITH_OPEN_INCIDENT`. One transaction. On deactivation: every user of the team gets `teamId = null` and `leadId = null` and **all their sessions are revoked**; nothing is stored about the former team; reactivation does **not** restore users (an Admin sets `teamId` again via U4).

**U1 `POST /identity/users`** — `ADMIN`. Body `{ name (1–50), email (valid, ≤72, stored lower-case), password (8–24, hashed with the Argon2 algorithm using its default configuration, never returned), role? ENGINEER|TEAM_LEAD (default ENGINEER), teamId? uuid, leadId? uuid }`. `teamId` must exist and the team must not be `DEACTIVATED`, else `403 INVALID_ACTION`. `leadId` must reference an `ACTIVE` `TEAM_LEAD` of the same team, else `403 INVALID_ACTION`; a `leadId` while `teamId` is null → `403 INVALID_ACTION`. `201 UserResponse` (`status ACTIVE`). Errors: `422`, `400`, `401`, `403 FORBIDDEN_ROLE`, `403 INVALID_ACTION`, `409 EMAIL_ALREADY_EXISTS`. ADMIN users cannot be created here.

**U2 `GET /identity/teams/:teamId/users`** — `ADMIN` any team; `TEAM_LEAD` own team (other → `403 TEAM_ACCESS_DENIED`); `ENGINEER` → `403 FORBIDDEN_ROLE`; non-Admin with null team → `403 INVALID_ACTION`. Query: `limit`, `offset`, `role?` (`ENGINEER|TEAM_LEAD`), `status?` (`ACTIVE|DEACTIVATED`), `orderBy?` (`name|createdAt`, default `name`), `sort?`. `200 UserListItem[]` + offset pagination. Errors: `422`, `401`, `403`, `404 TEAM_NOT_FOUND`.

**U3 `GET /identity/users/:userId`** — `ADMIN` any; `TEAM_LEAD` users of own team only (other → `403 TEAM_ACCESS_DENIED`); `ENGINEER` → `403 FORBIDDEN_ROLE`; null-team non-Admin → `403 INVALID_ACTION`. `200 UserResponse`. Errors: `422`, `401`, `403`, `404 USER_NOT_FOUND`.

**U4 `PATCH /identity/users/:userId`** — `ADMIN`. Body (≥1 field) `{ name? (1–50), password? (8–24), role? ENGINEER|TEAM_LEAD, status? ACTIVE|DEACTIVATED, teamId? uuid, leadId? uuid }`; `email` is immutable (unknown/forbidden field → `400`). Rules: **teamId** must reference an existing, non-`DEACTIVATED` team (else `403 INVALID_ACTION`); may be set when currently null; may be changed later only if the user is not `acknowledgedBy` on any unresolved incident (else `409 USER_ASSIGNED_CURRENTLY`); a team change sets `leadId = null` (a `leadId` sent in the same request is validated against the resulting team). **leadId** must reference an `ACTIVE` `TEAM_LEAD` of the same team, else `403 INVALID_ACTION`; never allowed for an `ADMIN` user (`403 INVALID_ACTION`); a `leadId` while the resulting `teamId` is null → `403 INVALID_ACTION`. **role:** `ENGINEER → TEAM_LEAD` sets `leadId = null`; `TEAM_LEAD → ENGINEER` with engineers still reporting to them → `409 CONFLICT_STILL_HAS_ENGINEERS`; any role change on a user who is `acknowledgedBy` on an unresolved incident → `409 USER_ASSIGNED_CURRENTLY`. **status:** deactivating such a user → `409 USER_ASSIGNED_CURRENTLY`; deactivating or moving to another team a Team Lead who still has engineers → `409 CONFLICT_STILL_HAS_ENGINEERS`. If both 409s apply, `USER_ASSIGNED_CURRENTLY` wins. `200 UserResponse`. Errors: `422`, `400`, `401`, `403 FORBIDDEN_ROLE`, `403 INVALID_ACTION`, `404 USER_NOT_FOUND`, `409 USER_ASSIGNED_CURRENTLY`, `409 CONFLICT_STILL_HAS_ENGINEERS`. One transaction including session revocation: a change of `role`, `teamId`, `password` or `status` revokes all of that user's sessions. Deactivation does not touch incidents already assigned and does not edit escalation policies.

**Response types.** `TeamResponse { id, name, status, createdAt, updatedAt }`. `UserResponse` / `UserListItem { id, name, email, role, status, teamId|null, leadId|null, createdAt, updatedAt }`. Never return `passwordHash`.

## 7. Authorization & Security
Gate order per `AGENTS.md` §6. Roles: writes are `ADMIN` only (`403 FORBIDDEN_ROLE` otherwise). Passwords: hashed with the **Argon2** password-hashing algorithm using the library's default configuration; no custom cost, memory or time parameters are specified. Refresh tokens: hash only. Login never reveals whether the email exists. JWT secret from config. No tokens, passwords, or hashes in logs or audit. Cookie attributes exactly as in §4.

## 8. Consistency & Concurrency
Each write endpoint is a single transaction (including session revocation). Uniqueness (`Team.name`, `User.email`) is enforced by the database; unique violations map to `DUPLICATE_TEAM` / `EMAIL_ALREADY_EXISTS`. Conflict checks (T4, U4) and the update run in the same transaction; two concurrent refreshes with the same token: one rotates, the other is treated as reuse (update guarded by the expected `refreshTokenHash`).

## 9. Async / Events / Workers
None. (Rate-limit counters and blocks live in Redis.) No audit events are written by this slice.

## 10. Failure & Recovery
The error catalogue lists `503 DEPENDENCY_UNAVAILABLE` (with `Retry-After`) when a required dependency such as Redis is down. The design does not define whether the A1/A2 rate limiter fails open or closed during a Redis outage; do not invent that behavior (stop per `AGENTS.md` §13 if it must be decided). Database failure rolls back the whole operation, including session revocation. Expired/invalid access token → `401 UNAUTHENTICATED`; client refreshes via A2.

## 11. Implementation Surface
Application: auth and identity (users/teams) modules — controllers, services, repositories, Zod DTOs, Argon2 password hashing (default configuration), JWT/cookie helpers, rate-limit helper (Redis), guard/authorization helpers exported via `index.ts`. Database: no schema change expected (models exist). Tests: unit (token/cookie, rate-limit ladder, role/team helpers), integration (all endpoints against PostgreSQL + Redis). Tooling: seed script and its `package.json` script.

## 12. Verification Requirements
- Stored `passwordHash` values are Argon2 hashes; login verifies against them; the password is never stored or returned in clear text.
- Login success sets header/cookie/body exactly; wrong password and unknown email are indistinguishable; deactivated user → `ACCOUNT_DEACTIVATED`; ladder escalation and counter reset.
- Refresh rotation; reuse detection revokes all sessions; revoked/expired/absent cookie cases; deactivated user.
- Guard rejects missing/invalid/expired tokens without a DB read.
- Every role × endpoint matrix for T1–T4, U1–U4 including null-team behavior and cross-team `TEAM_ACCESS_DENIED`.
- U4 rule matrix incl. both-409 precedence, lead/team/role transitions, session revocation on each of `role|teamId|password|status`.
- T4 deactivation: users' `teamId`/`leadId` nulled and sessions revoked atomically; both-blocker precedence; no restore on reactivation.
- Duplicate email/team name (also under concurrent requests); strict-unknown-field → `400`; empty PATCH → `422`; `passwordHash` never in any response.
- Rollback test: a failure mid-transaction leaves no partial changes.

## 13. Completion Criteria
- All 12 endpoints behave exactly as specified, with the listed status and error codes.
- The guard and helpers are exported and usable by other modules; protected requests do not hit the database.
- Session rotation, reuse detection, logout and logout-all work; revocation on `role|teamId|password|status` change and team deactivation is atomic.
- Rate limiting on A1/A2 follows the ladder and resets on success.
- Passwords are hashed with Argon2 (default configuration) in U1, U4 and the seed script.
- Seed script creates an Admin idempotently.
- Constraints hold in the database; no secrets in logs/responses; tests above pass; typecheck/lint/format clean for touched files; existing tests unaffected.
