import { Effect, Stream } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../ipc/cake-chat-data";
import type { PiSessionSummary } from "../../ipc/session-contract";
import { CakeSessionRuntimes, type PiSessionError } from "../../services/pi/CakeSessionRuntimes";
import type { CakeChatLocation } from "./cakeChatLocations";
import type { CakeChatCatalogUpdate } from "../../contracts/application/catalog-data";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { toJsonValue } from "../../utils/to-json-value";
import {
  CakeChatError,
  type CakeChatCatalogQuery,
  type CakeChatPreview,
  type CakeChatSummary,
} from "../../ipc/cake-chat-data";

const errorValue = (operation: string, error: unknown) =>
  new CakeChatError({ operation, message: error instanceof Error ? error.message : String(error) });
export const asError = (operation: string) =>
  Effect.mapError((error: PiSessionError | unknown) => errorValue(operation, error));
const summary = (item: PiSessionSummary): CakeChatSummary => ({
  sessionId: item.id,
  title: "Cake Chat",
  createdAt: item.created,
  modifiedAt: item.modified,
  messageCount: item.messageCount,
  resolved: false,
});
const queryFor = (location: CakeChatLocation) => ({
  workingDirectory: location.workingDirectory,
  sessionDirectory: location.sessionDirectory,
  direct: true as const,
});

export const sessionNamespace = Effect.fn("CakeChats.sessionNamespace")(function* (
  sessionId: string,
  location: CakeChatLocation,
) {
  const sessions = yield* CakeSessionRuntimes;
  const item = yield* sessions.catalogEntry(queryFor(location), sessionId).pipe(asError("locate"));
  return item ? ("active" as const) : undefined;
});
export const publishCatalogChange = Effect.fn("CakeChats.publishCatalogChange")(function* (
  sessionId: string,
  resolved: boolean,
) {
  const catalogs = yield* SessionCatalogChanges;
  yield* catalogs.publish({ _tag: "CakeChatSessionChanged", sessionId, resolved });
});

/** One permanent coordinator. There is no global resolved-session lane or JSONL archive. */
export const observeCatalog = Effect.fn("CakeChats.observeCatalog")(function* (
  query: CakeChatCatalogQuery,
  location: CakeChatLocation,
) {
  const catalogs = yield* SessionCatalogChanges;
  const sessions = yield* CakeSessionRuntimes;
  const initial = Stream.fromEffect(
    (query.resolved
      ? Effect.succeed([])
      : sessions.catalog(queryFor(location)).pipe(
          Stream.filter((item) => item.id === CAKE_CHAT_SESSION_ID),
          Stream.map(summary),
          Stream.runCollect,
        )
    ).pipe(
      Effect.map((items) => ({
        _tag: "InitialSnapshot" as const,
        sessions: Array.from(items),
        hasMore: false,
      })),
    ),
  );
  return catalogs.initialThenChanges(initial).pipe(
    Stream.mapEffect(
      (
        item,
      ): Effect.Effect<
        | { _tag: "InitialSnapshot"; sessions: CakeChatSummary[]; hasMore?: boolean }
        | { _tag: "Upserted"; session: CakeChatSummary }
        | undefined,
        PiSessionError
      > => {
        if (item._tag === "InitialSnapshot") return Effect.succeed(item);
        if (
          query.resolved ||
          item._tag !== "CakeChatSessionChanged" ||
          item.sessionId !== CAKE_CHAT_SESSION_ID
        )
          return Effect.succeed(undefined);
        return sessions
          .catalogEntry(queryFor(location), CAKE_CHAT_SESSION_ID)
          .pipe(
            Effect.map((entry) =>
              entry ? { _tag: "Upserted" as const, session: summary(entry) } : undefined,
            ),
          );
      },
    ),
    Stream.filter((item) => item !== undefined),
    Stream.mapError((error) => errorValue("catalog", error)),
    Stream.mapAccum(
      () => 0,
      (revision, item): readonly [number, ReadonlyArray<CakeChatCatalogUpdate>] => {
        const nextRevision = revision + 1;
        return [
          nextRevision,
          [
            item._tag === "InitialSnapshot"
              ? {
                  _tag: "Snapshot",
                  revision: nextRevision,
                  sessions: item.sessions,
                  hasMore: item.hasMore ?? false,
                }
              : { _tag: "Event", revision: nextRevision, event: item },
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
  const sessions = yield* CakeSessionRuntimes;
  const preview = yield* sessions
    .inspect({
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
      sessionId,
      direct: true,
    })
    .pipe(asError("inspect"));
  return {
    sessionId: preview.sessionId,
    sessionFile: preview.sessionFile,
    parts: preview.parts.map(toJsonValue),
    resolved: false,
  } satisfies CakeChatPreview;
});
