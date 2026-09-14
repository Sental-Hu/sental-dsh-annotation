import type { Context } from "@deepseek-ai/cordis";
import type { DomainFacility } from "@deepseek-ai/dsh-storage-domain";

import { storageDomain } from "./domain.js";
import { adaptSessionPersistence } from "./compat/persistence.js";
import { HistoryProjector } from "./history.js";
import { registerAnnotationRoute, type WebServerPort } from "./http.js";
import { AnnotationRepository } from "./repository.js";
import {
  AnnotationService,
  type SessionPersistencePort,
  type SessionsPort,
} from "./service.js";

export { storageDomain } from "./domain.js";
export * from "./history.js";
export * from "./repository.js";
export * from "./service.js";
export * from "./shared/types.js";
export * from "./http.js";

/** Context service name provided by this plugin's Host face. */
export const ANNOTATION_SERVICE = "dshAnnotation" as const;

declare module "@deepseek-ai/cordis" {
  interface Context {
    dshAnnotation: AnnotationService;
  }
}

export const inject = [
  "webServer",
  "storageDomain",
  "sessionPersistence",
  "sessions",
] as const;

interface AnnotationHostContext extends Context {
  get(name: string, strict?: boolean): unknown;
}

function requiredService<T>(ctx: AnnotationHostContext, name: string): T {
  const service = ctx.get(name);
  if (service === undefined) {
    throw new Error(`dsh-annotation: required DSH service is missing: ${name}`);
  }
  return service as T;
}

/**
 * Open the sidecar domain and publish one lifecycle-bound annotation service.
 * The plugin owns only its domain and provided service; it never creates or
 * resumes a DSH Agent/Session.
 */
export async function apply(ctx: Context): Promise<void> {
  const host = ctx as AnnotationHostContext;
  const webServer = requiredService<WebServerPort>(host, "webServer");
  const facility = requiredService<DomainFacility>(host, "storageDomain");
  const sessionPersistence = requiredService<SessionPersistencePort>(
    host,
    "sessionPersistence",
  );
  const sessions = requiredService<SessionsPort>(host, "sessions");
  const domain = await facility.open(storageDomain);
  const repository = new AnnotationRepository(domain.table("sessions"));
  const service = new AnnotationService({
    repository,
    sessionPersistence: adaptSessionPersistence(sessionPersistence),
    sessions,
    history: new HistoryProjector(),
  });

  // Register through effects so a plugin remove/reload unregisters the public
  // service before releasing the domain handle (Cordis disposes in reverse
  // registration order).
  ctx.effect(
    () => async () => {
      await domain.close();
    },
    "dsh-annotation: domain",
  );
  ctx.effect(
    () => ctx.provide(ANNOTATION_SERVICE, service),
    "dsh-annotation: service",
  );
  ctx.effect(
    () => registerAnnotationRoute({ webServer }, service),
    "dsh-annotation: /dsh-annotation/api",
  );
}
