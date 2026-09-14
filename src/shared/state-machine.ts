import type {
  AnnotationBatchRecord,
  AnnotationMachineState,
  AnnotationRecord,
} from "./types.js";

export type AnnotationMachineAction =
  | {
      type: "prepare";
      batchId: string;
      annotationIds: string[];
      markdown: string;
      preparedAt: string;
    }
  | {
      type: "mark-unknown";
      batchId: string;
      occurredAt: string;
      reason: string;
    }
  | {
      type: "confirm-sent";
      batchId: string;
      sentAt: string;
    }
  | {
      type: "record-definite-failure";
      batchId: string;
      receiptId: string;
      occurredAt: string;
    }
  | {
      type: "reconcile-log";
      batchId: string;
      found: boolean;
      scannedAt: string;
      sentAt?: string;
    };

function cloneAnnotation(annotation: AnnotationRecord): AnnotationRecord {
  return {
    ...annotation,
    anchor: {
      ...annotation.anchor,
      blockPath: [...annotation.anchor.blockPath],
    },
  };
}

function cloneBatch(batch: AnnotationBatchRecord): AnnotationBatchRecord {
  return {
    ...batch,
    annotationIds: [...batch.annotationIds],
  };
}

function cloneState(state: AnnotationMachineState): AnnotationMachineState {
  return {
    annotations: state.annotations.map(cloneAnnotation),
    batches: Object.fromEntries(
      Object.entries(state.batches).map(([batchId, batch]) => [
        batchId,
        cloneBatch(batch),
      ]),
    ),
  };
}

function getBatchOrThrow(
  state: AnnotationMachineState,
  batchId: string,
): AnnotationBatchRecord {
  const batch = state.batches[batchId];
  if (!batch) {
    throw new Error(`Unknown batch: ${batchId}`);
  }

  return batch;
}

function getAnnotationsByBatch(
  state: AnnotationMachineState,
  batchId: string,
): AnnotationRecord[] {
  return state.annotations.filter(
    (annotation: AnnotationRecord) => annotation.batchId === batchId,
  );
}

function ensureUniqueAnnotationIds(annotationIds: string[]): void {
  const seen = new Set<string>();
  for (const annotationId of annotationIds) {
    if (seen.has(annotationId)) {
      throw new Error(
        `Duplicate annotation id in batch preparation: ${annotationId}`,
      );
    }
    seen.add(annotationId);
  }
}

function sameAnnotationIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((annotationId, index) => annotationId === right[index])
  );
}

export function createAnnotationMachineState(
  annotations: AnnotationRecord[],
): AnnotationMachineState {
  return {
    annotations: annotations.map(cloneAnnotation),
    batches: {},
  };
}

