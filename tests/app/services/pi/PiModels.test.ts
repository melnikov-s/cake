import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Cache, Deferred, Effect, Fiber, Ref } from "effect";
import { describe, it as vitestIt, vi } from "vitest";
import {
  makePiModelsLayer,
  PiModels,
  type PiModelsAdapter,
} from "../../../../src/services/pi/PiModels";
import type { PiModel } from "../../../../src/contracts/pi/model-data";
import {
  makePiModelsLive,
  makeSessionlessRuntimeCache,
  projectModelCatalog,
} from "../../../../src/services/pi/live/PiModelsLive";

const model = (overrides: Partial<PiModel> = {}): PiModel => ({
  provider: "openai-codex",
  providerName: "OpenAI Codex",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  reasoning: true,
  supportedThinkingLevels: ["off", "low", "high"],
  fastMode: true,
  input: ["text", "image"],
  authenticated: true,
  available: true,
  authSource: "stored",
  authLabel: "OAuth",
  authTypes: ["oauth"],
  ...overrides,
});

const selection = {
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high" as const,
  fastMode: true,
};

const run = <A, E>(models: ReadonlyArray<PiModel>, effect: Effect.Effect<A, E, PiModels>) => {
  const adapter: PiModelsAdapter = {
    loadCatalog: () => Effect.succeed(models),
    loadNonChatCatalog: () => Effect.succeed([]),
    refreshCatalog: () => Effect.void,
    login: () => Effect.void,
    logout: () => Effect.void,
    complete: () => Effect.succeed("completed response"),
  };
  return effect.pipe(Effect.provide(makePiModelsLayer(adapter)));
};

const resolve = (models: ReadonlyArray<PiModel>, input = selection) =>
  run(
    models,
    Effect.gen(function* () {
      const service = yield* PiModels;
      return yield* service.resolve(input);
    }),
  );

const resolveError = (models: ReadonlyArray<PiModel>, input = selection) =>
  Effect.flip(resolve(models, input));

