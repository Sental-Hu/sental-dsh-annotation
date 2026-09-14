export interface RectLike {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface ViewportLike {
  readonly width: number;
  readonly height: number;
}

export interface PopoverSize {
  readonly width: number;
  readonly height: number;
}

export interface PopoverPosition {
  readonly left: number;
  readonly top: number;
}

/** Place a popover beside a selection while keeping it inside the viewport. */
export function positionPopover(
  rect: RectLike,
  viewport: ViewportLike,
  size: PopoverSize = { width: 320, height: 100 },
  gap = 8,
  margin = 8,
): PopoverPosition {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(
    Math.max(margin, Number.isFinite(rect.left) ? rect.left : margin),
    maxLeft,
  );
  const below = rect.bottom + gap;
  const above = rect.top - size.height - gap;
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  const preferredTop =
    below + size.height <= viewport.height - margin ? below : above;
  const top = Math.min(
    Math.max(margin, Number.isFinite(preferredTop) ? preferredTop : margin),
    maxTop,
  );
  return { left, top };
}

const ANNOTATION_UI_SELECTOR =
  ".dsh-annotation-resume,.dsh-annotation-history-wrap,.dsh-annotation-menu,.dsh-annotation-editor-popover,.dsh-annotation-tab,.dsh-annotation-card-detail,.dsh-annotation-handle";

/** Return true when an event target belongs to this plugin's own UI. */
export function isAnnotationUiTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== "function") return false;
  return Boolean(
    (closest as (selector: string) => unknown).call(
      target,
      ANNOTATION_UI_SELECTOR,
    ),
  );
}

export type OperationStatus = "idle" | "saving" | "sending" | "saved" | "error";

export interface OperationState {
  readonly status: OperationStatus;
  readonly message?: string;
}

/** An outside click can discard an empty new editor, but never persists text. */
export function dismissNewEditorOnOutsidePointer(comment: string): boolean {
  return !comment.trim();
}

/** Closing a panel must not discard edits or interrupt an in-flight save. */
export function canDismissAnnotationEditor(
  editor: { kind: "new" | "edit"; comment: string } | undefined,
  persistedComment: string | undefined,
  saving: boolean,
): boolean {
  if (saving) return false;
  if (!editor) return true;
  return editor.kind === "new"
    ? dismissNewEditorOnOutsidePointer(editor.comment)
    : editor.comment === persistedComment;
}

export function annotationStatusLabel(status: string): string {
  return (
    (
      {
        pending: "待发送",
        prepared: "待发送",
        unknown: "发送确认中",
        sent: "已发送",
      } as Record<string, string>
    )[status] ?? status
  );
}

/** One short, file-like label keeps a batch of annotations from filling the dock. */
export function annotationListLabel(sequence: number): string {
  return `批注 ${sequence}`;
}

export function annotationTab(
  sequence: number,
  active: boolean,
): { label: string; active: boolean } {
  return { label: annotationListLabel(sequence), active };
}

/** A second click closes the open detail; selecting another item replaces it. */
export function toggleAnnotationDetails(
  currentId: string | undefined,
  nextId: string,
): string | undefined {
  return currentId === nextId ? undefined : nextId;
}

interface ViewportGeometryTarget {
  addEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** Keep fixed overlays aligned when any scroll container or viewport moves. */
export function subscribeViewportGeometry(
  scrollTarget: ViewportGeometryTarget,
  resizeTarget: ViewportGeometryTarget,
  refresh: EventListener,
): () => void {
  scrollTarget.addEventListener("scroll", refresh, true);
  resizeTarget.addEventListener("resize", refresh);
  return () => {
    scrollTarget.removeEventListener("scroll", refresh, true);
    resizeTarget.removeEventListener("resize", refresh);
  };
}

export function loadErrorMessage(
  status: "idle" | "loading" | "ready" | "error",
  error?: unknown,
): string | undefined {
  if (status !== "error") return undefined;
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail ? `批注加载失败：${detail}` : "批注加载失败，请重试。";
}

export function saveErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "conflict") return "批注已被其他窗口修改，请重试。";
  if (code === "target-not-complete") return "回答还未完成，稍后再试。";
  if (code === "range-conflict") return "这段文字已有批注，请换一段文字。";
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail ? `批注保存失败：${detail}` : "批注保存失败，请重试。";
}

/** Surface deletion failures so a clicked delete button never appears inert. */
export function deleteErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "conflict") return "批注已被其他窗口修改，已刷新列表。";
  if (code === "invalid-state") return "这条批注的发送状态未确认，暂不能删除。";
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail ? `批注删除失败：${detail}` : "批注删除失败，请重试。";
}
