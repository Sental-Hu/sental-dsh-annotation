import type { TextAnchor } from "../shared/types.js";

const CONTEXT_LENGTH = 48;

/** A small deterministic hash suitable for anchor integrity checks in Browser. */
export function quoteHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Persisted anchor offsets follow DOM text nodes, not the browser's rendered
 * paragraph separators. Range#toString inserts visual line breaks between
 * sibling blocks while Element#textContent does not, so the two must never be
 * mixed for offset arithmetic.
 */
export function rangeTextContent(range: Pick<Range, "cloneContents">): string {
  return range.cloneContents().textContent ?? "";
}

function elementIndex(element: Element): number {
  let index = 0;
  let sibling = element.previousElementSibling;
  while (sibling !== null) {
    index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

/** Stable-ish block path relative to one DSH chat row. */
export function blockPathFor(
  row: Element,
  block: Element,
): number[] | undefined {
  const path: number[] = [];
  let current: Element | null = block;
  while (current !== null && current !== row) {
    path.unshift(elementIndex(current));
    current = current.parentElement;
  }
  return current === row ? path : undefined;
}

function textOffset(root: Element, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return rangeTextContent(range).length;
}

function textContentBefore(
  root: Element,
  container: Node,
  offset: number,
): string {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return rangeTextContent(range);
}

/** Build the persisted UTF-16 anchor for a range inside one selected anchor root. */
export function anchorForRange(
  row: Element,
  block: Element,
  range: Range,
): TextAnchor | undefined {
  const path = blockPathFor(row, block);
  if (path === undefined) return undefined;
  const quote = rangeTextContent(range);
  if (!quote) return undefined;
  const blockText = block.textContent ?? "";
  const start = textOffset(block, range.startContainer, range.startOffset);
  const end = textOffset(block, range.endContainer, range.endOffset);
  if (start < 0 || end <= start || end > blockText.length) return undefined;
  const before = textContentBefore(
    block,
    range.startContainer,
    range.startOffset,
  );
  const after = blockText.slice(end, end + CONTEXT_LENGTH);
  return {
    blockPath: path,
    start,
    end,
    prefix: before.slice(-CONTEXT_LENGTH),
    suffix: after,
    quoteHash: quoteHash(quote),
  };
}

function childAtPath(
  row: Element,
  path: readonly number[],
): Element | undefined {
  let current: Element = row;
  for (const index of path) {
    const child = current.children.item(index);
    if (!child) return undefined;
    current = child;
  }
  return current;
}

/** Resolve a stored block path without searching for matching prose. */
export function blockForPath(
  row: Element,
  path: readonly number[],
): Element | undefined {
  return childAtPath(row, path);
}

function textPoint(root: Element, offset: number): [Node, number] | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node !== null) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return [node, remaining];
    remaining -= length;
    node = walker.nextNode();
  }
  if (remaining === 0 && root.lastChild)
    return [root.lastChild, root.lastChild.textContent?.length ?? 0];
  return undefined;
}

/** Resolve a stored anchor to a DOM Range; returns undefined when the block changed. */
export function rangeForAnchor(
  row: Element,
  anchor: TextAnchor,
): Range | undefined {
  const block = blockForPath(row, anchor.blockPath);
  if (!block) return undefined;
  const text = block.textContent ?? "";
  if (
    anchor.start < 0 ||
    anchor.end > text.length ||
    anchor.end <= anchor.start
  )
    return undefined;
  const start = textPoint(block, anchor.start);
  const end = textPoint(block, anchor.end);
  if (!start || !end) return undefined;
  const range = document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1]);
  return quoteHash(rangeTextContent(range)) === anchor.quoteHash
    ? range
    : undefined;
}

/** Resolve the text caret under a viewport point while staying inside one block. */
export function caretForPoint(
  block: Element,
  clientX: number,
  clientY: number,
): [Node, number] | undefined {
  const documentLike = block.ownerDocument;
  const withCaret = documentLike as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = withCaret.caretPositionFromPoint?.(clientX, clientY);
  if (position && block.contains(position.offsetNode)) {
    return [position.offsetNode, position.offset];
  }
  const range = withCaret.caretRangeFromPoint?.(clientX, clientY);
  if (range && block.contains(range.startContainer)) {
    return [range.startContainer, range.startOffset];
  }
  return undefined;
}
