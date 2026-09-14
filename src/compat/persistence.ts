import type {
  DurableSessionEvent,
  DurableSessionInspection,
  SessionPersistencePort,
} from "../service.js";

type Header = { readonly id?: string; readonly cwd?: string };
interface ReadHandle {
  readonly id: string;
  readonly header: Header;
  read(
    offset?: number,
    length?: number,
    options?: { signal?: AbortSignal },
  ): Promise<{ readonly events: readonly DurableSessionEvent[] }>;
  close(): Promise<void>;
}
interface HandlePersistence {
  open(
    id: string,
    access: "read",
    options?: { signal?: AbortSignal },
  ): Promise<ReadHandle>;
}

export class CompatibilityError extends Error {
  readonly code = "unsupported-host";
}

/** Normalize only the documented V3 user-message envelope. Never infer a
 * completed assistant message, rewrite a log, or fall back after I/O failure. */
function normalizeEvent(event: DurableSessionEvent): DurableSessionEvent {
  const data = event.data;
  if (
    event.type === "user/message" &&
    data &&
    typeof data === "object" &&
    "role" in data &&
    data.role === "user" &&
    "content" in data &&
    Array.isArray(data.content)
  ) {
    return { ...event, data: { message: data } };
  }
  return event;
}

/** Select by public capabilities, not release strings or private file formats.
 * Future backends implementing either contract need no business-layer change. */
export function adaptSessionPersistence(
  value: unknown,
): SessionPersistencePort {
  const candidate = value as
    Partial<HandlePersistence & SessionPersistencePort> | undefined;
  if (typeof candidate?.open === "function") {
    const backend = candidate as HandlePersistence;
    const read = async (
      id: string,
      offset: number,
      signal?: AbortSignal,
    ): Promise<DurableSessionInspection> => {
      const handle = await backend.open(id, "read", { signal });
      try {
        if (handle.id !== id || handle.header?.id !== id)
          throw new Error("DSH persistence identity mismatch");
        const result = await handle.read(offset, undefined, { signal });
        return {
          meta: handle.header,
          events: result.events.map(normalizeEvent),
        };
      } finally {
        await handle.close();
      }
    };
    return {
      inspect: (id, signal) => read(id, 0, signal),
      readFrom: async (id, offset, signal) => {
        const result = await read(id, offset, signal);
        return { meta: result.meta, events: [...result.events] };
      },
    };
  }
  if (
    typeof candidate?.inspect === "function" &&
    typeof candidate.readFrom === "function"
  ) {
    const backend = candidate as SessionPersistencePort;
    return {
      inspect: (id, signal) => backend.inspect(id, signal),
      readFrom: (id, offset, signal) => backend.readFrom(id, offset, signal),
    };
  }
  const unsupported = async (): Promise<never> => {
    throw new CompatibilityError(
      "当前 DSH 会话读取接口不受支持；已有批注仍可查看和导出，请更新批注插件。 (unsupported persistence API)",
    );
  };
  return { inspect: unsupported, readFrom: unsupported };
}
