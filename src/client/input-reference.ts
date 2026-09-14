import type { AnnotationApiClient } from "./api.js";

export const ANNOTATION_BATCH_SOURCE = "annotation-batch" as const;
const REFERENCE_PREFIX = "dsh-annotation-batch:";
const ITEM_REFERENCE_PREFIX = "dsh-annotation-item:";

export interface InputReferenceOccurrence {
  readonly offset?: number;
  readonly length?: number;
  readonly occurrenceId: number;
  readonly source: string;
  readonly ref: string;
}
export interface InputReferenceState {
  readonly sessionId: string;
  readonly draft: string;
  readonly draftRev: number;
  readonly expectedDraftRev?: number;
  readonly occurrences: readonly InputReferenceOccurrence[];
}
export interface TokenSpan {
  readonly start: number;
  readonly end: number;
  readonly draftRev: number;
}
export interface ReferenceInsert {
  readonly source: typeof ANNOTATION_BATCH_SOURCE;
  readonly ref: string;
  readonly label: string;
  readonly appearance: "file";
  readonly clipboardText: string;
}
export interface InsertReferenceRequest {
  readonly reference: ReferenceInsert;
  readonly span: TokenSpan;
}

export function annotationReferenceFor(
  sessionId: string,
  annotationId: string,
): string {
  if (!sessionId.trim() || !annotationId.trim())
    throw new Error("Session and annotation ids must not be empty.");
  return `${ITEM_REFERENCE_PREFIX}${encodeURIComponent(sessionId)}:${encodeURIComponent(annotationId)}`;
}
function annotationFromReference(
  ref: string,
): { sessionId: string; annotationId: string } | undefined {
  if (!ref.startsWith(ITEM_REFERENCE_PREFIX)) return undefined;
  const [sessionId, annotationId, extra] = ref
    .slice(ITEM_REFERENCE_PREFIX.length)
    .split(":");
  if (!sessionId || !annotationId || extra !== undefined) return undefined;
  try {
    const decodedSessionId = decodeURIComponent(sessionId);
    const decodedAnnotationId = decodeURIComponent(annotationId);
    return decodedSessionId && decodedAnnotationId
      ? { sessionId: decodedSessionId, annotationId: decodedAnnotationId }
      : undefined;
  } catch {
    return undefined;
  }
}
function sessionIdFromReference(ref: string): string | undefined {
  if (!ref.startsWith(REFERENCE_PREFIX)) return undefined;
  try {
    const decoded = decodeURIComponent(ref.slice(REFERENCE_PREFIX.length));
    return decoded || undefined;
  } catch {
    return undefined;
  }
}
export function hasAnnotationReferenceOccurrence(
  occurrences: readonly InputReferenceOccurrence[],
  sessionId: string,
  annotationId: string,
): boolean {
  const ref = annotationReferenceFor(sessionId, annotationId);
  return occurrences.some(
    (occurrence) =>
      occurrence.source === ANNOTATION_BATCH_SOURCE && occurrence.ref === ref,
  );
}

/** Insert one independently removable, file-like annotation chip. */
export function insertAnnotationReference(
  state: InputReferenceState,
  annotation: { readonly id: string; readonly sequence: number },
): InsertReferenceRequest | undefined {
  if (
    state.expectedDraftRev !== undefined &&
    state.expectedDraftRev !== state.draftRev
  )
    return undefined;
  const ref = annotationReferenceFor(state.sessionId, annotation.id);
  if (
    state.occurrences.some(
      (occurrence) =>
        occurrence.source === ANNOTATION_BATCH_SOURCE && occurrence.ref === ref,
    )
  )
    return undefined;
  return {
    span: {
      start: state.draft.length,
      end: state.draft.length,
      draftRev: state.draftRev,
    },
    reference: {
      source: ANNOTATION_BATCH_SOURCE,
      ref,
      label: `批注 ${annotation.sequence}`,
      appearance: "file",
      clipboardText: `[批注 ${annotation.sequence}]`,
    },
  };
}

export interface InputTriggerSource {
  readonly trigger: "@";
  readonly name: typeof ANNOTATION_BATCH_SOURCE;
  candidates(...args: readonly unknown[]): Promise<readonly unknown[]>;
  onPick(...args: readonly unknown[]): undefined;
  readonly codec: {
    clipboardText(ref: string): string;
    serialize(ref: string, signal: AbortSignal): Promise<string>;
  };
}

interface SerializableAnnotation {
  readonly id: string;
  readonly status: "pending" | "prepared" | "unknown" | "sent";
  readonly quote: string;
  readonly comment: string;
}

interface AnnotationReferenceSourceOptions {
  prepare: (
    sessionId: string,
    body?: string,
    signal?: AbortSignal,
    annotationIds?: string[],
  ) => Promise<{ markdown: string }>;
  list?: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<readonly SerializableAnnotation[]>;
}

