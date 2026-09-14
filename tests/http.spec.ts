import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  ANNOTATION_API_PATH,
  CSRF_HEADER,
  registerAnnotationRoute,
  type WebRoute,
} from "../src/http.js";
import type { AnnotationService } from "../src/service.js";

class RequestFake extends EventEmitter {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  destroyed = false;

  constructor(
    body: unknown,
    options: { method?: string; origin?: string; contentType?: string } = {},
  ) {
    super();
    this.method = options.method ?? "POST";
    this.url = `${ANNOTATION_API_PATH}?v=1`;
    this.headers = {
      host: "127.0.0.1:3080",
      [CSRF_HEADER]: "1",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.contentType === undefined
        ? { "content-type": "application/json" }
        : { "content-type": options.contentType }),
    };
    queueMicrotask(() => {
      if (body !== undefined)
        this.emit("data", Buffer.from(JSON.stringify(body)));
      this.emit("end");
    });
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class ResponseFake {
  statusCode = 200;
  headersSent = false;
  readonly headers = new Map<string, string>();
  body = "";

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  end(body = ""): void {
    this.headersSent = true;
    this.body = body;
  }
}

function routeFor(service: AnnotationService): WebRoute {
  let route: WebRoute | undefined;
  registerAnnotationRoute(
    {
      webServer: {
        register(value) {
          route = value;
          return () => undefined;
        },
      },
    },
    service,
  );
  return route!;
}

async function call(
  route: WebRoute,
  body: unknown,
  options: { method?: string; origin?: string; contentType?: string } = {},
) {
  const req = new RequestFake(body, options);
  const res = new ResponseFake();
  await route.handler(req as never, res as never);
  return { req, res, json: JSON.parse(res.body) as Record<string, unknown> };
}

describe("annotation HTTP route", () => {
  it("enforces method, same-origin, CSRF and content type before dispatch", async () => {
    const service = { list: vi.fn() } as unknown as AnnotationService;
    const route = routeFor(service);

    await expect(call(route, {}, { method: "GET" })).resolves.toMatchObject({
      res: { statusCode: 405 },
    });
    await expect(
      call(route, {}, { origin: "http://evil.example" }),
    ).resolves.toMatchObject({ res: { statusCode: 403 } });
    const csrf = new RequestFake({});
    delete csrf.headers[CSRF_HEADER];
    const response = new ResponseFake();
    await route.handler(csrf as never, response as never);
    expect(response.statusCode).toBe(403);
    await expect(
      call(route, {}, { contentType: "text/plain" }),
    ).resolves.toMatchObject({ res: { statusCode: 415 } });
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and dispatches strict JSON actions", async () => {
    const service = {
      list: vi.fn(async () => [{ id: "a" }]),
    } as unknown as AnnotationService;
    const route = routeFor(service);

    const malformed = await call(route, {
      action: "list",
      sessionId: "session-1",
      extra: true,
    });
    expect(malformed.res.statusCode).toBe(400);
    expect(malformed.json).toMatchObject({ ok: false });

    const listed = await call(route, {
      action: "list",
      sessionId: "session-1",
    });
    expect(listed.res.statusCode).toBe(200);
    expect(listed.json).toEqual({ ok: true, data: [{ id: "a" }] });
    expect(service.list).toHaveBeenCalledWith("session-1");
  });

  it("forwards the exact selected annotation ids to Host prepare", async () => {
    const service = {
      prepare: vi.fn(async () => ({ batchId: "batch-345" })),
    } as unknown as AnnotationService;
    const route = routeFor(service);

    const response = await call(route, {
      action: "prepare",
      sessionId: "session-1",
      annotationIds: ["annotation-3", "annotation-4", "annotation-5"],
    });

    expect(response.res.statusCode).toBe(200);
    expect(service.prepare).toHaveBeenCalledWith("session-1", {
      body: undefined,
      batchId: undefined,
      annotationIds: ["annotation-3", "annotation-4", "annotation-5"],
    });
  });

  it("limits request bodies before JSON parsing", async () => {
    const service = { list: vi.fn() } as unknown as AnnotationService;
    const route = routeFor(service);
    const request = new RequestFake({
      action: "list",
      sessionId: "x".repeat(70 * 1024),
    });
    const response = new ResponseFake();
    await route.handler(request as never, response as never);
    expect(request.destroyed).toBe(true);
    expect(response.statusCode).toBe(413);
    expect(service.list).not.toHaveBeenCalled();
  });
});
