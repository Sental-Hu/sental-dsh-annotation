import { describe, expect, it } from "vitest";

import { rangeTextContent } from "../src/client/anchors.js";

describe("annotation range text", () => {
  it("uses DOM text content instead of visual paragraph spacing for anchor offsets", () => {
    const range = {
      toString: () => "第一段\n\n第二段",
      cloneContents: () => ({ textContent: "第一段第二段" }),
    };

    expect(rangeTextContent(range as unknown as Range)).toBe("第一段第二段");
  });
});
