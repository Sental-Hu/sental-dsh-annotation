import type { AnnotationRecord, BatchParseResult } from "./types.js";

const INVISIBLE_MARKER = "\u2063";
const BATCH_MARKER_PREFIX = "dsh-annotation:batch=";

function compareCardOrder(
  left: AnnotationRecord,
  right: AnnotationRecord,
): number {
  if (left.order !== right.order) {
    return left.order - right.order;
  }

  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }

  return left.id.localeCompare(right.id);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function escapeMarkdownText(value: string): string {
  return normalizeNewlines(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([[\]()*_`#+!|])/g, "\\$1");
}

export function formatBatchMarker(batchId: string): string {
  if (!batchId.trim()) {
    throw new Error("Batch id must not be empty.");
  }

  return `\u{e0001}${[...encodeURIComponent(batchId)].map((character) => String.fromCodePoint(917504 + character.charCodeAt(0))).join("")}\u{e007f}`;
}

export function parseBatchMarker(markdown: string): BatchParseResult | null {
  const current = /\u{e0001}([\u{e0021}-\u{e007e}]+)\u{e007f}/u.exec(markdown);
  if (current?.[1]) {
    try {
      return {
        batchId: decodeURIComponent(
          [...current[1]]
            .map((character) =>
              String.fromCharCode(character.codePointAt(0)! - 917504),
            )
            .join(""),
        ),
        marker: current[0],
        start: current.index,
        end: current.index + current[0].length,
      };
    } catch {
      return null;
    }
  }
  const match = new RegExp(
    `${INVISIBLE_MARKER}${BATCH_MARKER_PREFIX}([^${INVISIBLE_MARKER}]+)${INVISIBLE_MARKER}`,
  ).exec(markdown);
  const legacy = /<!-- dsh-annotation:batch=([^\s][\s\S]*?) -->/.exec(markdown);
  const found = match ?? legacy;
  if (!found?.[1]) {
    return null;
  }

  const marker = found[0];
  const start = found.index;
  return {
    batchId: found[1],
    marker,
    start,
    end: start + marker.length,
  };
}

export function serializeAnnotationBatch(input: {
  batchId: string;
  annotations: AnnotationRecord[];
  body?: string;
}): string {
  const body = input.body ? normalizeNewlines(input.body) : "";
  const marker = formatBatchMarker(input.batchId);
  const sorted = [...input.annotations].sort(compareCardOrder);

  const items = sorted.map((annotation, index) => {
    const comment = normalizeNewlines(annotation.comment);
    if (!comment.trim()) {
      throw new Error(
        `Cannot serialize empty comment for annotation ${annotation.id}.`,
      );
    }

    const commentLines = comment.split("\n").map(escapeMarkdownText);
    const quote = escapeMarkdownText(annotation.quote);
    const lines = [
      `${index + 1}. 原文：“${quote}”`,
      `   批注：${commentLines[0] ?? ""}`,
    ];

    for (const line of commentLines.slice(1)) {
      lines.push(`   ${line}`);
    }

    return lines.join("\n");
  });

  const sections = body
    ? [body, "", marker, "## 批注", "", items.join("\n")]
    : [marker, "## 批注", "", items.join("\n")];

  return sections.join("\n");
}
