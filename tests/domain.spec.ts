import { describe, expect, it } from "vitest";

import {
  STORAGE_SCHEMA_VERSION,
  sessionSnapshotSchema,
  storageDomain,
} from "../src/domain.js";

const snapshot = {
  schemaVersion: STORAGE_SCHEMA_VERSION,
  createdAt: "2026-08-28T00:00:00.000Z",
  cwd: "C:/workspace",
  annotations: [],
  batches: {},
};

describe("storageDomain", () => {
  it("accepts a legal session snapshot", () => {
    expect(sessionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects unknown and invalid fields strictly", () => {
    expect(() =>
      sessionSnapshotSchema.parse({ ...snapshot, extra: true }),
    ).toThrow();
    expect(() =>
      sessionSnapshotSchema.parse({ ...snapshot, schemaVersion: "1" }),
    ).toThrow();
    expect(() =>
      sessionSnapshotSchema.parse({
        ...snapshot,
        annotations: [{ id: "bad" }],
      }),
    ).toThrow();
  });

  it("rejects snapshots from a different schema version", () => {
    expect(() =>
      sessionSnapshotSchema.parse({
        ...snapshot,
        schemaVersion: STORAGE_SCHEMA_VERSION + 1,
      }),
    ).toThrow();
  });

  it("declares the expected domain identity and sessions table", () => {
    expect(storageDomain.name).toBe("dsh_annotation");
    expect(storageDomain.version).toBe(STORAGE_SCHEMA_VERSION);
    expect(Object.keys(storageDomain.tables)).toEqual(["sessions"]);
  });
});
