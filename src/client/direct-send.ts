import type {
  AnnotationRecord,
  AnnotationBatchRecord,
} from "../shared/types.js";
import type { AnnotationApiClient } from "./api.js";
import type { SessionsLike } from "./pending-reference.js";

export type DirectAnnotationSender = (
  annotation: AnnotationRecord,
) => Promise<void>;

/** The public scoped conversation API sends without touching the composer. */
export function createDirectAnnotationSender(
  sessions: SessionsLike | undefined,
  sessionId: string,
  api: Pick<AnnotationApiClient, "list" | "prepare" | "request">,
): DirectAnnotationSender | undefined {
  const scope = sessions?.scope?.(sessionId);
  const conversation = scope?.get("conversation") as
    { send?(text: string): Promise<void> } | undefined;
  if (typeof conversation?.send !== "function") return undefined;
  const inFlight = new Map<string, Promise<void>>();

  const confirm = async (batchId: string) => {
    const batch = await api.request<AnnotationBatchRecord>({
      action: "settle",
      sessionId,
      batchId,
      outcome: "accepted",
    });
    if (batch.status !== "sent") throw new Error("发送尚未确认");
  };

  async function send(annotation: AnnotationRecord): Promise<void> {
    if (annotation.sessionId !== sessionId)
      throw new Error("批注不属于当前会话");
    const current = (await api.list(sessionId)).find(
      (item) => item.id === annotation.id,
    );
    if (!current) throw new Error("批注不存在，请刷新列表");
    if (current.status === "sent") return;
    // A previous submission may have reached DSH even if its response was lost.
    // Rechecking it must never enqueue a second prompt.
    if (current.status !== "pending") {
      if (!current.batchId) throw new Error("发送状态待核对，请刷新列表");
      await confirm(current.batchId);
      return;
    }
    if (current.version !== annotation.version)
      throw new Error("批注已被修改，请重新打开后发送");
    const batchId = [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const batch = await api.prepare(sessionId, undefined, batchId, undefined, [
      annotation.id,
    ]);
    // The host mints its own batch id. Only a newly created response grants
    // submission; a concurrent tab receiving an existing batch only reconciles.
    if (batch.created !== true || batch.status === "sent") {
      await confirm(batch.batchId);
      return;
    }
    try {
      await conversation!.send!(batch.markdown);
    } catch {
      try {
        await confirm(batch.batchId);
        return;
      } catch {
        await api
          .request({
            action: "settle",
            sessionId,
            batchId: batch.batchId,
            outcome: "unknown",
          })
          .catch(() => undefined);
        throw new Error(
          "发送结果待确认，请核对当前对话后点击“核对发送”，不会重复发送",
        );
      }
    }
    try {
      await confirm(batch.batchId);
    } catch {
      throw new Error(
        "已提交，正在等待会话记录确认；可点击“核对发送”，不会重复发送",
      );
    }
  }

  return (annotation) => {
    const existing = inFlight.get(annotation.id);
    if (existing) return existing;
    const operation = send(annotation);
    inFlight.set(annotation.id, operation);
    void operation
      .finally(() => inFlight.delete(annotation.id))
      .catch(() => undefined);
    return operation;
  };
}
