import type {
  AnnotationColor,
  AnnotationRecord,
  DisplayAnnotation,
  TextAnchor,
} from "./types.js";
import { DEFAULT_ANNOTATION_PALETTE } from "./types.js";

export { DEFAULT_ANNOTATION_PALETTE };

interface ColorSelectionCandidate {
  messageId: string;
  anchor: TextAnchor;
}

function compareBlockPath(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? -1;
    const rightValue = right[index] ?? -1;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function compareTextOrder(
  left: AnnotationRecord,
  right: AnnotationRecord,
): number {
  const blockOrder = compareBlockPath(
    left.anchor.blockPath,
    right.anchor.blockPath,
  );
  if (blockOrder !== 0) {
    return blockOrder;
  }

  if (left.anchor.start !== right.anchor.start) {
    return left.anchor.start - right.anchor.start;
  }

  if (left.anchor.end !== right.anchor.end) {
    return left.anchor.end - right.anchor.end;
  }

  return left.id.localeCompare(right.id);
}

function compareCardOrder(
  left: AnnotationRecord,
  right: AnnotationRecord,
): number {
  if (left.order !== right.order) {
    return left.order - right.order;
  }

  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }

  return left.id.localeCompare(right.id);
}

function sameTargetBlock(
  candidate: ColorSelectionCandidate,
  annotation: AnnotationRecord,
): boolean {
  return (
    candidate.messageId === annotation.messageId &&
    compareBlockPath(
      candidate.anchor.blockPath,
      annotation.anchor.blockPath,
    ) === 0
  );
}

export function selectAnnotationColor(
  candidate: ColorSelectionCandidate,
  stored: AnnotationRecord[],
  palette: readonly AnnotationColor[] = DEFAULT_ANNOTATION_PALETTE,
): AnnotationColor {
  const inBlock = stored
    .filter((annotation) => sameTargetBlock(candidate, annotation))
    .sort(compareTextOrder);

  let leftNeighbour: AnnotationRecord | undefined;
  let rightNeighbour: AnnotationRecord | undefined;

  for (const annotation of inBlock) {
    if (annotation.anchor.end <= candidate.anchor.start) {
      leftNeighbour = annotation;
      continue;
    }

    if (annotation.anchor.start >= candidate.anchor.end) {
      rightNeighbour ??= annotation;
      break;
    }
  }

  const blocked = new Set<AnnotationColor>();
  if (leftNeighbour) {
    blocked.add(leftNeighbour.color);
  }
  if (rightNeighbour) {
    blocked.add(rightNeighbour.color);
  }

  const usage = new Map<AnnotationColor, number>(
    palette.map((color) => [color, 0]),
  );
  for (const annotation of inBlock) {
    usage.set(annotation.color, (usage.get(annotation.color) ?? 0) + 1);
  }

  const available = palette.filter((color) => !blocked.has(color));
  const selectionPool = available.length > 0 ? available : [...palette];

  return [...selectionPool].sort((left, right) => {
    const usageDelta = (usage.get(left) ?? 0) - (usage.get(right) ?? 0);
    if (usageDelta !== 0) {
      return usageDelta;
    }

    return palette.indexOf(left) - palette.indexOf(right);
  })[0]!;
}

export function toDisplayAnnotations(
  annotations: AnnotationRecord[],
): DisplayAnnotation[] {
  return [...annotations].sort(compareCardOrder).map((annotation) => ({
    ...annotation,
    sequence: annotation.order + 1,
  }));
}
