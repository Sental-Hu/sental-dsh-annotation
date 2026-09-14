import type { InputReferenceOccurrence } from "../client/input-reference.js";

/** Public DSH input snapshots project chips into clipboard coordinates; the
 * editor's insertion spans count each chip as one opaque character. */
export function inputOffset(
  offset: number,
  occurrences: readonly InputReferenceOccurrence[],
): number | undefined {
  let converted = offset;
  for (const item of occurrences) {
    if (typeof item.offset !== "number" || typeof item.length !== "number")
      return undefined;
    if (offset > item.offset && offset < item.offset + item.length)
      return undefined;
    if (item.offset + item.length <= offset) converted -= item.length - 1;
  }
  return converted;
}

export function orphanedAnnotationLabels(
  draft: string,
  occurrences: readonly InputReferenceOccurrence[],
): number[] {
  return [...draft.matchAll(/\[批注 (\d+)\]/g)]
    .filter(
      (match) =>
        !occurrences.some(
          (item) =>
            typeof item.offset === "number" &&
            typeof item.length === "number" &&
            match.index >= item.offset &&
            match.index < item.offset + item.length,
        ),
    )
    .map((match) => Number(match[1]));
}
