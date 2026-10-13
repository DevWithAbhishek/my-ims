import type { Db } from '../incidents.common.js';

export type NewComment = {
  incidentId: string;
  authorId: string;
  title: string | null;
  body: string;
};

/** Inserts the comment (API `body` is stored as `description`) with its author's name. */
export function insertComment(db: Db, data: NewComment) {
  return db.comment.create({
    data: {
      incidentId: data.incidentId,
      authorId: data.authorId,
      title: data.title,
      description: data.body,
    },
    select: {
      id: true,
      title: true,
      description: true,
      createdAt: true,
      author: { select: { id: true, name: true } },
    },
  });
}

export type StoredComment = Awaited<ReturnType<typeof insertComment>>;
