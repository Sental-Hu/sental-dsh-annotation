import { describe, expect, it } from "vitest";

import {
  classifyRangeConflict,
  validateRangeBoundary,
  validateRangeSet,
} from "../src/shared/ranges";
import type { HalfOpenRange } from "../src/shared/types";

describe("classifyRangeConflict", () => {
  const stored: HalfOpenRange = { start: 4, end: 8 };

  it("allows adjacent half-open ranges", () => {
    expect(classifyRangeConflict({ start: 0, end: 4 }, stored)).toBe("none");
    expect(classifyRangeConflict({ start: 8, end: 12 }, stored)).toBe("none");
  });

  it("rejects duplicate ranges", () => {
    expect(classifyRangeConflict({ start: 4, end: 8 }, stored)).toBe(
      "duplicate",
    );
  });

  it("rejects candidate ranges that contain stored ranges", () => {
    expect(classifyRangeConflict({ start: 2, end: 10 }, stored)).toBe(
      "contains",
    );
  });

  it("rejects candidate ranges contained by stored ranges", () => {
    expect(classifyRangeConflict({ start: 5, end: 7 }, stored)).toBe(
      "contained",
    );
  });

  it("rejects partial overlaps on either side", () => {
    expect(classifyRangeConflict({ start: 2, end: 6 }, stored)).toBe("overlap");
    expect(classifyRangeConflict({ start: 6, end: 10 }, stored)).toBe(
      "overlap",
    );
  });
});

describe("validateRangeBoundary", () => {
  it("accepts non-empty in-bounds ranges", () => {
    expect(validateRangeBoundary({ start: 0, end: 1 }, 1)).toBeNull();
    expect(validateRangeBoundary({ start: 1, end: 3 }, 6)).toBeNull();
  });

  it("rejects negative, empty, reversed, and out-of-bounds ranges", () => {
    expect(validateRangeBoundary({ start: 1.5, end: 3 }, 8)).toBe(
      "non-integer-start",
    );
    expect(validateRangeBoundary({ start: 1, end: 3.5 }, 8)).toBe(
      "non-integer-end",
    );
    expect(validateRangeBoundary({ start: -1, end: 3 }, 8)).toBe(
      "negative-start",
    );
    expect(validateRangeBoundary({ start: 1, end: -3 }, 8)).toBe(
      "negative-end",
    );
    expect(validateRangeBoundary({ start: 3, end: 3 }, 8)).toBe("empty");
    expect(validateRangeBoundary({ start: 5, end: 4 }, 8)).toBe("reversed");
    expect(validateRangeBoundary({ start: 9, end: 10 }, 8)).toBe(
      "start-out-of-bounds",
    );
    expect(validateRangeBoundary({ start: 1, end: 9 }, 8)).toBe(
      "end-out-of-bounds",
    );
  });
});

describe("validateRangeSet", () => {
  it("returns a clean result for adjacent valid ranges", () => {
    expect(
      validateRangeSet(
        [
          { start: 0, end: 2 },
          { start: 2, end: 5 },
          { start: 5, end: 6 },
        ],
        6,
      ),
    ).toEqual({
      boundaryIssue: null,
      conflict: null,
    });
  });

  it("reports boundary issues before overlap checks", () => {
    expect(
      validateRangeSet(
        [
          { start: 0, end: 2 },
          { start: 7, end: 9 },
        ],
        6,
      ),
    ).toEqual({
      boundaryIssue: {
        index: 1,
        reason: "start-out-of-bounds",
      },
      conflict: null,
    });
  });

  it("rejects the first non-adjacent conflict in a range collection", () => {
    expect(
      validateRangeSet(
        [
          { start: 0, end: 2 },
          { start: 2, end: 5 },
          { start: 4, end: 6 },
        ],
        6,
      ),
    ).toEqual({
      boundaryIssue: null,
      conflict: {
        candidateIndex: 2,
        conflictWithIndex: 1,
        reason: "overlap",
      },
    });
  });
});
