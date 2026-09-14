import { describe, expect, it } from "vitest";

import {
  formatBatchMarker,
  parseBatchMarker,
  serializeAnnotationBatch,
} from "../src/shared/markdown";
import type { AnnotationRecord, TextAnchor } from "../src/shared/types";

function makeAnchor(start: number, end: number): TextAnchor {
  return {
    blockPath: [0],
    start,
    end,
    prefix: "",
    suffix: "",
    quoteHash: `hash-${start}-${end}`,
  };
}

function makeAnnotation(
  id: string,
  order: number,
  quote: string,
  comment: string,
): AnnotationRecord {
  return {
    id,
    sessionId: "session-1",
    status: "pending",
    messageId: "message-1",
    anchor: makeAnchor(order, order + 1),
    quote,
    comment,
    color: "amber",
    order,
    version: `version-${id}`,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("serializeAnnotationBatch", () => {
  it("serializes deterministic markdown with escaped user content", () => {
    const markdown = serializeAnnotationBatch({
      batchId: "opaque:/+id=",
      body: "请处理以下内容",
      annotations: [
        makeAnnotation(
          "second",
          20,
          "beta *bold*",
          "补充 <script>alert(1)</script>",
        ),
        makeAnnotation("first", 10, "alpha", "第一行\n第二行 [link]"),
      ],
    });

    expect(markdown).toBe(`请处理以下内容

${formatBatchMarker("opaque:/+id=")}
## 批注

1. 原文：“alpha”
   批注：第一行
   第二行 \\[link\\]
2. 原文：“beta \\*bold\\*”
   批注：补充 &lt;script&gt;alert\\(1\\)&lt;/script&gt;`);
  });

  it("rejects empty comments before serialization", () => {
    expect(() =>
      serializeAnnotationBatch({
        batchId: "opaque-id",
        annotations: [makeAnnotation("empty", 1, "quote", "   ")],
      }),
    ).toThrowError(/empty comment/i);
  });

  it("orders tied cards deterministically and keeps the marker when body is empty", () => {
    expect(
      serializeAnnotationBatch({
        batchId: "batch-2",
        annotations: [
          {
            ...makeAnnotation("b", 10, "quote-b", "comment-b"),
            createdAt: "2026-08-27T00:00:01.000Z",
          },
          {
            ...makeAnnotation("a", 10, "quote-a", "comment-a"),
            createdAt: "2026-08-27T00:00:00.000Z",
          },
        ],
      }),
    ).toBe(`${formatBatchMarker("batch-2")}
## 批注

1. 原文：“quote-a”
   批注：comment-a
2. 原文：“quote-b”
   批注：comment-b`);
  });
});

describe("batch markers", () => {
  it("formats and parses opaque batch markers without altering the id", () => {
    const marker = formatBatchMarker("opaque:/+id=");
    expect(marker.startsWith("\u{e0001}")).toBe(true);
    expect(marker).not.toContain("dsh-annotation:");

    expect(
      parseBatchMarker(`before
${marker}
after`),
    ).toEqual({
      batchId: "opaque:/+id=",
      marker,
      start: 7,
      end: 7 + marker.length,
    });
  });

  it("rejects empty batch ids and ignores unrelated html comments", () => {
    expect(() => formatBatchMarker("   ")).toThrowError(/must not be empty/i);
    expect(parseBatchMarker("<!-- something-else -->")).toBeNull();
  });
});
