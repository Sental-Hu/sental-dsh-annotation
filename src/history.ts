import { createHash, randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { join, isAbsolute, win32 } from "node:path";

import type { AnnotationBatchRecord } from "./shared/types.js";

export const HISTORY_DIRECTORY = ".dsh/annotations";
export const HISTORY_START_MARKER = "<!-- dsh-annotation:history:start -->";
export const HISTORY_END_MARKER = "<!-- dsh-annotation:history:end -->";
const HISTORY_HASH_PREFIX = "<!-- dsh-annotation:history:hash=";

export type HistoryProjectionStatus =
  "written" | "unchanged" | "unavailable" | "conflict";

export interface HistoryProjectionResult {
  status: HistoryProjectionStatus;
  path?: string;
  reason?: string;
  managedHash?: string;
  mtimeMs?: number;
}

export interface HistoryProjectionInput {
  sessionId: string;
  /** The value persisted in the DSH session header. Browser paths are never accepted. */
  cwd?: string;
  batches: readonly AnnotationBatchRecord[];
}

export interface HistoryFileStat {
  mtimeMs: number;
  size: number;
}

export interface HistoryFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; mode?: number; flag?: string },
  ): Promise<void>;
  stat(path: string): Promise<HistoryFileStat>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
}

const fileSystem: HistoryFileSystem = {
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
  stat: async (path) => {
    const info = await nodeFs.stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  },
  rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  rm: (path, options) => nodeFs.rm(path, options),
};

interface Observation {
  mtimeMs: number;
  size: number;
  managedHash: string;
}

export class HistoryProjectionError extends Error {
  readonly name = "HistoryProjectionError";

  constructor(
    readonly code: "invalid-input" | "unavailable" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

function requireSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new HistoryProjectionError(
      "invalid-input",
      "sessionId must be a non-empty string.",
    );
  }
}

function requireCwd(cwd: string | undefined): string {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new HistoryProjectionError(
      "unavailable",
      "The persisted session has no writable workspace cwd.",
    );
  }
  // DSH headers are absolute workspace identities. Rejecting relative values
  // prevents an accidental write relative to the plugin process directory.
  if (!isAbsolute(cwd) && !win32.isAbsolute(cwd)) {
    throw new HistoryProjectionError(
      "unavailable",
      "The persisted session cwd is not an absolute workspace path.",
    );
  }
  return cwd;
}

function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

/** Derive the only history path the plugin is allowed to use. */
export function historyPathForSession(cwd: string, sessionId: string): string {
  requireSessionId(sessionId);
  const workspace = requireCwd(cwd);
  return join(workspace, ".dsh", "annotations", `${sessionHash(sessionId)}.md`);
}

export const deriveHistoryPath = historyPathForSession;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function managedHash(content: string): string {
  return hash(normalizeNewlines(content));
}

function hashMarker(value: string): string {
  return `${HISTORY_HASH_PREFIX}${value} -->`;
}

function extractManaged(content: string): {
  before: string;
  managed: string;
  after: string;
  storedHash?: string;
} | null {
  const start = content.indexOf(HISTORY_START_MARKER);
  if (start < 0) return null;
  const bodyStart = start + HISTORY_START_MARKER.length;
  const end = content.indexOf(HISTORY_END_MARKER, bodyStart);
  if (end < 0) return null;
  const rawManaged = content.slice(bodyStart, end);
  const hashMatch = new RegExp(
    `${HISTORY_HASH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([a-f0-9]{64}) -->`,
  ).exec(rawManaged);
  const storedHash = hashMatch?.[1];
  const markerStart = rawManaged.indexOf(HISTORY_HASH_PREFIX);
  const markerEnd =
    markerStart < 0 ? -1 : rawManaged.indexOf(" -->", markerStart);
  // The canonical managed payload starts with one newline. Keeping that
  // exact representation makes the hash stable across repeated projections.
  const managed =
    markerStart >= 0 && markerEnd >= 0
      ? rawManaged
          .slice(markerEnd + " -->".length)
          .replace(/^\n/, "")
          .replace(/\n$/, "")
      : rawManaged;
  return {
    before: content.slice(0, start),
    managed,
    after: content.slice(end + HISTORY_END_MARKER.length),
    storedHash,
  };
}

function renderBatch(batch: AnnotationBatchRecord): string {
  return `### 批次 ${batch.batchId}\n\n${normalizeNewlines(batch.markdown).trim()}\n`;
}

