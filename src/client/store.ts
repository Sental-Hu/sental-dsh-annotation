import { AnnotationApiError, type AnnotationApiClient } from "./api.js";
import type {
  AnnotationCreateInput,
  AnnotationUpdateInput,
} from "../repository.js";
import type { AnnotationRecord, TextAnchor } from "../shared/types.js";

export interface AnnotationStoreApi {
  list(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly AnnotationRecord[]>;
  snapshot?(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly revision: string;
    readonly annotations: readonly AnnotationRecord[];
    readonly batches?: Readonly<Record<string, unknown>>;
  }>;
  create(
    input: {
      sessionId: string;
      messageId: string;
      anchor: TextAnchor;
      quote: string;
      comment: string;
      order: number;
      version?: string;
    },
    signal?: AbortSignal,
  ): Promise<AnnotationRecord>;
  update(
    sessionId: string,
    annotationId: string,
    patch: {
      version: string;
      comment?: string;
      anchor?: TextAnchor;
      quote?: string;
      order?: number;
    },
    signal?: AbortSignal,
  ): Promise<AnnotationRecord>;
  delete(
    sessionId: string,
    annotationId: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  reorder(
    sessionId: string,
    annotationIds: string[],
    version: string,
    signal?: AbortSignal,
  ): Promise<readonly AnnotationRecord[]>;
}

export type AnnotationStoreStatus = "idle" | "loading" | "ready" | "error";

export interface AnnotationStoreSnapshot {
  readonly sessionId: string;
  readonly status: AnnotationStoreStatus;
  readonly annotations: readonly AnnotationRecord[];
  readonly revision?: string;
  readonly error?: Error;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === "object") frozen(child);
    }
    Object.freeze(value);
  }
  return value;
}
function isConflict(error: unknown): boolean {
  return error instanceof AnnotationApiError
    ? error.code === "conflict"
    : error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "conflict";
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Per-session Browser state with optimistic mutations and CAS recovery. */
export class AnnotationStore {
  private sessionId: string;
  private snapshot: AnnotationStoreSnapshot;
  private readonly listeners = new Set<() => void>();
  private requestController: AbortController | undefined;

  constructor(
    private readonly api: AnnotationStoreApi | AnnotationApiClient,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
    this.snapshot = {
      sessionId,
      status: "idle",
      annotations: frozen([] as readonly AnnotationRecord[]),
    };
  }

  getSnapshot(): AnnotationStoreSnapshot {
    return this.snapshot;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSession(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.requestController?.abort();
    this.requestController = undefined;
    this.sessionId = sessionId;
    this.setSnapshot({
      sessionId,
      status: "idle",
      annotations: frozen([] as readonly AnnotationRecord[]),
    });
  }

  async load(): Promise<readonly AnnotationRecord[]> {
    const sessionId = this.sessionId;
    const controller = this.beginRequest();
    this.setSnapshot({
      ...this.snapshot,
      sessionId,
      status: "loading",
      error: undefined,
    });
    try {
      const loaded = this.api.snapshot
        ? await this.api.snapshot(sessionId, controller.signal)
        : await this.api.list(sessionId, controller.signal);
      if (sessionId !== this.sessionId || controller.signal.aborted)
        return this.snapshot.annotations;
      const snapshotLoaded = loaded as
        | {
            readonly revision?: string;
            readonly annotations: readonly AnnotationRecord[];
          }
        | readonly AnnotationRecord[];
      const isSnapshot =
        typeof snapshotLoaded === "object" &&
        !Array.isArray(snapshotLoaded) &&
        "annotations" in snapshotLoaded;
      const annotationSource = isSnapshot
        ? snapshotLoaded.annotations
        : snapshotLoaded;
      const revision = isSnapshot ? snapshotLoaded.revision : undefined;
      const annotations = frozen(clone(annotationSource));
      this.setSnapshot({
        sessionId,
        status: "ready",
        annotations,
        ...(revision === undefined ? {} : { revision }),
      });
      return annotations;
    } catch (error) {
      if (sessionId !== this.sessionId || controller.signal.aborted)
        return this.snapshot.annotations;
      this.setSnapshot({
        ...this.snapshot,
        status: "error",
        error: asError(error),
      });
      throw error;
    } finally {
      if (this.requestController === controller)
        this.requestController = undefined;
    }
  }

  async create(
    input: Omit<AnnotationCreateInput, "sessionId">,
  ): Promise<AnnotationRecord | undefined> {
    if (!input.comment.trim()) return undefined;
    const sessionId = this.sessionId;
    const controller = this.beginRequest();
    const previous = this.snapshot;
    const now = new Date().toISOString();
    const optimistic: AnnotationRecord = {
      id: `client-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sessionId,
      status: "pending",
      messageId: input.messageId,
      anchor: clone(input.anchor),
      quote: input.quote,
      comment: input.comment,
      color: input.color ?? "amber",
      order: input.order,
      version: input.version ?? "0",
      createdAt: now,
      updatedAt: now,
    };
    this.setSnapshot({
      ...previous,
      sessionId,
      status: "ready",
      annotations: frozen([...previous.annotations, optimistic]),
    });
    try {
      const created = await this.api.create(
        { ...input, sessionId },
        controller.signal,
      );
      if (sessionId !== this.sessionId || controller.signal.aborted)
        return undefined;
      await this.refreshRevision(sessionId, controller.signal);
      this.setSnapshot({
        ...this.snapshot,
        status: "ready",
        annotations: frozen(
          clone(
            this.snapshot.annotations.map((item) =>
              item.id === optimistic.id ? created : item,
            ),
          ),
        ),
      });
      return created;
    } catch (error) {
      if (sessionId === this.sessionId && !controller.signal.aborted)
        this.setSnapshot(previous);
      throw error;
    } finally {
      if (this.requestController === controller)
        this.requestController = undefined;
    }
  }

  async update(
    annotationId: string,
    patch: AnnotationUpdateInput,
  ): Promise<AnnotationRecord> {
    const current = this.snapshot.annotations.find(
      (item) => item.id === annotationId,
    );
    if (!current)
      throw new AnnotationApiError(
        "not-found",
        `Unknown annotation: ${annotationId}.`,
      );
    const version = patch.expectedVersion ?? patch.version ?? current.version;
    const sessionId = this.sessionId;
    const controller = this.beginRequest();
    const previous = this.snapshot;
    const optimistic = {
      ...current,
      ...(patch.comment === undefined ? {} : { comment: patch.comment }),
      ...(patch.anchor === undefined ? {} : { anchor: clone(patch.anchor) }),
      ...(patch.quote === undefined ? {} : { quote: patch.quote }),
      ...(patch.order === undefined ? {} : { order: patch.order }),
      version,
      color: current.color,
      updatedAt: new Date().toISOString(),
    };
    this.setSnapshot({
      ...previous,
      annotations: frozen(
        previous.annotations.map((item) =>
          item.id === annotationId ? optimistic : item,
        ),
      ),
    });
    try {
      const updated = await this.api.update(
        sessionId,
        annotationId,
        {
          version,
          comment: patch.comment,
          anchor: patch.anchor,
          quote: patch.quote,
          order: patch.order,
        },
        controller.signal,
      );
      if (sessionId === this.sessionId && !controller.signal.aborted)
        this.setSnapshot({
          ...this.snapshot,
          status: "ready",
          annotations: frozen(
            this.snapshot.annotations.map((item) =>
              item.id === annotationId ? updated : item,
            ),
          ),
        });
      await this.refreshRevision(sessionId, controller.signal);
      return updated;
    } catch (error) {
      if (sessionId === this.sessionId && !controller.signal.aborted) {
        this.setSnapshot(previous);
        if (isConflict(error)) void this.load();
      }
      throw error;
    } finally {
      if (this.requestController === controller)
        this.requestController = undefined;
    }
  }

  async delete(annotationId: string, version?: string): Promise<boolean> {
    const current = this.snapshot.annotations.find(
      (item) => item.id === annotationId,
    );
    if (!current)
      throw new AnnotationApiError(
        "not-found",
        `Unknown annotation: ${annotationId}.`,
      );
    const sessionId = this.sessionId;
    const controller = this.beginRequest();
    const previous = this.snapshot;
    this.setSnapshot({
      ...previous,
      annotations: frozen(
        previous.annotations.filter((item) => item.id !== annotationId),
      ),
    });
    try {
      const deleted = await this.api.delete(
        sessionId,
        annotationId,
        version ?? current.version,
        controller.signal,
      );
      await this.refreshRevision(sessionId, controller.signal);
      return deleted;
    } catch (error) {
      if (sessionId === this.sessionId && !controller.signal.aborted) {
        this.setSnapshot(previous);
        if (isConflict(error)) void this.load();
      }
      throw error;
    } finally {
      if (this.requestController === controller)
        this.requestController = undefined;
    }
  }

  async reorder(
    annotationIds: string[],
    version: string,
  ): Promise<readonly AnnotationRecord[]> {
    const sessionId = this.sessionId;
    const controller = this.beginRequest();
    const previous = this.snapshot;
    const rank = new Map(annotationIds.map((id, index) => [id, index]));
    this.setSnapshot({
      ...previous,
      annotations: frozen(
        previous.annotations.map((item) => ({
          ...item,
          order: rank.get(item.id) ?? item.order,
        })),
      ),
    });
    try {
      const updated = await this.api.reorder(
        sessionId,
        annotationIds,
        version,
        controller.signal,
      );
      if (sessionId === this.sessionId && !controller.signal.aborted)
        this.setSnapshot({
          ...this.snapshot,
          status: "ready",
          annotations: frozen(clone(updated)),
        });
      await this.refreshRevision(sessionId, controller.signal);
      return updated;
    } catch (error) {
      if (sessionId === this.sessionId && !controller.signal.aborted) {
        this.setSnapshot(previous);
        if (isConflict(error)) void this.load();
      }
      throw error;
    } finally {
      if (this.requestController === controller)
        this.requestController = undefined;
    }
  }

  private beginRequest(): AbortController {
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    return controller;
  }

  private async refreshRevision(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.api.snapshot) return;
    try {
      const latest = await this.api.snapshot(sessionId, signal);
      if (sessionId !== this.sessionId || signal.aborted) return;
      this.setSnapshot({
        ...this.snapshot,
        revision: latest.revision,
        annotations: frozen(clone(latest.annotations)),
      });
    } catch {
      // The mutation already succeeded; a later load will recover the CAS ref.
    }
  }
  private setSnapshot(snapshot: AnnotationStoreSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export default AnnotationStore;
