import { AnnotationApiClient } from "./api.js";
import { CompatibleAnnotationDock } from "../compat/client.js";
import { createBatchReferenceSourceFromApi } from "./input-reference.js";
import {
  createAnnotationReferenceInserter,
  type SessionsLike,
} from "./pending-reference.js";
import { AnnotationStore } from "./store.js";
import { createDirectAnnotationSender } from "./direct-send.js";

interface InputTriggersPort {
  registerSource(source: unknown): () => void;
}

interface SlotsPort {
  inject(name: string, factory: () => unknown): void;
  register(options: Record<string, unknown>, component: unknown): unknown;
}

interface ClientContextLike {
  get(name: string, strict?: boolean): unknown;
  effect(factory: () => void | (() => void), label?: string): void;
}

export const inject = ["slots", "inputTriggers", "sessions"] as const;

/** Browser half: one session-scoped dock plus the internal @annotation-batch source. */
export function apply(ctx: ClientContextLike): void {
  if (!ctx || typeof ctx.get !== "function") {
    throw new Error("dsh-annotation: slots and inputTriggers are required.");
  }
  const slots = ctx.get("slots") as SlotsPort | undefined;
  const inputTriggers = ctx.get("inputTriggers") as
    InputTriggersPort | undefined;
  const sessions = ctx.get("sessions") as SessionsLike | undefined;
  if (!slots || !inputTriggers) {
    throw new Error("dsh-annotation: slots and inputTriggers are required.");
  }

  const api = new AnnotationApiClient();
  const stores = new Map<string, AnnotationStore>();
  const storeFor = (sessionId: string): AnnotationStore => {
    let store = stores.get(sessionId);
    if (!store) {
      store = new AnnotationStore(api, sessionId);
      stores.set(sessionId, store);
    }
    return store;
  };

  const codec = createBatchReferenceSourceFromApi(api);
  // Keep the codec only for pre-0.1.5 drafts that already contain a marker.
  // New annotations are inserted one by one as normal readable message text.
  const source = codec;

  ctx.effect(() => {
    const unregister = inputTriggers.registerSource(source);
    return () => {
      unregister();
      stores.clear();
    };
  }, "dsh-annotation: input reference source");

  slots.inject("conversation.input.dock", () =>
    slots.register(
      {
        name: "conversation.input.dock",
        id: "dsh-annotation",
        order: 30,
        inject: (sessionId: string) => ({
          store: storeFor(sessionId),
          sendAnnotation: createDirectAnnotationSender(
            sessions,
            sessionId,
            api,
          ),
          insertAnnotationReference: createAnnotationReferenceInserter(
            sessions,
            sessionId,
          ),
        }),
      },
      CompatibleAnnotationDock,
    ),
  );
}

export { AnnotationDock } from "./AnnotationDock.js";
export { AnnotationApiClient, AnnotationApiError } from "./api.js";
export { AnnotationStore } from "./store.js";
export * from "./input-reference.js";
