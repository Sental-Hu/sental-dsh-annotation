import { describe, expect, it } from "vitest";

import { highlightStyleText } from "../src/client/highlight-style.js";

describe("annotation highlight styles", () => {
  it("emits one safe named highlight rule for every annotation color", () => {
    expect(
      highlightStyleText(
        [
          { id: "safe-id", color: "amber" },
          { id: "odd id!", color: "green" },
        ],
        { amber: "#f59e0b66", green: "#22c55e66" },
      ),
    ).toBe(
      "::highlight(dsh-annotation-safe-id){background-color:#f59e0b66}\n" +
        "::highlight(dsh-annotation-odd_id_){background-color:#22c55e66}",
    );
  });

  it("uses the amber fallback and does not repeat a rule for the same id", () => {
    expect(
      highlightStyleText(
        [
          { id: "a", color: "unknown" },
          { id: "a", color: "green" },
        ],
        { amber: "#f59e0b66", green: "#22c55e66" },
      ),
    ).toBe("::highlight(dsh-annotation-a){background-color:#f59e0b66}");
  });
});