export function reduceAnnotationMachine(
  state: AnnotationMachineState,
  action: AnnotationMachineAction,
): AnnotationMachineState {
  switch (action.type) {
    case "prepare": {
      ensureUniqueAnnotationIds(action.annotationIds);

      const next = cloneState(state);
      const annotationIds = new Set(action.annotationIds);

      if (annotationIds.size === 0) {
        throw new Error("Cannot prepare an empty annotation batch.");
      }

      const existingBatch = next.batches[action.batchId];
      if (existingBatch) {
        if (existingBatch.terminalOutcome === "definite-failure") {
          throw new Error(
            `Batch ${action.batchId} already has a definite failure and cannot be reused.`,
          );
        }

        if (
          existingBatch.status !== "prepared" &&
          existingBatch.status !== "unknown" &&
          existingBatch.status !== "sent"
        ) {
          throw new Error(
            `Batch ${action.batchId} cannot be prepared from ${existingBatch.status}.`,
          );
        }

        if (
          sameAnnotationIds(
            existingBatch.annotationIds,
            action.annotationIds,
          ) &&
          existingBatch.markdown === action.markdown
        ) {
          return next;
        }

        throw new Error(
          `Batch ${action.batchId} preparation conflict: existing members or markdown differ.`,
        );
      }

      for (const annotationId of annotationIds) {
        const annotation = next.annotations.find(
          (candidate: AnnotationRecord) => candidate.id === annotationId,
        );
        if (!annotation) {
          throw new Error(`Unknown annotation: ${annotationId}`);
        }

        if (annotation.status === "unknown") {
          throw new Error(
            `Cannot re-prepare unknown annotation ${annotationId}.`,
          );
        }

        if (annotation.status !== "pending") {
          throw new Error(
            `Only pending annotations can be prepared: ${annotationId}.`,
          );
        }
      }

      for (const annotation of next.annotations) {
        if (!annotationIds.has(annotation.id)) {
          continue;
        }

        annotation.status = "prepared";
        annotation.batchId = action.batchId;
        annotation.sentAt = undefined;
        annotation.updatedAt = action.preparedAt;
      }

      next.batches[action.batchId] = {
        batchId: action.batchId,
        annotationIds: action.annotationIds.slice(),
        markdown: action.markdown,
        status: "prepared",
        preparedAt: action.preparedAt,
        updatedAt: action.preparedAt,
      };

      return next;
    }

    case "mark-unknown": {
      const next = cloneState(state);
      const batch = getBatchOrThrow(next, action.batchId);

      if (batch.status === "sent") {
        return next;
      }

      if (batch.status !== "prepared" && batch.status !== "unknown") {
        throw new Error(
          `Batch ${action.batchId} cannot become unknown from ${batch.status}.`,
        );
      }

      batch.status = "unknown";
      batch.unknownReason = action.reason;
      batch.updatedAt = action.occurredAt;

      for (const annotation of getAnnotationsByBatch(next, action.batchId)) {
        if (
          annotation.status === "prepared" ||
          annotation.status === "unknown"
        ) {
          annotation.status = "unknown";
          annotation.updatedAt = action.occurredAt;
        }
      }

      return next;
    }

    case "confirm-sent": {
      const next = cloneState(state);
      const batch = getBatchOrThrow(next, action.batchId);

      if (batch.status === "sent") {
        return next;
      }

      if (batch.status !== "prepared" && batch.status !== "unknown") {
        throw new Error(
          `Batch ${action.batchId} cannot be confirmed from ${batch.status}.`,
        );
      }

      batch.status = "sent";
      batch.sentAt = action.sentAt;
      batch.updatedAt = action.sentAt;

      for (const annotation of getAnnotationsByBatch(next, action.batchId)) {
        annotation.status = "sent";
        annotation.batchId = action.batchId;
        annotation.sentAt = action.sentAt;
        annotation.updatedAt = action.sentAt;
      }

      return next;
    }

    case "record-definite-failure": {
      const next = cloneState(state);
      const batch = getBatchOrThrow(next, action.batchId);

      if (batch.status === "sent") {
        throw new Error(`Cannot roll back sent batch ${action.batchId}.`);
      }

      if (batch.status !== "prepared" && batch.status !== "unknown") {
        throw new Error(
          `Batch ${action.batchId} cannot fail from ${batch.status}.`,
        );
      }

      for (const annotation of getAnnotationsByBatch(next, action.batchId)) {
        annotation.status = "pending";
        annotation.batchId = undefined;
        annotation.sentAt = undefined;
        annotation.updatedAt = action.occurredAt;
      }

      // Keep the batch record as a tombstone. The annotations are released
      // for a new batch, while the old correlation remains available for a
      // durable marker that arrives after the failure receipt.
      batch.status = "unknown";
      batch.terminalOutcome = "definite-failure";
      batch.failureReceiptId = action.receiptId;
      batch.failedAt = action.occurredAt;
      batch.updatedAt = action.occurredAt;

      return next;
    }

    case "reconcile-log": {
      if (!action.found) {
        return state;
      }

      if (!action.sentAt) {
        throw new Error(
          `Reconciled batch ${action.batchId} requires a sentAt timestamp.`,
        );
      }

      const confirmed = reduceAnnotationMachine(state, {
        type: "confirm-sent",
        batchId: action.batchId,
        sentAt: action.sentAt,
      });
      const next = cloneState(confirmed);
      const batch = getBatchOrThrow(next, action.batchId);
      batch.scannedAt = action.scannedAt;
      batch.updatedAt = action.scannedAt;
      return next;
    }

    /* c8 ignore next 3 */
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