function renderManaged(batches: readonly AnnotationBatchRecord[]): {
  content: string;
  hash: string;
} {
  const unique = new Map<string, AnnotationBatchRecord>();
  for (const batch of batches) {
    if (batch.status !== "sent" || batch.terminalOutcome) continue;
    if (!unique.has(batch.batchId)) unique.set(batch.batchId, batch);
  }
  const ordered = [...unique.values()].sort(
    (left, right) =>
      left.sentAt?.localeCompare(right.sentAt ?? "") ||
      left.preparedAt.localeCompare(right.preparedAt) ||
      left.batchId.localeCompare(right.batchId),
  );
  const body = ordered.length
    ? ordered.map(renderBatch).join("\n")
    : "暂无已发送批注。\n";
  const withoutHash = `\n${body}`;
  const content = `${hashMarker(managedHash(withoutHash))}\n${withoutHash}`;
  return { content, hash: managedHash(withoutHash) };
}

function extractBatchIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const match of content.matchAll(
    /(?:\u2063dsh-annotation:batch=([^\u2063]+)\u2063|<!-- dsh-annotation:batch=([^\s][\s\S]*?) -->)/g,
  )) {
    const id = match[1] ?? match[2];
    if (id) ids.add(id);
  }
  return ids;
}

function composeContent(
  original: string,
  generated: string,
  batches: readonly AnnotationBatchRecord[],
): { content: string; managedHash: string } {
  const existing = extractManaged(original);
  if (existing) {
    const existingIds = extractBatchIds(existing.managed);
    const additions = batches.filter(
      (batch) =>
        batch.status === "sent" &&
        !batch.terminalOutcome &&
        !existingIds.has(batch.batchId),
    );
    // Re-render all caller-provided batches when they represent the complete
    // history. If the caller supplies only a new batch, append it to preserve
    // already-projected batches.
    const generatedIds = extractBatchIds(generated);
    const hasAllExisting = [...existingIds].every((id) => generatedIds.has(id));
    if (hasAllExisting) {
      return {
        content: `${existing.before}${HISTORY_START_MARKER}\n${generated}\n${HISTORY_END_MARKER}${existing.after}`,
        managedHash: managedHash(
          extractManaged(
            `${HISTORY_START_MARKER}\n${generated}\n${HISTORY_END_MARKER}`,
          )?.managed ?? "",
        ),
      };
    }
    const appended = additions.map(renderBatch).join("\n");
    if (!appended && generatedIds.size === 0) {
      return {
        content: original,
        managedHash: managedHash(existing.managed),
      };
    }
    const merged = `${existing.managed.trimEnd()}${appended ? `\n\n${appended}` : "\n"}\n`;
    const managed = `${hashMarker(managedHash(merged))}\n${merged}`;
    return {
      content: `${existing.before}${HISTORY_START_MARKER}\n${managed}\n${HISTORY_END_MARKER}${existing.after}`,
      managedHash: managedHash(merged),
    };
  }
  const separator =
    original.length > 0 && !original.endsWith("\n") ? "\n\n" : "\n";
  return {
    content: `${original}${separator}${HISTORY_START_MARKER}\n${generated}\n${HISTORY_END_MARKER}\n`,
    managedHash: managedHash(
      extractManaged(
        `${HISTORY_START_MARKER}\n${generated}\n${HISTORY_END_MARKER}`,
      )?.managed ?? "",
    ),
  };
}

function statMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

/**
 * Filesystem-backed Markdown history projector. It owns only the marked
 * region; text outside that region remains user-owned and is preserved.
 */
export class HistoryProjector {
  private readonly fs: HistoryFileSystem;
  private readonly observations = new Map<string, Observation>();
  private readonly tempId: () => string;

  constructor(options: { fs?: HistoryFileSystem; tempId?: () => string } = {}) {
    this.fs = options.fs ?? fileSystem;
    this.tempId = options.tempId ?? randomUUID;
  }

