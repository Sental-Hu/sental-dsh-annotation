import { describe, expect, it, vi } from "vitest";
import { adaptSessionPersistence } from "../src/compat/persistence.js";

describe("persistence compatibility boundary", () => {
  it("preserves the legacy persistence contract and receiver", async () => {
    const legacy = {
      inspect: vi.fn(async () => ({ meta: { id: "s" }, events: [] })),
      readFrom: vi.fn(async () => ({ meta: { id: "s" }, events: [] })),
    };
    await expect(adaptSessionPersistence(legacy).inspect("s")).resolves.toEqual(
      { meta: { id: "s" }, events: [] },
    );
    expect(legacy.inspect.mock.contexts[0]).toBe(legacy);
  });
  it("opens only a read handle, normalizes V3 user messages and closes it", async () => {
    const event = {
      type: "user/message",
      data: {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    };
    const handle = {
      id: "s",
      header: { id: "s", cwd: "/work" },
      read: vi.fn(async () => ({ events: [event] })),
      close: vi.fn(async () => {}),
    };
    const open = vi.fn(async () => handle);
    const result = await adaptSessionPersistence({ open }).readFrom("s", 3);
    expect(open).toHaveBeenCalledWith("s", "read", { signal: undefined });
    expect(handle.read).toHaveBeenCalledWith(3, undefined, {
      signal: undefined,
    });
    expect(result.events[0]?.data).toEqual({ message: event.data });
    expect(handle.close).toHaveBeenCalledOnce();
    expect(event.data).not.toHaveProperty("message");
  });
  it("closes on read failure and never retries another API after failure", async () => {
    const close = vi.fn(async () => {});
    const inspect = vi.fn();
    const port = adaptSessionPersistence({
      inspect,
      readFrom: vi.fn(),
      open: async () => ({
        id: "s",
        header: { id: "s" },
        read: async () => {
          throw new Error("corrupt log");
        },
        close,
      }),
    });
    await expect(port.inspect("s")).rejects.toThrow("corrupt log");
    expect(close).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
  });
  it("rejects wrong identities and still releases the handle", async () => {
    const close = vi.fn(async () => {});
    const read = vi.fn();
    await expect(
      adaptSessionPersistence({
        open: async () => ({
          id: "other",
          header: { id: "other" },
          read,
          close,
        }),
      }).inspect("s"),
    ).rejects.toThrow("identity");
    expect(close).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps plugin activation possible but refuses unsupported persistence on use", async () => {
    const port = adaptSessionPersistence({});
    await expect(port.inspect("s")).rejects.toThrow("DSH");
  });
});
