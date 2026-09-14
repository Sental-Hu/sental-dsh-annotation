import { describe, expect, it } from "vitest";

import {
  MAX_JSON_PAYLOAD_BYTES,
  assertJsonSafeValue,
  parseAnnotationApiRequest,
  parseAnnotationApiResponse,
} from "../src/shared/schema";

describe("parseAnnotationApiRequest", () => {
  it("accepts a strict create request with JSON-safe fields only", () => {
    expect(
      parseAnnotationApiRequest({
        action: "create",
        sessionId: "session-1",
        messageId: "message-1",
        anchor: {
          blockPath: [0],
          start: 1,
          end: 4,
          prefix: "",
          suffix: "",
          quoteHash: "hash",
        },
        quote: "alpha",
        comment: "beta",
        order: 10,
        version: "version-1",
      }),
    ).toMatchObject({
      action: "create",
      sessionId: "session-1",
      version: "version-1",
    });
  });

  it("rejects unknown fields and oversized request bodies", () => {
    expect(() =>
      parseAnnotationApiRequest({
        action: "list",
        sessionId: "session-1",
        extra: true,
      }),
    ).toThrowError(/unknown field/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "list",
        sessionId: "x".repeat(MAX_JSON_PAYLOAD_BYTES),
      }),
    ).toThrowError(/payload too large/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "list",
        sessionId: "session-1",
        messageId: "message-1",
      }),
    ).toThrowError(/unknown field/i);
  });

  it("parses update, delete, reorder, settle, reconcile, and history requests", () => {
    expect(
      parseAnnotationApiRequest({
        action: "prepare",
        sessionId: "session-1",
        body: "draft",
        batchId: "batch-1",
        annotationIds: ["annotation-1"],
      }),
    ).toEqual({
      action: "prepare",
      sessionId: "session-1",
      body: "draft",
      batchId: "batch-1",
      annotationIds: ["annotation-1"],
    });

    expect(
      parseAnnotationApiRequest({
        action: "update",
        sessionId: "session-1",
        annotationId: "annotation-1",
        version: "v1",
        comment: "updated",
        quote: "moved quote",
      }),
    ).toMatchObject({
      action: "update",
      annotationId: "annotation-1",
      comment: "updated",
      quote: "moved quote",
    });

    expect(
      parseAnnotationApiRequest({
        action: "delete",
        sessionId: "session-1",
        annotationId: "annotation-1",
        version: "v1",
      }),
    ).toMatchObject({
      action: "delete",
      annotationId: "annotation-1",
    });

    expect(
      parseAnnotationApiRequest({
        action: "reorder",
        sessionId: "session-1",
        annotationIds: ["a", "b"],
        version: "v2",
      }),
    ).toMatchObject({
      action: "reorder",
      annotationIds: ["a", "b"],
    });

    expect(
      parseAnnotationApiRequest({
        action: "settle",
        sessionId: "session-1",
        batchId: "batch-1",
        outcome: "accepted",
      }),
    ).toMatchObject({
      action: "settle",
      batchId: "batch-1",
      outcome: "accepted",
    });

    expect(
      parseAnnotationApiRequest({
        action: "settle",
        sessionId: "session-1",
        batchId: "batch-1",
        outcome: "unknown",
      }),
    ).toMatchObject({
      action: "settle",
      batchId: "batch-1",
      outcome: "unknown",
    });

    expect(
      parseAnnotationApiRequest({
        action: "settle",
        sessionId: "session-1",
        batchId: "batch-1",
        outcome: "definite-failure",
        receiptId: "receipt-1",
      }),
    ).toMatchObject({
      action: "settle",
      batchId: "batch-1",
      outcome: "definite-failure",
    });

    expect(
      parseAnnotationApiRequest({
        action: "reconcile",
        sessionId: "session-1",
        batchId: "batch-1",
        found: true,
        scannedAt: "2026-08-27T00:00:00.000Z",
        sentAt: "2026-08-27T00:01:00.000Z",
      }),
    ).toMatchObject({
      action: "reconcile",
      found: true,
    });

    expect(
      parseAnnotationApiRequest({
        action: "history-status",
        sessionId: "session-1",
      }),
    ).toEqual({
      action: "history-status",
      sessionId: "session-1",
    });
  });

  it("rejects malformed requests and unsafe values", () => {
    expect(() =>
      parseAnnotationApiRequest({
        action: "update",
        sessionId: "session-1",
        annotationId: "annotation-1",
        version: "v1",
      }),
    ).toThrowError(/at least one mutable field/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "create",
        sessionId: "session-1",
        messageId: "message-1",
        anchor: {
          blockPath: ["0"],
          start: 1,
          end: 4,
          prefix: "",
          suffix: "",
          quoteHash: "hash",
        },
        quote: "alpha",
        comment: "beta",
        order: 10,
        version: "version-1",
      }),
    ).toThrowError(/blockPath\[0\] expected non-negative integer/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "settle",
        sessionId: "session-1",
        batchId: "batch-1",
        outcome: "maybe",
      }),
    ).toThrowError(/supported settle outcome/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "create",
        sessionId: "session-1",
        messageId: "message-1",
        annotationId: "annotation-1",
        anchor: {
          blockPath: [0],
          start: 1,
          end: 4,
          prefix: "",
          suffix: "",
          quoteHash: "hash",
        },
        quote: "alpha",
        comment: "beta",
        order: 10,
        version: "version-1",
      }),
    ).toThrowError(/unknown field/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "settle",
        sessionId: "session-1",
        batchId: "batch-1",
        outcome: "accepted",
        receiptId: "receipt-1",
      }),
    ).toThrowError(/receiptId is only allowed/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "settle",
        sessionId: "session-1",
        batchId: "batch-1",
        outcome: "unknown",
        sentAt: "2026-08-27T00:01:00.000Z",
      }),
    ).toThrowError(/sentAt is only allowed/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "settle",
        sessionId: "session-1",
        batchId: "batch-1",
        outcome: "definite-failure",
      }),
    ).toThrowError(/receiptId is required/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "settle",
        sessionId: "session-1",
        batchId: "batch-1",
        outcome: "definite-failure",
        receiptId: "receipt-1",
        sentAt: "2026-08-27T00:01:00.000Z",
      }),
    ).toThrowError(/sentAt is only allowed/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "reconcile",
        sessionId: "session-1",
        batchId: "batch-1",
        found: "yes",
        scannedAt: "2026-08-27T00:00:00.000Z",
      }),
    ).toThrowError(/expected boolean/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "reconcile",
        sessionId: "session-1",
        batchId: "batch-1",
        found: true,
        scannedAt: "2026-08-27T00:00:00.000Z",
      }),
    ).toThrowError(/sentAt is required/i);

    expect(() =>
      parseAnnotationApiRequest({
        action: "reconcile",
        sessionId: "session-1",
        batchId: "batch-1",
        found: false,
        scannedAt: "2026-08-27T00:00:00.000Z",
        sentAt: "2026-08-27T00:01:00.000Z",
      }),
    ).toThrowError(/sentAt is only allowed/i);

    expect(() => assertJsonSafeValue({ bad: undefined })).toThrowError(
      /expected defined JSON value/i,
    );
    expect(() => assertJsonSafeValue(() => "bad")).toThrowError(
      /expected JSON-safe plain object/i,
    );
    expect(() =>
      assertJsonSafeValue({ bad: Number.POSITIVE_INFINITY }),
    ).toThrowError(/expected finite number/i);
    expect(() => assertJsonSafeValue(new Array(2))).toThrowError(
      /sparse arrays are not allowed/i,
    );
  });
});

