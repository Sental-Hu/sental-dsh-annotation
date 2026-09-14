import { describe, expect, it } from "vitest";

import {
  DEFAULT_ANNOTATION_PALETTE,
  selectAnnotationColor,
  toDisplayAnnotations,
} from "../src/shared/colors";
import type { AnnotationRecord, TextAnchor } from "../src/shared/types";

function makeAnchor(
  start: number,
  end: number,
  blockPath: number[] = [0],
): TextAnchor {
  return {
    blockPath,
    start,
    end,
    prefix: "",
    suffix: "",
    quoteHash: `hash-${start}-${end}`,
  };
}

function makeAnnotation(
  id: string,
  color: AnnotationRecord["color"],
  order: number,
  start: number,
  end: number,
): AnnotationRecord {
  return {
    id,
    sessionId: "session-1",
    status: "pending",
    messageId: "message-1",
    anchor: makeAnchor(start, end),
    quote: `quote-${id}`,
    comment: `comment-${id}`,
    color,
    order,
    version: `version-${id}`,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("selectAnnotationColor", () => {
  it("avoids the immediate text neighbours when another color is available", () => {
    const stored = [
      makeAnnotation("left", DEFAULT_ANNOTATION_PALETTE[0], 10, 0, 3),
      makeAnnotation("right", DEFAULT_ANNOTATION_PALETTE[1], 20, 8, 11),
    ];

    expect(
      selectAnnotationColor(
        {
          messageId: "message-1",
          anchor: makeAnchor(4, 7),
        },
        stored,
      ),
    ).toBe(DEFAULT_ANNOTATION_PALETTE[2]);
  });

  it("falls back deterministically when every palette color is already blocked", () => {
    const palette = ["amber", "green"] as const;
    const stored = [
      makeAnnotation("left", palette[0], 10, 0, 3),
      makeAnnotation("right", palette[1], 20, 8, 11),
    ];

    expect(
      selectAnnotationColor(
        {
          messageId: "message-1",
          anchor: makeAnchor(4, 7),
        },
        stored,
        palette,
      ),
    ).toBe("amber");
  });

  it("only considers annotations in the same message block and uses least-used colors first", () => {
    const stored = [
      makeAnnotation(
        "same-block-left",
        DEFAULT_ANNOTATION_PALETTE[0],
        10,
        0,
        3,
      ),
      makeAnnotation(
        "same-block-far",
        DEFAULT_ANNOTATION_PALETTE[0],
        20,
        20,
        24,
      ),
      {
        ...makeAnnotation(
          "other-message",
          DEFAULT_ANNOTATION_PALETTE[1],
          30,
          4,
          7,
        ),
        messageId: "message-2",
      },
      {
        ...makeAnnotation(
          "other-block",
          DEFAULT_ANNOTATION_PALETTE[1],
          40,
          4,
          7,
        ),
        anchor: makeAnchor(4, 7, [1]),
      },
    ];

    expect(
      selectAnnotationColor(
        {
          messageId: "message-1",
          anchor: makeAnchor(10, 14),
        },
        stored,
      ),
    ).toBe(DEFAULT_ANNOTATION_PALETTE[1]);
  });
});

describe("toDisplayAnnotations", () => {
  it("uses persistent card positions as labels without recoloring stored records", () => {
    const stored = [
      makeAnnotation("third", DEFAULT_ANNOTATION_PALETTE[2], 30, 12, 16),
      makeAnnotation("first", DEFAULT_ANNOTATION_PALETTE[0], 10, 0, 4),
      makeAnnotation("second", DEFAULT_ANNOTATION_PALETTE[1], 20, 6, 10),
    ];

    const display = toDisplayAnnotations(stored);

    expect(
      display.map(({ id, sequence, color }) => ({
        id,
        sequence,
        color,
      })),
    ).toEqual([
      { id: "first", sequence: 11, color: DEFAULT_ANNOTATION_PALETTE[0] },
      { id: "second", sequence: 21, color: DEFAULT_ANNOTATION_PALETTE[1] },
      { id: "third", sequence: 31, color: DEFAULT_ANNOTATION_PALETTE[2] },
    ]);

    const reordered = toDisplayAnnotations([
      { ...stored[0], order: 5 },
      stored[1],
      stored[2],
    ]);

    expect(
      reordered.map(({ id, sequence, color }) => ({
        id,
        sequence,
        color,
      })),
    ).toEqual([
      { id: "third", sequence: 6, color: DEFAULT_ANNOTATION_PALETTE[2] },
      { id: "first", sequence: 11, color: DEFAULT_ANNOTATION_PALETTE[0] },
      { id: "second", sequence: 21, color: DEFAULT_ANNOTATION_PALETTE[1] },
    ]);
  });

  it("does not renumber remaining annotations after a middle annotation is deleted", () => {
    const display = toDisplayAnnotations([
      makeAnnotation("first", DEFAULT_ANNOTATION_PALETTE[0], 0, 0, 4),
      makeAnnotation("third", DEFAULT_ANNOTATION_PALETTE[2], 2, 12, 16),
    ]);

    expect(display.map(({ id, sequence }) => ({ id, sequence }))).toEqual([
      { id: "first", sequence: 1 },
      { id: "third", sequence: 3 },
    ]);
  });

  it("breaks ordering ties deterministically by createdAt and id", () => {
    const tied = [
      {
        ...makeAnnotation("b", DEFAULT_ANNOTATION_PALETTE[1], 10, 8, 10),
        createdAt: "2026-08-27T00:00:01.000Z",
      },
      {
        ...makeAnnotation("a", DEFAULT_ANNOTATION_PALETTE[0], 10, 0, 2),
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      {
        ...makeAnnotation("c", DEFAULT_ANNOTATION_PALETTE[2], 10, 12, 14),
        createdAt: "2026-08-27T00:00:01.000Z",
      },
    ];

    expect(
      toDisplayAnnotations(tied).map(({ id, sequence }) => ({ id, sequence })),
    ).toEqual([
      { id: "a", sequence: 11 },
      { id: "b", sequence: 11 },
      { id: "c", sequence: 11 },
    ]);
  });
});
