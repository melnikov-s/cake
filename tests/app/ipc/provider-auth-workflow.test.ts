import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue, Stream } from "effect";
import { describe, expect } from "vitest";
import type { CakeEvent } from "../../../src/ipc/cake-rpc-contract";
import { RendererConnection } from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import { providerAuthHandlers } from "../../../src/ipc/server/ProviderAuthHandlers";
import { ClientConnectionsLive } from "../../../src/services/clients/ClientConnections";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../src/services/clients/ClientEventsLive";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { makePiModelsLayer } from "../../../src/services/pi/PiModels";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../src/services/renderer-requests/RendererRequestCoordinator";

const testFixture = Effect.fn("ProviderAuthTest.fixture")(function* (
  flow: "device" | "manual" = "device",
) {
  const credentials = { value: undefined as string | undefined };
  const refreshed = { count: 0 };
  const authorizationStarted = yield* Deferred.make<void>();
  const eventsA = yield* Queue.unbounded<CakeEvent>();
  const eventsB = yield* Queue.unbounded<CakeEvent>();
  const eventsLayer = RendererRequestCoordinatorLive.pipe(
    Layer.provideMerge(Layer.merge(ClientConnectionsLive, ClientEventsLive)),
  );
  const layer = Layer.mergeAll(
    eventsLayer,
    makePiModelsLayer({
      loadCatalog: () => Effect.succeed([]),
      refreshCatalog: () => Effect.void,
      complete: () => Effect.succeed(""),
      login: (_provider, _authType, interaction) =>
        Effect.tryPromise({
          try: async (signal) => {
            interaction.notify(
              flow === "device"
                ? {
                    type: "device_code",
                    verificationUri: "https://example.test/device",
                    userCode: "ABCD-EFGH",
                  }
                : {
                    type: "auth_url",
                    url: "https://auth.example/authorize?state=unique",
                    instructions: "Sign in",
                  },
            );
            // Keep a real server-side PiModels adapter in control of the credential
            // until the initiating renderer answers its secret prompt.
            await Effect.runPromise(Deferred.succeed(authorizationStarted, undefined));
            const answer = await interaction.request({
              kind: flow === "manual" ? "manual_code" : "secret",
              message: flow === "manual" ? "Paste redirect URL" : "API key",
              signal,
            });
            if (!answer) throw new Error("Authentication cancelled");
            credentials.value = answer;
          },
          catch: (cause) => cause,
        }),
      logout: () =>
        Effect.sync(() => {
          credentials.value = undefined;
        }),
    }),
    Layer.mock(CakeSessionRuntimes, {
      refreshModels: () =>
        Effect.sync(() => {
          refreshed.count++;
        }),
    }),
  );
  const context = yield* Layer.build(layer);
  const clientEvents = Context.get(context, ClientEvents);
  const ready = yield* Queue.unbounded<void>();
  for (const [id, events] of [
    [11, eventsA],
    [22, eventsB],
  ] as const) {
    yield* Stream.merge(clientEvents.application(id), clientEvents.artifacts(id)).pipe(
      Stream.runForEach((event) =>
        event.type === "renderer-events-ready"
          ? Queue.offer(ready, undefined)
          : Queue.offer(events, event),
      ),
      Effect.forkScoped,
    );
    yield* Queue.take(ready);
    yield* Queue.take(ready);
  }
  const coordinator = Context.get(context, RendererRequestCoordinator);
  const from = (connectionId: number) =>
    Effect.provideService(
      providerAuthHandlers["models.login"]({ provider: "example", authType: "api_key" }),
      RendererConnection,
      { connectionId, correlationId: `auth-${connectionId}` },
    ).pipe(Effect.provide(context));
  return {
    credentials,
    refreshed,
    eventsA,
    eventsB,
    authorizationStarted,
    from,
    coordinator,
    context,
  };
});

