import type {
  HalfOpenRange,
  RangeBoundaryIssue,
  RangeConflict,
} from "./types.js";

export interface RangeSetValidationResult {
  boundaryIssue: {
    index: number;
    reason: RangeBoundaryIssue;
  } | null;
  conflict: {
    candidateIndex: number;
    conflictWithIndex: number;
    reason: Exclude<RangeConflict, "none">;
  } | null;
}

export function validateRangeBoundary(
  range: HalfOpenRange,
  textLength: number,
): RangeBoundaryIssue | null {
  if (!Number.isInteger(range.start)) {
    return "non-integer-start";
  }

  if (!Number.isInteger(range.end)) {
    return "non-integer-end";
  }

  if (range.start < 0) {
    return "negative-start";
  }

  if (range.end < 0) {
    return "negative-end";
  }

  if (range.end < range.start) {
    return "reversed";
  }

  if (range.end === range.start) {
    return "empty";
  }

  if (range.start > textLength) {
    return "start-out-of-bounds";
  }

  if (range.end > textLength) {
    return "end-out-of-bounds";
  }

  return null;
}

export function classifyRangeConflict(
  candidate: HalfOpenRange,
  stored: HalfOpenRange,
): RangeConflict {
  if (candidate.start === stored.start && candidate.end === stored.end) {
    return "duplicate";
  }

  if (candidate.end <= stored.start || candidate.start >= stored.end) {
    return "none";
  }

  if (candidate.start <= stored.start && candidate.end >= stored.end) {
    return "contains";
  }

  if (candidate.start >= stored.start && candidate.end <= stored.end) {
    return "contained";
  }

  return "overlap";
}

export function validateRangeSet(
  ranges: HalfOpenRange[],
  textLength: number,
): RangeSetValidationResult {
  for (const [candidateIndex, candidate] of ranges.entries()) {
    const boundaryIssue = validateRangeBoundary(candidate, textLength);
    if (boundaryIssue) {
      return {
        boundaryIssue: {
          index: candidateIndex,
          reason: boundaryIssue,
        },
        conflict: null,
      };
    }

    for (
      let conflictWithIndex = 0;
      conflictWithIndex < candidateIndex;
      conflictWithIndex += 1
    ) {
      const reason = classifyRangeConflict(
        candidate,
        ranges[conflictWithIndex]!,
      );
      if (reason !== "none") {
        return {
          boundaryIssue: null,
          conflict: {
            candidateIndex,
            conflictWithIndex,
            reason,
          },
        };
      }
    }
  }

  return {
    boundaryIssue: null,
    conflict: null,
  };
}
