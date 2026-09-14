import type { JsonObject, JsonValue, TextAnchor } from "./types.js";

export const MAX_JSON_PAYLOAD_BYTES = 64 * 1024;

export type AnnotationApiRequest =
  | {
      action: "list" | "snapshot" | "history-status";
      sessionId: string;
    }
  | {
      action: "prepare";
      sessionId: string;
      body?: string;
      batchId?: string;
      annotationIds?: string[];
    }
  | {
      action: "create";
      sessionId: string;
      messageId: string;
      anchor: TextAnchor;
      quote: string;
      comment: string;
      order: number;
      version: string;
    }
  | {
      action: "update";
      sessionId: string;
      annotationId: string;
      version: string;
      comment?: string;
      anchor?: TextAnchor;
      quote?: string;
      order?: number;
    }
  | {
      action: "delete";
      sessionId: string;
      annotationId: string;
      version: string;
    }
  | {
      action: "reorder";
      sessionId: string;
      annotationIds: string[];
      version: string;
    }
  | {
      action: "settle";
      sessionId: string;
      batchId: string;
      outcome: "accepted" | "unknown" | "definite-failure";
      receiptId?: string;
    }
  | {
      action: "reconcile";
      sessionId: string;
      batchId: string;
      found: boolean;
      scannedAt: string;
      sentAt?: string;
    };

export type AnnotationApiResponse =
  | {
      ok: true;
      data: JsonValue;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: JsonValue;
      };
    };

function fail(message: string): never {
  throw new Error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertJsonSafeValue(value: unknown, path = "$"): JsonValue {
  if (value === null) {
    return value;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`${path} expected finite number.`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        fail(`${path} sparse arrays are not allowed.`);
      }
    }

    return value.map((entry, index) =>
      assertJsonSafeValue(entry, `${path}[${index}]`),
    );
  }

  if (!isPlainObject(value)) {
    fail(`${path} expected JSON-safe plain object.`);
  }

  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      fail(`${path}.${key} expected defined JSON value.`);
    }
    result[key] = assertJsonSafeValue(entry, `${path}.${key}`);
  }

  return result;
}

function assertPayloadSize(value: unknown): void {
  const jsonValue = assertJsonSafeValue(value);
  const size = new TextEncoder().encode(JSON.stringify(jsonValue)).length;
  if (size > MAX_JSON_PAYLOAD_BYTES) {
    fail(`Payload too large: ${size} bytes.`);
  }
}

function readObject(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`${path} expected object.`);
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      fail(`${path} contains unknown field "${key}".`);
    }
  }

  return value;
}

function readRawObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`${path} expected object.`);
  }

  return value;
}

function readString(
  object: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || !value.trim()) {
    fail(`${path}.${key} expected non-empty string.`);
  }

  return value;
}

function readBoolean(
  object: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    fail(`${path}.${key} expected boolean.`);
  }

  return value;
}

function readNumber(
  object: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path}.${key} expected finite number.`);
  }

  return value;
}

function readOptionalString(
  object: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !value.trim()) {
    fail(`${path}.${key} expected non-empty string.`);
  }

  return value;
}

function readOptionalText(
  object: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    fail(`${path}.${key} expected string.`);
  }
  return value;
}

function readOptionalNumber(
  object: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path}.${key} expected finite number.`);
  }

  return value;
}

function readSettleOutcome(
  object: Record<string, unknown>,
  key: string,
  path: string,
): "accepted" | "unknown" | "definite-failure" {
  const value = readString(object, key, path);
  if (
    value !== "accepted" &&
    value !== "unknown" &&
    value !== "definite-failure"
  ) {
    fail(`${path}.${key} expected supported settle outcome.`);
  }

  return value;
}

function rejectPresentField(
  object: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (object[key] !== undefined) {
    fail(`${path}.${key} is only allowed in a different branch.`);
  }
}

