export interface HighlightStyleAnnotation {
  readonly id: string;
  readonly color: string;
}

export function highlightName(id: string): string {
  return `dsh-annotation-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** CSS Highlight API rules are separate from range registration. */
export function highlightStyleText(
  annotations: readonly HighlightStyleAnnotation[],
  colors: Readonly<Record<string, string>>,
): string {
  const fallback = colors.amber;
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const annotation of annotations) {
    const name = highlightName(annotation.id);
    if (seen.has(name)) continue;
    seen.add(name);
    const color = colors[annotation.color] ?? fallback;
    if (!color) continue;
    rules.push(`::highlight(${name}){background-color:${color}}`);
  }
  return rules.join("\n");
}
