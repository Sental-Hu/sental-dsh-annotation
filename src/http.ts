import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AnnotationService,
  AnnotationServiceError,
  type AnnotationServiceErrorCode,
} from "./service.js";
import {
  MAX_JSON_PAYLOAD_BYTES,
  parseAnnotationApiRequest,
  type AnnotationApiRequest,
} from "./shared/schema.js";
import {
  ANNOTATION_API_PATH,
  CSRF_HEADER,
  CSRF_VALUE,
} from "./shared/protocol.js";

export {
  ANNOTATION_API_PATH,
  CSRF_HEADER,
  CSRF_VALUE,
} from "./shared/protocol.js";

export interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface WebServerPort {
  register(route: WebRoute): () => void;
}

export interface AnnotationHttpContext {
  webServer: WebServerPort;
}

interface JsonSuccess {
  ok: true;
  data: unknown;
}

interface JsonFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

function respond(
  res: ServerResponse,
  status: number,
  body: JsonSuccess | JsonFailure,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function failure(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  respond(res, status, {
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

function statusForCode(code: string): number {
  if (code === "invalid-input") return 400;
  if (code === "unsupported-host") return 503;
  if (code === "target-not-found") return 404;
  if (
    code === "live-session-not-found" ||
    code === "flush-failed" ||
    code === "storage-error"
  )
    return 503;
  if (
    code === "conflict" ||
    code === "range-conflict" ||
    code === "prepare-conflict" ||
    code === "batch-conflict" ||
    code === "invalid-state" ||
    code === "durable-marker-missing"
  )
    return 409;
  if (code === "internal-error") return 500;
  return 422;
}

function errorParts(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof AnnotationServiceError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error && typeof error === "object") {
    const raw = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    if (typeof raw.code === "string" && typeof raw.message === "string") {
      return { code: raw.code, message: raw.message, details: raw.details };
    }
  }
  return { code: "internal-error", message: "Annotation request failed." };
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin) || typeof origin !== "string") return false;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function contentTypeIsJson(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return (
    typeof contentType === "string" &&
    contentType.split(";", 1)[0]!.trim().toLowerCase() === "application/json"
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_JSON_PAYLOAD_BYTES) {
        req.destroy();
        fail(new Error("Payload too large."));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("Request aborted.")));
  });
}

async function dispatch(
  service: AnnotationService,
  request: AnnotationApiRequest,
): Promise<unknown> {
  switch (request.action) {
    case "list":
      return service.list(request.sessionId);
    case "snapshot":
      return service.snapshot(request.sessionId);
    case "create":
      return service.create(request.sessionId, request);
    case "update":
      return service.update(request.sessionId, request.annotationId, request);
    case "delete":
      return service.delete(
        request.sessionId,
        request.annotationId,
        request.version,
      );
    case "reorder":
      return service.reorder(
        request.sessionId,
        request.annotationIds,
        request.version,
      );
    case "prepare":
      return service.prepare(request.sessionId, {
        body: request.body,
        batchId: request.batchId,
        annotationIds: request.annotationIds,
      });
    case "settle":
      return service.settle({
        sessionId: request.sessionId,
        batchId: request.batchId,
        outcome: request.outcome,
        receiptId: request.receiptId,
      });
    case "reconcile":
      if (!request.found) return { found: false, batchId: request.batchId };
      return service.reconcile({
        sessionId: request.sessionId,
        batchId: request.batchId,
        scannedAt: request.scannedAt,
        sentAt: request.sentAt,
      });
    case "history-status":
      return service.historyStatus(request.sessionId);
  }
}

/** Register the one same-origin JSON API route and return its disposer. */
export function registerAnnotationRoute(
  context: AnnotationHttpContext,
  service: AnnotationService,
): () => void {
  const route: WebRoute = {
    kind: "prefix",
    path: ANNOTATION_API_PATH,
    handler: async (req, res) => {
      if (req.url === undefined) {
        failure(res, 400, "invalid-request", "Request URL is missing.");
        return;
      }
      const pathname = new URL(req.url, "http://dsh-annotation.invalid")
        .pathname;
      if (pathname !== ANNOTATION_API_PATH) {
        failure(res, 404, "not-found", "Unknown annotation endpoint.");
        return;
      }
      if (req.method !== "POST") {
        failure(
          res,
          405,
          "method-not-allowed",
          "Use POST for annotation actions.",
        );
        return;
      }
      if (!sameOrigin(req)) {
        failure(
          res,
          403,
          "origin-forbidden",
          "Cross-origin annotation requests are not allowed.",
        );
        return;
      }
      const csrf = req.headers[CSRF_HEADER];
      if (csrf !== CSRF_VALUE) {
        failure(
          res,
          403,
          "csrf-required",
          "The annotation CSRF header is required.",
        );
        return;
      }
      if (!contentTypeIsJson(req)) {
        failure(res, 415, "content-type-required", "Use application/json.");
        return;
      }
      try {
        const text = await readBody(req);
        let request: AnnotationApiRequest;
        try {
          const parsed: unknown = JSON.parse(text);
          request = parseAnnotationApiRequest(parsed);
        } catch (error) {
          failure(
            res,
            400,
            "invalid-input",
            error instanceof Error ? error.message : "Malformed JSON request.",
          );
          return;
        }
        const data = await dispatch(service, request);
        respond(res, 200, { ok: true, data });
      } catch (error) {
        const parts = errorParts(error);
        const status =
          parts.code === "internal-error" &&
          error instanceof Error &&
          /Payload too large/.test(error.message)
            ? 413
            : statusForCode(parts.code);
        failure(res, status, parts.code, parts.message, parts.details);
      }
    },
  };
  return context.webServer.register(route);
}

export type { AnnotationServiceErrorCode };
