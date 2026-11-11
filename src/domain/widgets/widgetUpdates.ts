import { Effect, Schema, Stream } from "effect";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { WidgetPolls } from "../../services/widgets/WidgetPolls";
import type {
  WidgetEvent,
  WidgetEventSubscription,
  WidgetPollRequest,
  WidgetUpdate,
} from "../../contracts/widgets/widget-updates";
import { jsonObjectSchema, type JsonValue } from "../../contracts/serialization/json-contract";
import * as artifactCommands from "../artifacts/artifactCommands";
import { toJsonValue } from "../../utils/to-json-value";

const eventSource = Effect.fn("WidgetUpdates.eventSource")(function* (
  input: WidgetEventSubscription,
  connectionId: number,
) {
  if (input.topic === "artifact.execution.changed") {
    return (yield* ClientEvents).artifacts(connectionId).pipe(
      Stream.flatMap((event): Stream.Stream<WidgetEvent> =>
        event.type === "renderer-events-ready"
          ? Stream.make({ kind: "ready", topic: input.topic } satisfies WidgetEvent)
          : event.type === "artifact-execution-invalidated" &&
              (!input.filter.lineageId || event.lineageId === input.filter.lineageId)
            ? Stream.make({
                kind: "change",
                topic: "artifact.execution.changed",
                lineageId: event.lineageId,
              } satisfies WidgetEvent)
            : Stream.empty,
      ),
    );
  }
  const topic = input.topic;
  return (yield* SessionCatalogChanges)
    .initialThenChanges(Stream.make({ kind: "ready", topic } satisfies WidgetEvent))
    .pipe(
      Stream.flatMap((change): Stream.Stream<WidgetEvent> => {
        if ("kind" in change) return Stream.make(change);
        const removed =
          change._tag === "ProjectSessionRemoved" || change._tag === "CakeChatSessionRemoved";
        if ((input.topic === "session.removed") !== removed) return Stream.empty;
        // Invalidation, not a second transcript. Consumers read authoritative session data.
        if (
          input.topic === "session.transcript.changed" &&
          ![
            "ProjectSessionChanged",
            "ProjectSessionActivityChanged",
            "CakeChatSessionChanged",
          ].includes(change._tag)
        )
          return Stream.empty;
        const ids =
          "sessionId" in change
            ? [change.sessionId]
            : "sessions" in change
              ? change.sessions.map((entry) => entry.sessionId)
              : [];
        return Stream.fromIterable(
          ids
            .filter((id) => !input.filter.sessionId || input.filter.sessionId === id)
            .map(
              (sessionId) =>
                ({ kind: "change", topic, sessionId, reason: change._tag }) satisfies WidgetEvent,
            ),
        );
      }),
    );
});
export const events = (input: WidgetEventSubscription, connectionId: number) =>
  Stream.unwrap(eventSource(input, connectionId));

function canonical(value: JsonValue): string {
  const keys = new Set<string>();
  JSON.stringify(value, (key, nested) => {
    keys.add(key);
    return nested;
  });
  return JSON.stringify(value, [...keys].sort());
}

const pollSource = Effect.fn("WidgetUpdates.pollSource")(function* (
  request: WidgetPollRequest,
  connectionId: number,
) {
  const polls = yield* WidgetPolls;
  const context =
    yield* Effect.context<Effect.Services<ReturnType<typeof artifactCommands.invoke>>>();
  const read = Effect.scoped(
    artifactCommands.invoke(request.options.command, request.options.input, {
      artifactId: request.lineageId,
      ...(request.sessionId === undefined ? null : { callingSessionId: request.sessionId }),
      windowConnectionId: connectionId,
    }),
  ).pipe(
    Effect.provideContext(context),
    Effect.map((result): WidgetUpdate => ({ ok: true, result })),
    Effect.catch((cause) =>
      Effect.succeed<WidgetUpdate>({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  );
  // Window-independent backend commands share a loop across windows too. Window/native
  // commands retain their real connection, so a result cannot leak another view's context.
  const catalog = Schema.decodeUnknownSync(jsonObjectSchema)(
    artifactCommands.describe(request.options.command),
  );
  const backend = Array.isArray(catalog.commands) && catalog.commands.length > 0;
  const key = canonical(toJsonValue({ ...request, connectionId: backend ? null : connectionId }));
  return polls.observe(key, request.options.intervalMs, read);
});
export const poll = (request: WidgetPollRequest, connectionId: number) =>
  Stream.unwrap(pollSource(request, connectionId));
