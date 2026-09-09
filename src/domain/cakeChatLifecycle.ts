import { Effect } from "effect";
import * as subagents from "./subagents";
import { CakeChatEnvironment } from "../services/cake-chats/CakeChatEnvironment";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { CakeChatError, type CakeChatTarget } from "./cake-chat-data";
import { acquireTarget } from "./cakeChatOperations";
import { asError, sessionNamespace } from "./cakeChatMetadata";

export const resolve = Effect.fn("CakeChats.resolve")(function* (target: CakeChatTarget) {
  const snapshot = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* acquireTarget(target, false);
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
  const environment = yield* CakeChatEnvironment;
  yield* environment.archive(target.sessionId).pipe(asError("resolve"));
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs
    .publish({ _tag: "CakeChatSessionStatusChanged", sessionId: target.sessionId, resolved: true })
    .pipe(asError("resolve"));
});

export const restore = Effect.fn("CakeChats.restore")(function* (target: CakeChatTarget) {
  const environment = yield* CakeChatEnvironment;
  yield* environment.restore(target.sessionId).pipe(asError("restore"));
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs
    .publish({ _tag: "CakeChatSessionStatusChanged", sessionId: target.sessionId, resolved: false })
    .pipe(asError("restore"));
});

export const deleteResolved = Effect.fn("CakeChats.deleteResolved")(function* (
  target: CakeChatTarget,
) {
  if ((yield* sessionNamespace(target.sessionId)) !== "resolved")
    return yield* new CakeChatError({
      operation: "deleteResolved",
      message: "Only resolved Cake Chat sessions can be deleted",
    });
  const environment = yield* CakeChatEnvironment;
  yield* environment.deleteResolved(target.sessionId).pipe(asError("deleteResolved"));
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs.publish({ _tag: "CakeChatSessionRemoved", sessionId: target.sessionId });
});
