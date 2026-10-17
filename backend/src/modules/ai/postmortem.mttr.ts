const MS_PER_MINUTE = 60_000;

/** `mttrMinutes = ceil((resolvedAt − createdAt) in minutes)`. */
export function computeMttrMinutes(createdAt: Date, resolvedAt: Date): number {
  return Math.ceil((resolvedAt.getTime() - createdAt.getTime()) / MS_PER_MINUTE);
}
