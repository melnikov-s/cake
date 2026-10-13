import { it } from "@effect/vitest";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { describe, expect } from "vitest";
import {
  applicationEventSchema,
  cakeEventSchema,
  type CakeEvent,
} from "../../../../src/contracts/application/cake-rpc-contract";
import { ArtifactLineageId } from "../../../../src/contracts/artifacts/artifact-lineage";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";

const subscribe = Effect.fn("ClientEvents.test.subscribe")(function* (
  stream: Stream.Stream<CakeEvent>,
) {
  const received = yield* Queue.unbounded<CakeEvent>();
  const fiber = yield* stream.pipe(
    Stream.runForEach((event) => Queue.offer(received, event)),
    Effect.forkScoped,
  );
  const ready = yield* Queue.take(received);
  expect(ready.type).toBe("renderer-events-ready");
  return { received, fiber, ready };
});

const browserRequest: CakeEvent = {
  type: "browser-native-requested",
  sessionId: "session-1",
  requestId: "00000000-0000-4000-8000-000000000001",
  operation: "enter",
  workspacePath: "/project",
};
const notification: CakeEvent = {
  type: "notification",
  tone: "info",
  title: "Test",
  message: "Broadcast",
};

describe("ClientEvents", () => {
  it.effect("native_window_blur_validates_and_reaches_only_target_application_connection", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      const first = yield* subscribe(events.application(1));
      const second = yield* subscribe(events.application(2));
      const blur = yield* Schema.decodeUnknownEffect(cakeEventSchema)({ type: "window-blurred" });
      expect(yield* Schema.decodeUnknownEffect(applicationEventSchema)(blur)).toEqual({
        type: "window-blurred",
      });
      expect(Schema.is(applicationEventSchema)({ type: "window-blur" })).toBe(false);
      expect(events.sendTo(1, blur)).toBe(true);
      events.broadcast(notification);
      expect(yield* Queue.take(first.received)).toEqual(blur);
      expect(yield* Queue.take(first.received)).toEqual(notification);
      expect(yield* Queue.take(second.received)).toEqual(notification);
      expect(events.sendTo(99, blur)).toBe(false);
    }).pipe(Effect.provide(ClientEventsLive)),
  );
  it.effect("native_window_blur_is_not_replayed_to_late_or_other_channel_subscribers", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      const first = yield* subscribe(events.application(1));
      const terminals = yield* subscribe(events.terminals(1));
      const onlyTerminals = yield* subscribe(events.terminals(2));
      const blur = { type: "window-blurred" } as const;
      expect(events.sendTo(1, blur)).toBe(true);
      expect(yield* Queue.take(first.received)).toEqual(blur);
      expect(events.sendTo(2, blur)).toBe(false);
      const late = yield* subscribe(events.application(1));
      // Ordered, channel-specific barriers prove neither channel filtering nor late
      // subscription has retained the earlier targeted blur.
      expect(events.sendTo(1, { type: "terminal-toggle-requested" })).toBe(true);
      expect(events.sendTo(2, { type: "terminal-toggle-requested" })).toBe(true);
      events.broadcast(notification);
      expect(yield* Queue.take(terminals.received)).toEqual({ type: "terminal-toggle-requested" });
      expect(yield* Queue.take(onlyTerminals.received)).toEqual({
        type: "terminal-toggle-requested",
      });
      expect(yield* Queue.take(first.received)).toEqual(notification);
      expect(yield* Queue.take(late.received)).toEqual(notification);
      yield* Fiber.interrupt(first.fiber);
      yield* Fiber.interrupt(late.fiber);
      expect(events.sendTo(1, blur)).toBe(false);
    }).pipe(Effect.provide(ClientEventsLive)),
  );
  it.effect("client_events_deliver_only_to_target_connection", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      const first = yield* subscribe(events.application(1));
      const second = yield* subscribe(events.application(2));
      expect(events.sendTo(1, browserRequest)).toBe(true);
      events.broadcast(notification);
      expect(yield* Queue.take(first.received)).toEqual(browserRequest);
      expect(yield* Queue.take(first.received)).toEqual(notification);
      // A broadcast acts as an ordered barrier: no targeted event preceded it here.
      expect(yield* Queue.take(second.received)).toEqual(notification);
      expect(events.sendTo(99, browserRequest)).toBe(false);
    }).pipe(Effect.provide(ClientEventsLive)),
  );

  it.effect("auth notices validate and reach only the initiating application subscriber", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      const first = yield* subscribe(events.application(1));
      const second = yield* subscribe(events.application(2));
      const notice = yield* Schema.decodeUnknownEffect(cakeEventSchema)({
        type: "provider-auth-notice",
        provider: "test-provider",
        sessionId: "session-1",
        notice: {
          type: "device_code",
          verificationUri: "https://auth.example/device",
          userCode: "ABCD",
        },
      });
      expect(yield* Schema.decodeUnknownEffect(applicationEventSchema)(notice)).toEqual(notice);
      expect(
        Schema.is(applicationEventSchema)({
          ...notice,
          notice: { type: "device_code", verificationUri: "https://auth.example/device" },
        }),
      ).toBe(false);
      expect(
        Schema.is(applicationEventSchema)({
          ...notice,
          notice: { type: "auth_url", url: "x".repeat(16_385) },
        }),
      ).toBe(false);
      expect(events.sendTo(1, notice)).toBe(true);
      events.broadcast(notification);
      expect(yield* Queue.take(first.received)).toEqual(notice);
      expect(yield* Queue.take(first.received)).toEqual(notification);
      expect(yield* Queue.take(second.received)).toEqual(notification);
      yield* Fiber.interrupt(first.fiber);
      expect(events.sendTo(1, notice)).toBe(false);
    }).pipe(Effect.provide(ClientEventsLive)),
  );

  it.effect("client_events_broadcast_to_current_subscribers", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      events.broadcast(notification);
      const first = yield* subscribe(events.application(1));
      const second = yield* subscribe(events.application(2));
      events.broadcast(browserRequest);
      expect(yield* Queue.take(first.received)).toEqual(browserRequest);
      expect(yield* Queue.take(second.received)).toEqual(browserRequest);
      // No replay for a subscriber joining after publication.
      const late = yield* subscribe(events.application(3));
      events.broadcast(notification);
      expect(yield* Queue.take(late.received)).toEqual(notification);
    }).pipe(Effect.provide(ClientEventsLive)),
  );

  it.effect("closing_one_subscription_preserves_other_clients", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      const first = yield* subscribe(events.application(1));
      const sameClient = yield* subscribe(events.application(1));
      const second = yield* subscribe(events.application(2));
      yield* Fiber.interrupt(first.fiber);
      expect(events.sendTo(1, browserRequest)).toBe(true);
      expect(yield* Queue.take(sameClient.received)).toEqual(browserRequest);
      yield* Fiber.interrupt(sameClient.fiber);
      expect(events.sendTo(1, browserRequest)).toBe(false);
      events.broadcast(notification);
      expect(yield* Queue.take(second.received)).toEqual(notification);
      const reconnected = yield* subscribe(events.application(1));
      expect(events.sendTo(1, browserRequest)).toBe(true);
      expect(yield* Queue.take(reconnected.received)).toEqual(browserRequest);
    }).pipe(Effect.provide(ClientEventsLive)),
  );

  it.effect("reports delivery only while the recipient has a matching channel subscription", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      const terminals = yield* subscribe(events.terminals(1));
      const otherClient = yield* subscribe(events.application(2));
      expect(events.sendTo(1, browserRequest)).toBe(false);
      const application = yield* subscribe(events.application(1));
      expect(events.sendTo(1, browserRequest)).toBe(true);
      expect(yield* Queue.take(application.received)).toEqual(browserRequest);
      yield* Fiber.interrupt(application.fiber);
      expect(events.sendTo(1, browserRequest)).toBe(false);
      expect(events.sendTo(1, { type: "terminal-toggle-requested" })).toBe(true);
      expect((yield* Queue.take(terminals.received)).type).toBe("terminal-toggle-requested");
      events.broadcast(notification);
      expect(yield* Queue.take(otherClient.received)).toEqual(notification);
    }).pipe(Effect.provide(ClientEventsLive)),
  );

  it.effect("preserves focused channels and readiness before native and session events", () =>
    Effect.gen(function* () {
      const events = yield* ClientEvents;
      const application = yield* subscribe(events.application(1));
      const artifacts = yield* subscribe(events.artifacts(1));
      const terminals = yield* subscribe(events.terminals(1));
      const vscode = yield* subscribe(events.vscode(1));
      const surfaces = yield* subscribe(events.surfaces(1));
      for (const [subscription, channel] of [
        [application, "application"],
        [artifacts, "artifacts"],
        [terminals, "terminals"],
        [vscode, "vscode"],
        [surfaces, "surfaces"],
      ] as const)
        expect(subscription.ready).toEqual({ type: "renderer-events-ready", channel });
      events.sendTo(1, { type: "terminal-toggle-requested" });
      events.sendTo(1, browserRequest);
      events.broadcast({
        type: "artifact-catalog-invalidated",
        lineageId: "00000000-0000-4000-8000-000000000001",
      });
      events.sendTo(1, { type: "embedded-editor-toggle-mode-requested" });
      events.sendTo(1, { type: "fullscreen-surface-close-requested", surfaceId: "surface-1" });
      expect(yield* Queue.take(application.received)).toEqual(browserRequest);
      expect((yield* Queue.take(artifacts.received)).type).toBe("artifact-catalog-invalidated");
      events.broadcast({
        type: "message-board-invalidated",
        lineageId: Schema.decodeUnknownSync(ArtifactLineageId)("family-board-test"),
      });
      expect((yield* Queue.take(artifacts.received)).type).toBe("message-board-invalidated");
      expect((yield* Queue.take(terminals.received)).type).toBe("terminal-toggle-requested");
      expect((yield* Queue.take(vscode.received)).type).toBe(
        "embedded-editor-toggle-mode-requested",
      );
      expect((yield* Queue.take(surfaces.received)).type).toBe(
        "fullscreen-surface-close-requested",
      );
    }).pipe(Effect.provide(ClientEventsLive)),
  );
});
