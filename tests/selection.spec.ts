import { describe, expect, it } from "vitest";

import { textRootForBlocks } from "../src/client/selection.js";

interface FakeElement {
  parentElement: FakeElement | null;
  contains(node: FakeElement): boolean;
}

function fakeElement(parentElement: FakeElement | null): FakeElement {
  const element: FakeElement = {
    parentElement,
    contains(node) {
      let current: FakeElement | null = node;
      while (current !== null) {
        if (current === element) return true;
        current = current.parentElement;
      }
      return false;
    },
  };
  return element;
}

describe("selection text roots", () => {
  it("uses the shared answer container for a selection spanning paragraphs", () => {
    const row = fakeElement(null);
    const markdown = fakeElement(row);
    const firstParagraph = fakeElement(markdown);
    const secondParagraph = fakeElement(markdown);

    expect(
      textRootForBlocks(
        firstParagraph as unknown as HTMLElement,
        secondParagraph as unknown as HTMLElement,
        row as unknown as HTMLElement,
      ),
    ).toBe(markdown);
  });

  it("rejects blocks that do not share a container inside the same row", () => {
    const firstRow = fakeElement(null);
    const secondRow = fakeElement(null);
    const firstParagraph = fakeElement(firstRow);
    const secondParagraph = fakeElement(secondRow);

    expect(
      textRootForBlocks(
        firstParagraph as unknown as HTMLElement,
        secondParagraph as unknown as HTMLElement,
        firstRow as unknown as HTMLElement,
      ),
    ).toBeUndefined();
  });
});
