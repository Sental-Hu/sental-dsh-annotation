import { describe, expect, it, vi } from "vitest";

import type { KvTable } from "@deepseek-ai/dsh-storage-domain";

import type { SessionSnapshot } from "../src/domain.js";
import { parseBatchMarker } from "../src/shared/markdown.js";
import { AnnotationRepository } from "../src/repository.js";
import { createDirectAnnotationSender } from "../src/client/direct-send.js";
import type { AnnotationApiClient } from "../src/client/api.js";
import {
  AnnotationService,
  AnnotationServiceError,
  type DurableSessionEvent,
  type SessionPersistencePort,
  type SessionsPort,
} from "../src/service.js";

class MemoryTable implements KvTable<string, SessionSnapshot> {
  readonly records = new Map<string, SessionSnapshot>();
  get(key: string): SessionSnapshot | undefined {
    return this.records.get(key);
  }
  entries(): IterableIterator<[string, SessionSnapshot]> {
    return this.records.entries();
  }
  keys(): IterableIterator<string> {
    return this.records.keys();
  }
  get size(): number {
    return this.records.size;
  }
  async put(key: string, value: SessionSnapshot): Promise<void> {
    this.records.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
  async update(
    key: string,
    fn: (current: SessionSnapshot) => SessionSnapshot,
  ): Promise<SessionSnapshot> {
    const current = this.records.get(key);
    if (!current) throw new Error("missing-key");
    const next = fn(current);
    this.records.set(key, next);
    return next;
  }
}

const anchor = (start: number) => ({
  blockPath: [0],
  start,
  end: start + 2,
  prefix: "",
  suffix: "",
  quoteHash: `hash-${start}`,
});

function assistantEvent(messageId = "message-1"): DurableSessionEvent {
  return {
    type: "assistant/message",
    surfaceOp: "append",
    data: {
      message: {
        id: messageId,
        role: "assistant",
        content: [{ type: "text", text: "ordinary text" }],
      },
    },
  };
}

function userEvent(text: string, messageId = "user-1"): DurableSessionEvent {
  return {
    type: "user/message",
    data: {
      message: {
        id: messageId,
        role: "user",
        content: [{ type: "text", text }],
      },
    },
  };
}

class PersistenceFake implements SessionPersistencePort {
  inspected: DurableSessionEvent[] = [assistantEvent()];
  durable: DurableSessionEvent[] = [...this.inspected];
  inspect = vi.fn(async () => ({
    meta: { id: "session-1" },
    events: this.inspected,
  }));
  readFrom = vi.fn(async () => ({
    meta: { id: "session-1" },
    events: this.durable,
  }));
}

class SessionsFake implements SessionsPort {
  live: object | undefined = {};
  flushResult: boolean | Error = true;
  get = vi.fn(() => this.live);
  flush = vi.fn(async () => {
    if (this.flushResult instanceof Error) throw this.flushResult;
    return this.flushResult;
  });
}

function makeService() {
  const persistence = new PersistenceFake();
  const sessions = new SessionsFake();
  let id = 0;
  const repository = new AnnotationRepository(new MemoryTable(), {
    now: () => "2026-08-28T00:00:00.000Z",
    uuid: () => `host-${++id}`,
  });
  const service = new AnnotationService({
    repository,
    sessionPersistence: persistence,
    sessions,
    uuid: () => `batch-${++id}`,
    now: () => "2026-08-28T00:00:00.000Z",
  });
  return { service, repository, persistence, sessions };
}

async function create(
  service: AnnotationService,
  start = 0,
  messageId = "message-1",
) {
  return service.create("session-1", {
    messageId,
    anchor: anchor(start),
    quote: `quote-${start}`,
    comment: `comment-${start}`,
    order: start,
  });
}

describe("AnnotationService", () => {
  it.each([1, 2])(
    "sends once through the real host batch contract with %i browser callers",
    async (callers) => {
      const { service, persistence } = makeService();
      const annotation = await create(service);
      const send = vi.fn(async (text: string) => {
        persistence.durable.push(userEvent(text));
      });
      const api = {
        list: (id: string) => service.list(id),
        prepare: (
          id: string,
          body: string | undefined,
          batchId: string | undefined,
          _signal: AbortSignal | undefined,
          annotationIds: string[],
        ) => service.prepare({ sessionId: id, body, batchId, annotationIds }),
        request: (request: Parameters<AnnotationService["settle"]>[0]) =>
          service.settle(request as never),
      } as unknown as AnnotationApiClient;
      const operations = Array.from({ length: callers }, () =>
        createDirectAnnotationSender(
          { scope: () => ({ get: () => ({ send }) }) },
          "session-1",
          api,
        )!(annotation),
      );
      const results = await Promise.allSettled(operations);
      expect(send).toHaveBeenCalledTimes(1);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      const saved = (await service.list("session-1"))[0]!;
      expect(saved.status).toBe("sent");
      expect(saved.batchId).toMatch(/^host-/);
      expect(parseBatchMarker(send.mock.calls[0]![0])?.batchId).toBe(
        saved.batchId,
      );
    },
  );

  it("preserves submitted messages and batch snapshots when a sent annotation is edited and deleted", async () => {
    const { service, persistence } = makeService();
    const original = await create(service);
    const batch = await service.prepare({
      sessionId: "session-1",
      annotationIds: [original.id],
    });
    persistence.durable.push(userEvent(batch.markdown));
    await service.settle({
      sessionId: "session-1",
      batchId: batch.batchId,
      outcome: "accepted",
    });
    const before = await service.snapshot("session-1");
    const sent = before.annotations[0]!;
    expect(sent.status).toBe("sent");
    const messages = structuredClone(persistence.durable);
    const edited = await service.update("session-1", sent.id, {
      comment: "edited after sending",
      anchor: anchor(2),
      expectedVersion: sent.version,
    });
    expect(edited.comment).toBe("edited after sending");
    expect(edited.status).toBe("sent");
    expect((await service.snapshot("session-1")).batches).toEqual(
      before.batches,
    );
    await service.delete("session-1", edited.id, edited.version);
    expect((await service.snapshot("session-1")).batches).toEqual(
      before.batches,
    );
    expect(persistence.durable).toEqual(messages);
  });

  it("returns an empty snapshot for a session with no annotations", async () => {
    const { service } = makeService();

    await expect(service.snapshot("session-1")).resolves.toEqual({
      revision: "0",
      annotations: [],
      batches: {},
    });
  });

  it("rejects blank comments and validates the durable assistant target", async () => {
    const { service, persistence } = makeService();
    await expect(
      service.create("session-1", {
        messageId: "message-1",
        anchor: anchor(0),
        quote: "quote",
        comment: "   ",
        order: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    persistence.inspected = [
      {
        type: "user/message",
        data: {
          message: { id: "bad", content: [{ type: "text", text: "user" }] },
        },
      },
    ];
    persistence.durable = [...persistence.inspected];
    await expect(create(service, 0, "bad")).rejects.toMatchObject({
      code: "target-not-text",
    });
    expect(persistence.inspect).toHaveBeenCalled();
    expect(persistence.readFrom).toHaveBeenCalledWith("session-1", 0);
  });

  it("prefers an assistant event when a user event reuses the same message id", async () => {
    const { service, persistence } = makeService();
    const assistant = assistantEvent("reused-id");
    const reusedUser = userEvent("same id", "reused-id");
    persistence.inspected = [reusedUser, assistant];
    persistence.durable = [...persistence.inspected];
    await expect(create(service, 0, "reused-id")).resolves.toMatchObject({
      messageId: "reused-id",
    });
  });

  it("accepts assistant text when the durable message also contains reasoning", async () => {
    const { service, persistence } = makeService();
    const event = assistantEvent("reasoned-message");
    event.data = {
      message: {
        id: "reasoned-message",
        role: "assistant",
        content: [
          { type: "reasoning", text: "internal reasoning" },
          { type: "text", text: "visible answer" },
        ],
      },
    };
    persistence.inspected = [event];
    persistence.durable = [event];

    await expect(create(service, 0, "reasoned-message")).resolves.toMatchObject(
      {
        messageId: "reasoned-message",
      },
    );
  });

  it("classifies a still-streaming reasoning plus text message as incomplete", async () => {
    const { service, persistence } = makeService();
    const event = assistantEvent("streaming-reasoned-message");
    event.data = {
      completed: false,
      message: {
        id: "streaming-reasoned-message",
        role: "assistant",
        content: [
          { type: "reasoning", text: "internal reasoning" },
          { type: "text", text: "partial answer" },
        ],
      },
    };
    persistence.inspected = [event];
    persistence.durable = [event];

    await expect(
      create(service, 0, "streaming-reasoned-message"),
    ).rejects.toMatchObject({ code: "target-not-complete" });
  });

  it("rejects code, table, incomplete and missing-id targets", async () => {
    const { service, persistence } = makeService();
    const invalid = [
      { id: "code", block: { type: "code", text: "x" } },
      { id: "table", block: { type: "table", rows: [] } },
      {
        id: "incomplete",
        block: { type: "text", text: "x" },
        completed: false,
      },
      { id: "missing", block: { type: "text", text: "x" }, missing: true },
    ];
    for (const candidate of invalid) {
      persistence.inspected = [
        {
          type: "assistant/message",
          data: candidate.missing
            ? { message: { role: "assistant", content: [candidate.block] } }
            : {
                message: {
                  id: candidate.id,
                  role: "assistant",
                  content: [candidate.block],
                },
                ...(candidate.completed === false ? { completed: false } : {}),
              },
        },
      ];
      persistence.durable = [...persistence.inspected];
      await expect(create(service, 0, candidate.id)).rejects.toMatchObject({
        code:
          candidate.id === "incomplete"
            ? "target-not-complete"
            : candidate.id === "missing"
              ? "target-not-found"
              : "target-not-text",
      });
    }
  });

  it("keeps duplicate, contained, overlapping and adjacent annotations independent", async () => {
    const { service } = makeService();
    const ranges = [
      [2, 6],
      [2, 6],
      [1, 7],
      [3, 5],
      [0, 3],
      [5, 8],
      [6, 8],
    ];
    const records = [];
    for (const [start, end] of ranges) {
      records.push(
        await service.create("session-1", {
          messageId: "message-1",
          anchor: { ...anchor(start!), end: end! },
          quote: "shared text",
          comment: "comment-" + records.length,
          order: records.length,
        }),
      );
    }
    expect(new Set(records.map((item) => item.id)).size).toBe(ranges.length);
    const first = records[0]!;
    const second = records[1]!;
    const updated = await service.update("session-1", first.id, {
      comment: "independent edit",
      expectedVersion: first.version,
    });
    await service.delete("session-1", updated.id, updated.version);
    const remaining = await service.list("session-1");
    expect(remaining).toHaveLength(ranges.length - 1);
    expect(remaining.find((item) => item.id === second.id)).toEqual(second);
  });

  it("delegates CAS-protected update, reorder and delete after Host validation", async () => {
    const { service, repository, persistence } = makeService();
    const first = await create(service, 0);
    const second = await create(service, 2);
    let updated = await service.update("session-1", first.id, {
      comment: "updated",
      color: first.color,
      expectedVersion: first.version,
    });
    updated = await service.update("session-1", updated.id, {
      anchor: anchor(2),
      expectedVersion: updated.version,
    });
    expect(updated.anchor).toEqual(second.anchor);
    await expect(
      service.update("session-1", updated.id, {
        anchor: { ...anchor(9), start: -1 },
        expectedVersion: updated.version,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    const revision = (await repository.load("session-1"))?.revision;
    await service.reorder("session-1", [second.id, updated.id], revision);
    expect((await service.list("session-1")).map((item) => item.id)).toEqual([
      second.id,
      updated.id,
    ]);
    const reordered = (await service.list("session-1")).find(
      (item) => item.id === updated.id,
    )!;
    expect(
      await service.delete("session-1", updated.id, reordered.version),
    ).toBe(true);
    expect((await service.list("session-1")).map((item) => item.id)).toEqual([
      second.id,
    ]);
    persistence.inspected = [
      {
        type: "assistant/message",
        data: {
          message: {
            id: "role-missing",
            content: [{ type: "text", text: "x" }],
          },
        },
      },
    ];
    persistence.durable = [...persistence.inspected];
    await expect(create(service, 4, "role-missing")).rejects.toMatchObject({
      code: "target-not-complete",
    });
  });

  it("converges concurrent and repeated prepare calls to one marker and Markdown", async () => {
    const { service, repository } = makeService();
    await create(service, 0);
    const [first, second] = await Promise.all([
      service.prepare({ sessionId: "session-1" }),
      service.prepare({ sessionId: "session-1" }),
    ]);
    expect(second).toEqual(first);
    expect(parseBatchMarker(first.marker)?.batchId).toBe(first.batchId);
    expect(first.markdown).toContain(first.marker);
    expect(
      (await repository.listSnapshot("session-1"))?.batches,
    ).toHaveProperty(first.batchId);
    expect(await service.prepare({ sessionId: "session-1" })).toEqual(first);
  });

  it("prepares only the file-chip annotation selected for the outgoing message", async () => {
    const { service } = makeService();
    const first = await create(service, 0);
    const second = await create(service, 3);

    const prepared = await service.prepare({
      sessionId: "session-1",
      annotationIds: [first.id],
    });

    expect(prepared.annotationIds).toEqual([first.id]);
    expect(prepared.markdown).toContain(first.comment);
    expect(prepared.markdown).not.toContain(second.comment);
    expect(await service.list("session-1")).toMatchObject([
      { id: first.id, status: "prepared" },
      { id: second.id, status: "pending" },
    ]);
  });

  it("keeps three simultaneous file chips mapped to exactly their own annotations", async () => {
    const { service } = makeService();
    const annotations = await Promise.all(
      [0, 3, 6, 9, 12].map((start) => create(service, start)),
    );
    const selected = annotations.slice(2);

    const batches = await Promise.all(
      selected.map((annotation) =>
        service.prepare({
          sessionId: "session-1",
          annotationIds: [annotation.id],
        }),
      ),
    );
    const outgoing = batches.map((batch) => batch.markdown).join("\n");

    for (const annotation of selected)
      expect(outgoing).toContain(annotation.comment);
    for (const annotation of annotations.slice(0, 2))
      expect(outgoing).not.toContain(annotation.comment);
    expect(batches.flatMap((batch) => batch.annotationIds)).toEqual(
      selected.map((annotation) => annotation.id),
    );
  });

  it("passes an explicit batch id through to the repository", async () => {
    const { service, repository } = makeService();
    await create(service);
    const prepareSpy = vi.spyOn(repository, "prepare");
    await service.prepare({
      sessionId: "session-1",
      batchId: "requested-batch",
    });
    expect(prepareSpy).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ batchId: "requested-batch" }),
    );
  });

  it("does not merge prepare calls with different body keys", async () => {
    const { service } = makeService();
    await create(service);
    const first = service.prepare({ sessionId: "session-1", body: "first" });
    const second = service.prepare({ sessionId: "session-1", body: "second" });
    await first;
    await expect(second).rejects.toMatchObject({ code: "prepare-conflict" });
  });

  it("rolls back definite failure with a receipt and keeps ambiguous batches unknown", async () => {
    const { service } = makeService();
    const first = await create(service);
    const prepared = await service.prepare({ sessionId: "session-1" });
    await expect(
      service.settle({
        sessionId: "session-1",
        batchId: prepared.batchId,
        outcome: "definite-failure",
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await service.settle({
      sessionId: "session-1",
      batchId: prepared.batchId,
      outcome: "definite-failure",
      receiptId: "receipt-1",
    });
    expect((await service.list("session-1"))[0]).toMatchObject({
      id: first.id,
      status: "pending",
      batchId: undefined,
    });
    const next = await service.prepare({ sessionId: "session-1" });
    await service.settle({
      sessionId: "session-1",
      batchId: next.batchId,
      outcome: "unknown",
      reason: "disconnect",
    });
    expect((await service.list("session-1"))[0]?.status).toBe("unknown");
  });

  it("does not treat a definite-failure tombstone as an active no-pending batch", async () => {
    const { service } = makeService();
    await create(service);
    const prepared = await service.prepare({ sessionId: "session-1" });
    await service.settle({
      sessionId: "session-1",
      batchId: prepared.batchId,
      outcome: "definite-failure",
      receiptId: "receipt-1",
    });
    const pending = (await service.list("session-1"))[0]!;
    await service.delete("session-1", pending.id, pending.version);
    await expect(
      service.prepare({ sessionId: "session-1" }),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
  });

  it("requires live flush and durable marker before confirming, including event-before-persistence", async () => {
    const { service, persistence, sessions } = makeService();
    await create(service);
    const prepared = await service.prepare({ sessionId: "session-1" });
    const marker = prepared.marker;
    persistence.inspected = [userEvent(marker)];
    persistence.durable = [];
    expect(
      await service.reconcile({
        sessionId: "session-1",
        batchId: prepared.batchId,
      }),
    ).toBeUndefined();
    expect((await service.list("session-1"))[0]?.status).toBe("prepared");
    persistence.durable = [
      {
        type: "user/message",
        data: {
          message: {
            id: "user-split",
            role: "user",
            content: [
              { type: "text", text: marker.slice(0, 12) },
              { type: "text", text: marker.slice(12) },
            ],
          },
        },
      },
    ];
    expect(
      await service.reconcile({
        sessionId: "session-1",
        batchId: prepared.batchId,
      }),
    ).toBeUndefined();
    sessions.flushResult = false;
    persistence.durable = [userEvent(marker)];
    await expect(
      service.confirm({ sessionId: "session-1", batchId: prepared.batchId }),
    ).rejects.toMatchObject({ code: "flush-failed" });
    sessions.flushResult = new Error("flush failed");
    await expect(
      service.reconcile({ sessionId: "session-1", batchId: prepared.batchId }),
    ).rejects.toMatchObject({ code: "flush-failed" });
    sessions.flushResult = true;
    const sent = await service.confirm({
      sessionId: "session-1",
      batchId: prepared.batchId,
    });
    expect(sent?.status).toBe("sent");
    expect(
      await service.confirm({
        sessionId: "session-1",
        batchId: prepared.batchId,
      }),
    ).toEqual(sent);
    expect((await service.list("session-1"))[0]?.status).toBe("sent");
  });

  it("reports a missing live session for an unconfirmed batch", async () => {
    const { service, sessions } = makeService();
    await create(service);
    const prepared = await service.prepare({ sessionId: "session-1" });
    sessions.live = undefined;
    await expect(
      service.confirm({ sessionId: "session-1", batchId: prepared.batchId }),
    ).rejects.toMatchObject({
      code: "live-session-not-found",
    });
  });

  it("supports positional lifecycle calls and accepted settlement only after durable confirmation", async () => {
    const { service, persistence, sessions } = makeService();
    const item = await create(service);
    const prepared = await service.prepare("session-1");
    persistence.durable = [userEvent(prepared.marker)];
    const accepted = await service.settle(
      "session-1",
      prepared.batchId,
      "accepted",
    );
    expect(accepted.status).toBe("sent");
    sessions.live = undefined;
    expect(await service.confirm("session-1", prepared.batchId)).toEqual(
      accepted,
    );
    expect(item.id).toBeDefined();
    const error = new AnnotationServiceError("invalid-input", "bad", {
      field: "x",
    });
    expect(error.toJSON()).toEqual({
      code: "invalid-input",
      message: "bad",
      details: { field: "x" },
    });
  });
});
