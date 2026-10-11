import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue, Stream } from "effect";
import { expect } from "vitest";
import type { CakeEvent } from "../../src/contracts/application/cake-rpc-contract";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { PiModels, makePiModels } from "../../src/services/pi/PiModels";
import { SavedDraftStorage } from "../../src/services/storage/SavedDraftStorage";
import { ApplicationState } from "../../src/services/storage/ApplicationState";
import { connectClient } from "./fixtures/network-client";
import { observeNetworkEvents as observe } from "./fixtures/network-events";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

const configuration = {
  homeDirectory: "/home/test",
  cakeChat: {
    agentDirectory: "/agent",
    location: cakeChatLocations.make({
      homeDirectory: "/home/test",
      sessionDirectory: "/chat",
      resolvedSessionDirectory: "/chat-resolved",
    }),
  },
};

it.live(
  "remote image/classifier preferences and catalogs use the server authority across devices",
  () =>
    Effect.gen(function* () {
      const backend = yield* makeNetworkTestBackend();
      const models = makePiModels({
        loadCatalog: () => Effect.succeed([]),
        loadNonChatCatalog: () =>
          Effect.succeed([
            {
              type: "classifier",
              provider: "typesafe",
              providerName: "TypeSafe",
              id: "jev-latest",
              name: "Jev",
              input: ["text"],
              authenticated: false,
              available: false,
              authTypes: ["api_key"],
            },
          ]),
        refreshCatalog: () => Effect.void,
        complete: () => Effect.succeed(""),
        login: () => Effect.void,
        logout: () => Effect.void,
      });
      const context = Context.add(backend.context, PiModels, models);
      const listener = yield* openNetworkListener(
        { port: 0, allowMissingOrigin: true },
        configuration,
      ).pipe(Effect.provide(Layer.mock(SavedDraftStorage, {})), Effect.provideContext(context));
      assert.equal(listener.address._tag, "TcpAddress");
      const url = `ws://127.0.0.1:${listener.address.port}${listener.path}`;
      const a = yield* connectClient(url);
      const b = yield* connectClient(url);
      const preference = { provider: "typesafe", modelId: "jev-latest" };
      expect(yield* a.client["nonChatModels.list"]()).toEqual([
        expect.objectContaining({ type: "classifier", authenticated: false, available: false }),
      ]);
      yield* a.client["nonChatModels.updatePreference"]({ type: "classifier", preference });
      expect((yield* b.client["application.getState"]()).nonChatModelPreferences).toEqual({
        classifier: preference,
      });
      expect(
        (yield* Context.get(context, ApplicationState).current()).nonChatModelPreferences,
      ).toEqual({ classifier: preference });
      expect(yield* b.client["models.list"]()).toEqual([]);
      yield* b.client["nonChatModels.updatePreference"]({ type: "classifier", preference: null });
      expect((yield* a.client["application.getState"]()).nonChatModelPreferences).toEqual({});
      yield* a.close();
      yield* b.close();
    }),
);

it.live("disconnecting during device authorization aborts the server's provider operation", () =>
  Effect.gen(function* () {
    const backend = yield* makeNetworkTestBackend();
    const started = yield* Deferred.make<void>();
    const aborted = yield* Deferred.make<void>();
    let persisted = false;
    const models = makePiModels({
      loadCatalog: () => Effect.succeed([]),
      loadNonChatCatalog: () => Effect.succeed([]),
      refreshCatalog: () => Effect.void,
      complete: () => Effect.succeed(""),
      login: (_provider, _type, interaction) =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<void>((resolve) => {
              interaction.notify({
                type: "device_code",
                verificationUri: "https://accounts.example/device",
                userCode: "TEST",
              });
              void Effect.runPromise(Deferred.succeed(started, undefined));
              signal.addEventListener(
                "abort",
                () => {
                  void Effect.runPromise(Deferred.succeed(aborted, undefined));
                  resolve();
                },
                { once: true },
              );
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              persisted = true;
            }),
          ),
        ),
      logout: () => Effect.void,
    });
    const context = Context.add(backend.context, PiModels, models);
    const listener = yield* openNetworkListener(
      { port: 0, allowMissingOrigin: true },
      configuration,
    ).pipe(Effect.provide(Layer.mock(SavedDraftStorage, {})), Effect.provideContext(context));
    assert.equal(listener.address._tag, "TcpAddress");
    const a = yield* connectClient(`ws://127.0.0.1:${listener.address.port}${listener.path}`);
    const notices = yield* Queue.unbounded<CakeEvent>();
    yield* a.client["application.observeEvents"]().pipe(
      Stream.runForEach((event) => Queue.offer(notices, event)),
      Effect.forkScoped,
    );
    yield* Queue.take(notices);
    const login = yield* a.client["models.login"]({ provider: "example", authType: "oauth" }).pipe(
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    expect(yield* Queue.take(notices)).toMatchObject({
      type: "provider-auth-notice",
      notice: { type: "device_code" },
    });
    yield* a.close();
    yield* Deferred.await(aborted).pipe(Effect.timeout("2 seconds"));
    expect(persisted).toBe(false);
    yield* Fiber.await(login);
  }),
);

