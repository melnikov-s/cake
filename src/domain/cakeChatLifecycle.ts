import { Effect } from "effect";
import * as subagents from "./subagents";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import { CakeChatError, type CakeChatTarget } from "./cake-chat-data";
import { archiveLocation, type CakeChatLocation } from "./cakeChatLocations";
import { acquireTarget } from "./cakeChatOperations";
import { asError, sessionNamespace } from "./cakeChatMetadata";
import type { CakeChatRuntimeConfiguration } from "./cakeChatRuntime";

/** Applies the Cake-owned active/resolved namespace transition and publishes it. */
export const setResolved = Effect.fn("CakeChats.setResolved")(function* (
  sessionId: string,
  resolved: boolean,
  location: CakeChatLocation,
) {
  const storage = yield* SessionArchiveStorage;
  if (resolved)
    yield* storage.resolve(sessionId, archiveLocation(location)).pipe(asError("resolve"));
  else yield* storage.restore(sessionId, archiveLocation(location)).pipe(asError("restore"));
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs
    .publish({ _tag: "CakeChatSessionStatusChanged", sessionId, resolved })
    .pipe(asError(resolved ? "resolve" : "restore"));
});

export const resolve = Effect.fn("CakeChats.resolve")(function* (
  target: CakeChatTarget,
  configuration: CakeChatRuntimeConfiguration,
) {
  const snapshot = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* acquireTarget(target, false, configuration);
      return yield* handle.snapshot().pipe(asError("resolve"));
    }),
  );
  if (snapshot.streaming)
    return yield* new CakeChatError({
      operation: "resolve",
      message: "Cake Chat cannot resolve a session while it is running",
    });
  if (!snapshot.sessionFile)
    return yield* new CakeChatError({
      operation: "resolve",
      message: "Cake Chat cannot resolve an empty session before it has been persisted",
    });
  yield* subagents.releaseParent(target.sessionId).pipe(asError("resolve"));
  yield* setResolved(target.sessionId, true, configuration.location);
});

export const restore = Effect.fn("CakeChats.restore")(function* (
  target: CakeChatTarget,
  location: CakeChatLocation,
) {
  yield* setResolved(target.sessionId, false, location);
});

export const deleteResolved = Effect.fn("CakeChats.deleteResolved")(function* (
  target: CakeChatTarget,
  location: CakeChatLocation,
) {
  if ((yield* sessionNamespace(target.sessionId, location)) !== "resolved")
    return yield* new CakeChatError({
      operation: "deleteResolved",
      message: "Only resolved Cake Chat sessions can be deleted",
    });
  const storage = yield* SessionArchiveStorage;
  yield* storage
    .deleteResolved(target.sessionId, archiveLocation(location))
    .pipe(asError("deleteResolved"));
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs.publish({ _tag: "CakeChatSessionRemoved", sessionId: target.sessionId });
});