describe("PiModels", () => {
  vitestIt(
    "gives short utility completions room for reasoning independently of the display limit",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cake-utility-budget-"));
      const checkAuth = vi
        .spyOn(ModelRuntime.prototype, "checkAuth")
        .mockResolvedValue({ type: "api_key", source: "fixture" });
      const available = vi
        .spyOn(ModelRuntime.prototype, "getAvailable")
        .mockImplementation(async function (this: ModelRuntime, provider) {
          return this.getModels(provider);
        });
      const complete = vi
        .spyOn(ModelRuntime.prototype, "completeSimple")
        .mockImplementation(async (model, _context, options) => {
          assert.equal(options?.maxTokens, 2_048);
          assert.equal(options?.reasoning, "low");
          return {
            role: "assistant",
            content: [{ type: "text", text: "Useful title " + "x".repeat(100) }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 0,
          };
        });
      try {
        const title = await Effect.runPromise(
          Effect.gen(function* () {
            const models = yield* PiModels;
            return yield* models.complete({
              selection: {
                provider: "openai",
                modelId: "gpt-5-mini",
                thinkingLevel: "low",
                fastMode: false,
              },
              instructions: "Create a title",
              context: "Investigate naming",
              maximumOutputCharacters: 80,
              timeoutMs: 15_000,
            });
          }).pipe(Effect.provide(makePiModelsLive(directory))),
        );
        assert.equal(title.length, 80);
        assert.equal(complete.mock.calls.length, 1);
      } finally {
        complete.mockRestore();
        available.mockRestore();
        checkAuth.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  vitestIt(
    "sends the shared memory system/tools prefix and real assistant/user shortening turns without a utility wrapper",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cake-memory-prefix-"));
      const auth = vi
        .spyOn(ModelRuntime.prototype, "checkAuth")
        .mockResolvedValue({ type: "api_key", source: "fixture" });
      const available = vi
        .spyOn(ModelRuntime.prototype, "getAvailable")
        .mockImplementation(async function (this: ModelRuntime, provider) {
          return this.getModels(provider);
        });
      const tools = [
        {
          name: "zoom",
          description: "Open original detail",
          parameters: { type: "object", properties: {} },
        },
      ];
      const previous = [
        { role: "assistant" as const, text: "An oversized first line" },
        { role: "user" as const, text: "Too long: shorten the same input" },
      ];
      const complete = vi
        .spyOn(ModelRuntime.prototype, "completeSimple")
        .mockImplementation(async (model, context) => {
          assert.equal(context.systemPrompt, "Stable coordinator system and compaction rules");
          assert.deepEqual(context.tools, tools);
          assert.deepEqual(
            context.messages.map((message) => message.role),
            ["user", "assistant", "user"],
          );
          assert.equal(
            context.messages[0]?.content,
            "<chat>built prefix</chat>\\nCompaction: compress message 4",
          );
          assert.deepEqual(context.messages[1]?.content, [
            { type: "text", text: previous[0]!.text },
          ]);
          assert.equal(context.messages[2]?.content, previous[1]!.text);
          return {
            role: "assistant",
            content: [{ type: "text", text: "Fits now" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 0,
          };
        });
      try {
        const answer = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* PiModels).complete({
              selection: {
                provider: "openai",
                modelId: "gpt-5-mini",
                thinkingLevel: "low",
                fastMode: false,
              },
              instructions: "Stable coordinator system and compaction rules",
              context: "<chat>built prefix</chat>\\nCompaction: compress message 4",
              chat: { tools, previous },
              maximumOutputCharacters: 4_096,
              timeoutMs: 120_000,
            });
          }).pipe(Effect.provide(makePiModelsLive(directory))),
        );
        assert.equal(answer, "Fits now");
      } finally {
        complete.mockRestore();
        available.mockRestore();
        auth.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  vitestIt("supplies and persists Pi's installation ID for provider login", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-provider-device-id-"));
    const deviceIds: Array<string | undefined> = [];
    const login = vi
      .spyOn(ModelRuntime.prototype, "login")
      .mockImplementation(async (_provider, _type, _interaction, options) => {
        deviceIds.push(options?.getDeviceId?.());
        return { type: "api_key", key: "fixture" };
      });
    const interaction = { request: async () => undefined, notify: () => undefined };
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const models = yield* PiModels;
          yield* models.login("openai", "oauth", interaction);
          yield* models.login("openai", "oauth", interaction);
        }).pipe(Effect.provide(makePiModelsLive(directory))),
      );
      assert.match(
        deviceIds[0] ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(deviceIds[1], deviceIds[0]);
      const persisted = SettingsManager.create(directory, directory);
      assert.equal(persisted.getGlobalSettings().deviceId, deviceIds[0]);
      assert.equal(persisted.getOrCreateDeviceId(), deviceIds[0]);
      await persisted.flush();
    } finally {
      login.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  vitestIt("refuses to remove an externally managed environment credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-provider-auth-"));
    vi.stubEnv("OPENAI_API_KEY", "test-external-credential");
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const models = yield* PiModels;
          return yield* Effect.exit(models.logout("openai"));
        }).pipe(Effect.provide(makePiModelsLive(directory))),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.cause), /managed outside Cake/);
      }
      assert.doesNotMatch(
        await readFile(join(directory, "auth.json"), "utf8"),
        /test-external-credential/,
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  vitestIt("projects the controlled Pi provider catalog", async () => {
    const projected = await projectModelCatalog(
      {
        getProviders: () => [
          {
            id: "openai-codex",
            name: "OpenAI Codex",
            auth: { oauth: {} },
            getModels: () => [
              {
                id: "gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                reasoning: true,
                input: ["text", "image"],
              },
            ],
          },
        ],
        checkAuth: async () => ({ source: "OAuth" }),
        getAvailable: async () => [{ id: "gpt-5.6-sol" }],
        getProviderAuthStatus: () => ({ source: "stored", label: "OAuth" }),
      },
      () => ["off", "low", "high"],
    );
    assert.deepEqual(projected[0], {
      ...projected[0],
      provider: "openai-codex",
      providerName: "OpenAI Codex",
      id: "gpt-5.6-sol",
      authenticated: true,
      available: true,
      fastMode: true,
      authSource: "stored",
      authLabel: "OAuth",
      authTypes: ["oauth"],
    });
  });

  vitestIt.each(["openai", "openai-codex"])(
    "projects Fast support for current Sol and Astra models from %s",
    async (provider) => {
      const ids = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.3-codex-spark"];
      const projected = await projectModelCatalog(
        {
          getProviders: () => [
            {
              id: provider,
              name: provider,
              auth: { oauth: {} },
              getModels: () =>
                ids.map((id) => ({
                  id,
                  name: id,
                  reasoning: true,
                  input: ["text"] as const,
                })),
            },
          ],
          checkAuth: async () => ({ source: "OAuth" }),
          getAvailable: async () => ids.map((id) => ({ id })),
          getProviderAuthStatus: () => ({ source: "stored", label: "OAuth" }),
        },
        () => ["high"],
      );
      assert.deepEqual(
        projected.map(({ id, fastMode }) => ({ id, fastMode })),
        ids.map((id) => ({ id, fastMode: id !== "gpt-5.3-codex-spark" })),
      );
    },
  );

  it.effect("shares successful runtime acquisition and immediately evicts failures", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const release = yield* Deferred.make<void>();
      const runtime = { id: "runtime" };
      const cache = yield* makeSessionlessRuntimeCache(
        Effect.gen(function* () {
          const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1);
          if (attempt === 0) return yield* Effect.fail("initialization failed" as const);
          yield* Deferred.await(release);
          return runtime;
        }),
      );

      assert.equal(yield* Effect.flip(Cache.get(cache, "runtime")), "initialization failed");
      const first = yield* Effect.forkChild(Cache.get(cache, "runtime"));
      const second = yield* Effect.forkChild(Cache.get(cache, "runtime"));
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* Fiber.join(first), runtime);
      assert.equal(yield* Fiber.join(second), runtime);
      assert.equal(yield* Ref.get(attempts), 2);
      assert.equal(yield* Cache.get(cache, "runtime"), runtime);
      assert.equal(yield* Ref.get(attempts), 2);
    }),
  );

  it.effect(
    "projects provider/model identity, authentication, thinking levels, and Fast support",
    () =>
      Effect.gen(function* () {
        const catalog = yield* run(
          [model()],
          Effect.gen(function* () {
            return yield* (yield* PiModels).list();
          }),
        );
        assert.deepEqual(catalog, [model()]);
      }),
  );

  it.effect("resolves only the exact authenticated and available selection", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* resolve([model()]), selection);
      const error = yield* resolveError([model(), model({ provider: "other", id: "fallback" })], {
        ...selection,
        modelId: "missing",
      });
      assert.equal(error._tag, "UnknownPiModelError");
      assert.equal(error.modelId, "missing");
    }),
  );

  it.effect("distinguishes unauthenticated and unavailable models", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* resolveError([model({ authenticated: false })]))._tag,
        "UnauthenticatedPiModelError",
      );
      assert.equal(
        (yield* resolveError([model({ available: false })]))._tag,
        "UnavailablePiModelError",
      );
    }),
  );

  it.effect("rejects unsupported thinking levels and Fast mode", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* resolveError([model({ supportedThinkingLevels: ["off", "low"] })]))._tag,
        "UnsupportedThinkingLevelError",
      );
      assert.equal(
        (yield* resolveError([model({ fastMode: false })]))._tag,
        "UnsupportedFastModeError",
      );
    }),
  );

  it.effect("rejects malformed catalog projections at the Pi boundary", () => {
    const layer = makePiModelsLayer({
      loadCatalog: () => Effect.succeed([{ id: "missing-required-fields" }]),
      loadNonChatCatalog: () => Effect.succeed([]),
      refreshCatalog: () => Effect.void,
      login: () => Effect.void,
      logout: () => Effect.void,
      complete: () => Effect.succeed(""),
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* PiModels).list());
      assert.equal(error._tag, "PiModelCatalogError");
      assert.match(error.message, /provider/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports catalog loading failures", () => {
    const layer = makePiModelsLayer({
      loadCatalog: () => Effect.fail(new Error("catalog unavailable")),
      loadNonChatCatalog: () => Effect.succeed([]),
      refreshCatalog: () => Effect.void,
      login: () => Effect.void,
      logout: () => Effect.void,
      complete: () => Effect.succeed(""),
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* PiModels).list());
      assert.equal(error._tag, "PiModelCatalogError");
      assert.equal(error.operation, "load");
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs bounded completion with the exact resolved selection", () => {
    let received: Parameters<PiModelsAdapter["complete"]>[0] | undefined;
    const layer = makePiModelsLayer({
      loadCatalog: () => Effect.succeed([model()]),
      loadNonChatCatalog: () => Effect.succeed([]),
      refreshCatalog: () => Effect.void,
      login: () => Effect.void,
      logout: () => Effect.void,
      complete: (input) =>
        Effect.sync(() => {
          received = input;
          return "response beyond bound";
        }),
    });
    return Effect.gen(function* () {
      const result = yield* (yield* PiModels).complete({
        selection,
        instructions: "Return a title",
        context: "context",
        maximumOutputCharacters: 8,
        timeoutMs: 1_000,
      });
      assert.equal(result, "response");
      assert.deepEqual(received?.selection, selection);
    }).pipe(Effect.provide(layer));
  });

  it.effect("interrupts the provider request when bounded completion is cancelled", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const layer = makePiModelsLayer({
        loadCatalog: () => Effect.succeed([model()]),
        loadNonChatCatalog: () => Effect.succeed([]),
        refreshCatalog: () => Effect.void,
        login: () => Effect.void,
        logout: () => Effect.void,
        complete: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      });
      const operation = Effect.gen(function* () {
        return yield* (yield* PiModels).complete({
          selection,
          instructions: "Return a title",
          context: "context",
          maximumOutputCharacters: 80,
          timeoutMs: 1_000,
        });
      }).pipe(Effect.provide(layer));
      const fiber = yield* Effect.forkChild(operation);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("returns a typed bounded-completion failure", () => {
    const layer = makePiModelsLayer({
      loadCatalog: () => Effect.succeed([model()]),
      loadNonChatCatalog: () => Effect.succeed([]),
      refreshCatalog: () => Effect.void,
      login: () => Effect.void,
      logout: () => Effect.void,
      complete: () => Effect.fail(new Error("provider failed")),
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        (yield* PiModels).complete({
          selection,
          instructions: "Return a title",
          context: "context",
          maximumOutputCharacters: 80,
          timeoutMs: 1_000,
        }),
      );
      assert.equal(error._tag, "PiModelCompletionError");
      assert.match(error.message, /provider failed/);
    }).pipe(Effect.provide(layer));
  });
});
