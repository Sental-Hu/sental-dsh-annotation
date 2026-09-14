import { describe, expect, it } from "vitest";

import {
  createAnnotationMachineState,
  reduceAnnotationMachine,
} from "../src/shared/state-machine";
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
  status: AnnotationRecord["status"] = "pending",
): AnnotationRecord {
  return {
    id,
    sessionId: "session-1",
    status,
    messageId: "message-1",
    anchor: makeAnchor(0, 4),
    quote: `quote-${id}`,
    comment: `comment-${id}`,
    color: "amber",
    order: id === "a" ? 10 : 20,
    version: `version-${id}`,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("annotation send state machine", () => {
  it("transitions pending annotations to prepared and then sent", () => {
    const initial = createAnnotationMachineState([
      makeAnnotation("a"),
      makeAnnotation("b"),
      makeAnnotation("c"),
    ]);

    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a", "b"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });

    expect(
      prepared.annotations.map(({ id, status, batchId }) => ({
        id,
        status,
        batchId,
      })),
    ).toEqual([
      { id: "a", status: "prepared", batchId: "batch-1" },
      { id: "b", status: "prepared", batchId: "batch-1" },
      { id: "c", status: "pending", batchId: undefined },
    ]);

    const sent = reduceAnnotationMachine(prepared, {
      type: "confirm-sent",
      batchId: "batch-1",
      sentAt: "2026-08-27T01:05:00.000Z",
    });

    expect(
      sent.annotations.map(({ id, status, batchId, sentAt }) => ({
        id,
        status,
        batchId,
        sentAt,
      })),
    ).toEqual([
      {
        id: "a",
        status: "sent",
        batchId: "batch-1",
        sentAt: "2026-08-27T01:05:00.000Z",
      },
      {
        id: "b",
        status: "sent",
        batchId: "batch-1",
        sentAt: "2026-08-27T01:05:00.000Z",
      },
      {
        id: "c",
        status: "pending",
        batchId: undefined,
        sentAt: undefined,
      },
    ]);
  });

  it("rolls prepared or unknown batches back to pending only after a definite failure receipt", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });
    const unknown = reduceAnnotationMachine(prepared, {
      type: "mark-unknown",
      batchId: "batch-1",
      occurredAt: "2026-08-27T01:01:00.000Z",
      reason: "disconnect",
    });

    const rolledBack = reduceAnnotationMachine(unknown, {
      type: "record-definite-failure",
      batchId: "batch-1",
      receiptId: "receipt-1",
      occurredAt: "2026-08-27T01:02:00.000Z",
    });

    expect(rolledBack.annotations).toMatchObject([
      {
        id: "a",
        status: "pending",
        batchId: undefined,
        sentAt: undefined,
      },
    ]);
    expect(rolledBack.batches).toEqual({
      "batch-1": {
        batchId: "batch-1",
        annotationIds: ["a"],
        markdown: "serialized",
        status: "unknown",
        preparedAt: "2026-08-27T01:00:00.000Z",
        updatedAt: "2026-08-27T01:02:00.000Z",
        unknownReason: "disconnect",
        terminalOutcome: "definite-failure",
        failureReceiptId: "receipt-1",
        failedAt: "2026-08-27T01:02:00.000Z",
      },
    });
  });

  it("moves prepared batches to unknown and confirms them from durable log reconciliation", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });
    const unknown = reduceAnnotationMachine(prepared, {
      type: "mark-unknown",
      batchId: "batch-1",
      occurredAt: "2026-08-27T01:01:00.000Z",
      reason: "refresh",
    });
    const unknownAgain = reduceAnnotationMachine(unknown, {
      type: "mark-unknown",
      batchId: "batch-1",
      occurredAt: "2026-08-27T01:02:00.000Z",
      reason: "still-refreshing",
    });

    expect(unknownAgain.annotations[0]?.status).toBe("unknown");

    const unresolved = reduceAnnotationMachine(unknownAgain, {
      type: "reconcile-log",
      batchId: "batch-1",
      found: false,
      scannedAt: "2026-08-27T01:03:00.000Z",
    });
    expect(unresolved).toEqual(unknownAgain);

    const reconciled = reduceAnnotationMachine(unknownAgain, {
      type: "reconcile-log",
      batchId: "batch-1",
      found: true,
      scannedAt: "2026-08-27T01:04:00.000Z",
      sentAt: "2026-08-27T01:04:00.000Z",
    });

    expect(reconciled.annotations[0]).toMatchObject({
      id: "a",
      status: "sent",
      batchId: "batch-1",
      sentAt: "2026-08-27T01:04:00.000Z",
    });
    expect(reconciled.batches["batch-1"]).toMatchObject({
      status: "sent",
      scannedAt: "2026-08-27T01:04:00.000Z",
      sentAt: "2026-08-27T01:04:00.000Z",
    });
  });

  it("treats confirmation as idempotent", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });
    const confirmedOnce = reduceAnnotationMachine(prepared, {
      type: "confirm-sent",
      batchId: "batch-1",
      sentAt: "2026-08-27T01:05:00.000Z",
    });

    expect(
      reduceAnnotationMachine(confirmedOnce, {
        type: "confirm-sent",
        batchId: "batch-1",
        sentAt: "2026-08-27T01:06:00.000Z",
      }),
    ).toEqual(confirmedOnce);
  });

  it("treats an identical prepare retry as idempotent for prepared and unknown batches", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });

    expect(
      reduceAnnotationMachine(prepared, {
        type: "prepare",
        batchId: "batch-1",
        annotationIds: ["a"],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:01:00.000Z",
      }),
    ).toEqual(prepared);

    const unknown = reduceAnnotationMachine(prepared, {
      type: "mark-unknown",
      batchId: "batch-1",
      occurredAt: "2026-08-27T01:02:00.000Z",
      reason: "disconnect",
    });

    expect(
      reduceAnnotationMachine(unknown, {
        type: "prepare",
        batchId: "batch-1",
        annotationIds: ["a"],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:03:00.000Z",
      }),
    ).toEqual(unknown);
  });

  it("rejects prepare retries whose members or markdown conflict with the existing batch", () => {
    const initial = createAnnotationMachineState([
      makeAnnotation("a"),
      makeAnnotation("b"),
    ]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });

    expect(() =>
      reduceAnnotationMachine(prepared, {
        type: "prepare",
        batchId: "batch-1",
        annotationIds: ["a"],
        markdown: "different",
        preparedAt: "2026-08-27T01:01:00.000Z",
      }),
    ).toThrowError(/preparation conflict/i);

    expect(() =>
      reduceAnnotationMachine(prepared, {
        type: "prepare",
        batchId: "batch-1",
        annotationIds: ["a", "b"],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:01:00.000Z",
      }),
    ).toThrowError(/preparation conflict/i);
  });

  it("blocks unknown annotations from re-preparing before a definite failure receipt arrives", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });
    const unknown = reduceAnnotationMachine(prepared, {
      type: "mark-unknown",
      batchId: "batch-1",
      occurredAt: "2026-08-27T01:01:00.000Z",
      reason: "timeout",
    });

    expect(() =>
      reduceAnnotationMachine(unknown, {
        type: "prepare",
        batchId: "batch-2",
        annotationIds: ["a"],
        markdown: "serialized-2",
        preparedAt: "2026-08-27T01:02:00.000Z",
      }),
    ).toThrowError(/unknown/i);
  });

  it("rejects invalid prepare requests", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);

    expect(() =>
      reduceAnnotationMachine(initial, {
        type: "prepare",
        batchId: "batch-empty",
        annotationIds: [],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:00:00.000Z",
      }),
    ).toThrowError(/empty annotation batch/i);

    expect(() =>
      reduceAnnotationMachine(initial, {
        type: "prepare",
        batchId: "batch-dup",
        annotationIds: ["a", "a"],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:00:00.000Z",
      }),
    ).toThrowError(/duplicate annotation id/i);

    expect(() =>
      reduceAnnotationMachine(initial, {
        type: "prepare",
        batchId: "batch-missing",
        annotationIds: ["missing"],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:00:00.000Z",
      }),
    ).toThrowError(/unknown annotation/i);
  });

  it("rejects preparing annotations that are already prepared or sent", () => {
    const preparedState = createAnnotationMachineState([
      makeAnnotation("a", "prepared"),
    ]);
    const sentState = createAnnotationMachineState([
      makeAnnotation("a", "sent"),
    ]);

    expect(() =>
      reduceAnnotationMachine(preparedState, {
        type: "prepare",
        batchId: "batch-1",
        annotationIds: ["a"],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:00:00.000Z",
      }),
    ).toThrowError(/only pending annotations/i);

    expect(() =>
      reduceAnnotationMachine(sentState, {
        type: "prepare",
        batchId: "batch-2",
        annotationIds: ["a"],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:00:00.000Z",
      }),
    ).toThrowError(/only pending annotations/i);
  });

  it("handles invalid batch transitions exhaustively", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });
    const sent = reduceAnnotationMachine(prepared, {
      type: "confirm-sent",
      batchId: "batch-1",
      sentAt: "2026-08-27T01:05:00.000Z",
    });
    const rolledBack = reduceAnnotationMachine(prepared, {
      type: "record-definite-failure",
      batchId: "batch-1",
      receiptId: "receipt-1",
      occurredAt: "2026-08-27T01:02:00.000Z",
    });

    expect(
      reduceAnnotationMachine(sent, {
        type: "mark-unknown",
        batchId: "batch-1",
        occurredAt: "2026-08-27T01:06:00.000Z",
        reason: "late-timeout",
      }),
    ).toEqual(sent);

    expect(() =>
      reduceAnnotationMachine(initial, {
        type: "confirm-sent",
        batchId: "missing",
        sentAt: "2026-08-27T01:05:00.000Z",
      }),
    ).toThrowError(/unknown batch/i);

    expect(
      reduceAnnotationMachine(rolledBack, {
        type: "mark-unknown",
        batchId: "batch-1",
        occurredAt: "2026-08-27T01:06:00.000Z",
        reason: "retry",
      }).batches["batch-1"],
    ).toMatchObject({
      status: "unknown",
      terminalOutcome: "definite-failure",
    });

    expect(
      reduceAnnotationMachine(rolledBack, {
        type: "confirm-sent",
        batchId: "batch-1",
        sentAt: "2026-08-27T01:07:00.000Z",
      }).batches["batch-1"],
    ).toMatchObject({
      status: "sent",
      terminalOutcome: "definite-failure",
      failureReceiptId: "receipt-1",
    });

    expect(() =>
      reduceAnnotationMachine(sent, {
        type: "record-definite-failure",
        batchId: "batch-1",
        receiptId: "receipt-2",
        occurredAt: "2026-08-27T01:08:00.000Z",
      }),
    ).toThrowError(/cannot roll back sent batch/i);

    expect(
      reduceAnnotationMachine(rolledBack, {
        type: "record-definite-failure",
        batchId: "batch-1",
        receiptId: "receipt-3",
        occurredAt: "2026-08-27T01:09:00.000Z",
      }).batches["batch-1"],
    ).toMatchObject({
      status: "unknown",
      terminalOutcome: "definite-failure",
      failureReceiptId: "receipt-3",
      failedAt: "2026-08-27T01:09:00.000Z",
    });

    expect(() =>
      reduceAnnotationMachine(prepared, {
        type: "reconcile-log",
        batchId: "batch-1",
        found: true,
        scannedAt: "2026-08-27T01:10:00.000Z",
      }),
    ).toThrowError(/requires a sentAt timestamp/i);
  });

  it("does not downgrade inconsistent sent annotations during unknown transitions", () => {
    const inconsistent = {
      annotations: [
        {
          ...makeAnnotation("a", "sent"),
          batchId: "batch-1",
          sentAt: "2026-08-27T01:05:00.000Z",
        },
      ],
      batches: {
        "batch-1": {
          batchId: "batch-1",
          annotationIds: ["a"],
          markdown: "serialized",
          status: "unknown" as const,
          preparedAt: "2026-08-27T01:00:00.000Z",
          updatedAt: "2026-08-27T01:01:00.000Z",
        },
      },
    };

    const result = reduceAnnotationMachine(inconsistent, {
      type: "mark-unknown",
      batchId: "batch-1",
      occurredAt: "2026-08-27T01:06:00.000Z",
      reason: "late-disconnect",
    });

    expect(result.annotations[0]).toMatchObject({
      id: "a",
      status: "sent",
      batchId: "batch-1",
      sentAt: "2026-08-27T01:05:00.000Z",
    });
  });

  it("never persists a DESIGN-undefined failed batch state", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });

    const rolledBack = reduceAnnotationMachine(prepared, {
      type: "record-definite-failure",
      batchId: "batch-1",
      receiptId: "receipt-1",
      occurredAt: "2026-08-27T01:02:00.000Z",
    });

    expect(
      Object.values(rolledBack.batches).some(
        (batch) => batch.status === "failed",
      ),
    ).toBe(false);
    expect(rolledBack.batches["batch-1"]).toBeDefined();
  });

  it("keeps failed-batch correlation for late durable marker reconciliation", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });
    const rolledBack = reduceAnnotationMachine(prepared, {
      type: "record-definite-failure",
      batchId: "batch-1",
      receiptId: "receipt-1",
      occurredAt: "2026-08-27T01:02:00.000Z",
    });

    const lateReconciled = reduceAnnotationMachine(rolledBack, {
      type: "reconcile-log",
      batchId: "batch-1",
      found: true,
      scannedAt: "2026-08-27T01:04:00.000Z",
      sentAt: "2026-08-27T01:04:00.000Z",
    });

    expect(lateReconciled.annotations[0]).toMatchObject({
      id: "a",
      status: "pending",
      batchId: undefined,
      sentAt: undefined,
    });
    expect(lateReconciled.batches["batch-1"]).toMatchObject({
      status: "sent",
      terminalOutcome: "definite-failure",
      failureReceiptId: "receipt-1",
      failedAt: "2026-08-27T01:02:00.000Z",
      sentAt: "2026-08-27T01:04:00.000Z",
      scannedAt: "2026-08-27T01:04:00.000Z",
    });
  });

  it("allows a new batch after failure tombstone and does not let old reconciliation steal it back", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized-1",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });
    const rolledBack = reduceAnnotationMachine(prepared, {
      type: "record-definite-failure",
      batchId: "batch-1",
      receiptId: "receipt-1",
      occurredAt: "2026-08-27T01:02:00.000Z",
    });
    const reparared = reduceAnnotationMachine(rolledBack, {
      type: "prepare",
      batchId: "batch-2",
      annotationIds: ["a"],
      markdown: "serialized-2",
      preparedAt: "2026-08-27T01:03:00.000Z",
    });
    const lateOldReconcile = reduceAnnotationMachine(reparared, {
      type: "reconcile-log",
      batchId: "batch-1",
      found: true,
      scannedAt: "2026-08-27T01:04:00.000Z",
      sentAt: "2026-08-27T01:04:00.000Z",
    });

    expect(lateOldReconcile.annotations[0]).toMatchObject({
      id: "a",
      status: "prepared",
      batchId: "batch-2",
      sentAt: undefined,
    });
    expect(lateOldReconcile.batches["batch-1"]).toMatchObject({
      status: "sent",
      terminalOutcome: "definite-failure",
    });
    expect(lateOldReconcile.batches["batch-2"]).toMatchObject({
      status: "prepared",
      annotationIds: ["a"],
      markdown: "serialized-2",
    });
  });

  it("never reuses a failure tombstone correlation", () => {
    const initial = createAnnotationMachineState([makeAnnotation("a")]);
    const prepared = reduceAnnotationMachine(initial, {
      type: "prepare",
      batchId: "batch-1",
      annotationIds: ["a"],
      markdown: "serialized-1",
      preparedAt: "2026-08-27T01:00:00.000Z",
    });
    const failed = reduceAnnotationMachine(prepared, {
      type: "record-definite-failure",
      batchId: "batch-1",
      receiptId: "receipt-1",
      occurredAt: "2026-08-27T01:02:00.000Z",
    });

    expect(() =>
      reduceAnnotationMachine(failed, {
        type: "prepare",
        batchId: "batch-1",
        annotationIds: ["a"],
        markdown: "serialized-retry",
        preparedAt: "2026-08-27T01:03:00.000Z",
      }),
    ).toThrowError(/cannot be reused/i);
    expect(failed.batches["batch-1"]).toMatchObject({
      terminalOutcome: "definite-failure",
      failureReceiptId: "receipt-1",
    });
  });

  it("rejects malformed batch snapshots with unsupported statuses", () => {
    const malformed = {
      annotations: [{ ...makeAnnotation("a"), batchId: "batch-1" }],
      batches: {
        "batch-1": {
          batchId: "batch-1",
          annotationIds: ["a"],
          markdown: "serialized",
          status: "pending",
          preparedAt: "2026-08-27T01:00:00.000Z",
          updatedAt: "2026-08-27T01:00:00.000Z",
        },
      },
    } as unknown as ReturnType<typeof createAnnotationMachineState>;

    expect(() =>
      reduceAnnotationMachine(malformed, {
        type: "mark-unknown",
        batchId: "batch-1",
        occurredAt: "2026-08-27T01:06:00.000Z",
        reason: "corrupt",
      }),
    ).toThrowError(/cannot become unknown from pending/i);

    expect(() =>
      reduceAnnotationMachine(malformed, {
        type: "confirm-sent",
        batchId: "batch-1",
        sentAt: "2026-08-27T01:06:00.000Z",
      }),
    ).toThrowError(/cannot be confirmed from pending/i);

    expect(() =>
      reduceAnnotationMachine(malformed, {
        type: "record-definite-failure",
        batchId: "batch-1",
        receiptId: "receipt-1",
        occurredAt: "2026-08-27T01:06:00.000Z",
      }),
    ).toThrowError(/cannot fail from pending/i);

    expect(() =>
      reduceAnnotationMachine(malformed, {
        type: "prepare",
        batchId: "batch-1",
        annotationIds: ["a"],
        markdown: "serialized",
        preparedAt: "2026-08-27T01:06:00.000Z",
      }),
    ).toThrowError(/cannot be prepared from pending/i);
  });
});