describe("server-owned interactive provider authentication", () => {
  it.effect(
    "targets device URL and secret form to the initiating client; rejects another client's answer; refreshes and logs out on server",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* testFixture();
          const login = yield* fixture.from(11).pipe(Effect.forkChild({ startImmediately: true }));
          const notice = yield* Effect.race(
            Queue.take(fixture.eventsA),
            Fiber.await(login).pipe(
              Effect.map((exit) => {
                throw new Error(`Login ended before notice: ${JSON.stringify(exit)}`);
              }),
            ),
          );
          expect(notice).toMatchObject({
            type: "provider-auth-notice",
            provider: "example",
            notice: {
              type: "device_code",
              verificationUri: "https://example.test/device",
              userCode: "ABCD-EFGH",
            },
          });
          yield* Deferred.await(fixture.authorizationStarted);
          const prompt = yield* Queue.take(fixture.eventsA);
          if (prompt.type !== "ui-request")
            throw new Error(`Expected secret prompt, got ${prompt.type}`);
          expect(prompt.kind).toBe("secret");
          expect(Option.isNone(yield* Queue.poll(fixture.eventsB))).toBe(true);
          const response = {
            sessionId: prompt.sessionId,
            requestId: prompt.requestId,
            uiRequestId: prompt.uiRequestId,
            cancelled: false,
            value: "server-secret",
          };
          expect(
            (yield* fixture.coordinator.respondUi(22, prompt.sessionId, response).pipe(Effect.exit))
              ._tag,
          ).toBe("Failure");
          yield* fixture.coordinator.respondUi(11, prompt.sessionId, response);
          yield* Fiber.join(login);
          expect(fixture.credentials.value).toBe("server-secret");
          expect(fixture.refreshed.count).toBe(1);
          yield* providerAuthHandlers["models.logout"]({ provider: "example" }).pipe(
            Effect.provide(fixture.context),
          );
          expect(fixture.credentials.value).toBeUndefined();
          expect(fixture.refreshed.count).toBe(2);
        }),
      ),
  );

  it.effect(
    "manual-code OAuth presents the actual remote authorization URL in the local form",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* testFixture("manual");
          const login = yield* fixture.from(11).pipe(Effect.forkChild({ startImmediately: true }));
          const notice = yield* Queue.take(fixture.eventsA);
          expect(notice).toMatchObject({
            type: "provider-auth-notice",
            notice: { type: "auth_url", url: "https://auth.example/authorize?state=unique" },
          });
          const prompt = yield* Queue.take(fixture.eventsA);
          if (prompt.type !== "ui-request") throw new Error("Expected manual code form");
          expect(prompt.kind).toBe("manual_code");
          expect(prompt.message).toContain("https://auth.example/authorize?state=unique");
          expect(prompt.message).toContain("paste it here");
          yield* fixture.coordinator.respondUi(11, prompt.sessionId, {
            sessionId: prompt.sessionId,
            requestId: prompt.requestId,
            uiRequestId: prompt.uiRequestId,
            cancelled: false,
            value: "https://server.example/callback?code=one-time",
          });
          yield* Fiber.join(login);
          expect(fixture.credentials.value).toContain("one-time");
        }),
      ),
  );

  it.effect("interrupting login cancels Pi's prompt without persisting a credential", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testFixture();
        const login = yield* fixture.from(11).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Queue.take(fixture.eventsA);
        const prompt = yield* Queue.take(fixture.eventsA);
        if (prompt.type !== "ui-request") throw new Error("Expected authentication form");
        yield* Fiber.interrupt(login);
        expect(fixture.credentials.value).toBeUndefined();
        expect(fixture.refreshed.count).toBe(0);
        yield* fixture.coordinator.respondUi(11, prompt.sessionId, {
          sessionId: prompt.sessionId,
          requestId: prompt.requestId,
          uiRequestId: prompt.uiRequestId,
          cancelled: false,
          value: "late-secret",
        });
        expect(fixture.credentials.value).toBeUndefined();
      }),
    ),
  );

  it.effect("disconnect cancels the form and cannot store a credential", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testFixture();
        const login = yield* fixture.from(11).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.race(
          Queue.take(fixture.eventsA),
          Fiber.await(login).pipe(
            Effect.map((exit) => {
              throw new Error(`Login ended before notice: ${JSON.stringify(exit)}`);
            }),
          ),
        ); // targeted device URL
        const prompt = yield* Queue.take(fixture.eventsA);
        if (prompt.type !== "ui-request") throw new Error("Expected secret prompt");
        yield* fixture.coordinator.releaseConnection(11);
        expect((yield* Fiber.await(login))._tag).toBe("Failure");
        expect(fixture.credentials.value).toBeUndefined();
        expect(fixture.refreshed.count).toBe(0);
        yield* fixture.coordinator.respondUi(22, prompt.sessionId, {
          sessionId: prompt.sessionId,
          requestId: prompt.requestId,
          uiRequestId: prompt.uiRequestId,
          cancelled: false,
          value: "stolen",
        });
        expect(fixture.credentials.value).toBeUndefined();
      }),
    ),
  );
});