  async project(
    input: HistoryProjectionInput,
  ): Promise<HistoryProjectionResult> {
    requireSessionId(input.sessionId);
    let path: string;
    try {
      path = historyPathForSession(input.cwd ?? "", input.sessionId);
    } catch (error) {
      if (
        error instanceof HistoryProjectionError &&
        error.code === "unavailable"
      ) {
        return { status: "unavailable", reason: error.message };
      }
      throw error;
    }
    const directory = join(path, "..");
    try {
      await this.fs.mkdir(directory, { recursive: true });
    } catch (error) {
      return { status: "unavailable", path, reason: String(error) };
    }

    let original = "";
    let beforeStat: HistoryFileStat | undefined;
    try {
      original = await this.fs.readFile(path, "utf8");
      beforeStat = await this.fs.stat(path);
    } catch (error) {
      if (!statMissing(error))
        return { status: "unavailable", path, reason: String(error) };
    }
    const existing = extractManaged(original);
    if (
      existing?.storedHash &&
      existing.storedHash !== managedHash(existing.managed)
    ) {
      return {
        status: "conflict",
        path,
        reason: "The managed history block was edited externally.",
      };
    }
    const previous = this.observations.get(path);
    if (previous && beforeStat && existing) {
      const currentHash = managedHash(existing?.managed ?? "");
      if (
        previous.mtimeMs !== beforeStat.mtimeMs ||
        previous.size !== beforeStat.size ||
        previous.managedHash !== currentHash
      ) {
        return {
          status: "conflict",
          path,
          reason: "The history file changed since the last plugin write.",
        };
      }
    }
    const generated = renderManaged(input.batches);
    const composed = composeContent(original, generated.content, input.batches);
    if (composed.content === original && beforeStat) {
      this.observations.set(path, {
        ...beforeStat,
        managedHash: composed.managedHash,
      });
      return {
        status: "unchanged",
        path,
        managedHash: composed.managedHash,
        mtimeMs: beforeStat.mtimeMs,
      };
    }
    // Re-stat immediately before replacement. This closes the read/modify
    // window and prevents overwriting a concurrent editor's write.
    if (beforeStat) {
      try {
        const latest = await this.fs.stat(path);
        const latestContent = await this.fs.readFile(path, "utf8");
        if (
          latest.mtimeMs !== beforeStat.mtimeMs ||
          latest.size !== beforeStat.size ||
          latestContent !== original
        ) {
          return {
            status: "conflict",
            path,
            reason: "The history file changed during projection.",
          };
        }
      } catch (error) {
        return { status: "conflict", path, reason: String(error) };
      }
    }
    const temp = join(directory, `.${this.tempId()}.tmp`);
    try {
      await this.fs.writeFile(temp, composed.content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await this.replaceAtomically(temp, path, beforeStat !== undefined);
      const afterStat = await this.fs.stat(path);
      this.observations.set(path, {
        ...afterStat,
        managedHash: composed.managedHash,
      });
      return {
        status: "written",
        path,
        managedHash: composed.managedHash,
        mtimeMs: afterStat.mtimeMs,
      };
    } catch (error) {
      await this.fs.rm(temp, { force: true }).catch(() => undefined);
      if (
        error instanceof HistoryProjectionError &&
        error.code !== "invalid-input"
      ) {
        return { status: error.code, path, reason: error.message };
      }
      return { status: "unavailable", path, reason: String(error) };
    }
  }

  private async replaceAtomically(
    temp: string,
    target: string,
    replacing: boolean,
  ): Promise<void> {
    try {
      await this.fs.rename(temp, target);
      return;
    } catch (error) {
      if (!replacing) throw error;
      // Windows rename refuses to replace an existing file. Move the old file
      // aside and restore it if the second rename fails; all files stay in the
      // same directory and the target is never removed without a replacement.
      const backup = `${target}.${this.tempId()}.bak`;
      try {
        await this.fs.rename(target, backup);
        try {
          await this.fs.rename(temp, target);
        } catch (replacementError) {
          await this.fs.rename(backup, target).catch(() => undefined);
          throw replacementError;
        }
        await this.fs.rm(backup, { force: true });
      } catch (fallbackError) {
        throw fallbackError instanceof Error ? fallbackError : error;
      }
    }
  }

  async status(
    input: Pick<HistoryProjectionInput, "sessionId" | "cwd">,
  ): Promise<HistoryProjectionResult> {
    requireSessionId(input.sessionId);
    try {
      const path = historyPathForSession(input.cwd ?? "", input.sessionId);
      const info = await this.fs.stat(path);
      return { status: "unchanged", path, mtimeMs: info.mtimeMs };
    } catch (error) {
      if (
        error instanceof HistoryProjectionError &&
        error.code === "unavailable"
      )
        return { status: "unavailable", reason: error.message };
      try {
        return {
          status: "unavailable",
          path: historyPathForSession(input.cwd ?? "", input.sessionId),
          reason: String(error),
        };
      } catch {
        return { status: "unavailable", reason: String(error) };
      }
    }
  }
}

export default HistoryProjector;
