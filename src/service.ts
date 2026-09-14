import { randomUUID } from "node:crypto";

import type {
  AnnotationCreateInput,
  AnnotationRepository,
  AnnotationUpdateInput,
  ConfirmInput,
  MarkInput,
  PrepareInput,
} from "./repository.js";
import { RepositoryError } from "./repository.js";
import {
  classifyRangeConflict,
  validateRangeBoundary,
} from "./shared/ranges.js";
import {
  formatBatchMarker,
  parseBatchMarker,
  serializeAnnotationBatch,
} from "./shared/markdown.js";
import type {
  AnnotationBatchRecord,
  AnnotationRecord,
  TextAnchor,
} from "./shared/types.js";
import type { HistoryProjectionResult, HistoryProjector } from "./history.js";

/** The small event surface needed from DSH persistence. */
export interface DurableSessionEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly surfaceOp?: unknown;
}

export interface DurableSessionInspection {
  readonly meta?: { readonly id?: string; readonly cwd?: string };
  readonly events: readonly DurableSessionEvent[];
}

export interface SessionPersistencePort {
  inspect(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<DurableSessionInspection>;
  readFrom(
    sessionId: string,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{
    readonly meta?: { readonly id?: string };
    readonly events: DurableSessionEvent[];
  }>;
}

export interface LiveSession {
  readonly header?: { readonly id?: string };
}

export interface SessionsPort {
  get(sessionId: string): LiveSession | undefined;
  flush(session: LiveSession): Promise<boolean> | boolean;
}

export interface AnnotationRepositoryPort {
  list(sessionId: string): Promise<readonly AnnotationRecord[]>;
  listSnapshot(sessionId: string): Promise<
    | {
        readonly revision?: string;
        readonly annotations: readonly AnnotationRecord[];
        readonly batches: Record<string, AnnotationBatchRecord>;
      }
    | undefined
  >;
  create(
    sessionId: string,
    input: AnnotationCreateInput,
  ): Promise<AnnotationRecord>;
  update(
    sessionId: string,
    annotationId: string,
    patch: AnnotationUpdateInput,
  ): Promise<AnnotationRecord>;
  delete(
    sessionId: string,
    annotationId: string,
    expectedVersion?: string,
  ): Promise<boolean>;
  reorder(
    sessionId: string,
    annotationIds: string[],
    expectedVersion?: string,
  ): Promise<readonly AnnotationRecord[]>;
  prepare(
    sessionId: string,
    input: PrepareInput,
  ): Promise<AnnotationBatchRecord>;
  mark(sessionId: string, input: MarkInput): Promise<AnnotationBatchRecord>;
  confirm(
    sessionId: string,
    input: ConfirmInput,
  ): Promise<AnnotationBatchRecord>;
}

export type AnnotationServiceErrorCode =
  | "invalid-input"
  | "target-not-found"
  | "target-not-complete"
  | "target-not-text"
  | "range-conflict"
  | "prepare-conflict"
  | "live-session-not-found"
  | "durable-marker-missing"
  | "flush-failed";

export class AnnotationServiceError extends Error {
  readonly name = "AnnotationServiceError";
  constructor(
    readonly code: AnnotationServiceErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toJSON(): {
    code: AnnotationServiceErrorCode;
    message: string;
    details: Record<string, unknown>;
  } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function sameAnnotationIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

export interface CreateAnnotationRequest extends AnnotationCreateInput {
  readonly sessionId: string;
}

export interface UpdateAnnotationRequest extends AnnotationUpdateInput {
  readonly sessionId: string;
  readonly annotationId: string;
}

export interface PrepareAnnotationRequest {
  readonly sessionId: string;
  readonly body?: string;
  readonly batchId?: string;
  /** A file chip prepares only the annotation it represents. */
  readonly annotationIds?: readonly string[];
}

export interface SettleAnnotationRequest {
  readonly sessionId: string;
  readonly batchId: string;
  readonly outcome: "accepted" | "unknown" | "definite-failure";
  readonly receiptId?: string;
  readonly reason?: string;
  readonly occurredAt?: string;
}

export interface ReconcileAnnotationRequest {
  readonly sessionId: string;
  readonly batchId: string;
  readonly sentAt?: string;
  readonly scannedAt?: string;
}

export interface PreparedAnnotationBatch extends AnnotationBatchRecord {
  readonly marker: string;
}

type QueueTask<T> = () => Promise<T>;

function asPort(
  repository: AnnotationRepositoryPort | AnnotationRepository,
): AnnotationRepositoryPort {
  return repository;
}

function anchorSameBlock(left: TextAnchor, right: TextAnchor): boolean {
  return (
    left.blockPath.length === right.blockPath.length &&
    left.blockPath.every((part, index) => part === right.blockPath[index])
  );
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AnnotationServiceError(
      "invalid-input",
      `${field} must not be blank.`,
      { field },
    );
  }
}

function assertAnchor(anchor: TextAnchor): void {
  const reason = validateRangeBoundary(anchor, Number.MAX_SAFE_INTEGER);
  if (reason !== null) {
    throw new AnnotationServiceError(
      "invalid-input",
      `Invalid annotation range: ${reason}.`,
      {
        field: "anchor",
        reason,
      },
    );
  }
}

function contentBlocks(
  data: unknown,
): readonly Record<string, unknown>[] | null {
  if (!data || typeof data !== "object") return null;
  const message = (data as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;
  if (
    content.some(
      (block) => !block || typeof block !== "object" || Array.isArray(block),
    )
  )
    return null;
  return content as Record<string, unknown>[];
}

function messageIdOf(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const message = (data as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return undefined;
  const id = (message as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function isCompletedAssistantTextEvent(
  event: DurableSessionEvent,
  messageId: string,
): boolean {
  if (event.type !== "assistant/message") return false;
  const data = event.data;
  if (!data || typeof data !== "object") return false;
  const raw = data as Record<string, unknown>;
  if (!(event.surfaceOp === "append")) return false;
  if (
    raw.interrupted === true ||
    raw.completed === false ||
    raw.finished === false ||
    raw.status === "pending" ||
    raw.status === "streaming" ||
    raw.status === "in-progress"
  )
    return false;
  const message = raw.message;
  if (!message || typeof message !== "object") return false;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.role !== "assistant") return false;
  const semanticKind = [
    raw.kind,
    raw.format,
    raw.contentType,
    messageRecord.kind,
    messageRecord.format,
  ];
  if (
    semanticKind.some(
      (kind) =>
        typeof kind === "string" &&
        [
          "code",
          "table",
          "tool",
          "tool-call",
          "tool-result",
          "reasoning",
        ].includes(kind),
    )
  )
    return false;
  const actualId = messageIdOf(data);
  if (actualId !== messageId) return false;
  const blocks = contentBlocks(data);
  if (blocks === null || blocks.length === 0) return false;
  const hasVisibleText = blocks.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.length > 0,
  );
  if (!hasVisibleText) return false;
  // DSH stores the model's internal reasoning beside the visible text in
  // the same assistant/message event. It is not rendered as answer prose,
  // so it must not make an otherwise ordinary text answer unannotatable.
  return blocks.every(
    (block) =>
      block.type === "reasoning" ||
      (block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0),
  );
}

function hasDurableMarker(
  events: readonly DurableSessionEvent[],
  marker: string,
): boolean {
  const batchId = parseBatchMarker(marker)?.batchId;
  const markers = batchId
    ? [
        marker,
        `\u2063dsh-annotation:batch=${batchId}\u2063`,
        `<!-- dsh-annotation:batch=${batchId} -->`,
      ]
    : [marker];
  return events.some(
    (event) =>
      event.type === "user/message" &&
      (contentBlocks(event.data) ?? []).some(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          markers.some((candidate) =>
            (block.text as string).includes(candidate),
          ),
      ),
  );
}

function cloneBatchWithMarker(
  batch: AnnotationBatchRecord,
): PreparedAnnotationBatch {
  const marker = formatBatchMarker(batch.batchId);
  const parsed = parseBatchMarker(batch.markdown);
  const markdown = parsed
    ? `${batch.markdown.slice(0, parsed.start)}${marker}${batch.markdown.slice(parsed.end)}`
    : batch.markdown;
  return {
    ...batch,
    annotationIds: [...batch.annotationIds],
    markdown,
    marker,
  };
}

/** Host-side business service for annotations and their send transactions. */
export class AnnotationService {
  private readonly repository: AnnotationRepositoryPort;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly prepares = new Map<
    string,
    Promise<PreparedAnnotationBatch>
  >();
  private readonly uuid: () => string;
  private readonly now: () => string;

  constructor(options: {
    repository: AnnotationRepositoryPort | AnnotationRepository;
    sessionPersistence: SessionPersistencePort;
    sessions: SessionsPort;
    uuid?: () => string;
    now?: () => string;
    history?: HistoryProjector;
  });
  constructor(
    repository: AnnotationRepositoryPort | AnnotationRepository,
    sessionPersistence: SessionPersistencePort,
    sessions: SessionsPort,
    options?: {
      uuid?: () => string;
      now?: () => string;
      history?: HistoryProjector;
    },
  );
  constructor(
    optionsOrRepository:
      | {
          repository: AnnotationRepositoryPort | AnnotationRepository;
          sessionPersistence: SessionPersistencePort;
          sessions: SessionsPort;
          uuid?: () => string;
          now?: () => string;
          history?: HistoryProjector;
        }
      | AnnotationRepositoryPort
      | AnnotationRepository,
    persistence?: SessionPersistencePort,
    sessions?: SessionsPort,
    constructorOptions: {
      uuid?: () => string;
      now?: () => string;
      history?: HistoryProjector;
    } = {},
  ) {
    const options =
      "repository" in optionsOrRepository
        ? optionsOrRepository
        : {
            repository: optionsOrRepository,
            sessionPersistence: persistence!,
            sessions: sessions!,
            ...constructorOptions,
          };
    this.repository = asPort(options.repository);
    this.sessionPersistence = options.sessionPersistence;
    this.sessions = options.sessions;
    this.uuid = options.uuid ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.history = options.history;
  }

  private readonly sessionPersistence: SessionPersistencePort;
  private readonly sessions: SessionsPort;
  private readonly history?: HistoryProjector;

  private enqueue<T>(sessionId: string, task: QueueTask<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.tails.set(sessionId, current);
    void current.then(
      () => {
        if (this.tails.get(sessionId) === current) this.tails.delete(sessionId);
      },
      () => {
        if (this.tails.get(sessionId) === current) this.tails.delete(sessionId);
      },
    );
    return current;
  }

  private async durableEvents(
    sessionId: string,
  ): Promise<readonly DurableSessionEvent[]> {
    const inspected = await this.sessionPersistence.inspect(sessionId);
    if (inspected.meta?.id !== sessionId) {
      throw new AnnotationServiceError(
        "durable-marker-missing",
        "Inspected session identity does not match the requested session.",
        { sessionId },
      );
    }
    const stored = await this.sessionPersistence.readFrom(sessionId, 0);
    if (stored.meta?.id !== sessionId) {
      throw new AnnotationServiceError(
        "durable-marker-missing",
        "Durable session identity does not match the requested session.",
        { sessionId },
      );
    }
    // The detached read is the durability proof. In particular, never fall
    // back to the live immutable inspection when persistence has not caught up.
    return stored.events;
  }

  private async assertTarget(
    sessionId: string,
    messageId: string,
  ): Promise<void> {
    assertNonBlank(messageId, "messageId");
    try {
      const inspected = await this.sessionPersistence.inspect(sessionId);
      if (inspected.meta?.id !== sessionId) {
        throw new AnnotationServiceError(
          "target-not-found",
          "Inspected session identity does not match the requested session.",
          { sessionId },
        );
      }
      const stored = await this.sessionPersistence.readFrom(sessionId, 0);
      if (stored.meta?.id !== sessionId) {
        throw new AnnotationServiceError(
          "target-not-found",
          "Durable session identity does not match the requested session.",
          { sessionId },
        );
      }
      const events = stored.events;
      // A reused id in another role must not mask an append-origin assistant
      // projection. Accept exactly one compliant assistant candidate.
      const assistantCandidates = events.filter(
        (event) =>
          event.type === "assistant/message" &&
          messageIdOf(event.data) === messageId,
      );
      const target = assistantCandidates.find((event) =>
        isCompletedAssistantTextEvent(event, messageId),
      );
      if (
        assistantCandidates.filter((event) =>
          isCompletedAssistantTextEvent(event, messageId),
        ).length > 1
      ) {
        throw new AnnotationServiceError(
          "target-not-found",
          `Assistant message id is ambiguous: ${messageId}.`,
          { sessionId, messageId },
        );
      }
      const fallback = events.find(
        (event) => messageIdOf(event.data) === messageId,
      );
      const diagnosed = target ?? fallback;
      if (!diagnosed)
        throw new AnnotationServiceError(
          "target-not-found",
          `Unknown assistant message: ${messageId}.`,
          { sessionId, messageId },
        );
      if (diagnosed.type !== "assistant/message")
        throw new AnnotationServiceError(
          "target-not-text",
          "Annotations require an assistant message.",
          { sessionId, messageId },
        );
      if (!isCompletedAssistantTextEvent(diagnosed, messageId)) {
        const blocks = contentBlocks(diagnosed.data);
        if (
          blocks?.some(
            (block) => block.type !== "text" && block.type !== "reasoning",
          )
        ) {
          throw new AnnotationServiceError(
            "target-not-text",
            "Annotations require ordinary assistant text.",
            { sessionId, messageId },
          );
        }
        throw new AnnotationServiceError(
          "target-not-complete",
          "The assistant message is not complete.",
          { sessionId, messageId },
        );
      }
    } catch (error) {
      if (error instanceof AnnotationServiceError) throw error;
      throw error;
    }
  }

  private async assertNoConflict(
    sessionId: string,
    messageId: string,
    anchor: TextAnchor,
    exceptId?: string,
  ): Promise<void> {
    assertAnchor(anchor);
    const existing = await this.repository.list(sessionId);
    for (const annotation of existing) {
      if (annotation.id === exceptId || annotation.messageId !== messageId)
        continue;
      if (!anchorSameBlock(annotation.anchor, anchor)) continue;
      const reason = classifyRangeConflict(anchor, annotation.anchor);
      if (reason !== "none") {
        throw new AnnotationServiceError(
          "range-conflict",
          `Annotation range ${reason} with ${annotation.id}.`,
          {
            reason,
            annotationId: annotation.id,
          },
        );
      }
    }
  }

  async create(
    sessionId: string,
    input: AnnotationCreateInput,
  ): Promise<AnnotationRecord>;
  async create(request: CreateAnnotationRequest): Promise<AnnotationRecord>;
  async create(
    sessionOrRequest: string | CreateAnnotationRequest,
    maybeInput?: AnnotationCreateInput,
  ): Promise<AnnotationRecord> {
    const request =
      typeof sessionOrRequest === "string"
        ? { ...maybeInput!, sessionId: sessionOrRequest }
        : sessionOrRequest;
    return this.enqueue(request.sessionId, async () => {
      assertNonBlank(request.comment, "comment");
      await this.assertTarget(request.sessionId, request.messageId);
      await this.assertNoConflict(
        request.sessionId,
        request.messageId,
        request.anchor,
      );
      return this.repository.create(request.sessionId, request);
    });
  }

  async list(sessionId: string): Promise<readonly AnnotationRecord[]> {
    return this.repository.list(sessionId);
  }

  /** Return the sidecar snapshot used by Browser reorder/CAS clients. */
  async snapshot(sessionId: string): Promise<{
    readonly revision: string;
    readonly annotations: readonly AnnotationRecord[];
    readonly batches: Record<string, AnnotationBatchRecord>;
  }> {
    const snapshot = await this.repository.listSnapshot(sessionId);
    if (!snapshot) {
      return { revision: "0", annotations: [], batches: {} };
    }
    return {
      revision: snapshot.revision ?? "0",
      annotations: snapshot.annotations,
      batches: snapshot.batches,
    };
  }

  /** Read-only projection status; unavailable history never blocks annotations. */
  async historyStatus(sessionId: string): Promise<HistoryProjectionResult> {
    if (!this.history)
      return {
        status: "unavailable",
        reason: "History projection is not enabled.",
      };
    const inspected = await this.sessionPersistence.inspect(sessionId);
    if (inspected.meta?.id !== sessionId) {
      throw new AnnotationServiceError(
        "target-not-found",
        "Durable session identity does not match the requested session.",
        { sessionId },
      );
    }
    return this.history.status({ sessionId, cwd: inspected.meta?.cwd });
  }

  async update(
    sessionId: string,
    annotationId: string,
    patch: AnnotationUpdateInput,
  ): Promise<AnnotationRecord>;
  async update(request: UpdateAnnotationRequest): Promise<AnnotationRecord>;
  async update(
    sessionOrRequest: string | UpdateAnnotationRequest,
    maybeAnnotationId?: string,
    maybePatch?: AnnotationUpdateInput,
  ): Promise<AnnotationRecord> {
    const request =
      typeof sessionOrRequest === "string"
        ? {
            ...maybePatch!,
            sessionId: sessionOrRequest,
            annotationId: maybeAnnotationId!,
          }
        : sessionOrRequest;
    return this.enqueue(request.sessionId, async () => {
      if (request.comment !== undefined)
        assertNonBlank(request.comment, "comment");
      if (request.color !== undefined) {
        const current = await this.repository
          .list(request.sessionId)
          .then((items) =>
            items.find((item) => item.id === request.annotationId),
          );
        if (current && request.color !== current.color) {
          throw new AnnotationServiceError(
            "invalid-input",
            "Annotation colors are immutable.",
            { field: "color" },
          );
        }
      }
      if (request.messageId !== undefined)
        await this.assertTarget(request.sessionId, request.messageId);
      if (request.anchor !== undefined) {
        const current = await this.repository
          .list(request.sessionId)
          .then((items) =>
            items.find((item) => item.id === request.annotationId),
          );
        if (!current)
          throw new RepositoryError(
            "not-found",
            `Unknown annotation: ${request.annotationId}.`,
            { annotationId: request.annotationId },
          );
        await this.assertNoConflict(
          request.sessionId,
          request.messageId ?? current.messageId,
          request.anchor,
          request.annotationId,
        );
      }
      return this.repository.update(
        request.sessionId,
        request.annotationId,
        request,
      );
    });
  }

  async delete(
    sessionId: string,
    annotationId: string,
    expectedVersion?: string,
  ): Promise<boolean>;
  async delete(request: {
    sessionId: string;
    annotationId: string;
    expectedVersion?: string;
    version?: string;
  }): Promise<boolean>;
  async delete(
    sessionOrRequest:
      | string
      | {
          sessionId: string;
          annotationId: string;
          expectedVersion?: string;
          version?: string;
        },
    maybeAnnotationId?: string,
    maybeVersion?: string,
  ): Promise<boolean> {
    const request =
      typeof sessionOrRequest === "string"
        ? {
            sessionId: sessionOrRequest,
            annotationId: maybeAnnotationId!,
            expectedVersion: maybeVersion,
          }
        : sessionOrRequest;
    return this.enqueue(request.sessionId, () =>
      this.repository.delete(
        request.sessionId,
        request.annotationId,
        request.expectedVersion ?? request.version,
      ),
    );
  }

  async reorder(
    sessionId: string,
    annotationIds: string[],
    expectedVersion?: string,
  ): Promise<readonly AnnotationRecord[]>;
  async reorder(request: {
    sessionId: string;
    annotationIds: string[];
    expectedVersion?: string;
    version?: string;
  }): Promise<readonly AnnotationRecord[]>;
  async reorder(
    sessionOrRequest:
      | string
      | {
          sessionId: string;
          annotationIds: string[];
          expectedVersion?: string;
          version?: string;
        },
    maybeIds?: string[],
    maybeVersion?: string,
  ): Promise<readonly AnnotationRecord[]> {
    const request =
      typeof sessionOrRequest === "string"
        ? {
            sessionId: sessionOrRequest,
            annotationIds: maybeIds!,
            expectedVersion: maybeVersion,
          }
        : sessionOrRequest;
    return this.enqueue(request.sessionId, () =>
      this.repository.reorder(
        request.sessionId,
        request.annotationIds,
        request.expectedVersion ?? request.version,
      ),
    );
  }

  async prepare(
    sessionId: string,
    request?: Omit<PrepareAnnotationRequest, "sessionId">,
  ): Promise<PreparedAnnotationBatch>;
  async prepare(
    request: PrepareAnnotationRequest,
  ): Promise<PreparedAnnotationBatch>;
  async prepare(
    sessionOrRequest: string | PrepareAnnotationRequest,
    maybeRequest: Omit<PrepareAnnotationRequest, "sessionId"> = {},
  ): Promise<PreparedAnnotationBatch> {
    const request: PrepareAnnotationRequest =
      typeof sessionOrRequest === "string"
        ? { ...maybeRequest, sessionId: sessionOrRequest }
        : sessionOrRequest;
    const requestedIds = request.annotationIds?.join("\u0001") ?? "";
    const prepareKey = `${request.sessionId}\u0000${request.body ?? ""}\u0000${request.batchId ?? ""}\u0000${requestedIds}`;
    const existing = this.prepares.get(prepareKey);
    if (existing) return existing;
    const operation = this.enqueue(request.sessionId, async () => {
      const snapshot = await this.repository.listSnapshot(request.sessionId);
      if (!snapshot)
        throw new RepositoryError(
          "not-found",
          `Unknown session: ${request.sessionId}.`,
          { sessionId: request.sessionId },
        );
      const selectedIds = request.annotationIds;
      if (
        selectedIds !== undefined &&
        (selectedIds.length === 0 ||
          new Set(selectedIds).size !== selectedIds.length)
      ) {
        throw new AnnotationServiceError(
          "invalid-input",
          "A file chip must identify one or more unique annotations.",
          { annotationIds: selectedIds },
        );
      }
      const byId = new Map(snapshot.annotations.map((item) => [item.id, item]));
      const selected = selectedIds
        ? selectedIds.map((id) => {
            const annotation = byId.get(id);
            if (!annotation)
              throw new AnnotationServiceError(
                "target-not-found",
                `Unknown annotation: ${id}.`,
                { sessionId: request.sessionId, annotationId: id },
              );
            return annotation;
          })
        : snapshot.annotations
            .filter((annotation) => annotation.status === "pending")
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const matchingActive = selectedIds
        ? Object.values(snapshot.batches).find(
            (batch) =>
              batch.terminalOutcome !== "definite-failure" &&
              sameAnnotationIds(batch.annotationIds, selectedIds) &&
              (batch.status === "prepared" ||
                batch.status === "unknown" ||
                batch.status === "sent"),
          )
        : undefined;
      if (matchingActive) return cloneBatchWithMarker(matchingActive);
      const pending = selected.filter(
        (annotation) => annotation.status === "pending",
      );
      if (pending.length !== selected.length) {
        throw new AnnotationServiceError(
          "invalid-input",
          "Only pending annotations can be prepared.",
          { annotationIds: selected.map((annotation) => annotation.id) },
        );
      }
      if (pending.length === 0) {
        const active = Object.values(snapshot.batches).find(
          (batch) =>
            batch.terminalOutcome !== "definite-failure" &&
            (batch.status === "prepared" ||
              batch.status === "unknown" ||
              batch.status === "sent"),
        );
        if (active) {
          if (
            request.batchId !== undefined &&
            request.batchId !== active.batchId
          ) {
            throw new AnnotationServiceError(
              "prepare-conflict",
              "The requested batch id conflicts with the active batch.",
              { batchId: request.batchId, activeBatchId: active.batchId },
            );
          }
          if (request.body !== undefined) {
            const activeAnnotations = snapshot.annotations.filter(
              (annotation) => active.annotationIds.includes(annotation.id),
            );
            const expected = serializeAnnotationBatch({
              batchId: active.batchId,
              annotations: [...activeAnnotations],
              body: request.body,
            });
            if (cloneBatchWithMarker(active).markdown !== expected) {
              throw new AnnotationServiceError(
                "prepare-conflict",
                "The requested body conflicts with the active batch.",
                { batchId: active.batchId },
              );
            }
          }
          return cloneBatchWithMarker(active);
        }
        throw new AnnotationServiceError(
          "invalid-input",
          "There are no pending annotations to prepare.",
        );
      }
      // AnnotationRepository mints the authoritative id. The provisional id
      // is only used to make a deterministic request body; normalize the
      // returned Markdown to the repository's id before crossing this API.
      const serializationId = request.batchId ?? this.uuid();
      const markdown = serializeAnnotationBatch({
        batchId: serializationId,
        annotations: pending,
        body: request.body,
      });
      const batch = await this.repository.prepare(request.sessionId, {
        annotationIds: pending.map((annotation) => annotation.id),
        markdown,
        batchId: request.batchId,
      });
      return cloneBatchWithMarker(batch);
    });
    this.prepares.set(prepareKey, operation);
    void operation.then(
      () => {
        if (this.prepares.get(prepareKey) === operation)
          this.prepares.delete(prepareKey);
      },
      () => {
        if (this.prepares.get(prepareKey) === operation)
          this.prepares.delete(prepareKey);
      },
    );
    return operation;
  }

  async settle(
    request: SettleAnnotationRequest,
  ): Promise<AnnotationBatchRecord>;
  async settle(
    sessionId: string,
    batchId: string,
    outcome: SettleAnnotationRequest["outcome"],
    receiptId?: string,
  ): Promise<AnnotationBatchRecord>;
  async settle(
    sessionOrRequest: string | SettleAnnotationRequest,
    maybeBatchId?: string,
    maybeOutcome?: SettleAnnotationRequest["outcome"],
    maybeReceiptId?: string,
  ): Promise<AnnotationBatchRecord> {
    const request: SettleAnnotationRequest =
      typeof sessionOrRequest === "string"
        ? {
            sessionId: sessionOrRequest,
            batchId: maybeBatchId!,
            outcome: maybeOutcome!,
            receiptId: maybeReceiptId,
          }
        : sessionOrRequest;
    if (request.outcome === "accepted") {
      const confirmed = await this.confirm({
        sessionId: request.sessionId,
        batchId: request.batchId,
      });
      if (confirmed === undefined) {
        throw new AnnotationServiceError(
          "durable-marker-missing",
          "The batch marker is not durable yet.",
          { batchId: request.batchId },
        );
      }
      return confirmed;
    }
    return this.enqueue(request.sessionId, async () => {
      if (request.outcome === "definite-failure") {
        assertNonBlank(request.receiptId ?? "", "receiptId");
      }
      return this.repository.mark(request.sessionId, {
        batchId: request.batchId,
        outcome: request.outcome,
        receiptId: request.receiptId,
        reason: request.reason,
        occurredAt: request.occurredAt,
      });
    });
  }

  async reconcile(
    request: ReconcileAnnotationRequest,
  ): Promise<AnnotationBatchRecord | undefined>;
  async reconcile(
    sessionId: string,
    batchId: string,
  ): Promise<AnnotationBatchRecord | undefined>;
  async reconcile(
    sessionOrRequest: string | ReconcileAnnotationRequest,
    maybeBatchId?: string,
  ): Promise<AnnotationBatchRecord | undefined> {
    const request: ReconcileAnnotationRequest =
      typeof sessionOrRequest === "string"
        ? { sessionId: sessionOrRequest, batchId: maybeBatchId! }
        : sessionOrRequest;
    const snapshot = await this.repository.listSnapshot(request.sessionId);
    const batch = snapshot?.batches[request.batchId];
    if (batch?.status === "sent") return batch;
    if (!batch) {
      throw new RepositoryError(
        "not-found",
        `Unknown batch: ${request.batchId}.`,
        { sessionId: request.sessionId, batchId: request.batchId },
      );
    }
    const live = this.sessions.get(request.sessionId);
    if (!live) {
      throw new AnnotationServiceError(
        "live-session-not-found",
        `Live session is not available: ${request.sessionId}.`,
        { sessionId: request.sessionId, batchId: request.batchId },
      );
    }
    let flushed: boolean;
    try {
      flushed = await this.sessions.flush(live);
    } catch (error) {
      throw new AnnotationServiceError(
        "flush-failed",
        `Unable to flush live session: ${request.sessionId}.`,
        {
          sessionId: request.sessionId,
          batchId: request.batchId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (!flushed) {
      throw new AnnotationServiceError(
        "flush-failed",
        `Unable to flush live session: ${request.sessionId}.`,
        { sessionId: request.sessionId, batchId: request.batchId },
      );
    }
    const events = await this.durableEvents(request.sessionId);
    if (!hasDurableMarker(events, formatBatchMarker(request.batchId)))
      return undefined;
    const confirmed = await this.enqueue(request.sessionId, () =>
      this.repository.confirm(request.sessionId, {
        batchId: request.batchId,
        sentAt: request.sentAt ?? this.now(),
        scannedAt: request.scannedAt ?? this.now(),
      }),
    );
    await this.projectHistory(request.sessionId);
    return confirmed;
  }

  private async projectHistory(sessionId: string): Promise<void> {
    if (!this.history) return;
    try {
      const inspected = await this.sessionPersistence.inspect(sessionId);
      if (inspected.meta?.id !== sessionId) return;
      const snapshot = await this.repository.listSnapshot(sessionId);
      if (!snapshot) return;
      await this.history.project({
        sessionId,
        cwd: inspected.meta?.cwd,
        batches: Object.values(snapshot.batches),
      });
    } catch {
      // Markdown is a user-facing projection. A filesystem conflict or an
      // unavailable workspace must not turn an already durable send into a
      // retryable business failure.
    }
  }

  async confirm(
    request: ReconcileAnnotationRequest,
  ): Promise<AnnotationBatchRecord | undefined>;
  async confirm(
    sessionId: string,
    batchId: string,
  ): Promise<AnnotationBatchRecord | undefined>;
  async confirm(
    sessionOrRequest: string | ReconcileAnnotationRequest,
    maybeBatchId?: string,
  ): Promise<AnnotationBatchRecord | undefined> {
    return typeof sessionOrRequest === "string"
      ? this.reconcile(sessionOrRequest, maybeBatchId!)
      : this.reconcile(sessionOrRequest);
  }
}

export default AnnotationService;