describe("parseAnnotationApiResponse", () => {
  it("rejects non-envelope responses and success payloads with unknown fields", () => {
    expect(() =>
      parseAnnotationApiResponse({
        ok: true,
        data: { annotations: [] },
        extra: true,
      }),
    ).toThrowError(/unknown field/i);

    expect(() =>
      parseAnnotationApiResponse({
        data: {},
      }),
    ).toThrowError(/expected boolean/i);
  });

  it("accepts strict error responses", () => {
    expect(
      parseAnnotationApiResponse({
        ok: false,
        error: {
          code: "conflict",
          message: "Version mismatch",
          details: { expectedVersion: "v2" },
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "conflict",
        message: "Version mismatch",
        details: { expectedVersion: "v2" },
      },
    });
  });

  it("accepts strict success responses and rejects malformed envelopes", () => {
    expect(
      parseAnnotationApiResponse({
        ok: true,
        data: {
          annotations: [{ id: "a" }],
          next: null,
        },
      }),
    ).toEqual({
      ok: true,
      data: {
        annotations: [{ id: "a" }],
        next: null,
      },
    });

    expect(() =>
      parseAnnotationApiResponse({
        ok: true,
        data: {},
        error: {
          code: "bad",
          message: "should not coexist",
        },
      }),
    ).toThrowError(/mutually exclusive/i);

    expect(() =>
      parseAnnotationApiResponse({
        ok: false,
        data: {},
        error: {
          code: "bad",
          message: "no data on error",
        },
      }),
    ).toThrowError(/mutually exclusive/i);

    expect(() =>
      parseAnnotationApiResponse({
        ok: false,
      }),
    ).toThrowError(/expected for error response/i);

    expect(() =>
      parseAnnotationApiResponse({
        ok: true,
      }),
    ).toThrowError(/expected for successful response/i);

    expect(() =>
      parseAnnotationApiResponse({
        ok: false,
        error: {
          code: "bad",
          message: "",
        },
      }),
    ).toThrowError(/expected non-empty string/i);
  });
});
