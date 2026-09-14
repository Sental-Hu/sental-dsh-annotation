import type { AnnotationStatus } from "../shared/types.js";

type HistoryPanelAnnotation = {
  readonly id: string;
  readonly status: AnnotationStatus;
  readonly sentAt?: string;
  readonly updatedAt: string;
};

function historyTimestamp(annotation: HistoryPanelAnnotation): number {
  const timestamp = Date.parse(annotation.sentAt ?? annotation.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/**
 * Keep unfinished work in the visible tabs and archive sent annotations in a
 * stable newest-first order. IDs are only the final tie-breaker; selection
 * continues to use the record itself rather than its display position.
 */
export function projectAnnotationPanel<T extends HistoryPanelAnnotation>(
  annotations: readonly T[],
): { readonly current: readonly T[]; readonly history: readonly T[] } {
  const current = annotations.filter(
    (annotation) => annotation.status !== "sent",
  );
  const history = annotations
    .filter((annotation) => annotation.status === "sent")
    .toSorted((left, right) => {
      const timeDifference = historyTimestamp(right) - historyTimestamp(left);
      return timeDifference || left.id.localeCompare(right.id);
    });
  return { current, history };
}
