import { randomUUID } from "node:crypto";

import type { KvTable } from "@deepseek-ai/dsh-storage-domain";

import {
  STORAGE_SCHEMA_VERSION,
  sessionSnapshotSchema,
  type SessionSnapshot,
} from "./domain.js";
import type {
  AnnotationBatchRecord,
  AnnotationColor,
  AnnotationRecord,
  AnnotationStatus,
  TextAnchor,
} from "./shared/types.js";

export const DEFAULT_REPOSITORY_LIMITS = {
  maxCommentBytes: 16 * 1024,
  maxQuoteBytes: 32 * 1024,
  maxAnnotationsPerSession: 100,
  maxBatchSize: 50,
} as const;

export interface RepositoryLimits {
  maxCommentBytes: number;
  maxQuoteBytes: number;
  maxAnnotationsPerSession: number;
  maxBatchSize: number;
}

export type RepositoryErrorCode =
  | "invalid-input"
  | "not-found"
  | "conflict"
  | "limit-exceeded"
  | "batch-conflict"
  | "invalid-state"
  | "storage-error";

export interface RepositoryErrorDetails {
  sessionId?: string;
  annotationId?: string;
  batchId?: string;
  expectedVersion?: string;
  actualVersion?: string;
  limit?: number;
  actual?: number;
  field?: string;
  [key: string]: unknown;
}

/** Errors are intentionally JSON-safe so the HTTP layer can expose them. */
export class RepositoryError extends Error {
  readonly name = "RepositoryError";
  readonly code: RepositoryErrorCode;
  readonly details: RepositoryErrorDetails;

  constructor(
    code: RepositoryErrorCode,
    message: string,
    details: RepositoryErrorDetails = {},
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toJSON(): {
    code: RepositoryErrorCode;
    message: string;
    details: RepositoryErrorDetails;
  } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export interface RepositoryOptions {
  limits?: Partial<RepositoryLimits>;
  now?: () => string;
  uuid?: () => string;
}

export interface AnnotationCreateInput {
  sessionId?: string;
  id?: string;
  status?: AnnotationStatus;
  messageId: string;
  anchor: TextAnchor;
  quote: string;
  comment: string;
  color?: AnnotationColor;
  order: number;
  batchId?: string;
  version?: string;
  createdAt?: string;
  updatedAt?: string;
  sentAt?: string;
}

export interface AnnotationUpdateInput {
  comment?: string;
  anchor?: TextAnchor;
  quote?: string;
  order?: number;
  color?: AnnotationColor;
  messageId?: string;
  expectedVersion?: string;
  /** Alias used by the HTTP contract. */
  version?: string;
}

export interface PrepareInput {
  annotationIds: string[];
  markdown: string;
  batchId?: string;
  preparedAt?: string;
}

export interface MarkInput {
  batchId: string;
  reason?: string;
  occurredAt?: string;
  outcome?: "unknown" | "definite-failure" | "accepted";
  receiptId?: string;
}

export interface ConfirmInput {
  batchId: string;
  sentAt?: string;
  scannedAt?: string;
}

export interface RepositoryTable {
  sessions: KvTable<string, SessionSnapshot>;
}

type TableLike = KvTable<string, SessionSnapshot> | RepositoryTable;

function resolveTable(table: TableLike): KvTable<string, SessionSnapshot> {
  return "sessions" in table ? table.sessions : table;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cloneAnchor(anchor: TextAnchor): TextAnchor {
  return { ...anchor, blockPath: [...anchor.blockPath] };
}

function cloneAnnotation(annotation: AnnotationRecord): AnnotationRecord {
  return { ...annotation, anchor: cloneAnchor(annotation.anchor) };
}

function cloneBatch(batch: AnnotationBatchRecord): AnnotationBatchRecord {
  return { ...batch, annotationIds: [...batch.annotationIds] };
}

function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    annotations: snapshot.annotations.map(cloneAnnotation),
    batches: Object.fromEntries(
      Object.entries(snapshot.batches).map(([id, batch]) => [
        id,
        cloneBatch(batch),
      ]),
    ),
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RepositoryError(
      "invalid-input",
      `${field} must be a non-empty string.`,
      { field },
    );
  }
}

function assertLimit(value: number, limit: number, field: string): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RepositoryError(
      "invalid-input",
      `${field} limit must be a positive integer.`,
      { field },
    );
  }
  if (value > limit) {
    throw new RepositoryError(
      "limit-exceeded",
      `${field} exceeds the configured limit.`,
      {
        field,
        limit,
        actual: value,
      },
    );
  }
}

