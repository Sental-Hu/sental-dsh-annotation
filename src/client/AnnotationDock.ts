import type { AnnotationRecord, DisplayAnnotation } from "../shared/types.js";
import {
  selectAnnotationColor,
  toDisplayAnnotations,
} from "../shared/colors.js";
import {
  anchorForRange,
  blockForPath,
  caretForPoint,
  rangeForAnchor,
} from "./anchors.js";
import {
  resolveSelection,
  type SelectionDraft,
  type SelectionSessionLike,
} from "./selection.js";
import { AnnotationStore, type AnnotationStoreSnapshot } from "./store.js";
import { highlightName, highlightStyleText } from "./highlight-style.js";
import { appendToDraft, formatQuotedText } from "./composer-text.js";
import { orphanedAnnotationLabels } from "../compat/input.js";
import type { AnnotationReferenceTarget } from "./pending-reference.js";
import { projectAnnotationPanel } from "./history-panel.js";
import type { DirectAnnotationSender } from "./direct-send.js";
import {
  hasAnnotationReferenceOccurrence,
  type InputReferenceOccurrence,
} from "./input-reference.js";
import {
  annotationListLabel,
  annotationTab,
  subscribeViewportGeometry,
  toggleAnnotationDetails,
  isAnnotationUiTarget,
  canDismissAnnotationEditor,
  annotationStatusLabel,
  deleteErrorMessage,
  loadErrorMessage,
  positionPopover,
  saveErrorMessage,
  type OperationState,
} from "./ui-state.js";

/* React is a DSH baseline module. Keeping this runtime import inside the lazy
 * client factory avoids taking a second React copy into the npm package. */
interface ReactRuntime {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  useCallback<T extends (...args: never[]) => unknown>(
    fn: T,
    deps: readonly unknown[],
  ): T;
  useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useRef<T>(value: T): { current: T };
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void];
  useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
}

let reactRuntime: ReactRuntime | undefined;
function getReact(): ReactRuntime {
  if (reactRuntime) return reactRuntime;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  reactRuntime = require("react") as ReactRuntime;
  return reactRuntime;
}

const COLORS: Record<string, string> = {
  amber: "#f59e0b66",
  green: "#22c55e66",
  blue: "#3b82f666",
  rose: "#f43f5e66",
  teal: "#14b8a666",
  slate: "#94a3b866",
};

interface InputLike {
  readonly draft: string;
  readonly occurrences: readonly InputReferenceOccurrence[];
}

interface InputActionsLike {
  setDraft?(draft: string): void;
}

export interface AnnotationDockProps {
  readonly session: SelectionSessionLike & { readonly sessionId: string };
  readonly input: InputLike;
  readonly inputActions?: InputActionsLike;
  readonly insertAnnotationReference?: (
    annotation: AnnotationReferenceTarget,
  ) => boolean;
  readonly store: AnnotationStore;
  readonly sendAnnotation?: DirectAnnotationSender;
}

type ComposerState =
  | {
      readonly kind: "new";
      readonly nonce: number;
      readonly target: SelectionDraft;
      readonly comment: string;
    }
  | {
      readonly kind: "edit";
      readonly nonce: number;
      readonly id: string;
      readonly version: string;
      readonly comment: string;
    };

function freezeSnapshot(store: AnnotationStore): AnnotationStoreSnapshot {
  return store.getSnapshot();
}

