/**
 * The data allow-list of postmortem generation (SLICE-11 §4.2 step 2): the incident's
 * `description` and `severity`, and every comment's `title` and `description`. Nothing else: no
 * resolution summary, alert payloads, identities or credentials.
 */
export type PostmortemSource = {
  description: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  comments: readonly { title: string | null; description: string }[];
};

/**
 * What leaves the system, as the flat record the provider contract requires. Each comment is one
 * JSON string `{ "title", "description" }`, which keeps the pairing and a missing title explicit.
 */
export type PostmortemInput = {
  description: string;
  severity: string;
  comments: string[];
};

/** Copies exactly the allow-listed fields, whatever else the source object carries. */
export function projectPostmortemInput(source: PostmortemSource): PostmortemInput {
  return {
    description: source.description,
    severity: source.severity,
    comments: source.comments.map((comment) =>
      JSON.stringify({ title: comment.title, description: comment.description }),
    ),
  };
}

/** No description and no comments: there is nothing to generate from, so no provider call. */
export function hasNoAllowedContext(source: PostmortemSource): boolean {
  return source.description.trim() === '' && source.comments.length === 0;
}
