import { describe, expect, it, vi } from "vitest";

import type { KvTable } from "@deepseek-ai/dsh-storage-domain";

import { ANNOTATION_SERVICE, apply } from "../src/index.js";
import type { SessionSnapshot } from "../src/domain.js";
import type { SessionPersistencePort, SessionsPort } from "../src/service.js";

class EmptyTable implements KvTable<string, SessionSnapshot> {
  get(): SessionSnapshot | undefined {
    return undefined;
  }
  entries(): IterableIterator<[string, SessionSnapshot]> {
    return new Map<string, SessionSnapshot>().entries();
  }
  keys(): IterableIterator<string> {
    return new Map<string, SessionSnapshot>().keys();
  }
  get size(): number {
    return 0;
  }
  async put(): Promise<void> {}
  async delete(): Promise<boolean> {
    return false;
  }
  async update(): Promise<SessionSnapshot> {
    throw new Error("missing-key");
  }
}

function dependencies() {
  const table = new EmptyTable();
  const domain = {
    table: vi.fn(() => table),
    close: vi.fn(async () => undefined),
  };
  const facility = {
    open: vi.fn(async () => domain),
  };
  const persistence = {
    inspect: vi.fn(),
    readFrom: vi.fn(),
  } as unknown as SessionPersistencePort;
  const sessions = {
    get: vi.fn(() => undefined),
    flush: vi.fn(async () => true),
  } as unknown as SessionsPort;
  const webServer = {
    register: vi.fn(() => () => undefined),
  };
  const services = new Map<string, unknown>();
  const disposers: Array<() => unknown> = [];
  const ctx = {
    get(name: string) {
      return {
        storageDomain: facility,
        sessionPersistence: persistence,
        sessions,
        webServer,
      }[name];
    },
    provide(name: string, value: unknown) {
      services.set(name, value);
      return () => services.delete(name);
    },
    effect(execute: () => unknown) {
      const result = execute();
      if (typeof result === "function") disposers.push(result);
      return result;
    },
  } as never;
  return { ctx, facility, domain, webServer, services, disposers };
}

describe("Host plugin lifecycle", () => {
  it("opens the sidecar domain and publishes the service", async () => {
    const { ctx, facility, domain, webServer, services } = dependencies();

    await apply(ctx);

    expect(facility.open).toHaveBeenCalledWith(
      expect.objectContaining({ name: "dsh_annotation", version: 1 }),
    );
    expect(domain.table).toHaveBeenCalledWith("sessions");
    expect(webServer.register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prefix",
        path: "/dsh-annotation/api",
      }),
    );
    expect(services.get(ANNOTATION_SERVICE)).toBeDefined();
  });

  it("unregisters before closing the domain", async () => {
    const { ctx, domain, services, disposers } = dependencies();
    await apply(ctx);

    const domainDisposer = disposers[0];
    const serviceDisposer = disposers[1];
    const routeDisposer = disposers[2];
    expect(domainDisposer).toBeTypeOf("function");
    expect(serviceDisposer).toBeTypeOf("function");
    expect(routeDisposer).toBeTypeOf("function");

    routeDisposer!();
    serviceDisposer!();
    expect(services.has(ANNOTATION_SERVICE)).toBe(false);
    await domainDisposer!();
    expect(domain.close).toHaveBeenCalledTimes(1);
  });
});
