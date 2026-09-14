import { describe, expect, it } from "vitest";

import type { KvTable } from "@deepseek-ai/dsh-storage-domain";

import type { SessionSnapshot } from "../src/domain.js";
import {
  AnnotationRepository,
  RepositoryError,
  type RepositoryLimits,
} from "../src/repository.js";
import type { AnnotationRecord } from "../src/shared/types.js";

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

const anchor = (start = 0) => ({
  blockPath: [0],
  start,
  end: start + 2,
  prefix: "",
  suffix: "",
  quoteHash: `hash-${start}`,
});

function makeRepository(
  table = new MemoryTable(),
  limits?: Partial<RepositoryLimits>,
) {
  let id = 0;
  return {
    table,
    repository: new AnnotationRepository(table, {
      limits,
      now: () => "2026-08-28T00:00:00.000Z",
      uuid: () => `host-${++id}`,
    }),
  };
}

async function createOne(
  repository: AnnotationRepository,
  sessionId = "session-1",
  comment = "comment",
) {
  return repository.create(sessionId, {
    messageId: "message-1",
    anchor: anchor(),
    quote: "quote",
    comment,
    order: 0,
  });
}

describe("AnnotationRepository", () => {
  it("creates, lists, gets, updates and deletes records with host versions", async () => {
    const { repository } = makeRepository();
    const created = await createOne(repository);
    expect(created.id).toBe("host-1");
    expect(created.version).toBe("host-2");
    expect(await repository.list("session-1")).toEqual([created]);
    expect(await repository.get("session-1", created.id)).toEqual(created);

    const updated = await repository.update("session-1", created.id, {
      comment: "updated",
      expectedVersion: created.version,
    });
    expect(updated.comment).toBe("updated");
    expect(updated.version).not.toBe(created.version);
    const moved = await repository.update("session-1", created.id, {
      anchor: anchor(2),
      quote: "moved quote",
      expectedVersion: updated.version,
    });
    expect(moved.anchor.start).toBe(2);
    expect(moved.quote).toBe("moved quote");
    await expect(
      repository.update("session-1", created.id, {
        expectedVersion: updated.version,
        comment: "stale",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await repository.delete("session-1", created.id, moved.version),
    ).toBe(true);
    expect(await repository.get("session-1", created.id)).toBeUndefined();
  });

  it("assigns a new position after the highest existing one instead of reusing a deleted label", async () => {
    const { repository } = makeRepository();
    const first = await createOne(repository);
    const second = await createOne(repository);
    const third = await createOne(repository);

    await repository.delete("session-1", second.id, second.version);
    const fourth = await createOne(repository);

    expect([first.order, third.order, fourth.order]).toEqual([0, 2, 3]);
  });

  it("reorders atomically and keeps the input arrays immutable", async () => {
    const { repository } = makeRepository();
    const first = await createOne(repository);
    const second = await repository.create("session-1", {
      messageId: "m",
      anchor: anchor(3),
      quote: "q",
      comment: "c",
      order: 1,
    });
    const ids = [second.id, first.id];
    const copy = [...ids];
    const ordered = await repository.reorder(
      "session-1",
      ids,
      (await repository.load("session-1"))?.revision,
    );
    expect(ids).toEqual(copy);
    expect(ordered.map(({ id }) => id)).toEqual(copy);
    expect((await repository.list("session-1")).map(({ id }) => id)).toEqual(
      copy,
    );
  });

  it("supports durable prepare, mark and idempotent confirm", async () => {
    const { table, repository } = makeRepository();
    const first = await createOne(repository);
    const second = await repository.create("session-1", {
      messageId: "m",
      anchor: anchor(3),
      quote: "q",
      comment: "c",
      order: 1,
    });
    const prepared = await repository.prepare("session-1", {
      annotationIds: [first.id, second.id],
      markdown: "marker",
    });
    const retry = await repository.prepare("session-1", {
      annotationIds: [first.id, second.id],
      markdown: "marker",
    });
    expect(retry).toEqual(prepared);
    await repository.markUnknown("session-1", prepared.batchId, "disconnect");
    const sent = await repository.confirm("session-1", {
      batchId: prepared.batchId,
      sentAt: "2026-08-28T00:01:00.000Z",
    });
    expect(sent.status).toBe("sent");
    expect(
      await repository.confirm("session-1", {
        batchId: prepared.batchId,
        sentAt: "later",
      }),
    ).toEqual(sent);

    const restarted = new AnnotationRepository(table, {
      uuid: () => "new",
      now: () => "later",
    });
    expect(
      (await restarted.list("session-1")).every(
        ({ status }) => status === "sent",
      ),
    ).toBe(true);
  });

  it("serializes concurrent creates and converges identical prepares", async () => {
    const { repository } = makeRepository();
    const records = await Promise.all(
      Array.from({ length: 5 }, () => createOne(repository)),
    );
    expect(new Set(records.map(({ id }) => id)).size).toBe(5);
    const prepared = await Promise.all(
      records.slice(0, 2).map(() =>
        repository.prepare("session-1", {
          annotationIds: records.slice(0, 2).map(({ id }) => id),
          markdown: "same",
        }),
      ),
    );
    expect(prepared[0]).toEqual(prepared[1]);
    expect(new Set(prepared.map(({ batchId }) => batchId)).size).toBe(1);
  });

  it("mints new batch identity and keeps no-op retry revision stable", async () => {
    const { repository } = makeRepository();
    const annotation = await createOne(repository);
    const before = await repository.load("session-1");
    const prepared = await repository.prepare("session-1", {
      annotationIds: [annotation.id],
      markdown: "marker",
      batchId: "forged-batch",
      preparedAt: "forged-time",
    });
    expect(prepared.batchId).toBe("host-4");
    expect(prepared.preparedAt).toBe("2026-08-28T00:00:00.000Z");
    const afterPrepare = await repository.load("session-1");
    const retry = await repository.prepare("session-1", {
      annotationIds: [annotation.id],
      markdown: "marker",
      batchId: prepared.batchId,
      preparedAt: "another-time",
    });
    expect(retry).toEqual(prepared);
    expect((await repository.load("session-1"))?.revision).toBe(
      afterPrepare?.revision,
    );
    expect(before?.revision).not.toBe(afterPrepare?.revision);
  });

  it("covers rejected inputs and terminal batch branches", async () => {
    const { repository } = makeRepository();
    await expect(repository.get("missing", "a")).resolves.toBeUndefined();
    await expect(repository.list("missing")).resolves.toEqual([]);
    await expect(
      repository.ensureSession("s", "C:/cwd"),
    ).resolves.toMatchObject({ cwd: "C:/cwd" });
    await expect(repository.ensureSession("s")).resolves.toMatchObject({
      cwd: "C:/cwd",
    });
    await expect(
      repository.create("s", {
        messageId: "",
        anchor: anchor(),
        quote: "q",
        comment: "c",
        order: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      repository.update("s", "missing", { comment: "c", expectedVersion: "v" }),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(repository.delete("s", "missing", "v")).resolves.toBe(false);
    await expect(
      repository.prepare("missing", { annotationIds: ["a"], markdown: "m" }),
    ).rejects.toMatchObject({ code: "not-found" });
    const one = await createOne(repository, "s");
    await expect(
      repository.prepare("s", { annotationIds: [], markdown: "m" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    const batch = await repository.prepare("s", {
      annotationIds: [one.id],
      markdown: "m",
    });
    await expect(
      repository.prepare("s", {
        annotationIds: [one.id],
        markdown: "other",
        batchId: batch.batchId,
      }),
    ).rejects.toMatchObject({ code: "batch-conflict" });
    await expect(
      repository.confirm("s", { batchId: "missing" }),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      repository.mark("s", { batchId: batch.batchId, outcome: "unknown" }),
    ).resolves.toMatchObject({ status: "unknown" });
    await expect(
      repository.confirm("s", { batchId: batch.batchId }),
    ).resolves.toMatchObject({ status: "sent" });
    await expect(
      repository.confirm("s", { batchId: batch.batchId }),
    ).resolves.toMatchObject({ status: "sent" });
  });

  it("enforces UTF-8, count and batch limits", async () => {
    const limits = {
      maxCommentBytes: 3,
      maxQuoteBytes: 3,
      maxAnnotationsPerSession: 1,
      maxBatchSize: 1,
    };
    const { repository } = makeRepository(new MemoryTable(), limits);
    await expect(createOne(repository, "s", "😀")).rejects.toMatchObject({
      code: "limit-exceeded",
    });
    await expect(
      repository.create("s", {
        messageId: "m",
        anchor: anchor(),
        quote: "😀",
        comment: "ok",
        order: 0,
      }),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    const one = await repository.create("s", {
      messageId: "m",
      anchor: anchor(),
      quote: "ok",
      comment: "ok",
      order: 0,
    });
    await expect(createOne(repository, "s", "ok")).rejects.toMatchObject({
      code: "limit-exceeded",
    });
    await expect(
      repository.prepare("s", {
        annotationIds: [one.id, "missing"],
        markdown: "x",
      }),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it("returns immutable snapshots and structured errors", async () => {
    const { repository } = makeRepository();
    const annotation = await createOne(repository);
    const snapshot = await repository.getSession("session-1");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.annotations[0])).toBe(true);
    expect(Object.isFrozen(snapshot?.annotations[0]?.anchor)).toBe(true);
    expect(() => {
      (annotation as AnnotationRecord).comment = "mutated";
    }).toThrow();
    const error = new RepositoryError("conflict", "stale", {
      sessionId: "s",
      expectedVersion: "a",
      actualVersion: "b",
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "conflict",
      message: "stale",
      details: { sessionId: "s", expectedVersion: "a", actualVersion: "b" },
    });
  });

  it("keeps the assigned color immutable", async () => {
    const { repository } = makeRepository();
    const annotation = await repository.create("session-1", {
      messageId: "message-1",
      anchor: anchor(),
      quote: "quote",
      comment: "comment",
      color: "blue",
      order: 0,
    });

    await expect(
      repository.update("session-1", annotation.id, {
        color: "rose",
        expectedVersion: annotation.version,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect((await repository.get("session-1", annotation.id))?.color).toBe(
      "blue",
    );
  });

  it("requires CAS tokens for every destructive or mutable operation", async () => {
    const { repository } = makeRepository();
    const annotation = await createOne(repository);
    await expect(
      repository.update("session-1", annotation.id, { comment: "x" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      repository.delete("session-1", annotation.id),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      repository.reorder("session-1", [annotation.id]),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("rejects blank comments when updating", async () => {
    const { repository } = makeRepository();
    const annotation = await createOne(repository);
    await expect(
      repository.update("session-1", annotation.id, {
        comment: "   ",
        expectedVersion: annotation.version,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("mints identity fields and timestamps on the Host", async () => {
    const { repository } = makeRepository();
    const created = await repository.create("session-1", {
      id: "forged-id",
      version: "forged-version",
      status: "sent",
      batchId: "forged-batch",
      createdAt: "forged-time",
      updatedAt: "forged-time",
      sentAt: "forged-time",
      messageId: "message-1",
      anchor: anchor(),
      quote: "quote",
      comment: "comment",
      order: 0,
    });
    expect(created.id).toBe("host-1");
    expect(created.version).toBe("host-2");
    expect(created.status).toBe("pending");
    expect(created.batchId).toBeUndefined();
    expect(created.createdAt).toBe("2026-08-28T00:00:00.000Z");
  });

  it("uses the session revision as reorder CAS, while prepared members can be removed", async () => {
    const { repository } = makeRepository();
    const first = await createOne(repository);
    const second = await repository.create("session-1", {
      messageId: "m",
      anchor: anchor(3),
      quote: "q",
      comment: "c",
      order: 1,
    });
    const revision = (await repository.load("session-1"))?.revision;
    expect(revision).toBeTruthy();
    await repository.reorder("session-1", [second.id, first.id], revision);
    await expect(
      repository.reorder("session-1", [first.id, second.id], revision),
    ).rejects.toMatchObject({ code: "conflict" });

    const batch = await repository.prepare("session-1", {
      annotationIds: [first.id],
      markdown: "marker",
    });
    const current = await repository.get("session-1", first.id);
    await expect(
      repository.update("session-1", first.id, {
        comment: "changed",
        expectedVersion: current?.version,
      }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      repository.delete("session-1", first.id, current?.version),
    ).resolves.toBe(true);
    expect(await repository.get("session-1", first.id)).toBeUndefined();
    await expect(
      repository.reorder(
        "session-1",
        [second.id],
        (await repository.load("session-1"))?.revision,
      ),
    ).resolves.toHaveLength(1);
    expect(batch.status).toBe("prepared");
  });

  it("requires failure receipts and never downgrades sent annotations", async () => {
    const { repository } = makeRepository();
    const annotation = await createOne(repository);
    const batch = await repository.prepare("session-1", {
      annotationIds: [annotation.id],
      markdown: "marker",
    });
    await expect(
      repository.mark("session-1", {
        batchId: batch.batchId,
        outcome: "definite-failure",
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await repository.confirm("session-1", { batchId: batch.batchId });
    const sent = await repository.mark("session-1", {
      batchId: batch.batchId,
      outcome: "unknown",
    });
    expect(sent.status).toBe("sent");
    expect((await repository.get("session-1", annotation.id))?.status).toBe(
      "sent",
    );
  });

  it("supports object-form aliases and validates configured limits", async () => {
    const { repository } = makeRepository();
    const created = await repository.createAnnotation({
      sessionId: "alias",
      messageId: "m",
      anchor: anchor(),
      quote: "q",
      comment: "c",
      order: 0,
    });
    await repository.updateAnnotation({
      sessionId: "alias",
      annotationId: created.id,
      comment: "cc",
      version: created.version,
    });
    const revision = (await repository.load("alias"))?.revision;
    await repository.reorder("alias", [created.id], revision);
    const current = await repository.get("alias", created.id);
    await expect(
      repository.deleteAnnotation({
        sessionId: "alias",
        annotationId: created.id,
        version: current!.version,
      }),
    ).resolves.toBe(true);
    const invalid = new AnnotationRepository(new MemoryTable(), {
      limits: { maxCommentBytes: 0 },
    });
    await expect(
      invalid.create("bad", {
        messageId: "m",
        anchor: anchor(),
        quote: "q",
        comment: "c",
        order: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
});
