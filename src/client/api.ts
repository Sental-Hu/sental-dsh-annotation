import {
  parseAnnotationApiResponse,
  type AnnotationApiRequest,
} from "../shared/schema.js";
import {
  ANNOTATION_API_PATH,
  CSRF_HEADER,
  CSRF_VALUE,
} from "../shared/protocol.js";
import type { AnnotationRecord, TextAnchor } from "../shared/types.js";
import type { PreparedAnnotationBatch } from "../service.js";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AnnotationApiClientOptions {
  fetch?: FetchLike;
  path?: string;
}

export interface AnnotationSnapshot {
  readonly revision: string;
  readonly annotations: readonly AnnotationRecord[];
  readonly batches: Readonly<Record<string, unknown>>;
}

export class AnnotationApiError extends Error {
  readonly name = "AnnotationApiError";

  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function defaultFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (typeof globalThis.fetch !== "function") {
    return Promise.reject(
      new AnnotationApiError("unavailable", "Fetch is unavailable."),
    );
  }
  return globalThis.fetch(input, init);
}

/** Same-origin transport for the plugin's small JSON API. */
export class AnnotationApiClient {
  private readonly fetcher: FetchLike;
  private readonly path: string;

  constructor(options: AnnotationApiClientOptions = {}) {
    this.fetcher = options.fetch ?? defaultFetch;
    this.path = options.path ?? ANNOTATION_API_PATH;
  }

  async request<T>(
    request: AnnotationApiRequest,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(this.path, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          [CSRF_HEADER]: CSRF_VALUE,
        },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      if (error instanceof AnnotationApiError) throw error;
      throw new AnnotationApiError(
        "network-error",
        error instanceof Error ? error.message : "Annotation request failed.",
      );
    }

    let parsed: ReturnType<typeof parseAnnotationApiResponse>;
    try {
      parsed = parseAnnotationApiResponse(await response.json());
    } catch (error) {
      throw new AnnotationApiError(
        "invalid-response",
        error instanceof Error
          ? error.message
          : "Malformed annotation response.",
        response.status,
      );
    }
    if (!parsed.ok) {
      throw new AnnotationApiError(
        parsed.error.code,
        parsed.error.message,
        response.status,
        parsed.error.details,
      );
    }
    if (!response.ok) {
      throw new AnnotationApiError(
        "http-error",
        `Annotation request failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    return parsed.data as T;
  }

  async list(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly AnnotationRecord[]> {
    const data = await this.request<unknown>(
      { action: "list", sessionId },
      signal,
    );
    if (!Array.isArray(data)) {
      throw new AnnotationApiError(
        "invalid-response",
        "Annotation list is not an array.",
      );
    }
    return data as AnnotationRecord[];
  }

  async snapshot(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<AnnotationSnapshot> {
    const data = await this.request<unknown>(
      { action: "snapshot", sessionId },
      signal,
    );
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new AnnotationApiError(
        "invalid-response",
        "Annotation snapshot is not an object.",
      );
    }
    const snapshot = data as {
      revision?: unknown;
      annotations?: unknown;
      batches?: unknown;
    };
    if (
      typeof snapshot.revision !== "string" ||
      !Array.isArray(snapshot.annotations) ||
      !snapshot.batches ||
      typeof snapshot.batches !== "object"
    ) {
      throw new AnnotationApiError(
        "invalid-response",
        "Annotation snapshot is malformed.",
      );
    }
    return {
      revision: snapshot.revision,
      annotations: snapshot.annotations as AnnotationRecord[],
      batches: snapshot.batches as Readonly<Record<string, unknown>>,
    };
  }

  create(
    input: {
      sessionId: string;
      messageId: string;
      anchor: TextAnchor;
      quote: string;
      comment: string;
      order: number;
      version?: string;
    },
    signal?: AbortSignal,
  ): Promise<AnnotationRecord> {
    return this.request<AnnotationRecord>(
      {
        action: "create",
        sessionId: input.sessionId,
        messageId: input.messageId,
        anchor: input.anchor,
        quote: input.quote,
        comment: input.comment,
        order: input.order,
        version: input.version ?? "0",
      },
      signal,
    );
  }

  update(
    sessionId: string,
    annotationId: string,
    patch: {
      version: string;
      comment?: string;
      anchor?: TextAnchor;
      quote?: string;
      order?: number;
    },
    signal?: AbortSignal,
  ): Promise<AnnotationRecord> {
    return this.request<AnnotationRecord>(
      { action: "update", sessionId, annotationId, ...patch },
      signal,
    );
  }

  delete(
    sessionId: string,
    annotationId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.request<boolean>(
      { action: "delete", sessionId, annotationId, version },
      signal,
    );
  }

  reorder(
    sessionId: string,
    annotationIds: string[],
    version: string,
    signal?: AbortSignal,
  ): Promise<readonly AnnotationRecord[]> {
    return this.request<readonly AnnotationRecord[]>(
      { action: "reorder", sessionId, annotationIds, version },
      signal,
    );
  }

  prepare(
    sessionId: string,
    body?: string,
    batchId?: string,
    signal?: AbortSignal,
    annotationIds?: string[],
  ): Promise<PreparedAnnotationBatch> {
    return this.request<PreparedAnnotationBatch>(
      {
        action: "prepare",
        sessionId,
        ...(body === undefined ? {} : { body }),
        ...(batchId === undefined ? {} : { batchId }),
        ...(annotationIds === undefined ? {} : { annotationIds }),
      },
      signal,
    );
  }
}

export default AnnotationApiClient;
