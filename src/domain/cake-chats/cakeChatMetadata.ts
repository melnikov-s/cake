import { Effect, Stream } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { CakeSessionRuntimes, type PiSessionError } from "../../services/pi/CakeSessionRuntimes";
import type { CakeChatLocation } from "../../services/pi-durable/CakeChatConfiguration";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { toJsonValue } from "../../utils/to-json-value";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { setSessionUnread } from "../application/application";
import {
  CakeChatError,
  type CakeChatCatalogQuery,
  type CakeChatPreview,
  type CakeChatSummary,
} from "../../contracts/cake-chats/cake-chat-data";
import * as locations from "./cakeChatLocations";

const errorValue = (operation: string, error: unknown) =>
  new CakeChatError({ operation, message: error instanceof Error ? error.message : String(error) });
export const asError = (operation: string) =>
  Effect.mapError((error: PiSessionError | unknown) => errorValue(operation, error));
const queryFor = (location: CakeChatLocation, sessionId: string) => ({
  ...location,
  direct: true as const,
  cakeChatSessionId: sessionId,
});

export const sessionNamespace = Effect.fn("CakeChats.sessionNamespace")(function* (
  sessionId: string,
  location: CakeChatLocation,
) {
  const sessions = yield* CakeSessionRuntimes;
  const item = yield* sessions
    .catalogEntry(queryFor(location, sessionId), sessionId)
    .pipe(asError("locate"));
  return item ? ("active" as const) : undefined;
});

export const publishCatalogChange = Effect.fn("CakeChats.publishCatalogChange")(function* (
  sessionId: string,
  resolved: boolean,
) {
  yield* (yield* SessionCatalogChanges).publish({
    _tag: "CakeChatSessionChanged",
    sessionId,
    resolved,
  });
});

export const setUnread = Effect.fn("CakeChats.setUnread")(function* (
  unread: boolean,
  sessionId = CAKE_CHAT_SESSION_ID,
) {
  yield* setSessionUnread(sessionId, unread).pipe(asError("setUnread"));
  yield* publishCatalogChange(sessionId, false);
});

/** Discovery never opens Harnesses. Unstarted project chats have an address but no database. */
export const catalog = Effect.fn("CakeChats.catalog")(function* (
  location: CakeChatLocation,
  sessionId?: string,
) {
  const application = yield* ApplicationState;
  const sessions = yield* CakeSessionRuntimes;
  const state = application.snapshot();
  const scopes = [
    {
      sessionId: CAKE_CHAT_SESSION_ID,
      title: "Cake Chat",
      location,
      projectPath: undefined,
      addedAt: undefined,
    },
    ...state.projects.map((project) => ({
      sessionId: locations.projectChatSessionId(project.path),
      title: project.name,
      location: locations.projectLocation(location, project.path),
      projectPath: project.path,
      addedAt: project.addedAt,
    })),
  ];
  const summaries: CakeChatSummary[] = [];
  for (const scope of scopes) {
    if (sessionId !== undefined && scope.sessionId !== sessionId) continue;
    const item = yield* sessions
      .catalogEntry(queryFor(scope.location, scope.sessionId), scope.sessionId)
      .pipe(asError("catalog"));
    // The permanent global address exists even before its first database. Exact startup
    // lookup may initialize it; passive discovery still omits absent global storage.
    const createdAt =
      item?.created ??
      scope.addedAt ??
      (sessionId === CAKE_CHAT_SESSION_ID ? new Date().toISOString() : undefined);
    if (!createdAt) continue;
    const activity = yield* sessions.currentStatus({
      workingDirectory: scope.location.workingDirectory,
      sessionDirectory: scope.location.sessionDirectory,
      sessionId: scope.sessionId,
    });
    summaries.push({
      sessionId: scope.sessionId,
      running: activity?.streaming ?? false,
      title: scope.title,
      ...(scope.projectPath ? { projectPath: scope.projectPath } : null),
      createdAt,
      modifiedAt: item?.modified ?? createdAt,
      messageCount: item?.messageCount ?? 0,
      ...(!item && scope.sessionId === CAKE_CHAT_SESSION_ID ? { unstarted: true } : null),
      ...(item?.contextMetadata ? { contextMetadata: item.contextMetadata } : null),
      resolved: false,
      unread: state.unreadSessionIds.includes(scope.sessionId),
    });
  }
  return summaries;
});

/** Exact metadata lookup also covers a registered Project Chat before its first turn. */
export const lookup = Effect.fn("CakeChats.lookup")(function* (
  sessionId: string,
  location: CakeChatLocation,
) {
  const summary = (yield* catalog(location, sessionId))[0];
  if (!summary)
    return yield* new CakeChatError({
      operation: "lookup",
      message: "Cake could not find that registered chat.",
    });
  return summary;
});

export const observeCatalog = Effect.fn("CakeChats.observeCatalog")(function* (
  query: CakeChatCatalogQuery,
  location: CakeChatLocation,
) {
  const changes = yield* SessionCatalogChanges;
  const application = yield* ApplicationState;
  const snapshot = () =>
    query.resolved ? Effect.succeed<CakeChatSummary[]>([]) : catalog(location);
  // Acquire the catalog subscription before starting the current-first project stream.
  // Its first value is the sole initial scan. Both sources stay subscribed during reads,
  // so project/catalog mutations in flight enqueue a subsequent authoritative snapshot.
  return changes.initialThenChanges(Stream.succeed({ _tag: "ObserveProjects" as const })).pipe(
    Stream.filter((item) => item._tag === "ObserveProjects" || item._tag.startsWith("CakeChat")),
    Stream.flatMap(
      (item): Stream.Stream<void> =>
        item._tag === "ObserveProjects"
          ? application.changes().pipe(
              Stream.map((item) =>
                JSON.stringify(
                  item.state.projects.map(({ path, name, addedAt }) => ({ path, name, addedAt })),
                ),
              ),
              Stream.changes,
              Stream.map(() => undefined),
            )
          : Stream.succeed(undefined),
      { concurrency: 2 },
    ),
    Stream.mapEffect(() => snapshot()),
    Stream.mapAccum(
      () => 0,
      (revision, sessions) =>
        [
          revision + 1,
          [{ _tag: "Snapshot" as const, revision: revision + 1, sessions, hasMore: false }],
        ] as const,
    ),
    Stream.mapError((error) => errorValue("catalog", error)),
  );
});

export const inspect = Effect.fn("CakeChats.inspect")(function* (
  sessionId: string,
  location: CakeChatLocation,
) {
  const sessions = yield* CakeSessionRuntimes;
  const resolved = yield* locations.resolve(location, sessionId);
  const preview = yield* sessions
    .inspect({ ...queryFor(resolved, sessionId), sessionId })
    .pipe(asError("inspect"));
  return {
    sessionId: preview.sessionId,
    sessionFile: preview.sessionFile,
    parts: preview.parts.map(toJsonValue),
    resolved: false,
  } satisfies CakeChatPreview;
});
