import { describe, expect, it, vi } from "vitest";
import { inputOffset, orphanedAnnotationLabels } from "../src/compat/input.js";
import { createAnnotationReferenceInserter } from "../src/client/pending-reference.js";

describe("input compatibility", () => {
  const chip = {
    source: "annotation-batch",
    ref: "a",
    occurrenceId: 1,
    offset: 0,
    length: 6,
  };
  it("converts clipboard positions without splitting an existing chip", () => {
    expect(inputOffset(7, [chip])).toBe(2);
    expect(inputOffset(3, [chip])).toBeUndefined();
    expect(
      inputOffset(7, [{ source: "unknown", ref: "x", occurrenceId: 2 }]),
    ).toBeUndefined();
  });
  it("distinguishes restored plain labels from live chips", () => {
    expect(orphanedAnnotationLabels("[批注 1] [批注 2]", [chip])).toEqual([2]);
  });
  it("restores only the user's selected unambiguous label and preserves surrounding text", () => {
    const insertReference = vi.fn(() => true);
    const input = {
      state: {
        getSnapshot: () => ({
          draft: "正文 [批注 2] 结尾",
          draftRev: 3,
          occurrences: [],
        }),
      },
      insertReference,
    };
    const insert = createAnnotationReferenceInserter(
      { scope: () => ({ get: () => ({ input: { for: () => input } }) }) },
      "s",
    );
    expect(insert?.({ id: "a", sequence: 2, restoreLabel: true })).toBe(true);
    expect(insertReference).toHaveBeenCalledWith(
      expect.objectContaining({ label: "批注 2" }),
      { start: 3, end: 9, draftRev: 3 },
    );
  });
});