function styleOnce(): void {
  if (
    typeof document === "undefined" ||
    document.querySelector("style[data-dsh-annotation]") !== null
  )
    return;
  const style = document.createElement("style");
  style.dataset.dshAnnotation = "";
  style.textContent = `
    .dsh-annotation-dock{display:flex;flex-direction:column;gap:8px;margin:4px 0;padding:0 4px;color:var(--dsw-alias-label-primary,#0f172a);font:13px/1.4 system-ui,sans-serif}
    .dsh-annotation-cards{display:flex;flex-direction:column;min-width:0}
    .dsh-annotation-tabstrip{display:flex;gap:2px;overflow-x:auto;overflow-y:hidden;align-items:flex-end;border-bottom:1px solid color-mix(in srgb,currentColor 18%,transparent);padding:0 4px;scrollbar-width:thin}
    .dsh-annotation-tab{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;max-width:160px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;padding:2px 3px 2px 8px;background:transparent;color:var(--dsw-alias-label-tertiary,#64748b);font:13px/1.2 system-ui,sans-serif;white-space:nowrap}
    .dsh-annotation-tab:hover{background:color-mix(in srgb,currentColor 7%,transparent);color:var(--dsw-alias-label-primary,#0f172a)}
    .dsh-annotation-tab[data-active=true]{position:relative;z-index:1;margin-bottom:-1px;border-color:color-mix(in srgb,currentColor 18%,transparent);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f172a)}
    .dsh-annotation-tab-label{display:inline-flex;align-items:center;gap:5px;min-width:0;border:0;padding:4px 2px;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
    .dsh-annotation-tab-close{width:20px;height:20px;border:0;border-radius:5px;padding:0;background:transparent;color:inherit;font:16px/1 system-ui;cursor:pointer;opacity:0}
    .dsh-annotation-tab:hover .dsh-annotation-tab-close,.dsh-annotation-tab[data-active=true] .dsh-annotation-tab-close{opacity:.72}
    .dsh-annotation-tab-close:hover{opacity:1!important;background:color-mix(in srgb,currentColor 12%,transparent)}
    .dsh-annotation-tab-dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%}
    .dsh-annotation-history-wrap{display:flex;flex-direction:column;gap:3px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);padding-top:6px}
    .dsh-annotation-history-toggle{align-self:flex-start;border:1px solid transparent;border-radius:7px;padding:5px 8px;background:transparent;color:var(--dsw-alias-label-tertiary,#64748b);font:12px/1.2 system-ui,sans-serif;cursor:pointer}
    .dsh-annotation-history-toggle:hover{border-color:color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 6%,transparent);color:var(--dsw-alias-label-primary,#0f172a)}
    .dsh-annotation-history{display:flex;max-height:280px;flex-direction:column;gap:2px;margin-top:1px;overflow-y:auto;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:4px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 96%,currentColor);scrollbar-width:thin}
    .dsh-annotation-history-row{display:flex;align-items:center;gap:7px;width:100%;border:0;border-radius:6px;padding:6px 7px;background:transparent;color:inherit;font:12px/1.3 system-ui,sans-serif;text-align:left;cursor:pointer}
    .dsh-annotation-history-row:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}
    .dsh-annotation-history-row:disabled{cursor:default;opacity:.58}
    .dsh-annotation-history-row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#64748b)}
    .dsh-annotation-card-detail{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-top:0;border-left:3px solid var(--dsh-annotation-color,#f59e0b);border-radius:0 0 8px 8px;padding:8px 9px;background:var(--dsw-alias-bg-base,#fff)}
    .dsh-annotation-card-detail[data-active=true]{outline:2px solid color-mix(in srgb,currentColor 35%,transparent)}
    .dsh-annotation-card-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#64748b);font-size:11px}
    .dsh-annotation-card-actions{margin-left:auto;display:flex;gap:4px}
    .dsh-annotation-card-detail button,.dsh-annotation-menu button{border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;padding:3px 6px}
    .dsh-annotation-card-detail button:hover,.dsh-annotation-menu button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
    .dsh-annotation-quote{margin-top:2px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#475569)}
    .dsh-annotation-comment{margin-top:3px;white-space:pre-wrap;color:var(--dsw-alias-label-primary,#0f172a)}
    .dsh-annotation-editor{display:flex;gap:6px;align-items:flex-start;margin-top:6px}
    .dsh-annotation-editor textarea{flex:1;min-height:44px;resize:vertical;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;padding:5px 7px;background:transparent;color:inherit;font:inherit}
    .dsh-annotation-menu{position:fixed;z-index:2147483000;display:flex;gap:2px;padding:4px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:7px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 5px 18px #0003;color:var(--dsw-alias-label-primary,#111827)}
    .dsh-annotation-editor-popover{position:fixed;z-index:2147483001;width:min(320px,calc(100vw - 20px));padding:8px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 8px 28px #0003}
    .dsh-annotation-editor-popover textarea{width:100%;box-sizing:border-box;min-height:70px;resize:vertical;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;padding:6px;background:transparent;color:inherit;font:inherit}
    .dsh-annotation-editor-actions{display:flex;align-items:center;gap:6px;margin-top:6px}
    .dsh-annotation-editor-actions button{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:5px;background:transparent;color:inherit;cursor:pointer;padding:3px 8px}
    .dsh-annotation-editor-actions button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
    .dsh-annotation-editor-status{color:var(--dsw-alias-label-tertiary,#64748b);font-size:11px}
    .dsh-annotation-editor-error{color:var(--dsw-alias-color-danger,#dc2626);font-size:11px;white-space:pre-wrap}
    .dsh-annotation-empty{color:var(--dsw-alias-label-tertiary,#64748b)}
    .dsh-annotation-dock{gap:10px;font:13px/1.55 system-ui,sans-serif;color:var(--dsw-alias-label-primary,#172033)}
    .dsh-annotation-tabstrip{gap:6px;border:0;padding:4px 0;align-items:center}
    .dsh-annotation-tab{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;padding:2px 4px 2px 9px;background:var(--dsw-alias-bg-base,#fff);transition:background .15s,border-color .15s}
    .dsh-annotation-tab[data-active=true]{margin:0;background:color-mix(in srgb,#3b82f6 9%,var(--dsw-alias-bg-base,#fff));border-color:color-mix(in srgb,#3b82f6 40%,transparent)}
    .dsh-annotation-tab-label{padding:5px 2px}
    .dsh-annotation-tab:focus-within .dsh-annotation-tab-close{opacity:1}
    .dsh-annotation-card-detail{margin-top:5px;padding:12px 14px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-left:3px solid var(--dsh-annotation-color);border-radius:10px;box-shadow:0 3px 12px #00000006;max-height:45vh;overflow:auto;overflow-wrap:anywhere}
    .dsh-annotation-card-detail[data-active=true]{outline:none;border-color:color-mix(in srgb,#3b82f6 35%,transparent)}
    .dsh-annotation-card-head{flex-wrap:wrap;gap:8px;font-size:12px}
    .dsh-annotation-card-head b{color:var(--dsw-alias-label-primary,#172033)}
    .dsh-annotation-status{font-size:11px;padding:1px 6px;border-radius:4px;background:color-mix(in srgb,currentColor 6%,transparent)}
    .dsh-annotation-card-actions{flex-wrap:wrap;gap:3px}
    .dsh-annotation-card-detail button{min-height:28px;padding:4px 7px}
    .dsh-annotation-quote{margin-top:10px;padding:8px 10px;border-radius:6px;background:color-mix(in srgb,currentColor 4%,transparent);font-size:12px;max-height:120px;overflow:auto}
    .dsh-annotation-comment{margin-top:10px;line-height:1.65}
    .dsh-annotation-editor{flex-direction:column;gap:4px}
    .dsh-annotation-editor textarea{width:100%;box-sizing:border-box;min-height:80px;padding:9px 10px;border-radius:8px;line-height:1.6}
    .dsh-annotation-editor-popover{padding:12px;border-radius:12px;box-shadow:0 8px 32px #0000001f;color:var(--dsw-alias-label-primary,#172033);box-sizing:border-box}
    .dsh-annotation-editor-popover textarea{padding:9px 10px;min-height:90px;border-radius:8px;font:13px/1.6 system-ui,sans-serif}
    .dsh-annotation-editor-actions{width:100%;justify-content:flex-end;flex-wrap:wrap}
    .dsh-annotation-editor-actions button{min-height:30px;padding:5px 12px;border-radius:6px}
    .dsh-annotation-editor-actions button:first-of-type{background:#2563eb;border-color:#2563eb;color:white}
    .dsh-annotation-menu{border-radius:9px;padding:4px;box-shadow:0 4px 20px #0000001a}
    .dsh-annotation-menu button{padding:6px 10px;min-height:30px}
    .dsh-annotation-dock button:disabled{opacity:.4;cursor:default}
    .dsh-annotation-dock button:focus-visible,.dsh-annotation-dock textarea:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
    .dsh-annotation-resume{display:flex;gap:12px;align-items:center;align-self:flex-start;padding:7px 10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;cursor:pointer}
    .dsh-annotation-resume span{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b)}
    @media(max-width:540px){.dsh-annotation-card-actions{margin-left:0;width:100%}.dsh-annotation-tab-close{opacity:.65}}
    @media(prefers-reduced-motion:reduce){.dsh-annotation-tab{transition:none}}
    .dsh-annotation-handle{position:fixed;z-index:2147483002;width:10px;height:10px;margin:-5px 0 0 -5px;padding:0;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px #0006;cursor:ew-resize}
  `;
  document.head.appendChild(style);
}

