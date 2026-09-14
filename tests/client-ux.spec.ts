import { describe, expect, it, vi } from "vitest";

import {
  annotationTab,
  annotationListLabel,
  deleteErrorMessage,
  dismissNewEditorOnOutsidePointer,
  isAnnotationUiTarget,
  loadErrorMessage,
  positionPopover,
  saveErrorMessage,
  subscribeViewportGeometry,
  toggleAnnotationDetails,
} from "../src/client/ui-state.js";

describe("annotation client UX state", () => {
  it("presents each compact annotation as a browser-like tab", () => {
    expect(annotationTab(2, true)).toEqual({ label: "批注 2", active: true });
    expect(annotationTab(3, false)).toEqual({
      label: "批注 3",
      active: false,
    });
  });

  it("refreshes fixed annotation handles after container scroll or viewport resize", () => {
    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: (type: string, listener: EventListener) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    const refresh = vi.fn();
    const stop = subscribeViewportGeometry(target, target, refresh);

    listeners.get("scroll")?.(new Event("scroll"));
    listeners.get("resize")?.(new Event("resize"));
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    expect(listeners.size).toBe(0);
  });

  it("keeps the annotation collection compact until one item is opened", () => {
    expect(annotationListLabel(3)).toBe("批注 3");
    expect(toggleAnnotationDetails(undefined, "a")).toBe("a");
    expect(toggleAnnotationDetails("a", "a")).toBeUndefined();
    expect(toggleAnnotationDetails("a", "b")).toBe("b");
  });

  it("never saves a draft merely because the pointer leaves its editor", () => {
    expect(dismissNewEditorOnOutsidePointer(" ")).toBe(true);
    expect(dismissNewEditorOnOutsidePointer("还没点击保存")).toBe(false);
  });

  it("keeps a new-editor popover next to the original selection", () => {
    expect(
      positionPopover(
        { left: 240, right: 360, top: 180, bottom: 204 },
        { width: 1024, height: 768 },
      ),
    ).toEqual({ left: 240, top: 212 });
  });

  it("flips and clamps a popover near viewport edges", () => {
    expect(
      positionPopover(
        { left: 990, right: 1000, top: 40, bottom: 54 },
        { width: 1024, height: 160 },
        { width: 320, height: 100 },
      ),
    ).toEqual({ left: 696, top: 8 });
  });

  it("does not treat the empty ready state as a load failure", () => {
    expect(loadErrorMessage("ready")).toBeUndefined();
    expect(loadErrorMessage("error")).toBe("批注加载失败，请重试。");
  });

  it("maps common save failures to actions the user can understand", () => {
    expect(saveErrorMessage({ code: "range-conflict" })).toBe(
      "这段文字已有批注，请换一段文字。",
    );
    expect(saveErrorMessage(new Error("offline"))).toBe(
      "批注保存失败：offline",
    );
  });

  it("shows deletion failures instead of silently ignoring them", () => {
    expect(deleteErrorMessage({ code: "conflict" })).toBe(
      "批注已被其他窗口修改，已刷新列表。",
    );
    expect(deleteErrorMessage(new Error("offline"))).toBe(
      "批注删除失败：offline",
    );
  });

  it("recognizes clicks inside the plugin UI", () => {
    const target = {
      closest: (selector: string) =>
        selector.includes("dsh-annotation-card-detail") ? {} : null,
    };
    expect(isAnnotationUiTarget(target)).toBe(true);
    expect(isAnnotationUiTarget({ closest: () => null })).toBe(false);
    expect(isAnnotationUiTarget(null)).toBe(false);
  });
});
