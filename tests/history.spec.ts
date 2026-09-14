import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HISTORY_END_MARKER,
  HISTORY_START_MARKER,
  HistoryProjector,
  deriveHistoryPath,
} from "../src/history.js";
import type { AnnotationBatchRecord } from "../src/shared/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function batch(
  batchId: string,
  sentAt = "2026-08-28T00:00:00.000Z",
): AnnotationBatchRecord {
  return {
    batchId,
    annotationIds: [`annotation-${batchId}`],
    markdown: `<!-- dsh-annotation:batch=${batchId} -->\n\n## 批注\n\n1. 原文：“原文”\n   批注：说明`,
    status: "sent",
    preparedAt: "2026-08-27T00:00:00.000Z",
    updatedAt: sentAt,
    sentAt,
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-annotation-history-"));
  roots.push(root);
  return root;
}

describe("history path", () => {
  it("uses sha256 and rejects traversal-shaped ids without accepting a file path", () => {
    const path = deriveHistoryPath("C:/workspace", "../../etc/passwd");
    expect(path).toMatch(/[0-9a-f]{64}\.md$/);
    expect(path).not.toContain("passwd");
    expect(() => deriveHistoryPath("relative/workspace", "s")).toThrow(
      /absolute workspace path/,
    );
  });
});

describe("HistoryProjector", () => {
  it("returns unavailable when cwd is absent and does not choose a fallback", async () => {
    const projector = new HistoryProjector();
    await expect(
      projector.project({ sessionId: "s", batches: [] }),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("writes marked history, preserves user text, and is idempotent", async () => {
    const cwd = await workspace();
    const projector = new HistoryProjector({ tempId: () => "tmp" });
    const first = await projector.project({
      sessionId: "session/1",
      cwd,
      batches: [batch("b-1")],
    });
    expect(first.status).toBe("written");
    const path = first.path!;
    const initial = await readFile(path, "utf8");
    expect(initial).toContain(HISTORY_START_MARKER);
    expect(initial).toContain(HISTORY_END_MARKER);
    expect(initial).toContain("b-1");

    await import("node:fs/promises").then(({ appendFile }) =>
      appendFile(path, "\n我的说明\n"),
    );
    const second = await projector.project({
      sessionId: "session/1",
      cwd,
      batches: [batch("b-1"), batch("b-2", "2026-08-29T00:00:00.000Z")],
    });
    expect(second.status).toBe("conflict");
    expect(await readFile(path, "utf8")).toContain("我的说明");

    // An edit outside the marker is user-owned and should be accepted after a
    // fresh projector instance; the managed block remains authoritative.
    const fresh = new HistoryProjector({ tempId: () => "tmp-2" });
    const third = await fresh.project({
      sessionId: "session/1",
      cwd,
      batches: [batch("b-1"), batch("b-2", "2026-08-29T00:00:00.000Z")],
    });
    expect(third.status).toBe("written");
    const final = await readFile(path, "utf8");
    expect(final).toContain("我的说明");
    expect(final.match(/dsh-annotation:batch=b-1/g)).toHaveLength(1);
    expect(final.match(/dsh-annotation:batch=b-2/g)).toHaveLength(1);
  });

  it("preserves a pre-existing user document when creating the managed block", async () => {
    const cwd = await workspace();
    const path = join(cwd, ".dsh", "annotations");
    const projector = new HistoryProjector();
    const first = await projector.project({ sessionId: "s", cwd, batches: [] });
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(first.path!, "# 我的历史\n\n保留\n", "utf8"),
    );
    const result = await projector.project({
      sessionId: "s",
      cwd,
      batches: [batch("b-1")],
    });
    expect(result.status).toBe("written");
    const contents = await readFile(result.path!, "utf8");
    expect(contents).toContain("# 我的历史");
    expect(contents).toContain("保留");
    expect(contents).toContain("b-1");
    await expect(stat(path)).resolves.toBeTruthy();
  });

  it("returns conflict and does not overwrite managed edits", async () => {
    const cwd = await workspace();
    const projector = new HistoryProjector();
    const first = await projector.project({
      sessionId: "s",
      cwd,
      batches: [batch("b-1")],
    });
    const edited = (await readFile(first.path!, "utf8")).replace(
      "说明",
      "外部修改",
    );
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(first.path!, edited, "utf8"),
    );
    const result = await projector.project({
      sessionId: "s",
      cwd,
      batches: [batch("b-2")],
    });
    expect(result.status).toBe("conflict");
    expect(await readFile(first.path!, "utf8")).toContain("外部修改");
  });
});