function renderHighlights(
  session: SelectionSessionLike,
  annotations: readonly AnnotationRecord[],
): void {
  if (typeof document === "undefined") return;
  let style = document.querySelector<HTMLStyleElement>(
    "style[data-dsh-annotation-highlights]",
  );
  if (!style) {
    style = document.createElement("style");
    style.dataset.dshAnnotationHighlights = "";
    document.head.appendChild(style);
  }
  style.textContent = highlightStyleText(annotations, COLORS);
  const css = (
    globalThis as {
      CSS?: {
        highlights?: {
          set(name: string, value: unknown): void;
          delete(name: string): void;
        };
      };
    }
  ).CSS;
  const Highlight = (
    globalThis as { Highlight?: new (range: Range) => unknown }
  ).Highlight;
  if (!css?.highlights || !Highlight) return;
  const names = new Set<string>();
  for (const annotation of annotations) {
    const rows = document.querySelectorAll<HTMLElement>(
      "[data-chat-anchor-key]",
    );
    let row: HTMLElement | undefined;
    for (const candidate of rows) {
      const key = candidate.dataset.chatAnchorKey;
      if (!key) continue;
      const node = session.chat?.nodes?.get(key) as
        { data?: { finalNode?: { messageId?: unknown } } } | undefined;
      if (node?.data?.finalNode?.messageId === annotation.messageId) {
        row = candidate;
        break;
      }
    }
    if (!row) continue;
    const range = rangeForAnchor(row, annotation.anchor);
    if (!range) continue;
    const name = highlightName(annotation.id);
    names.add(name);
    css.highlights.set(name, new Highlight(range));
  }
  const previous =
    (renderHighlights as unknown as { names?: Set<string> }).names ??
    new Set<string>();
  for (const name of previous)
    if (!names.has(name)) css.highlights.delete(name);
  (renderHighlights as unknown as { names?: Set<string> }).names = names;
}

