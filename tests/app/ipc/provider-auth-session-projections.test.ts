import { it } from "@effect/vitest";
import { Context, Effect, Layer, Stream } from "effect";
import { describe, expect } from "vitest";
import { providerAuthHandlers } from "../../../src/ipc/server/ProviderAuthHandlers";
import { RendererConnection } from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { makePiModelsLayer } from "../../../src/services/pi/PiModels";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { fakeRuntime, options, snapshot } from "../helpers/piRuntimeFixture";

const projectedModel = (authenticated: boolean) => ({
  provider: "example",
  providerName: "Example",
  id: "test-model",
  name: "Test Model",
  reasoning: false,
  availableThinkingLevels: ["off" as const],
  input: ["text" as const],
  authenticated,
  available: authenticated,
  authSource: authenticated ? ("stored" as const) : undefined,
  authTypes: ["api_key" as const],
});

describe("provider auth across acquired Pi sessions", () => {
  it.effect(
    "Settings and Project/Cake Chat session login share server credentials and refresh both active snapshots on login/logout",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const credentials = { value: undefined as string | undefined };
          const refreshes = new Map<string, number>();
          const sessionsLayer = makeCakeSessionRuntimesLayer({
            sessionIds: () => Stream.empty,
            catalog: () => Stream.empty,
            catalogEntry: () => Effect.succeed(undefined),
            inspect: () => Effect.succeed(undefined),
            changelog: () => Effect.succeed(""),
            createRuntime: (runtimeOptions) =>
              Effect.sync(() => {
                const sessionId = runtimeOptions.sessionId ?? "session-1";
                let authenticated = credentials.value !== undefined;
                const current = () => ({
                  ...snapshot,
                  sessionId,
                  models: [projectedModel(authenticated)],
                });
                return {
                  ...fakeRuntime(runtimeOptions, () => undefined),
                  sessionId,
                  snapshot: async () => current(),
                  refreshModels: async () => {
                    authenticated = credentials.value !== undefined;
                    refreshes.set(sessionId, (refreshes.get(sessionId) ?? 0) + 1);
                    runtimeOptions.onEvent({ type: "snapshot", snapshot: current() });
                  },
                };
              }),
          });
          const layer = Layer.mergeAll(
            sessionsLayer,
            makePiModelsLayer({
              loadCatalog: () => Effect.succeed([]),
              refreshCatalog: () => Effect.void,
              complete: () => Effect.succeed(""),
              login: (_provider, _type, interaction) =>
                Effect.tryPromise({
                  try: async () => {
                    const secret = await interaction.request({
                      kind: "secret",
                      message: "Provider key",
                    });
                    if (!secret) throw new Error("Cancelled");
                    credentials.value = secret;
                  },
                  catch: (cause) => cause,
                }),
              logout: () =>
                Effect.sync(() => {
                  credentials.value = undefined;
                }),
            }),
            Layer.mock(ClientEvents, { sendTo: () => true, broadcast: () => undefined }),
            Layer.mock(RendererRequestCoordinator, {
              requestUiForConnection: () => Effect.succeed("server-key"),
            }),
          );
          const context = yield* Layer.build(layer);
          const sessions = Context.get(context, CakeSessionRuntimes);
          const project = yield* sessions.acquire(options());
          const cakeChat = yield* sessions.acquire({
            ...options({
              sessionId: "cake-chat-1",
              globalControl: { tools: [], invoke: async () => null },
            }),
            profile: { _tag: "CakeChatSession" },
          });
          const invoke = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(RendererConnection, {
                connectionId: 11,
                correlationId: "auth",
              }),
              Effect.provide(context),
            );
          expect((yield* project.snapshot()).models[0]?.authenticated).toBe(false);
          expect((yield* cakeChat.snapshot()).models[0]?.authenticated).toBe(false);
          yield* invoke(
            providerAuthHandlers["models.login"]({ provider: "example", authType: "api_key" }),
          );
          expect((yield* project.snapshot()).models[0]?.authenticated).toBe(true);
          expect((yield* cakeChat.snapshot()).models[0]?.authenticated).toBe(true);
          expect([...refreshes.values()]).toEqual([1, 1]);
          yield* invoke(
            providerAuthHandlers["sessionChats.logout"]({
              provider: "example",
              sessionId: "cake-chat-1",
            }),
          );
          expect(credentials.value).toBeUndefined();
          expect((yield* project.snapshot()).models[0]?.authenticated).toBe(false);
          expect((yield* cakeChat.snapshot()).models[0]?.authenticated).toBe(false);
          expect([...refreshes.values()]).toEqual([2, 2]);
          yield* invoke(
            providerAuthHandlers["sessionChats.login"]({
              provider: "example",
              authType: "api_key",
              sessionId: "session-1",
            }),
          );
          expect((yield* project.snapshot()).models[0]?.authenticated).toBe(true);
          expect((yield* cakeChat.snapshot()).models[0]?.authenticated).toBe(true);
          yield* invoke(providerAuthHandlers["models.logout"]({ provider: "example" }));
          expect(credentials.value).toBeUndefined();
        }),
      ),
  );
});
