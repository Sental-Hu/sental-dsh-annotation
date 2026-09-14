/** Turn selected assistant text into a normal Markdown block quote. */
export function formatQuotedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Preserve the user's draft and add a visually separate insertion after it. */
export function appendToDraft(draft: string, addition: string): string {
  if (!addition.trim()) return draft;
  return draft ? `${draft}\n\n${addition}` : addition;
}

/** Reuse one annotation as readable message text, never as an internal token. */
export function formatAnnotationForDraft(annotation: {
  readonly quote: string;
  readonly comment: string;
}): string {
  return formatQuotedText(`${annotation.quote}\n\n批注：${annotation.comment}`);
}
