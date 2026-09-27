import { Effect, Layer, PubSub, Stream } from "effect";
import type { CakeEvent } from "../../ipc/cake-rpc-contract";
import { ClientEvents, type FocusedCakeEvent } from "./ClientEvents";

/** One hub per backend Scope, shared by every transport and producer. No replay or persistence. */
export const ClientEventsLive = Layer.effect(
  ClientEvents,
  Effect.gen(function* () {
    // Native and Pi callbacks cannot backpressure; retain the existing lossless transient delivery.
    const hub = yield* PubSub.unbounded<{
      readonly connectionId?: number;
      readonly event: CakeEvent;
    }>();
    const subscribers = new Map<number, Map<CakeEvent["type"], number>>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(hub));

    const sendTo = (connectionId: number, event: CakeEvent): boolean =>
      (subscribers.get(connectionId)?.has(event.type) ?? false) &&
      PubSub.publishUnsafe(hub, { connectionId, event });
    const broadcast = (event: CakeEvent): void => {
      PubSub.publishUnsafe(hub, { event });
    };
    const observe = (
      connectionId: number,
      initial: CakeEvent,
      accepted: ReadonlySet<CakeEvent["type"]>,
    ) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(hub);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const counts = subscribers.get(connectionId) ?? new Map<CakeEvent["type"], number>();
              for (const type of accepted) counts.set(type, (counts.get(type) ?? 0) + 1);
              subscribers.set(connectionId, counts);
              return counts;
            }),
            (counts) =>
              Effect.sync(() => {
                for (const type of accepted) {
                  const remaining = (counts.get(type) ?? 1) - 1;
                  if (remaining === 0) counts.delete(type);
                  else counts.set(type, remaining);
                }
                if (counts.size === 0) subscribers.delete(connectionId);
              }),
          );
          // Subscribe before readiness so a producer reacting to readiness cannot fall into a gap.
          return Stream.concat(
            Stream.succeed(initial),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (delivery) =>
                  delivery.connectionId === undefined || delivery.connectionId === connectionId,
              ),
              Stream.map((delivery) => delivery.event),
            ),
          );
        }),
      );
    const focused = <Types extends CakeEvent["type"]>(
      connectionId: number,
      channel: Extract<CakeEvent, { type: "renderer-events-ready" }>["channel"],
      ...types: ReadonlyArray<Types>
    ): Stream.Stream<FocusedCakeEvent<Types | "renderer-events-ready">> => {
      const accepted = new Set<CakeEvent["type"]>(["renderer-events-ready", ...types]);
      return observe(connectionId, { type: "renderer-events-ready", channel }, accepted).pipe(
        Stream.filter((event): event is FocusedCakeEvent<Types | "renderer-events-ready"> =>
          accepted.has(event.type),
        ),
      );
    };
    return ClientEvents.of({
      sendTo,
      broadcast,
      application: (connectionId) =>
        focused(
          connectionId,
          "application",
          "changelog-snapshot",
          "complete",
          "fatal",
          "notification",
          "provider-auth-notice",
          "extension-ui-intent",
          "project-session-control-requested",
          "draw-control-requested",
          "widget-capture-requested",
          "browser-native-requested",
          "application-hotkey-input",
          "browser-entered",
          "browser-state-changed",
          "browser-element-selected",
        ),
      artifacts: (connectionId) =>
        focused(
          connectionId,
          "artifacts",
          "artifact-updated",
          "artifact-catalog-invalidated",
          "artifact-requested",
          "ui-request",
        ),
      terminals: (connectionId) => focused(connectionId, "terminals", "terminal-toggle-requested"),
      vscode: (connectionId) =>
        focused(
          connectionId,
          "vscode",
          "embedded-editor-toggle-mode-requested",
          "embedded-editor-selection",
          "embedded-editor-back-to-agent",
          "embedded-editor-annotation-opened",
          "embedded-editor-toggle-chat",
          "embedded-editor-toggle-sidebar",
          "embedded-editor-selection-cleared",
          "embedded-editor-annotation-requested",
          "embedded-editor-side-chat-requested",
        ),
      surfaces: (connectionId) =>
        focused(connectionId, "surfaces", "fullscreen-surface-close-requested"),
    });
  }),
);
