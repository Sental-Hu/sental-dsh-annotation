import { describe, expect, it } from "vitest";

import { projectAnnotationPanel } from "../src/client/history-panel.js";

describe("annotation history panel projection", () => {
  it("keeps unsent annotations current and orders history by sent time", () => {
    const annotations = [
      {
        id: "current",
        status: "prepared" as const,
        updatedAt: "2026-08-31T09:00:00.000Z",
      },
      {
        id: "older",
        status: "sent" as const,
        sentAt: "2026-08-30T09:00:00.000Z",
        updatedAt: "2026-08-30T10:00:00.000Z",
      },
      {
        id: "latest",
        status: "sent" as const,
        sentAt: "2026-08-31T10:00:00.000Z",
        updatedAt: "2026-08-31T10:00:00.000Z",
      },
    ] as const;

    expect(projectAnnotationPanel(annotations)).toEqual({
      current: [annotations[0]],
      history: [annotations[2], annotations[1]],
    });
  });

  it("falls back to updated time and then id for stable history ordering", () => {
    const annotations = [
      { id: "z", status: "sent" as const, updatedAt: "invalid" },
      {
        id: "later",
        status: "sent" as const,
        updatedAt: "2026-08-31T10:00:00.000Z",
      },
      { id: "a", status: "sent" as const, updatedAt: "invalid" },
    ] as const;

    expect(projectAnnotationPanel(annotations).history).toEqual([
      annotations[1],
      annotations[2],
      annotations[0],
    ]);
  });
});