function copyText(value: string): void {
  if (globalThis.navigator?.clipboard?.writeText) {
    void globalThis.navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === "undefined") return;
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function resolvedAnnotationRange(
  session: SelectionSessionLike,
  annotation: AnnotationRecord,
): { row: HTMLElement; block: HTMLElement; range: Range } | undefined {
  const rows = document.querySelectorAll<HTMLElement>("[data-chat-anchor-key]");
  for (const row of rows) {
    const key = row.dataset.chatAnchorKey;
    if (!key) continue;
    const node = session.chat?.nodes?.get(key) as
      { data?: { finalNode?: { messageId?: unknown } } } | undefined;
    if (node?.data?.finalNode?.messageId !== annotation.messageId) continue;
    const block = blockForPath(row, annotation.anchor.blockPath) as
      HTMLElement | undefined;
    const range = block ? rangeForAnchor(row, annotation.anchor) : undefined;
    if (block && range) return { row, block, range };
  }
  return undefined;
}

function placeHandle(handle: HTMLElement, range: Range, side: "start" | "end") {
  const rects = [...range.getClientRects()];
  const rect = side === "start" ? rects[0] : rects[rects.length - 1];
  if (!rect) {
    handle.hidden = true;
    return;
  }
  handle.hidden = false;
  handle.style.left = `${side === "start" ? rect.left : rect.right}px`;
  handle.style.top = `${side === "start" ? rect.top : rect.bottom}px`;
}

export function AnnotationDock({
  session,
  input,
  inputActions,
  insertAnnotationReference,
  sendAnnotation,
  store,
}: AnnotationDockProps): unknown {
  const React = getReact();
  const h = React.createElement;
  styleOnce();
  const snapshot = React.useSyncExternalStore(
    store.subscribe.bind(store),
    () => freezeSnapshot(store),
    () => freezeSnapshot(store),
  );
  const [selection, setSelection] = React.useState<SelectionDraft | undefined>(
    undefined,
  );
  const [composer, setComposer] = React.useState<ComposerState | undefined>(
    undefined,
  );
  const [expandedId, setExpandedId] = React.useState<string | undefined>(
    undefined,
  );
  const [saveState, setSaveState] = React.useState<OperationState>({
    status: "idle",
  });
  const [deleteError, setDeleteError] = React.useState<string | undefined>(
    undefined,
  );
  const [editorHidden, setEditorHidden] = React.useState(false);
  const composerRef = React.useRef<ComposerState | undefined>(composer);
  const saving = React.useRef(false);
  composerRef.current = composer;

  React.useEffect(() => {
    composerRef.current = undefined;
    setComposer(undefined);
    setExpandedId(undefined);
    setEditorHidden(false);
    setSelection(undefined);
    setSaveState({ status: "idle" });
    store.setSession(session.sessionId);
    void store.load().catch(() => undefined);
  }, [session.sessionId, store]);

  React.useEffect(() => {
    const update = () => setSelection(resolveSelection(session));
    const dismiss = () => {
      const current = composerRef.current;
      const persisted =
        current?.kind === "edit"
          ? snapshot.annotations.find((item) => item.id === current.id)?.comment
          : undefined;
      if (canDismissAnnotationEditor(current, persisted, saving.current)) {
        composerRef.current = undefined;
        setComposer(undefined);
        setSaveState({ status: "idle" });
      }
      setEditorHidden(true);
      setExpandedId(undefined);
      setSelection(undefined);
    };
    const outside = (event: PointerEvent) => {
      if (!isAnnotationUiTarget(event.target)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) dismiss();
    };
    const onSelectionChange = () => {
      if (isAnnotationUiTarget(document.activeElement)) return;
      update();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [session, snapshot.annotations]);

  React.useEffect(() => {
    renderHighlights(session, snapshot.annotations);
  }, [session, snapshot.annotations]);

  React.useEffect(() => {
    const activateHighlight = (event: MouseEvent) => {
      const target = event.target;
      if (isAnnotationUiTarget(target)) return;
      // A visible unsaved editor is the user's current work; never replace it
      // merely because a highlighted range was clicked behind the popover.
      if (composerRef.current) return;
      for (const annotation of snapshot.annotations) {
        const resolved = resolvedAnnotationRange(session, annotation);
        if (!resolved) continue;
        const hit = [...resolved.range.getClientRects()].some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        );
        if (!hit) continue;
        setComposer({
          kind: "edit",
          nonce: Date.now(),
          id: annotation.id,
          version: annotation.version,
          comment: annotation.comment,
        });
        setEditorHidden(false);
        setExpandedId(annotation.id);
        setSaveState({ status: "idle" });
        event.stopPropagation();
        return;
      }
    };
    document.addEventListener("click", activateHighlight);
    return () => document.removeEventListener("click", activateHighlight);
  }, [session, snapshot.annotations]);

  React.useEffect(() => {
    if (
      typeof document === "undefined" ||
      composer?.kind !== "edit" ||
      editorHidden
    )
      return;
    const annotation = snapshot.annotations.find(
      (item) => item.id === composer.id,
    );
    if (!annotation) return;
    const resolved = resolvedAnnotationRange(session, annotation);
    if (!resolved) return;
    const handles = (["start", "end"] as const).map((side) => {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "dsh-annotation-handle";
      handle.dataset.side = side;
      handle.setAttribute(
        "aria-label",
        side === "start" ? "调整批注起点" : "调整批注终点",
      );
      handle.style.background = COLORS[annotation.color] ?? COLORS.amber;
      handle.hidden = true;
      document.body.appendChild(handle);
      placeHandle(handle, resolved.range, side);
      return { side, handle };
    });
    let activeSide: "start" | "end" | undefined;
    let displayedRange = resolved.range;
    let candidate:
      | { readonly anchor: SelectionDraft["anchor"]; readonly quote: string }
      | undefined;
    const onPointerDown = (side: "start" | "end", event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      activeSide = side;
      candidate = undefined;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!activeSide) return;
      const point = caretForPoint(resolved.block, event.clientX, event.clientY);
      if (!point) return;
      const nextRange = document.createRange();
      try {
        if (activeSide === "start") {
          nextRange.setStart(point[0], point[1]);
          nextRange.setEnd(
            resolved.range.endContainer,
            resolved.range.endOffset,
          );
        } else {
          nextRange.setStart(
            resolved.range.startContainer,
            resolved.range.startOffset,
          );
          nextRange.setEnd(point[0], point[1]);
        }
      } catch {
        return;
      }
      const nextAnchor = anchorForRange(
        resolved.row,
        resolved.block,
        nextRange,
      );
      if (!nextAnchor) return;
      candidate = { anchor: nextAnchor, quote: nextRange.toString() };
      displayedRange = nextRange;
      for (const { side, handle } of handles)
        placeHandle(handle, nextRange, side);
    };
    const onPointerUp = () => {
      const next = candidate;
      activeSide = undefined;
      candidate = undefined;
      if (!next) {
        displayedRange = resolved.range;
        placeHandle(handles[0]!.handle, resolved.range, "start");
        placeHandle(handles[1]!.handle, resolved.range, "end");
        return;
      }
      const current = composerRef.current;
      if (!current || current.kind !== "edit" || current.id !== annotation.id)
        return;
      void store
        .update(current.id, {
          anchor: next.anchor,
          quote: next.quote,
          expectedVersion: current.version,
        })
        .then((updated) => {
          if (composerRef.current?.nonce === current.nonce)
            setComposer({ ...current, version: updated.version });
        })
        .catch(() => undefined);
    };
    for (const { side, handle } of handles)
      handle.addEventListener("pointerdown", (event) =>
        onPointerDown(side, event as PointerEvent),
      );
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    const stopViewportGeometry = subscribeViewportGeometry(
      document,
      window,
      () => {
        for (const { side, handle } of handles)
          placeHandle(handle, displayedRange, side);
      },
    );
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      stopViewportGeometry();
      for (const { handle } of handles) handle.remove();
    };
  }, [composer, editorHidden, session, snapshot.annotations, store]);

  async function saveNow(
    closeAfter = false,
    sendAfter = false,
  ): Promise<boolean> {
    const current = composerRef.current;
    if (!current || !current.comment.trim() || saving.current) return false;
    saving.current = true;
    setSaveState({ status: "saving" });
    let persisted: AnnotationRecord | undefined;
    try {
      if (current.kind === "new") {
        const color = selectAnnotationColor(
          {
            messageId: current.target.messageId,
            anchor: current.target.anchor,
          },
          [...snapshot.annotations],
        );
        persisted = await store.create({
          messageId: current.target.messageId,
          anchor: current.target.anchor,
          quote: current.target.quote,
          comment: current.comment,
          color,
          order:
            snapshot.annotations.reduce(
              (highest, annotation) => Math.max(highest, annotation.order),
              -1,
            ) + 1,
        });
      } else {
        const existing = store
          .getSnapshot()
          .annotations.find((item) => item.id === current.id);
        persisted =
          existing?.comment === current.comment
            ? existing
            : await store.update(current.id, {
                comment: current.comment,
                expectedVersion: current.version,
              });
      }
      if (!persisted) return false;
      if (sendAfter) {
        if (!sendAnnotation)
          throw new Error("当前 DSH 未提供直接发送接口，可先保存批注");
        setSaveState({ status: "sending" });
        try {
          await sendAnnotation(persisted);
        } finally {
          await store.load().catch(() => undefined);
        }
      }
      if (composerRef.current?.nonce === current.nonce) {
        if (closeAfter || sendAfter) {
          composerRef.current = undefined;
          setComposer(undefined);
          setSelection(undefined);
          setExpandedId(undefined);
        } else {
          setComposer({
            kind: "edit",
            nonce: current.nonce,
            id: persisted.id,
            version: persisted.version,
            comment: persisted.comment,
          });
        }
        setSaveState({ status: "saved" });
        if (sendAfter) setHistoryOpen(true);
        else if (current.kind === "new")
          insertAnnotationReference?.({
            id: persisted.id,
            sequence: persisted.order + 1,
          });
      }
      return true;
    } catch (error) {
      if (composerRef.current?.nonce === current.nonce) {
        if (persisted) {
          const latest =
            store
              .getSnapshot()
              .annotations.find((item) => item.id === persisted!.id) ??
            persisted;
          setComposer({
            kind: "edit",
            nonce: current.nonce,
            id: latest.id,
            version: latest.version,
            comment: latest.comment,
          });
          setExpandedId(latest.id);
        }
        setSaveState({
          status: "error",
          message:
            persisted && sendAfter
              ? `批注已保存。${error instanceof Error ? error.message : "发送未完成，请核对会话记录。"}`
              : saveErrorMessage(error),
        });
      }
      return false;
    } finally {
      saving.current = false;
    }
  }

  const busy = saveState.status === "saving" || saveState.status === "sending";
  const sendButton = (annotation?: DisplayAnnotation) =>
    h(
      "button",
      {
        type: "button",
        disabled: busy || !composer?.comment.trim() || !sendAnnotation,
        title: sendAnnotation
          ? "保存批注并直接发送到当前会话，不修改输入框"
          : "当前 DSH 未提供直接发送接口",
        onClick: () => void saveNow(true, true),
      },
      annotation &&
        (annotation.status === "prepared" || annotation.status === "unknown")
        ? "核对发送"
        : "发送",
    );

  const displayed = React.useMemo(
    () => toDisplayAnnotations([...snapshot.annotations]),
    [snapshot.annotations],
  );
  const { current: currentAnnotations, history: historyAnnotations } =
    React.useMemo(() => projectAnnotationPanel(displayed), [displayed]);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  React.useEffect(() => setHistoryOpen(false), [session.sessionId]);
  const viewport = {
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight,
  };
  const openComposer = (target: SelectionDraft) => {
    setEditorHidden(false);
    setSaveState({ status: "idle" });
    setComposer({ kind: "new", nonce: Date.now(), target, comment: "" });
  };
  const appendReference = (text: string) => {
    inputActions?.setDraft?.(appendToDraft(input.draft, text));
    setSelection(undefined);
  };
  const isInInput = (annotation: DisplayAnnotation): boolean =>
    hasAnnotationReferenceOccurrence(
      input.occurrences,
      session.sessionId,
      annotation.id,
    );
  const addToInput = (annotation: DisplayAnnotation): void => {
    const inserted = insertAnnotationReference?.({
      id: annotation.id,
      sequence: annotation.sequence,
      restoreLabel: orphanedLabels.includes(annotation.sequence),
    });
    if (!inserted)
      setDeleteError(
        "批注未加入输入框：请先移除重复的批注标签，或重新打开会话后再试。",
      );
  };
  const orphanedLabels = orphanedAnnotationLabels(
    input.draft,
    input.occurrences,
  );
  const menu =
    selection && !composer
      ? h(
          "div",
          {
            className: "dsh-annotation-menu",
            style: positionPopover(selection.rect, viewport, {
              width: 176,
              height: 36,
            }),
            onMouseDown: (event: MouseEvent) => event.stopPropagation(),
          },
          h(
            "button",
            { type: "button", onClick: () => copyText(selection.quote) },
            "复制",
          ),
          h(
            "button",
            { type: "button", onClick: () => openComposer(selection) },
            "批注",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () => appendReference(formatQuotedText(selection.quote)),
            },
            "引用",
          ),
        )
      : null;

  const editor =
    composer?.kind === "new" && !editorHidden
      ? h(
          "div",
          {
            className: "dsh-annotation-editor-popover",
            style: positionPopover(composer.target.rect, viewport),
            onMouseDown: (event: MouseEvent) => event.stopPropagation(),
          },
          h("textarea", {
            autoFocus: true,
            readOnly: busy,
            "aria-label": "批注内容",
            onKeyDown: (event: KeyboardEvent) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.isComposing
              ) {
                event.preventDefault();
                void saveNow(true);
              }
            },
            value: composer.comment,
            placeholder: "写下批注…",
            onChange: (event: { target: { value: string } }) => {
              setSaveState({ status: "idle" });
              setComposer({ ...composer, comment: event.target.value });
            },
          }),
          h(
            "div",
            { className: "dsh-annotation-editor-actions" },
            busy
              ? h(
                  "span",
                  { className: "dsh-annotation-editor-status" },
                  saveState.status === "sending" ? "发送中…" : "保存中…",
                )
              : saveState.status === "saved"
                ? h(
                    "span",
                    { className: "dsh-annotation-editor-status" },
                    "已保存",
                  )
                : saveState.status === "error"
                  ? h(
                      "span",
                      {
                        className: "dsh-annotation-editor-error",
                        role: "alert",
                      },
                      saveState.message,
                    )
                  : null,
            saveState.status === "error"
              ? h(
                  "button",
                  {
                    type: "button",
                    onClick: () => void saveNow(true),
                  },
                  "重试",
                )
              : h(
                  "button",
                  {
                    type: "button",
                    disabled: busy,
                    onClick: () => void saveNow(true),
                  },
                  "保存",
                ),
            sendButton(),
            h(
              "button",
              {
                type: "button",
                disabled: busy,
                onClick: () => {
                  setComposer(undefined);
                  setSelection(undefined);
                  setSaveState({ status: "idle" });
                },
              },
              "取消",
            ),
          ),
        )
      : null;

  const removeAnnotation = (annotation: DisplayAnnotation) => {
    setDeleteError(undefined);
    void store
      .delete(annotation.id, annotation.version)
      .then(() => {
        if (expandedId === annotation.id) setExpandedId(undefined);
        if (
          composerRef.current?.kind === "edit" &&
          composerRef.current.id === annotation.id
        )
          setComposer(undefined);
      })
      .catch((error: unknown) => setDeleteError(deleteErrorMessage(error)));
  };
  const cards = currentAnnotations.map((annotation: DisplayAnnotation) => {
    const tab = annotationTab(
      annotation.sequence,
      expandedId === annotation.id,
    );
    return h(
      "div",
      {
        key: annotation.id,
        className: "dsh-annotation-tab",
        "data-active": tab.active,
      },
      h(
        "button",
        {
          type: "button",
          className: "dsh-annotation-tab-label",
          role: "tab",
          "aria-selected": tab.active,
          onClick: () => {
            if (composerRef.current) return;
            setExpandedId(toggleAnnotationDetails(expandedId, annotation.id));
          },
        },
        h("span", {
          className: "dsh-annotation-tab-dot",
          style: { background: COLORS[annotation.color] ?? COLORS.amber },
        }),
        h("span", null, tab.label),
      ),
      h(
        "button",
        {
          type: "button",
          className: "dsh-annotation-tab-close",
          "aria-label": `删除${tab.label}`,
          title: `删除${tab.label}`,
          onClick: (event: MouseEvent) => {
            event.stopPropagation();
            removeAnnotation(annotation);
          },
        },
        "×",
      ),
    );
  });
  const expanded = currentAnnotations.find((item) => item.id === expandedId);
  const detail = expanded
    ? (() => {
        const active = composer?.kind === "edit" && composer.id === expanded.id;
        const position = currentAnnotations.findIndex(
          (item) => item.id === expanded.id,
        );
        const move = (delta: -1 | 1) => {
          const next = position + delta;
          if (next < 0 || next >= currentAnnotations.length) return;
          const ids = currentAnnotations.map((item) => item.id);
          [ids[position], ids[next]] = [ids[next]!, ids[position]!];
          void store
            .reorder(ids, snapshot.revision ?? "0")
            .catch(() => undefined);
        };
        const actions = h(
          "span",
          { className: "dsh-annotation-card-actions" },
          h(
            "button",
            {
              type: "button",
              onClick: () => {
                const resolved = resolvedAnnotationRange(session, expanded);
                resolved?.block.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
              },
            },
            "定位原文",
          ),
          h(
            "button",
            {
              type: "button",
              disabled: isInInput(expanded),
              onClick: () => addToInput(expanded),
            },
            isInInput(expanded)
              ? "已在输入框"
              : orphanedLabels.includes(expanded.sequence)
                ? "恢复引用"
                : "加入输入",
          ),
          h(
            "button",
            {
              type: "button",
              disabled: position === 0,
              onClick: () => move(-1),
              "aria-label": "上移",
            },
            "↑",
          ),
          h(
            "button",
            {
              type: "button",
              disabled: position === currentAnnotations.length - 1,
              onClick: () => move(1),
              "aria-label": "下移",
            },
            "↓",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () => {
                setEditorHidden(false);
                setSaveState({ status: "idle" });
                setComposer({
                  kind: "edit",
                  nonce: Date.now(),
                  id: expanded.id,
                  version: expanded.version,
                  comment: expanded.comment,
                });
              },
            },
            "编辑",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () => removeAnnotation(expanded),
            },
            "删除",
          ),
        );
        const edit = active
          ? h(
              "div",
              { className: "dsh-annotation-editor" },
              h("textarea", {
                autoFocus: true,
                readOnly:
                  busy ||
                  expanded.status === "prepared" ||
                  expanded.status === "unknown",
                "aria-label": "编辑批注内容",
                onKeyDown: (event: KeyboardEvent) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter" &&
                    !event.isComposing
                  ) {
                    event.preventDefault();
                    void saveNow();
                  }
                },
                value: composer.comment,
                onChange: (event: { target: { value: string } }) => {
                  setSaveState({ status: "idle" });
                  setComposer({ ...composer, comment: event.target.value });
                },
              }),
              h(
                "div",
                { className: "dsh-annotation-editor-actions" },
                busy
                  ? h(
                      "span",
                      { className: "dsh-annotation-editor-status" },
                      saveState.status === "sending" ? "发送中…" : "保存中…",
                    )
                  : saveState.status === "saved"
                    ? h(
                        "span",
                        { className: "dsh-annotation-editor-status" },
                        "已保存",
                      )
                    : saveState.status === "error"
                      ? h(
                          "span",
                          {
                            className: "dsh-annotation-editor-error",
                            role: "alert",
                          },
                          saveState.message,
                        )
                      : null,
                saveState.status === "error"
                  ? h(
                      "button",
                      { type: "button", onClick: () => void saveNow() },
                      "重试",
                    )
                  : h(
                      "button",
                      {
                        type: "button",
                        disabled: busy,
                        onClick: () => void saveNow(),
                      },
                      "保存",
                    ),
                sendButton(expanded),
                h(
                  "button",
                  {
                    type: "button",
                    disabled: busy,
                    onClick: () => {
                      setComposer(undefined);
                      setSaveState({ status: "idle" });
                    },
                  },
                  "关闭",
                ),
              ),
            )
          : null;
        return h(
          "article",
          {
            className: "dsh-annotation-card-detail",
            "data-active": active,
            style: {
              "--dsh-annotation-color": COLORS[expanded.color] ?? COLORS.amber,
            },
          },
          h(
            "div",
            { className: "dsh-annotation-card-head" },
            h("b", null, annotationListLabel(expanded.sequence)),
            h(
              "span",
              { className: "dsh-annotation-status" },
              annotationStatusLabel(expanded.status),
            ),
            actions,
          ),
          h(
            "div",
            { className: "dsh-annotation-quote" },
            `“${expanded.quote}”`,
          ),
          h("div", { className: "dsh-annotation-comment" }, expanded.comment),
          edit,
        );
      })()
    : null;

  const loadFailure = loadErrorMessage(snapshot.status, snapshot.error);
  const retryLoad = () => void store.load().catch(() => undefined);
  const history = historyAnnotations.length
    ? h(
        "div",
        { className: "dsh-annotation-history-wrap" },
        h(
          "button",
          {
            type: "button",
            className: "dsh-annotation-history-toggle",
            "aria-expanded": historyOpen,
            onClick: () => setHistoryOpen(!historyOpen),
          },
          `历史批注（${historyAnnotations.length}）`,
        ),
        historyOpen
          ? h(
              "div",
              { className: "dsh-annotation-history" },
              ...historyAnnotations.map((annotation) =>
                h(
                  "button",
                  {
                    key: annotation.id,
                    type: "button",
                    className: "dsh-annotation-history-row",
                    title: "将这条批注加入输入框",
                    disabled: isInInput(annotation),
                    onClick: () => addToInput(annotation),
                  },
                  h(
                    "b",
                    null,
                    isInInput(annotation)
                      ? `${annotationListLabel(annotation.sequence)}（已加入）`
                      : annotationListLabel(annotation.sequence),
                  ),
                  h("span", null, annotation.comment || annotation.quote),
                ),
              ),
            )
          : null,
      )
    : null;
  return h(
    "div",
    { className: "dsh-annotation-dock" },
    menu,
    editor,
    orphanedLabels.length
      ? h(
          "div",
          { className: "dsh-annotation-empty", role: "alert" },
          `输入中有未关联的批注标签（${[...new Set(orphanedLabels)].join("、")}）。核对对应卡片内容后点击“恢复引用”；不需要的标签请删除。`,
        )
      : null,
    loadFailure
      ? h(
          "div",
          { className: "dsh-annotation-empty", role: "alert" },
          loadFailure,
          h("button", { type: "button", onClick: retryLoad }, "重试"),
        )
      : null,
    deleteError
      ? h(
          "div",
          { className: "dsh-annotation-empty", role: "alert" },
          deleteError,
        )
      : null,
    cards.length
      ? h(
          "div",
          { className: "dsh-annotation-cards" },
          h(
            "div",
            { className: "dsh-annotation-tabstrip", role: "tablist" },
            cards,
          ),
          detail,
        )
      : null,
    composer && editorHidden
      ? h(
          "button",
          {
            type: "button",
            className: "dsh-annotation-resume",
            onClick: () => {
              setEditorHidden(false);
              if (composer.kind === "edit") setExpandedId(composer.id);
            },
          },
          "继续编辑批注",
          h("span", null, "草稿已保留"),
        )
      : null,
    history,
  );
}

export default AnnotationDock;
