import { describe, expect, it, vi } from "vitest";
import { createDirectAnnotationSender } from "../src/client/direct-send.js";
import type { AnnotationRecord } from "../src/shared/types.js";
import type { AnnotationApiClient } from "../src/client/api.js";

function fixture() {
  const annotation: AnnotationRecord = {
    id: "a",
    sessionId: "s",
    messageId: "m",
    status: "pending",
    version: "1",
    order: 0,
    color: "amber",
    quote: "原文",
    comment: "回复",
    anchor: {
      blockPath: [0],
      start: 0,
      end: 2,
      prefix: "",
      suffix: "",
      quoteHash: "h",
    },
    createdAt: "2026-09-14",
    updatedAt: "2026-09-14",
  };
  const list = vi.fn(async () => [
    annotation,
    { ...annotation, id: "unrelated" },
  ]);
  const prepare = vi.fn(async (_session, _body, batchId) => ({
    batchId,
    status: "prepared",
    markdown: "> 原文\n\n回复",
  }));
  const request = vi.fn(async () => ({ status: "sent" }));
  const setDraft = vi.fn();
  const insertReference = vi.fn();
  const send = vi.fn(async () => undefined);
  const conversation = { send, input: { setDraft, insertReference } };
  const scope = vi.fn(() => ({ get: () => conversation }));
  const api = { list, prepare, request } as unknown as AnnotationApiClient;
  const sender = createDirectAnnotationSender({ scope }, "s", api)!;
  return {
    annotation,
    sender,
    scope,
    send,
    setDraft,
    insertReference,
    list,
    prepare,
    request,
    api,
  };
}

describe("direct annotation send", () => {
  it("sends only the selected saved annotation into its scoped conversation without changing the input", async () => {
    const f = fixture();
    await f.sender(f.annotation);
    expect(f.scope).toHaveBeenCalledWith("s");
    expect(f.prepare).toHaveBeenCalledWith(
      "s",
      undefined,
      expect.any(String),
      undefined,
      ["a"],
    );
    expect(f.send).toHaveBeenCalledWith("> 原文\n\n回复");
    expect(f.request).toHaveBeenCalledWith({
      action: "settle",
      sessionId: "s",
      batchId: expect.any(String),
      outcome: "accepted",
    });
    expect(f.setDraft).not.toHaveBeenCalled();
    expect(f.insertReference).not.toHaveBeenCalled();
  });
  it("coalesces rapid repeated clicks", async () => {
    const f = fixture();
    await Promise.all([f.sender(f.annotation), f.sender(f.annotation)]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("rejects a different session or a stale saved version", async () => {
    const f = fixture();
    await expect(
      f.sender({ ...f.annotation, sessionId: "other" }),
    ).rejects.toThrow("不属于");
    await expect(f.sender({ ...f.annotation, version: "0" })).rejects.toThrow(
      "已被修改",
    );
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not send if preparation fails", async () => {
    const f = fixture();
    f.prepare.mockRejectedValueOnce(new Error("offline"));
    await expect(f.sender(f.annotation)).rejects.toThrow("offline");
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["prepared", "unknown"] as const)(
    "reconciles an earlier %s batch without resending",
    async (status) => {
      const f = fixture();
      Object.assign(f.annotation, { status, batchId: "previous" });
      await f.sender(f.annotation);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.request).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: "previous", outcome: "accepted" }),
      );
    },
  );
  it("does not resend a batch claimed by another tab", async () => {
    const f = fixture();
    f.prepare.mockResolvedValueOnce({
      batchId: "other-tab",
      status: "prepared",
      markdown: "other",
    });
    await f.sender(f.annotation);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("treats a lost send response as success only after durable confirmation", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("connection lost"));
    await f.sender(f.annotation);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("keeps ambiguous sends unresolved instead of claiming success", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("connection lost"));
    f.request.mockRejectedValueOnce(new Error("marker missing"));
    await expect(f.sender(f.annotation)).rejects.toThrow("发送结果待确认");
    expect(f.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "unknown" }),
    );
  });
  it("does not report success just because DSH accepted the prompt", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("flush failed"));
    await expect(f.sender(f.annotation)).rejects.toThrow("等待会话记录确认");
  });
  it("does not resend saved history", async () => {
    const f = fixture();
    f.annotation.status = "sent";
    await f.sender(f.annotation);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not guess a fallback when the host lacks the public send API", () => {
    expect(
      createDirectAnnotationSender(undefined, "s", fixture().api),
    ).toBeUndefined();
  });
});