it.live(
  "two remote clients use one server credential authority; only the initiating device sees and answers provider auth",
  () =>
    Effect.gen(function* () {
      const credentials = { value: undefined as string | undefined };
      const backend = yield* makeNetworkTestBackend();
      const models = makePiModels({
        loadCatalog: () => Effect.succeed([]),
        loadNonChatCatalog: () => Effect.succeed([]),
        refreshCatalog: () => Effect.void,
        complete: () => Effect.succeed(""),
        login: (_provider, _type, interaction) =>
          Effect.tryPromise({
            try: async (signal) => {
              interaction.notify({
                type: "device_code",
                verificationUri: "https://accounts.example/device",
                userCode: "TEST-CODE",
              });
              const secret = await interaction.request({
                kind: "secret",
                message: "Provider key",
                signal,
              });
              if (!secret) throw new Error("Login cancelled");
              credentials.value = secret;
            },
            catch: (cause) => cause,
          }),
        logout: () =>
          Effect.sync(() => {
            credentials.value = undefined;
          }),
      });
      const context = Context.add(backend.context, PiModels, models);
      const listener = yield* openNetworkListener(
        { port: 0, allowMissingOrigin: true },
        configuration,
      ).pipe(Effect.provide(Layer.mock(SavedDraftStorage, {})), Effect.provideContext(context));
      assert.equal(listener.address._tag, "TcpAddress");
      const url = `ws://127.0.0.1:${listener.address.port}${listener.path}`;
      const a = yield* connectClient(url);
      const b = yield* connectClient(url);
      const eventsA = yield* observe(a.client["application.observeEvents"]());
      const formsA = yield* observe(a.client["artifacts.observeEvents"]());
      const eventsB = yield* observe(b.client["application.observeEvents"]());
      const formsB = yield* observe(b.client["artifacts.observeEvents"]());
      const login = yield* a.client["models.login"]({
        provider: "example",
        authType: "api_key",
      }).pipe(Effect.forkScoped);
      expect(yield* eventsA.next()).toMatchObject({
        type: "provider-auth-notice",
        provider: "example",
        notice: {
          type: "device_code",
          verificationUri: "https://accounts.example/device",
          userCode: "TEST-CODE",
        },
      });
      const prompt = yield* formsA.next();
      if (prompt.type !== "ui-request") throw new Error(`Expected auth form, got ${prompt.type}`);
      expect(prompt.kind).toBe("secret");
      expect(Option.isNone(yield* Queue.poll(eventsB.events))).toBe(true);
      expect(Option.isNone(yield* Queue.poll(formsB.events))).toBe(true);
      const reply = {
        sessionId: prompt.sessionId,
        requestId: prompt.requestId,
        uiRequestId: prompt.uiRequestId,
        cancelled: false,
        value: "private-key",
      };
      expect((yield* b.client["artifacts.respond-ui"](reply).pipe(Effect.exit))._tag).toBe(
        "Failure",
      );
      expect(credentials.value).toBeUndefined();
      yield* a.client["artifacts.respond-ui"](reply);
      yield* Fiber.join(login);
      expect(credentials.value).toBe("private-key");
      yield* b.client["models.logout"]({ provider: "example" });
      expect(credentials.value).toBeUndefined();
      yield* a.close();
      yield* b.close();
    }),
);
