import { describe, expect, it, vi } from "vitest";

import {
  ANNOTATION_BATCH_SOURCE,
  annotationReferenceFor,
  createBatchReferenceSource,
  hasAnnotationReferenceOccurrence,
  insertAnnotationReference,
} from "../src/client/input-reference.js";
import { createAnnotationReferenceInserter } from "../src/client/pending-reference.js";

describe("annotation batch input reference", () => {
  it("does not expose the obsolete session-wide reference insertion API", async () => {
    const module = await import("../src/client/input-reference.js");

    expect(module).not.toHaveProperty("batchReferenceForSession");
    expect(module).not.toHaveProperty("insertBatchReference");
    expect(module).not.toHaveProperty("hasBatchReferenceOccurrence");
  });

  it("keeps each selected annotation as a separate removable file chip", () => {
    const first = insertAnnotationReference(
      {
        sessionId: "s1",
        draft: "正文",
        draftRev: 7,
        occurrences: [],
      },
      { id: "annotation-1", sequence: 1 },
    );
    const firstOccurrence = {
      occurrenceId: 1,
      source: ANNOTATION_BATCH_SOURCE,
      ref: annotationReferenceFor("s1", "annotation-1"),
    } as const;
    const second = insertAnnotationReference(
      {
        sessionId: "s1",
        draft: "正文",
        draftRev: 8,
        occurrences: [firstOccurrence],
      },
      { id: "annotation-2", sequence: 2 },
    );

    expect(first?.reference).toMatchObject({
      ref: firstOccurrence.ref,
      label: "批注 1",
      appearance: "file",
    });
    expect(second?.reference).toMatchObject({
      ref: annotationReferenceFor("s1", "annotation-2"),
      label: "批注 2",
    });
    expect(
      hasAnnotationReferenceOccurrence([firstOccurrence], "s1", "annotation-1"),
    ).toBe(true);
    expect(
      hasAnnotationReferenceOccurrence([firstOccurrence], "s1", "annotation-2"),
    ).toBe(false);
  });

  it("keeps the source invisible to the candidate menu and neutralizes a stale legacy batch ref", async () => {
    const prepare = vi.fn(async (sessionId: string) => ({
      batchId: "batch-1",
      markdown: "<!-- dsh-annotation:batch=batch-1 -->\n## 批注",
      sessionId,
    }));
    const source = createBatchReferenceSource({ prepare });
    const ref = "dsh-annotation-batch:s1";

    expect(source.trigger).toBe("@");
    expect(source.name).toBe(ANNOTATION_BATCH_SOURCE);
    await expect(
      source.candidates(
        { sessionId: "s1" },
        {
          query: "",
          position: "inline",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual([]);
    expect(source.onPick({} as never)).toBeUndefined();
    await expect(
      source.codec!.serialize(ref, new AbortController().signal),
    ).resolves.toBe("");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("serializes one pending file chip as only that annotation", async () => {
    const prepare = vi.fn(async () => ({
      batchId: "batch-annotation-1",
      markdown: "<!-- dsh-annotation:batch=batch-annotation-1 -->\n## 批注",
      sessionId: "s1",
    }));
    const source = createBatchReferenceSource({
      prepare,
      list: async () => [
        {
          id: "annotation-1",
          status: "pending",
          quote: "原文",
          comment: "批注",
        },
      ],
    });
    const signal = new AbortController().signal;

    await expect(
      source.codec!.serialize("dsh-annotation-item:s1:annotation-1", signal),
    ).resolves.toContain("batch-annotation-1");
    expect(prepare).toHaveBeenCalledWith("s1", undefined, signal, [
      "annotation-1",
    ]);
  });

  it("neutralizes a chip whose annotation was deleted before send", async () => {
    const source = createBatchReferenceSource({
      prepare: async () => ({ markdown: "should-not-run" }),
      list: async () => [],
    });

    await expect(
      source.codec.serialize(
        annotationReferenceFor("s1", "deleted-annotation"),
        new AbortController().signal,
      ),
    ).resolves.toBe("");
  });

  it("still serializes a remaining selected chip when an earlier chip was deleted", async () => {
    const prepare = vi.fn(async (_sessionId, _body, _signal, ids) => ({
      markdown: `batch:${ids?.join(",")}`,
    }));
    const source = createBatchReferenceSource({
      prepare,
      list: async () => [
        {
          id: "current",
          status: "pending" as const,
          quote: "原文",
          comment: "批注",
        },
      ],
    });
    const signal = new AbortController().signal;

    await expect(
      Promise.all([
        source.codec.serialize(
          annotationReferenceFor("s1", "deleted-annotation"),
          signal,
        ),
        source.codec.serialize(annotationReferenceFor("s1", "current"), signal),
      ]),
    ).resolves.toEqual(["", "batch:current"]);
    expect(prepare).toHaveBeenCalledWith("s1", undefined, signal, ["current"]);
  });

  it("serializes a prepared file chip from its own record without reusing its old batch", async () => {
    const prepare = vi.fn(async () => ({ markdown: "wrong-old-batch" }));
    const source = createBatchReferenceSource({
      prepare,
      list: async () => [
        {
          id: "annotation-7",
          status: "prepared" as const,
          quote: "第七条原文",
          comment: "第七条批注",
        },
      ],
    });

    await expect(
      source.codec.serialize(
        annotationReferenceFor("s1", "annotation-7"),
        new AbortController().signal,
      ),
    ).resolves.toBe("> 第七条原文\n> \n> 批注：第七条批注");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("serializes simultaneous selected chips as one exact batch without duplicates", async () => {
    const prepare = vi.fn(
      async (_sessionId, _body, _signal, annotationIds) => ({
        markdown: `batch:${annotationIds?.join(",")}`,
      }),
    );
    const source = createBatchReferenceSource({
      prepare,
      list: async () => [
        {
          id: "annotation-1",
          status: "pending" as const,
          quote: "一",
          comment: "甲",
        },
        {
          id: "annotation-2",
          status: "pending" as const,
          quote: "二",
          comment: "乙",
        },
        {
          id: "annotation-3",
          status: "pending" as const,
          quote: "三",
          comment: "丙",
        },
        {
          id: "annotation-4",
          status: "pending" as const,
          quote: "四",
          comment: "丁",
        },
        {
          id: "annotation-5",
          status: "pending" as const,
          quote: "五",
          comment: "戊",
        },
      ],
    });
    const signal = new AbortController().signal;

    await expect(
      Promise.all([
        source.codec.serialize(
          annotationReferenceFor("s1", "annotation-3"),
          signal,
        ),
        source.codec.serialize(
          annotationReferenceFor("s1", "annotation-4"),
          signal,
        ),
        source.codec.serialize(
          annotationReferenceFor("s1", "annotation-5"),
          signal,
        ),
      ]),
    ).resolves.toEqual([
      "batch:annotation-3,annotation-4,annotation-5",
      "",
      "",
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith("s1", undefined, signal, [
      "annotation-3",
      "annotation-4",
      "annotation-5",
    ]);
  });

  it("keeps a selected historical chip alongside the exact current batch", async () => {
    const prepare = vi.fn(
      async (_sessionId, _body, _signal, annotationIds) => ({
        markdown: `batch:${annotationIds?.join(",")}`,
      }),
    );
    const source = createBatchReferenceSource({
      prepare,
      list: async () => [
        {
          id: "annotation-current",
          status: "pending" as const,
          quote: "本次原文",
          comment: "本次批注",
        },
        {
          id: "annotation-history",
          status: "sent" as const,
          quote: "历史原文",
          comment: "历史批注",
        },
      ],
    });
    const signal = new AbortController().signal;

    await expect(
      Promise.all([
        source.codec.serialize(
          annotationReferenceFor("s1", "annotation-current"),
          signal,
        ),
        source.codec.serialize(
          annotationReferenceFor("s1", "annotation-history"),
          signal,
        ),
      ]),
    ).resolves.toEqual([
      "batch:annotation-current\n\n> 历史原文\n> \n> 批注：历史批注",
      "",
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith("s1", undefined, signal, [
      "annotation-current",
    ]);
  });

  it("adds a current annotation through the session input facade", () => {
    let state = { draft: "正文", draftRev: 7, occurrences: [] as const };
    const insertReference = vi.fn((reference, span) => {
      expect(reference).toMatchObject({
        label: "批注 2",
        appearance: "file",
      });
      expect(span).toEqual({ start: 2, end: 2, draftRev: 7 });
      state = {
        ...state,
        draftRev: 8,
        occurrences: [
          {
            occurrenceId: 2,
            source: ANNOTATION_BATCH_SOURCE,
            ref: annotationReferenceFor("s1", "annotation-2"),
          },
        ],
      } as typeof state;
      return true;
    });
    const input = { state: { getSnapshot: () => state }, insertReference };
    const sessions = {
      scope: () => ({
        get: (name: string) =>
          name === "conversation" ? { input: { for: () => input } } : undefined,
      }),
    };

    const insert = createAnnotationReferenceInserter(sessions, "s1");
    expect(insert?.({ id: "annotation-2", sequence: 2 })).toBe(true);
    expect(insert?.({ id: "annotation-2", sequence: 2 })).toBe(false);
    expect(insertReference).toHaveBeenCalledTimes(1);
  });
});