/**
 * Persistence boundary for annotation sidecars. Each session has an async
 * queue; every mutation in that queue performs one KvTable atomic update.
 */
export class AnnotationRepository {
  readonly limits: RepositoryLimits;
  private readonly table: KvTable<string, SessionSnapshot>;
  private readonly now: () => string;
  private readonly uuid: () => string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(table: TableLike, options: RepositoryOptions = {}) {
    this.table = resolveTable(table);
    this.limits = { ...DEFAULT_REPOSITORY_LIMITS, ...options.limits };
    this.now = options.now ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? randomUUID;
  }

  private enqueue<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertString(sessionId, "sessionId");
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(sessionId, current);
    // Do not attach `finally` without consuming its returned promise: a
    // rejected operation would otherwise create an unhandled rejection while
    // the caller is correctly handling the original promise.
    void current.then(
      () => {
        if (this.queues.get(sessionId) === current)
          this.queues.delete(sessionId);
      },
      () => {
        if (this.queues.get(sessionId) === current)
          this.queues.delete(sessionId);
      },
    );
    return current;
  }

  private normalize(sessionId: string, raw: SessionSnapshot): SessionSnapshot {
    try {
      const parsed = sessionSnapshotSchema.parse(raw);
      // The table key is the identity. This also repairs legacy records whose
      // annotation payload omitted sessionId, without trusting payload identity.
      return {
        ...parsed,
        annotations: parsed.annotations.map((annotation) => ({
          ...annotation,
          sessionId,
          anchor: cloneAnchor(annotation.anchor),
        })),
      };
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        "storage-error",
        `Invalid session record for ${sessionId}.`,
        {
          sessionId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private emptySnapshot(): SessionSnapshot {
    return {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      revision: "0",
      createdAt: this.now(),
      annotations: [],
      batches: {},
    };
  }

  private assertAnnotationMutable(annotation: AnnotationRecord): void {
    if (annotation.status === "prepared" || annotation.status === "unknown") {
      throw new RepositoryError(
        "invalid-state",
        `Annotation ${annotation.id} is locked by its prepared batch.`,
        { annotationId: annotation.id },
      );
    }
  }

  /**
   * A prepared annotation has not been durably sent yet, so the user may
   * withdraw it. Unknown remains locked because its delivery is ambiguous and
   * changing it could misrepresent a message that may already exist.
   */
  private assertAnnotationDeletable(annotation: AnnotationRecord): void {
    if (annotation.status === "unknown") {
      throw new RepositoryError(
        "invalid-state",
        `Annotation ${annotation.id} has an unknown delivery state.`,
        { annotationId: annotation.id },
      );
    }
  }

  private async updateSnapshot<T>(
    sessionId: string,
    fn: (snapshot: SessionSnapshot) => { snapshot: SessionSnapshot; result: T },
  ): Promise<T> {
    let result!: T;
    try {
      await this.table.update(sessionId, (stored) => {
        const normalized = this.normalize(sessionId, stored);
        const transformed = fn(cloneSnapshot(normalized));
        result = transformed.result;
        // A changed snapshot receives a Host-minted session revision. This is
        // the CAS token for operations spanning the whole annotation list.
        return JSON.stringify(transformed.snapshot) ===
          JSON.stringify(normalized)
          ? transformed.snapshot
          : { ...transformed.snapshot, revision: this.uuid() };
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        "storage-error",
        `Unable to update session ${sessionId}.`,
        {
          sessionId,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return result;
  }

  async ensureSession(
    sessionId: string,
    cwd?: string,
  ): Promise<SessionSnapshot> {
    return this.enqueue(sessionId, async () => {
      const existing = this.table.get(sessionId);
      if (existing)
        return freezeDeep(cloneSnapshot(this.normalize(sessionId, existing)));
      const snapshot = this.emptySnapshot();
      if (cwd !== undefined) snapshot.cwd = cwd;
      await this.table.put(sessionId, snapshot);
      return freezeDeep(cloneSnapshot(snapshot));
    });
  }

  async getSession(sessionId: string): Promise<SessionSnapshot | undefined> {
    return this.enqueue(sessionId, async () => {
      const stored = this.table.get(sessionId);
      return stored
        ? freezeDeep(cloneSnapshot(this.normalize(sessionId, stored)))
        : undefined;
    });
  }

  async list(sessionId: string): Promise<readonly AnnotationRecord[]> {
    return this.enqueue(sessionId, async () => {
      const stored = this.table.get(sessionId);
      if (!stored) return freezeDeep([] as AnnotationRecord[]);
      return freezeDeep(
        this.normalize(sessionId, stored)
          .annotations.slice()
          .sort(
            (left, right) =>
              left.order - right.order || left.id.localeCompare(right.id),
          )
          .map(cloneAnnotation),
      );
    });
  }

  async listSnapshot(sessionId: string): Promise<SessionSnapshot | undefined> {
    return this.getSession(sessionId);
  }

  async get(
    sessionId: string,
    annotationId: string,
  ): Promise<AnnotationRecord | undefined> {
    return this.enqueue(sessionId, async () => {
      const stored = this.table.get(sessionId);
      const annotation = stored
        ? this.normalize(sessionId, stored).annotations.find(
            ({ id }) => id === annotationId,
          )
        : undefined;
      return annotation ? freezeDeep(cloneAnnotation(annotation)) : undefined;
    });
  }

  /** Load the immutable session snapshot used by Host services. */
  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    return this.getSession(sessionId);
  }

  async create(
    sessionId: string,
    input: AnnotationCreateInput,
  ): Promise<AnnotationRecord>;
  async create(
    input: AnnotationCreateInput & { sessionId: string },
  ): Promise<AnnotationRecord>;
  async create(
    sessionOrInput: string | (AnnotationCreateInput & { sessionId: string }),
    maybeInput?: AnnotationCreateInput,
  ): Promise<AnnotationRecord> {
    const sessionId =
      typeof sessionOrInput === "string"
        ? sessionOrInput
        : sessionOrInput.sessionId;
    const input =
      typeof sessionOrInput === "string" ? maybeInput! : sessionOrInput;
    return this.enqueue(sessionId, async () => {
      assertString(input.messageId, "messageId");
      assertString(input.quote, "quote");
      assertString(input.comment, "comment");
      assertLimit(
        utf8Bytes(input.comment),
        this.limits.maxCommentBytes,
        "comment",
      );
      assertLimit(utf8Bytes(input.quote), this.limits.maxQuoteBytes, "quote");
      const stored = this.table.get(sessionId);
      if (!stored) {
        const initial = this.emptySnapshot();
        await this.table.put(sessionId, initial);
      }
      const result = await this.updateSnapshot(sessionId, (snapshot) => {
        assertLimit(
          snapshot.annotations.length + 1,
          this.limits.maxAnnotationsPerSession,
          "annotations",
        );
        const timestamp = this.now();
        const order =
          snapshot.annotations.reduce(
            (highest, annotation) => Math.max(highest, annotation.order),
            -1,
          ) + 1;
        const annotation: AnnotationRecord = {
          id: this.uuid(),
          sessionId,
          status: "pending",
          messageId: input.messageId,
          anchor: cloneAnchor(input.anchor),
          quote: input.quote,
          comment: input.comment,
          color: input.color ?? "amber",
          order,
          version: this.uuid(),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const next = {
          ...snapshot,
          annotations: [...snapshot.annotations, annotation],
        };
        return { snapshot: next, result: annotation };
      });
      return freezeDeep(cloneAnnotation(result));
    });
  }

  createAnnotation(
    sessionId: string,
    input: AnnotationCreateInput,
  ): Promise<AnnotationRecord>;
  createAnnotation(
    input: AnnotationCreateInput & { sessionId: string },
  ): Promise<AnnotationRecord>;
  createAnnotation(
    sessionOrInput: string | (AnnotationCreateInput & { sessionId: string }),
    maybeInput?: AnnotationCreateInput,
  ): Promise<AnnotationRecord> {
    return typeof sessionOrInput === "string"
      ? this.create(sessionOrInput, maybeInput!)
      : this.create(sessionOrInput);
  }

  async update(
    sessionId: string,
    annotationId: string,
    patch: AnnotationUpdateInput,
  ): Promise<AnnotationRecord>;
  async update(
    input: AnnotationUpdateInput & { sessionId: string; annotationId: string },
  ): Promise<AnnotationRecord>;
  async update(
    sessionOrInput:
      | string
      | (AnnotationUpdateInput & { sessionId: string; annotationId: string }),
    maybeAnnotationId?: string,
    maybePatch?: AnnotationUpdateInput,
  ): Promise<AnnotationRecord> {
    const sessionId =
      typeof sessionOrInput === "string"
        ? sessionOrInput
        : sessionOrInput.sessionId;
    const annotationId =
      typeof sessionOrInput === "string"
        ? maybeAnnotationId!
        : sessionOrInput.annotationId;
    const patch =
      typeof sessionOrInput === "string" ? maybePatch! : sessionOrInput;
    const expectedVersion = patch.expectedVersion ?? patch.version;
    if (expectedVersion === undefined) {
      return Promise.reject(
        new RepositoryError("invalid-input", "A version is required.", {
          field: "version",
        }),
      );
    }
    return this.enqueue(sessionId, async () => {
      if (patch.comment !== undefined) {
        assertString(patch.comment, "comment");
        assertLimit(
          utf8Bytes(patch.comment),
          this.limits.maxCommentBytes,
          "comment",
        );
      }
      if (patch.quote !== undefined) {
        assertString(patch.quote, "quote");
        assertLimit(utf8Bytes(patch.quote), this.limits.maxQuoteBytes, "quote");
      }
      const result = await this.updateSnapshot(sessionId, (snapshot) => {
        const index = snapshot.annotations.findIndex(
          ({ id }) => id === annotationId,
        );
        if (index < 0)
          throw new RepositoryError(
            "not-found",
            `Unknown annotation: ${annotationId}.`,
            { sessionId, annotationId },
          );
        const current = snapshot.annotations[index]!;
        const expected = expectedVersion;
        if (expected !== undefined && current.version !== expected) {
          throw new RepositoryError(
            "conflict",
            `Annotation ${annotationId} was changed by another writer.`,
            {
              sessionId,
              annotationId,
              expectedVersion: expected,
              actualVersion: current.version,
            },
          );
        }
        if (patch.color !== undefined && patch.color !== current.color) {
          throw new RepositoryError(
            "invalid-input",
            "Annotation colors are immutable.",
            {
              sessionId,
              annotationId,
              field: "color",
            },
          );
        }
        this.assertAnnotationMutable(current);
        if (patch.anchor !== undefined) {
          // Anchors have a quote alongside them; reject only clearly invalid input here.
          if (patch.anchor.end <= patch.anchor.start)
            throw new RepositoryError(
              "invalid-input",
              "anchor end must be greater than start.",
              { field: "anchor" },
            );
        }
        const nextAnnotation: AnnotationRecord = {
          ...current,
          ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
          ...(patch.anchor !== undefined
            ? { anchor: cloneAnchor(patch.anchor) }
            : {}),
          ...(patch.quote !== undefined ? { quote: patch.quote } : {}),
          ...(patch.order !== undefined ? { order: patch.order } : {}),
          color: current.color,
          ...(patch.messageId !== undefined
            ? { messageId: patch.messageId }
            : {}),
          version: this.uuid(),
          updatedAt: this.now(),
        };
        const annotations = [...snapshot.annotations];
        annotations[index] = nextAnnotation;
        return {
          snapshot: { ...snapshot, annotations },
          result: nextAnnotation,
        };
      });
      return freezeDeep(cloneAnnotation(result));
    });
  }

  updateAnnotation(
    sessionId: string,
    annotationId: string,
    patch: AnnotationUpdateInput,
  ): Promise<AnnotationRecord>;
  updateAnnotation(
    input: AnnotationUpdateInput & { sessionId: string; annotationId: string },
  ): Promise<AnnotationRecord>;
  updateAnnotation(
    sessionOrInput:
      | string
      | (AnnotationUpdateInput & { sessionId: string; annotationId: string }),
    maybeAnnotationId?: string,
    maybePatch?: AnnotationUpdateInput,
  ): Promise<AnnotationRecord> {
    return typeof sessionOrInput === "string"
      ? this.update(sessionOrInput, maybeAnnotationId!, maybePatch!)
      : this.update(sessionOrInput);
  }

  async delete(
    sessionId: string,
    annotationId: string,
    expectedVersion?: string,
  ): Promise<boolean>;
  async delete(input: {
    sessionId: string;
    annotationId: string;
    version?: string;
    expectedVersion?: string;
  }): Promise<boolean>;
  async delete(
    sessionOrInput:
      | string
      | {
          sessionId: string;
          annotationId: string;
          version?: string;
          expectedVersion?: string;
        },
    maybeAnnotationId?: string,
    maybeExpectedVersion?: string,
  ): Promise<boolean> {
    const sessionId =
      typeof sessionOrInput === "string"
        ? sessionOrInput
        : sessionOrInput.sessionId;
    const annotationId =
      typeof sessionOrInput === "string"
        ? maybeAnnotationId!
        : sessionOrInput.annotationId;
    const expected =
      typeof sessionOrInput === "string"
        ? maybeExpectedVersion
        : (sessionOrInput.expectedVersion ?? sessionOrInput.version);
    if (expected === undefined) {
      return Promise.reject(
        new RepositoryError("invalid-input", "A version is required.", {
          field: "version",
        }),
      );
    }
    return this.enqueue(sessionId, async () =>
      this.updateSnapshot(sessionId, (snapshot) => {
        const current = snapshot.annotations.find(
          ({ id }) => id === annotationId,
        );
        if (!current) return { snapshot, result: false };
        if (expected !== undefined && expected !== current.version) {
          throw new RepositoryError(
            "conflict",
            `Annotation ${annotationId} was changed by another writer.`,
            {
              sessionId,
              annotationId,
              expectedVersion: expected,
              actualVersion: current.version,
            },
          );
        }
        this.assertAnnotationDeletable(current);
        return {
          snapshot: {
            ...snapshot,
            annotations: snapshot.annotations.filter(
              ({ id }) => id !== annotationId,
            ),
          },
          result: true,
        };
      }),
    );
  }

  deleteAnnotation(
    sessionId: string,
    annotationId: string,
    expectedVersion?: string,
  ): Promise<boolean>;
  deleteAnnotation(input: {
    sessionId: string;
    annotationId: string;
    version?: string;
    expectedVersion?: string;
  }): Promise<boolean>;
  deleteAnnotation(
    sessionOrInput:
      | string
      | {
          sessionId: string;
          annotationId: string;
          version?: string;
          expectedVersion?: string;
        },
    maybeAnnotationId?: string,
    maybeExpectedVersion?: string,
  ): Promise<boolean> {
    return typeof sessionOrInput === "string"
      ? this.delete(sessionOrInput, maybeAnnotationId!, maybeExpectedVersion)
      : this.delete(sessionOrInput);
  }

  async reorder(
    sessionId: string,
    annotationIds: string[],
    expectedVersion?: string,
  ): Promise<readonly AnnotationRecord[]>;
  async reorder(input: {
    sessionId: string;
    annotationIds: string[];
    version?: string;
    expectedVersion?: string;
  }): Promise<readonly AnnotationRecord[]>;
  async reorder(
    sessionOrInput:
      | string
      | {
          sessionId: string;
          annotationIds: string[];
          version?: string;
          expectedVersion?: string;
        },
    maybeIds?: string[],
    maybeExpectedVersion?: string,
  ): Promise<readonly AnnotationRecord[]> {
    const sessionId =
      typeof sessionOrInput === "string"
        ? sessionOrInput
        : sessionOrInput.sessionId;
    const annotationIds =
      typeof sessionOrInput === "string"
        ? maybeIds!
        : sessionOrInput.annotationIds;
    const expected =
      typeof sessionOrInput === "string"
        ? maybeExpectedVersion
        : (sessionOrInput.expectedVersion ?? sessionOrInput.version);
    if (expected === undefined) {
      return Promise.reject(
        new RepositoryError("invalid-input", "A version is required.", {
          field: "version",
        }),
      );
    }
    return this.enqueue(sessionId, async () => {
      const result = await this.updateSnapshot(sessionId, (snapshot) => {
        const known = new Set(snapshot.annotations.map(({ id }) => id));
        if (
          new Set(annotationIds).size !== annotationIds.length ||
          annotationIds.some((id) => !known.has(id)) ||
          annotationIds.length !== snapshot.annotations.length
        ) {
          throw new RepositoryError(
            "invalid-input",
            "annotationIds must contain every annotation exactly once.",
            { field: "annotationIds" },
          );
        }
        for (const annotation of snapshot.annotations) {
          this.assertAnnotationMutable(annotation);
        }
        if (expected !== undefined && (snapshot.revision ?? "0") !== expected) {
          throw new RepositoryError(
            "conflict",
            "The annotation order is stale.",
            {
              sessionId,
              expectedVersion: expected,
              actualVersion: snapshot.revision ?? "0",
            },
          );
        }
        const rank = new Map(annotationIds.map((id, index) => [id, index]));
        const timestamp = this.now();
        const annotations = snapshot.annotations.map((annotation) => ({
          ...annotation,
          order: rank.get(annotation.id)!,
          version: this.uuid(),
          updatedAt: timestamp,
        }));
        return {
          snapshot: { ...snapshot, annotations },
          result: annotations,
        };
      });
      return freezeDeep(
        result
          .slice()
          .sort(
            (left, right) =>
              left.order - right.order || left.id.localeCompare(right.id),
          )
          .map(cloneAnnotation),
      );
    });
  }

  async prepare(
    sessionId: string,
    input: PrepareInput,
  ): Promise<AnnotationBatchRecord>;
  async prepare(
    input: PrepareInput & { sessionId: string },
  ): Promise<AnnotationBatchRecord>;
  async prepare(
    sessionOrInput: string | (PrepareInput & { sessionId: string }),
    maybeInput?: PrepareInput,
  ): Promise<AnnotationBatchRecord> {
    const sessionId =
      typeof sessionOrInput === "string"
        ? sessionOrInput
        : sessionOrInput.sessionId;
    const input =
      typeof sessionOrInput === "string" ? maybeInput! : sessionOrInput;
    return this.enqueue(sessionId, async () => {
      assertLimit(
        input.annotationIds.length,
        this.limits.maxBatchSize,
        "batch",
      );
      if (
        input.annotationIds.length === 0 ||
        new Set(input.annotationIds).size !== input.annotationIds.length
      )
        throw new RepositoryError(
          "invalid-input",
          "A batch must contain unique annotation ids.",
          { field: "annotationIds" },
        );
      const stored = this.table.get(sessionId);
      if (!stored)
        throw new RepositoryError(
          "not-found",
          `Unknown session: ${sessionId}.`,
          { sessionId },
        );
      const result = await this.updateSnapshot(sessionId, (snapshot) => {
        const requestedId = input.batchId;
        const active = Object.values(snapshot.batches).find(
          (batch) =>
            (batch.status === "prepared" ||
              batch.status === "unknown" ||
              batch.status === "sent") &&
            sameIds(batch.annotationIds, input.annotationIds) &&
            batch.markdown === input.markdown &&
            !batch.terminalOutcome &&
            (requestedId === undefined || batch.batchId === requestedId),
        );
        if (active) return { snapshot, result: active };
        if (requestedId && snapshot.batches[requestedId]) {
          const existing = snapshot.batches[requestedId]!;
          if (
            existing.markdown === input.markdown &&
            sameIds(existing.annotationIds, input.annotationIds) &&
            !existing.terminalOutcome
          )
            return { snapshot, result: existing };
          throw new RepositoryError(
            "batch-conflict",
            `Batch ${requestedId} preparation conflicts with the stored batch.`,
            { sessionId, batchId: requestedId },
          );
        }
        const selected = new Set(input.annotationIds);
        for (const annotationId of input.annotationIds) {
          const annotation = snapshot.annotations.find(
            ({ id }) => id === annotationId,
          );
          if (!annotation)
            throw new RepositoryError(
              "not-found",
              `Unknown annotation: ${annotationId}.`,
              { sessionId, annotationId },
            );
          if (annotation.status !== "pending")
            throw new RepositoryError(
              "invalid-state",
              `Only pending annotations can be prepared: ${annotationId}.`,
              { sessionId, annotationId },
            );
        }
        const batchId = this.uuid();
        const preparedAt = this.now();
        const annotations = snapshot.annotations.map((annotation) =>
          selected.has(annotation.id)
            ? {
                ...annotation,
                status: "prepared" as const,
                batchId,
                sentAt: undefined,
                version: this.uuid(),
                updatedAt: preparedAt,
              }
            : annotation,
        );
        const batch: AnnotationBatchRecord = {
          batchId,
          annotationIds: [...input.annotationIds],
          markdown: input.markdown,
          status: "prepared",
          preparedAt,
          updatedAt: preparedAt,
        };
        return {
          snapshot: {
            ...snapshot,
            annotations,
            batches: { ...snapshot.batches, [batchId]: batch },
          },
          result: batch,
        };
      });
      return freezeDeep(cloneBatch(result));
    });
  }

  async mark(
    sessionId: string,
    input: MarkInput,
  ): Promise<AnnotationBatchRecord>;
  async mark(
    input: MarkInput & { sessionId: string },
  ): Promise<AnnotationBatchRecord>;
  async mark(
    sessionOrInput: string | (MarkInput & { sessionId: string }),
    maybeInput?: MarkInput,
  ): Promise<AnnotationBatchRecord> {
    const sessionId =
      typeof sessionOrInput === "string"
        ? sessionOrInput
        : sessionOrInput.sessionId;
    const input =
      typeof sessionOrInput === "string" ? maybeInput! : sessionOrInput;
    return this.enqueue(sessionId, async () => {
      const result = await this.updateSnapshot(sessionId, (snapshot) => {
        const current = snapshot.batches[input.batchId];
        if (!current)
          throw new RepositoryError(
            "not-found",
            `Unknown batch: ${input.batchId}.`,
            { sessionId, batchId: input.batchId },
          );
        if (
          input.outcome === "definite-failure" &&
          (typeof input.receiptId !== "string" || !input.receiptId.trim())
        ) {
          throw new RepositoryError(
            "invalid-input",
            "A definite failure requires a non-empty receiptId.",
            { field: "receiptId", batchId: input.batchId },
          );
        }
        if (input.outcome === "accepted") return { snapshot, result: current };
        if (current.status === "sent") return { snapshot, result: current };
        const occurredAt = input.occurredAt ?? this.now();
        const definiteFailure = input.outcome === "definite-failure";
        const annotations = snapshot.annotations.map((annotation) => {
          if (annotation.batchId !== input.batchId) return annotation;
          if (annotation.status === "sent") return annotation;
          return definiteFailure
            ? {
                ...annotation,
                status: "pending" as const,
                batchId: undefined,
                sentAt: undefined,
                version: this.uuid(),
                updatedAt: occurredAt,
              }
            : {
                ...annotation,
                status: "unknown" as const,
                version: this.uuid(),
                updatedAt: occurredAt,
              };
        });
        const batch: AnnotationBatchRecord = {
          ...current,
          status: "unknown",
          updatedAt: occurredAt,
          ...(definiteFailure
            ? {
                terminalOutcome: "definite-failure" as const,
                failureReceiptId: input.receiptId,
                failedAt: occurredAt,
              }
            : { unknownReason: input.reason ?? "unknown" }),
        };
        return {
          snapshot: {
            ...snapshot,
            annotations,
            batches: { ...snapshot.batches, [input.batchId]: batch },
          },
          result: batch,
        };
      });
      return freezeDeep(cloneBatch(result));
    });
  }

  async markUnknown(
    sessionId: string,
    batchId: string,
    reason?: string,
    occurredAt?: string,
  ): Promise<AnnotationBatchRecord> {
    return this.mark(sessionId, {
      batchId,
      reason,
      occurredAt,
      outcome: "unknown",
    });
  }

  async confirm(
    sessionId: string,
    input: ConfirmInput,
  ): Promise<AnnotationBatchRecord>;
  async confirm(
    input: ConfirmInput & { sessionId: string },
  ): Promise<AnnotationBatchRecord>;
  async confirm(
    sessionOrInput: string | (ConfirmInput & { sessionId: string }),
    maybeInput?: ConfirmInput,
  ): Promise<AnnotationBatchRecord> {
    const sessionId =
      typeof sessionOrInput === "string"
        ? sessionOrInput
        : sessionOrInput.sessionId;
    const input =
      typeof sessionOrInput === "string" ? maybeInput! : sessionOrInput;
    return this.enqueue(sessionId, async () => {
      const result = await this.updateSnapshot(sessionId, (snapshot) => {
        const current = snapshot.batches[input.batchId];
        if (!current)
          throw new RepositoryError(
            "not-found",
            `Unknown batch: ${input.batchId}.`,
            { sessionId, batchId: input.batchId },
          );
        if (current.status === "sent") return { snapshot, result: current };
        if (current.status !== "prepared" && current.status !== "unknown")
          throw new RepositoryError(
            "invalid-state",
            `Batch ${input.batchId} cannot be confirmed from ${current.status}.`,
            { sessionId, batchId: input.batchId },
          );
        const sentAt = input.sentAt ?? this.now();
        const annotations = snapshot.annotations.map((annotation) =>
          annotation.batchId === input.batchId
            ? {
                ...annotation,
                status: "sent" as const,
                sentAt,
                version: this.uuid(),
                updatedAt: sentAt,
              }
            : annotation,
        );
        const batch: AnnotationBatchRecord = {
          ...current,
          status: "sent",
          sentAt,
          updatedAt: input.scannedAt ?? sentAt,
          ...(input.scannedAt ? { scannedAt: input.scannedAt } : {}),
        };
        return {
          snapshot: {
            ...snapshot,
            annotations,
            batches: { ...snapshot.batches, [input.batchId]: batch },
          },
          result: batch,
        };
      });
      return freezeDeep(cloneBatch(result));
    });
  }

  async settle(
    sessionId: string,
    input: MarkInput & { outcome: "accepted" | "unknown" | "definite-failure" },
  ): Promise<AnnotationBatchRecord> {
    if (input.outcome === "accepted")
      return this.confirm(sessionId, {
        batchId: input.batchId,
        sentAt: input.occurredAt,
      });
    return this.mark(sessionId, input);
  }
}

export function createAnnotationRepository(
  table: TableLike,
  options: RepositoryOptions = {},
): AnnotationRepository {
  return new AnnotationRepository(table, options);
}

export const createRepository = createAnnotationRepository;