interface ItemSerializationRequest {
  readonly sessionId: string;
  readonly annotationId: string;
  readonly resolve: (value: string) => void;
  readonly reject: (reason: unknown) => void;
}

interface ItemSerializationTransaction {
  scheduled: boolean;
  readonly requests: ItemSerializationRequest[];
}

function formatHistoricalAnnotation(
  annotation: SerializableAnnotation,
): string {
  return [
    ...annotation.quote
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => `> ${line}`),
    "> ",
    ...`批注：${annotation.comment}`
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => `> ${line}`),
  ].join("\n");
}

/**
 * All annotation chips in one composer submission receive the same AbortSignal
 * from DSH. Batch them during that turn so the outgoing markdown is generated
 * once from exactly the selected chip refs, instead of each chip independently
 * preparing an overlapping batch.
 */
export function createBatchReferenceSource(
  options: AnnotationReferenceSourceOptions,
): InputTriggerSource {
  const transactions = new WeakMap<AbortSignal, ItemSerializationTransaction>();

  const serializeItem = (
    item: { sessionId: string; annotationId: string },
    signal: AbortSignal,
  ): Promise<string> => {
    if (!options.list)
      return Promise.reject(new Error("Invalid annotation reference."));
    let transaction = transactions.get(signal);
    if (!transaction) {
      transaction = { scheduled: false, requests: [] };
      transactions.set(signal, transaction);
    }
    const activeTransaction = transaction;
    const result = new Promise<string>((resolve, reject) => {
      activeTransaction.requests.push({ ...item, resolve, reject });
    });
    if (!activeTransaction.scheduled) {
      activeTransaction.scheduled = true;
      void Promise.resolve().then(async () => {
        transactions.delete(signal);
        const bySession = new Map<string, ItemSerializationRequest[]>();
        for (const request of activeTransaction.requests) {
          const requests = bySession.get(request.sessionId) ?? [];
          requests.push(request);
          bySession.set(request.sessionId, requests);
        }
        await Promise.all(
          [...bySession.entries()].map(async ([sessionId, requests]) => {
            try {
              const available = await options.list!(sessionId, signal);
              const annotationsById = new Map(
                available.map((annotation) => [annotation.id, annotation]),
              );
              const annotationIds = [
                ...new Set(
                  requests
                    .map((request) => request.annotationId)
                    .filter((id) => annotationsById.has(id)),
                ),
              ];
              const annotations = annotationIds.map((id) =>
                annotationsById.get(id)!,
              );
              const pending = annotations.filter(
                (annotation) => annotation.status === "pending",
              );
              const batchIds = pending.map((annotation) => annotation.id);
              // A prepared record may belong to an older, wider batch. Never
              // reuse that batch for one chip: serialize this record itself.
              const plainText = annotations
                .filter((annotation) => annotation.status !== "pending")
                .map(formatHistoricalAnnotation)
                .join("\n\n");
              const parts = [
                batchIds.length > 0
                  ? (
                      await options.prepare(
                        sessionId,
                        undefined,
                        signal,
                        batchIds,
                      )
                    ).markdown
                  : "",
                plainText,
              ].filter(Boolean);
              const markdown = parts.join("\n\n");
              let emitted = false;
              requests.forEach((request) => {
                if (!annotationsById.has(request.annotationId)) {
                  request.resolve("");
                  return;
                }
                request.resolve(emitted ? "" : markdown);
                emitted = true;
              });
            } catch (error) {
              requests.forEach((request) => request.reject(error));
            }
          }),
        );
      });
    }
    return result;
  };

  return {
    trigger: "@",
    name: ANNOTATION_BATCH_SOURCE,
    candidates: async () => [],
    onPick: () => undefined,
    codec: {
      clipboardText: () => "[批注]",
      serialize: async (ref, signal) => {
        const sessionId = sessionIdFromReference(ref);
        // Pre-0.1.5 drafts can retain a hidden session-wide reference. It has
        // no selected IDs, so letting it prepare a batch would inject unrelated
        // annotations. Keep it inert; current chips always carry one explicit ID.
        if (sessionId !== undefined) return "";
        const item = annotationFromReference(ref);
        if (!item) throw new Error("Invalid annotation reference.");
        return serializeItem(item, signal);
      },
    },
  };
}
export function createBatchReferenceSourceFromApi(
  api: Pick<AnnotationApiClient, "prepare" | "list">,
): InputTriggerSource {
  return createBatchReferenceSource({
    prepare: (sessionId, body, signal, annotationIds) =>
      api.prepare(sessionId, body, undefined, signal, annotationIds),
    list: (sessionId, signal) => api.list(sessionId, signal),
  });
}
