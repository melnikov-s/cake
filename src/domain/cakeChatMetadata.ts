import { Effect, Stream } from "effect";
import type { SessionSummary } from "../ipc/session-contract";
import { PiSessions, type PiSessionError } from "../services/pi/PiSessions";
import type { CakeChatLocation } from "./cakeChatLocations";
import { archiveLocation } from "./cakeChatLocations";
import type { CakeChatCatalogUpdate } from "./catalog-data";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import { toJsonValue } from "../utils/to-json-value";
import { compareSessionSummariesForSidebar } from "../utils/session-summary-order";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../services/session-catalogs/SessionCatalogChanges";
import {
  CakeChatError,
  type CakeChatCatalogQuery,
  type CakeChatPreview,
  type CakeChatSummary,
} from "./cake-chat-data";

type CakeChatCatalogEvent = Extract<CakeChatCatalogUpdate, { _tag: "Event" }>["event"];

export const asError = (operation: string) =>
  Effect.mapError(
    (error: PiSessionError | unknown) =>
      new CakeChatError({
        operation,
        message: error instanceof Error ? error.message : String(error),
      }),
  );

const errorValue = (operation: string, error: unknown) =>
  new CakeChatError({
    operation,
    message: error instanceof Error ? error.message : String(error),
  });

const summary = (item: SessionSummary, resolved: boolean): CakeChatSummary => {
  const projected: CakeChatSummary = {
    sessionId: item.id,
    title: item.title,
    createdAt: item.created,
    modifiedAt: item.modified,
    messageCount: item.messageCount,
    resolved,
  };
  if (item.parentSessionId !== undefined)
    Object.assign(projected, { parentSessionId: item.parentSessionId });
  return projected;
};

export const sessionNamespace = Effect.fn("CakeChats.sessionNamespace")(function* (
  sessionId: string,
  location: CakeChatLocation,
) {
  const archive = yield* SessionArchiveStorage;
  return yield* archive.locate(sessionId, archiveLocation(location)).pipe(asError("locate"));
});

export const publishCatalogChange = Effect.fn("CakeChats.publishCatalogChange")(function* (
  sessionId: string,
  resolved: boolean,
) {
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs.publish({ _tag: "CakeChatSessionChanged", sessionId, resolved });
});

const catalogForState = Effect.fn("CakeChats.catalogForState")(function* (
  query: CakeChatCatalogQuery,
  location: CakeChatLocation,
) {
  const sessions = yield* PiSessions;
  const archive = yield* SessionArchiveStorage;
  const source: Stream.Stream<SessionSummary, unknown> = query.resolved
    ? archive.resolved({
        cwd: location.workingDirectory,
        activeRoot: location.sessionDirectory,
        resolvedRoot: location.resolvedSessionDirectory,
        direct: true,
      })
    : sessions.catalog({
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
        direct: true,
      });
  return source.pipe(
    Stream.map((item) => summary(item, query.resolved)),
    Stream.mapError((error) => errorValue("catalog", error)),
  );
});

const catalogEventForChange = Effect.fn("CakeChats.catalogEventForChange")(function* (
  query: CakeChatCatalogQuery,
  change: SessionCatalogChange,
  location: CakeChatLocation,
) {
  if (change._tag === "CakeChatSessionRemoved")
    return { _tag: "Removed", sessionId: change.sessionId } as const;
  if (change._tag === "CakeChatSessionStatusChanged")
    return {
      _tag: "StatusChanged" as const,
      sessionId: change.sessionId,
      resolved: change.resolved,
    };
  if (change._tag !== "CakeChatSessionChanged") return undefined;
  if (change.resolved !== query.resolved) return undefined;
  const sessions = yield* PiSessions;
  const archive = yield* SessionArchiveStorage;
  const item = change.resolved
    ? yield* archive.resolvedEntry(change.sessionId, {
        cwd: location.workingDirectory,
        activeRoot: location.sessionDirectory,
        resolvedRoot: location.resolvedSessionDirectory,
        direct: true,
      })
    : yield* sessions.catalogEntry(
        {
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
          direct: true,
        },
        change.sessionId,
      );
  return item
    ? ({ _tag: "Upserted", session: summary(item, change.resolved) } as const)
    : ({ _tag: "Removed", sessionId: change.sessionId } as const);
});

/** Scoped Cake Chat metadata observation: one lazy scan, then targeted mutations. */
export const observeCatalog = Effect.fn("CakeChats.observeCatalog")(function* (
  query: CakeChatCatalogQuery,
  location: CakeChatLocation,
) {
  const catalogs = yield* SessionCatalogChanges;
  const initial = Stream.fromEffect(
    Stream.unwrap(catalogForState(query, location)).pipe(
      Stream.runCollect,
      Effect.map((sessions) => {
        const all = Array.from(sessions);
        if (!query.resolved) return { _tag: "InitialSnapshot" as const, sessions: all };
        const sorted = all.sort(compareSessionSummariesForSidebar);
        return {
          _tag: "InitialSnapshot" as const,
          sessions: sorted.slice(0, query.limit),
          hasMore: sorted.length > query.limit,
        };
      }),
    ),
  );
  return catalogs.initialThenChanges(initial).pipe(
    Stream.mapEffect((item) =>
      item._tag === "InitialSnapshot"
        ? Effect.succeed<
            | {
                readonly _tag: "InitialSnapshot";
                readonly sessions: CakeChatSummary[];
                readonly hasMore?: boolean;
              }
            | CakeChatCatalogEvent
            | undefined
          >(item)
        : catalogEventForChange(query, item, location),
    ),
    Stream.filter(
      (
        item,
      ): item is
        | {
            readonly _tag: "InitialSnapshot";
            readonly sessions: CakeChatSummary[];
            readonly hasMore?: boolean;
          }
        | CakeChatCatalogEvent => item !== undefined,
    ),
    Stream.mapError((error) => errorValue("catalog", error)),
    Stream.mapAccum(
      () => 0,
      (revision, item): readonly [number, ReadonlyArray<CakeChatCatalogUpdate>] => {
        const nextRevision = revision + 1;
        return [
          nextRevision,
          [
            item._tag !== "InitialSnapshot"
              ? { _tag: "Event", revision: nextRevision, event: item }
              : item.hasMore === undefined
                ? { _tag: "Snapshot", revision: nextRevision, sessions: item.sessions }
                : {
                    _tag: "Snapshot",
                    revision: nextRevision,
                    sessions: item.sessions,
                    hasMore: item.hasMore,
                  },
          ],
        ];
      },
    ),
  );
});

export const inspect = Effect.fn("CakeChats.inspect")(function* (
  sessionId: string,
  location: CakeChatLocation,
) {
  const sessions = yield* PiSessions;
  const namespace = yield* sessionNamespace(sessionId, location);
  const preview = yield* sessions
    .inspect({
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
      resolvedSessionDirectory: location.resolvedSessionDirectory,
      sessionId,
      direct: true,
    })
    .pipe(asError("inspect"));
  return {
    sessionId: preview.sessionId,
    sessionFile: preview.sessionFile,
    parts: preview.parts.map(toJsonValue),
    resolved: namespace === "resolved",
  } satisfies CakeChatPreview;
});
