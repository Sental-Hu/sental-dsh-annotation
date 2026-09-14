import type { TextAnchor } from "../shared/types.js";
import { anchorForRange, blockPathFor } from "./anchors.js";

export interface SelectionSessionLike {
  readonly chat?: {
    readonly nodes?: { get(key: string): unknown };
  };
}

export interface SelectionDraft {
  readonly row: HTMLElement;
  readonly anchorKey: string;
  readonly messageId: string;
  readonly block: HTMLElement;
  readonly anchor: TextAnchor;
  readonly quote: string;
  readonly rect: DOMRect;
}

function elementOf(node: Node | null): Element | null {
  if (node === null) return null;
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function rowOf(node: Node | null): HTMLElement | null {
  return (
    elementOf(node)?.closest<HTMLElement>("[data-chat-anchor-key]") ?? null
  );
}

function ordinaryBlock(node: Node | null, row: Element): HTMLElement | null {
  const element = elementOf(node);
  if (!element || !row.contains(element)) return null;
  if (
    element.closest(
      "pre,code,table,thead,tbody,tfoot,tr,td,th,[aria-hidden='true']",
    )
  )
    return null;
  const block = element.closest<HTMLElement>("p,li,blockquote,dt,dd");
  return block && row.contains(block) ? block : null;
}

/**
 * Return the nearest text container shared by two ordinary blocks inside one
 * assistant row. A paragraph stays its own anchor scope; sibling paragraphs
 * use their common answer container so a normal drag can span line breaks.
 */
export function textRootForBlocks(
  startBlock: HTMLElement,
  endBlock: HTMLElement,
  row: HTMLElement,
): HTMLElement | undefined {
  if (!row.contains(startBlock) || !row.contains(endBlock)) return undefined;
  if (startBlock === endBlock) return startBlock;
  let current: HTMLElement | null = startBlock.parentElement;
  while (current !== null && current !== row) {
    if (current.contains(endBlock)) return current;
    current = current.parentElement;
  }
  return undefined;
}

function messageIdFor(
  session: SelectionSessionLike,
  key: string,
): string | undefined {
  const node = session.chat?.nodes?.get(key) as
    | {
        kind?: unknown;
        data?: { status?: unknown; finalNode?: { messageId?: unknown } };
      }
    | undefined;
  if (node?.kind !== "assistant-step") return undefined;
  if (node.data?.status !== "settled" && node.data?.status !== "interrupted")
    return undefined;
  const messageId = node.data.finalNode?.messageId;
  return typeof messageId === "string" && messageId.trim()
    ? messageId
    : undefined;
}

/** Resolve ordinary text in a finalized assistant row, including paragraphs. */
export function resolveSelection(
  session: SelectionSessionLike,
  selection: Selection | null = typeof window === "undefined"
    ? null
    : window.getSelection(),
): SelectionDraft | undefined {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed)
    return undefined;
  const range = selection.getRangeAt(0);
  const startRow = rowOf(range.startContainer);
  const endRow = rowOf(range.endContainer);
  if (!startRow || startRow !== endRow) return undefined;
  const key = startRow.dataset.chatAnchorKey;
  if (!key) return undefined;
  const messageId = messageIdFor(session, key);
  if (!messageId) return undefined;
  const startBlock = ordinaryBlock(range.startContainer, startRow);
  const endBlock = ordinaryBlock(range.endContainer, startRow);
  if (!startBlock || !endBlock) return undefined;
  const block = textRootForBlocks(startBlock, endBlock, startRow);
  if (!block) return undefined;
  const selected = range.cloneContents();
  if (
    selected.querySelector(
      "pre,code,table,thead,tbody,tfoot,tr,td,th,[aria-hidden='true']",
    )
  )
    return undefined;
  if (blockPathFor(startRow, block) === undefined) return undefined;
  const anchor = anchorForRange(startRow, block, range);
  if (!anchor) return undefined;
  return {
    row: startRow,
    anchorKey: key,
    messageId,
    block,
    anchor,
    quote: range.toString(),
    rect: range.getBoundingClientRect(),
  };
}
