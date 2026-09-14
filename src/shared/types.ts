export const ANNOTATION_STATUSES = [
  "pending",
  "prepared",
  "unknown",
  "sent",
] as const;

export type AnnotationStatus = (typeof ANNOTATION_STATUSES)[number];

export const DEFAULT_ANNOTATION_PALETTE = [
  "amber",
  "green",
  "blue",
  "rose",
  "teal",
  "slate",
] as const;

export type AnnotationColor = (typeof DEFAULT_ANNOTATION_PALETTE)[number];

export interface HalfOpenRange {
  start: number;
  end: number;
}

export interface TextAnchor extends HalfOpenRange {
  blockPath: number[];
  prefix: string;
  suffix: string;
  quoteHash: string;
}

export interface AnnotationRecord {
  id: string;
  sessionId: string;
  status: AnnotationStatus;
  messageId: string;
  anchor: TextAnchor;
  quote: string;
  comment: string;
  color: AnnotationColor;
  order: number;
  batchId?: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export interface DisplayAnnotation extends AnnotationRecord {
  sequence: number;
}

export type RangeConflict =
  "none" | "duplicate" | "contains" | "contained" | "overlap";

export type RangeBoundaryIssue =
  | "negative-start"
  | "negative-end"
  | "empty"
  | "reversed"
  | "start-out-of-bounds"
  | "end-out-of-bounds"
  | "non-integer-start"
  | "non-integer-end";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface BatchParseResult {
  batchId: string;
  marker: string;
  start: number;
  end: number;
}

export interface AnnotationBatchRecord {
  batchId: string;
  annotationIds: string[];
  markdown: string;
  status: "prepared" | "unknown" | "sent";
  preparedAt: string;
  updatedAt: string;
  sentAt?: string;
  unknownReason?: string;
  scannedAt?: string;
  /**
   * A definite failure releases the annotations but not the batch
   * correlation. Keep this terminal outcome on the tombstone so a late
   * durable marker can still be reconciled without reusing the batch id.
   */
  terminalOutcome?: "definite-failure";
  failureReceiptId?: string;
  failedAt?: string;
}

export interface AnnotationMachineState {
  annotations: AnnotationRecord[];
  batches: Record<string, AnnotationBatchRecord>;
}
