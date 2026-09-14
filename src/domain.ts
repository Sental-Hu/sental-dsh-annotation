import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

import {
  ANNOTATION_STATUSES,
  DEFAULT_ANNOTATION_PALETTE,
  type AnnotationBatchRecord,
  type AnnotationRecord,
} from "./shared/types.js";

export const STORAGE_SCHEMA_VERSION = 1 as const;

const textAnchorSchema = z
  .object({
    blockPath: z.array(z.number().int().nonnegative()),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    prefix: z.string(),
    suffix: z.string(),
    quoteHash: z.string().min(1),
  })
  .strict()
  .refine((anchor) => anchor.end > anchor.start, {
    message: "end must be greater than start",
    path: ["end"],
  });

const annotationSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    status: z.enum(ANNOTATION_STATUSES),
    messageId: z.string().min(1),
    anchor: textAnchorSchema,
    quote: z.string(),
    comment: z.string(),
    color: z.enum(DEFAULT_ANNOTATION_PALETTE),
    order: z.number().finite(),
    batchId: z.string().min(1).optional(),
    version: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    sentAt: z.string().min(1).optional(),
  })
  .strict() satisfies z.ZodType<AnnotationRecord>;

const batchSchema = z
  .object({
    batchId: z.string().min(1),
    annotationIds: z.array(z.string().min(1)),
    markdown: z.string(),
    status: z.enum(["prepared", "unknown", "sent"]),
    preparedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    sentAt: z.string().min(1).optional(),
    unknownReason: z.string().min(1).optional(),
    scannedAt: z.string().min(1).optional(),
    terminalOutcome: z.literal("definite-failure").optional(),
    failureReceiptId: z.string().min(1).optional(),
    failedAt: z.string().min(1).optional(),
  })
  .strict() satisfies z.ZodType<AnnotationBatchRecord>;

export const sessionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
    revision: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    cwd: z.string().min(1).optional(),
    annotations: z.array(annotationSchema),
    batches: z.record(z.string().min(1), batchSchema),
  })
  .strict();

export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const storageDomain = defineDomain({
  name: "dsh_annotation",
  version: STORAGE_SCHEMA_VERSION,
  tables: {
    sessions: domainTable<string, SessionSnapshot>(sessionSnapshotSchema),
  },
});
