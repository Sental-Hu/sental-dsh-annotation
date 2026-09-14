import { describe, expect, it, vi } from "vitest";

import { AnnotationApiClient, type FetchLike } from "../src/client/api.js";
import {
  AnnotationStore,
  type AnnotationStoreApi,
} from "../src/client/store.js";
import type { AnnotationRecord, TextAnchor } from "../src/shared/types.js";

const anchor: TextAnchor = {
  blockPath: [0],
  start: 0,
  end: 2,
  prefix: "",
  suffix: "",
  quoteHash: "hash",
};

function record(id = "a", comment = "old"): AnnotationRecord {
  return {
    id,
    sessionId: "s1",
    status: "pending",
    messageId: "m1",
    anchor,
    quote: "原文",
    comment,
    color: "amber",
    order: 0,
    version: `v-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function response(data: unknown, ok = true): Response {
  return new Response(JSON.stringify(ok ? { ok: true, data } : data), {
    status: ok ? 200 : 409,
    headers: { "content-type": "application/json" },
  });
}

describe("AnnotationApiClient", () => {
  it("uses the same-origin endpoint and required CSRF header", async () => {
    const fetcher: FetchLike = vi.fn(async (_input, init) => {
      expect(_input).toBe("/dsh-annotation/api");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        "x-dsh-annotation-csrf": "1",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "list",
        sessionId: "s1",
      });
      return response([record()]);
    });
    const api = new AnnotationApiClient({ fetch: fetcher });

    await expect(api.list("s1")).resolves.toEqual([record()]);
  });
});

describe("AnnotationStore", () => {
  function api(
    overrides: Partial<AnnotationStoreApi> = {},
  ): AnnotationStoreApi {
    return {
      list: vi.fn(async () => [record()]),
      create: vi.fn(async () => record("new", "new")),
      update: vi.fn(async (_sessionId, id, patch) =>
        record(id, patch.comment ?? "updated"),
      ),
      delete: vi.fn(async () => true),
      reorder: vi.fn(async (_sessionId, ids) => ids.map((id) => record(id))),
      ...overrides,
    };
  }

  it("loads one session into an immutable snapshot", async () => {
    const client = api();
    const store = new AnnotationStore(client, "s1");
    await store.load();

    expect(store.getSnapshot()).toMatchObject({
      sessionId: "s1",
      status: "ready",
      annotations: [record()],
    });
    expect(Object.isFrozen(store.getSnapshot().annotations)).toBe(true);
  });

  it("does not create an empty comment", async () => {
    const client = api();
    const store = new AnnotationStore(client, "s1");

    await expect(
      store.create({
        messageId: "m1",
        anchor,
        quote: "原文",
        comment: " \n ",
        order: 0,
      }),
    ).resolves.toBeUndefined();
    expect(client.create).not.toHaveBeenCalled();
  });

  it("rolls back an optimistic update when the request fails", async () => {
    const client = api({
      update: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const store = new AnnotationStore(client, "s1");
    await store.load();

    await expect(
      store.update("a", { comment: "optimistic", version: "v-a" }),
    ).rejects.toThrow("offline");
    expect(store.getSnapshot().annotations[0]?.comment).toBe("old");
    expect(store.getSnapshot().status).toBe("ready");
  });

  it("reloads after a CAS conflict before rethrowing it", async () => {
    const conflict = Object.assign(new Error("stale"), {
      code: "conflict",
    });
    const client = api({
      update: vi.fn(async () => {
        throw conflict;
      }),
      list: vi
        .fn()
        .mockResolvedValueOnce([record()])
        .mockResolvedValueOnce([record("a", "changed elsewhere")]),
    });
    const store = new AnnotationStore(client, "s1");
    await store.load();

    await expect(
      store.update("a", { comment: "mine", version: "v-a" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(store.getSnapshot().annotations[0]?.comment).toBe(
      "changed elsewhere",
    );
    expect(client.list).toHaveBeenCalledTimes(2);
  });

  it("aborts an old session load when switching sessions", async () => {
    let resolveFirst!: (items: readonly AnnotationRecord[]) => void;
    const first = new Promise<readonly AnnotationRecord[]>((resolve) => {
      resolveFirst = resolve;
    });
    const client = api({
      list: vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValueOnce([record("b")]),
    });
    const store = new AnnotationStore(client, "s1");
    const loading = store.load();
    store.setSession("s2");
    await store.load();
    resolveFirst([record("a")]);
    await loading;

    expect(store.getSnapshot().sessionId).toBe("s2");
    expect(store.getSnapshot().annotations[0]?.id).toBe("b");
  });
});