function readStringArray(
  object: Record<string, unknown>,
  key: string,
  path: string,
): string[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    fail(`${path}.${key} expected string array.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      fail(`${path}.${key}[${index}] expected non-empty string.`);
    }
    return entry;
  });
}

function readAnchor(value: unknown, path: string): TextAnchor {
  const object = readObject(
    value,
    ["blockPath", "start", "end", "prefix", "suffix", "quoteHash"],
    path,
  );
  const blockPathValue = object.blockPath;
  if (!Array.isArray(blockPathValue)) {
    fail(`${path}.blockPath expected number array.`);
  }

  const blockPath = blockPathValue.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      fail(`${path}.blockPath[${index}] expected non-negative integer.`);
    }
    return entry;
  });

  const start = readNumber(object, "start", path);
  const end = readNumber(object, "end", path);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    fail(`${path} expected valid half-open UTF-16 range.`);
  }

  return {
    blockPath,
    start,
    end,
    prefix:
      typeof object.prefix === "string"
        ? object.prefix
        : fail(`${path}.prefix expected string.`),
    suffix:
      typeof object.suffix === "string"
        ? object.suffix
        : fail(`${path}.suffix expected string.`),
    quoteHash:
      typeof object.quoteHash === "string" && object.quoteHash
        ? object.quoteHash
        : fail(`${path}.quoteHash expected non-empty string.`),
  };
}

export function parseAnnotationApiRequest(
  value: unknown,
): AnnotationApiRequest {
  assertPayloadSize(value);
  const rawObject = readRawObject(value, "$");
  const action = readString(rawObject, "action", "$");

  switch (action) {
    case "list":
    case "snapshot":
    case "history-status": {
      const object = readObject(value, ["action", "sessionId"], "$");
      return { action, sessionId: readString(object, "sessionId", "$") };
    }

    case "prepare": {
      const object = readObject(
        value,
        ["action", "sessionId", "body", "batchId", "annotationIds"],
        "$",
      );
      return {
        action,
        sessionId: readString(object, "sessionId", "$"),
        body: readOptionalText(object, "body", "$"),
        batchId: readOptionalString(object, "batchId", "$"),
        annotationIds:
          object.annotationIds === undefined
            ? undefined
            : readStringArray(object, "annotationIds", "$"),
      };
    }

    case "create": {
      const object = readObject(
        value,
        [
          "action",
          "sessionId",
          "messageId",
          "anchor",
          "quote",
          "comment",
          "order",
          "version",
        ],
        "$",
      );
      return {
        action,
        sessionId: readString(object, "sessionId", "$"),
        messageId: readString(object, "messageId", "$"),
        anchor: readAnchor(object.anchor, "$.anchor"),
        quote: readString(object, "quote", "$"),
        comment: readString(object, "comment", "$"),
        order: readNumber(object, "order", "$"),
        version: readString(object, "version", "$"),
      };
    }

    case "update": {
      const object = readObject(
        value,
        [
          "action",
          "sessionId",
          "annotationId",
          "version",
          "comment",
          "anchor",
          "quote",
          "order",
        ],
        "$",
      );
      const update = {
        action,
        sessionId: readString(object, "sessionId", "$"),
        annotationId: readString(object, "annotationId", "$"),
        version: readString(object, "version", "$"),
        comment: readOptionalString(object, "comment", "$"),
        anchor:
          object.anchor === undefined
            ? undefined
            : readAnchor(object.anchor, "$.anchor"),
        quote: readOptionalString(object, "quote", "$"),
        order: readOptionalNumber(object, "order", "$"),
      };

      if (
        update.comment === undefined &&
        update.anchor === undefined &&
        update.quote === undefined &&
        update.order === undefined
      ) {
        fail("$.update expected at least one mutable field.");
      }

      return update;
    }

    case "delete": {
      const object = readObject(
        value,
        ["action", "sessionId", "annotationId", "version"],
        "$",
      );
      return {
        action,
        sessionId: readString(object, "sessionId", "$"),
        annotationId: readString(object, "annotationId", "$"),
        version: readString(object, "version", "$"),
      };
    }

    case "reorder": {
      const object = readObject(
        value,
        ["action", "sessionId", "annotationIds", "version"],
        "$",
      );
      return {
        action,
        sessionId: readString(object, "sessionId", "$"),
        annotationIds: readStringArray(object, "annotationIds", "$"),
        version: readString(object, "version", "$"),
      };
    }

    case "settle": {
      const object = readObject(
        value,
        ["action", "sessionId", "batchId", "outcome", "receiptId", "sentAt"],
        "$",
      );
      const outcome = readSettleOutcome(object, "outcome", "$");
      if (outcome === "accepted" || outcome === "unknown") {
        rejectPresentField(object, "receiptId", "$");
        rejectPresentField(object, "sentAt", "$");
      }

      if (outcome === "definite-failure") {
        rejectPresentField(object, "sentAt", "$");
        if (object.receiptId === undefined) {
          fail("$.receiptId is required for definite-failure.");
        }
      }

      return {
        action,
        sessionId: readString(object, "sessionId", "$"),
        batchId: readString(object, "batchId", "$"),
        outcome,
        receiptId: readOptionalString(object, "receiptId", "$"),
      };
    }

    case "reconcile": {
      const object = readObject(
        value,
        ["action", "sessionId", "batchId", "found", "scannedAt", "sentAt"],
        "$",
      );
      const found = readBoolean(object, "found", "$");
      if (found && object.sentAt === undefined) {
        fail("$.sentAt is required when found is true.");
      }
      if (!found) {
        rejectPresentField(object, "sentAt", "$");
      }

      return {
        action,
        sessionId: readString(object, "sessionId", "$"),
        batchId: readString(object, "batchId", "$"),
        found,
        scannedAt: readString(object, "scannedAt", "$"),
        sentAt: readOptionalString(object, "sentAt", "$"),
      };
    }

    default:
      fail(`$.action unsupported action "${action}".`);
  }
}

export function parseAnnotationApiResponse(
  value: unknown,
): AnnotationApiResponse {
  assertPayloadSize(value);
  const object = readRawObject(value, "$");
  const okValue = object.ok;
  if (typeof okValue !== "boolean") {
    fail(`$.ok expected boolean.`);
  }

  if (okValue) {
    if ("error" in object) {
      fail("$.data and $.error are mutually exclusive.");
    }

    const strictObject = readObject(value, ["ok", "data"], "$");
    if (!("data" in object)) {
      fail("$.data expected for successful response.");
    }

    return {
      ok: true,
      data: assertJsonSafeValue(strictObject.data, "$.data"),
    };
  }

  if ("data" in object) {
    fail("$.data and $.error are mutually exclusive.");
  }

  const strictObject = readObject(value, ["ok", "error"], "$");
  if (!("error" in strictObject)) {
    fail("$.error expected for error response.");
  }

  const errorObject = readObject(
    strictObject.error,
    ["code", "message", "details"],
    "$.error",
  );
  return {
    ok: false,
    error: {
      code: readString(errorObject, "code", "$.error"),
      message: readString(errorObject, "message", "$.error"),
      details:
        errorObject.details === undefined
          ? undefined
          : assertJsonSafeValue(errorObject.details, "$.error.details"),
    },
  };
}
