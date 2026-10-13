import { appendAuditEvent } from '../../../infra/audit/append-audit-event.js';
import { ConflictError } from '../../../shared/errors/AppError.js';
import type { AuthContext } from '../../../shared/types/auth-context.js';
import { requireTeam } from '../../identity/index.js';
import { lockIncidentForShare } from '../incident.repository.js';
import { assertIncidentAccess, runIncidentTransaction } from '../incidents.common.js';
import type { CommentResponse } from '../incidents.types.js';
import { insertComment, type StoredComment } from './comment.repository.js';

export type CommentInput = { title?: string; body: string };

function toCommentResponse(comment: StoredComment): CommentResponse {
  return {
    id: comment.id,
    title: comment.title,
    body: comment.description,
    author: { id: comment.author.id, name: comment.author.name },
    createdAt: comment.createdAt.toISOString(),
  };
}

/**
 * I10: adds a comment as the caller, in any status except `CLOSED`. The comment and its
 * `COMMENT_ADDED` audit event commit together or not at all. The audit metadata is a snapshot of
 * the comment with the author as a user id; no idempotency, no notification.
 */
export async function addComment(
  auth: AuthContext,
  incidentId: string,
  input: CommentInput,
): Promise<CommentResponse> {
  requireTeam(auth);

  return runIncidentTransaction(async (tx) => {
    // FOR SHARE: a concurrent close (which needs FOR UPDATE) waits, so the status checked here
    // is still the status when the comment is inserted.
    const incident = await lockIncidentForShare(tx, incidentId);
    assertIncidentAccess(auth, incident);
    if (incident.status === 'CLOSED') {
      throw new ConflictError(
        'Comments cannot be added to a closed incident',
        'INVALID_STATE_TRANSITION',
        [{ currentStatus: incident.status }],
      );
    }

    const stored = await insertComment(tx, {
      incidentId,
      authorId: auth.userId,
      title: input.title ?? null,
      body: input.body,
    });
    const comment = toCommentResponse(stored);

    await appendAuditEvent(tx, {
      incidentId,
      eventType: 'COMMENT_ADDED',
      actorId: auth.userId,
      metadata: {
        comment: {
          id: comment.id,
          title: comment.title,
          body: comment.body,
          authorId: comment.author.id,
          createdAt: comment.createdAt,
        },
      },
    });
    return comment;
  });
}
