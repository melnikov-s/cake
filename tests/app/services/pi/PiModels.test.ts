import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cache, Deferred, Effect, Fiber, Ref } from "effect";
import { describe, it as vitestIt } from "vitest";
import {
  makePiModelsLayer,
  PiModels,
  type PiModelsAdapter,
} from "../../../../src/services/pi/PiModels";
import type { PiModel } from "../../../../src/services/pi/model-data";
import {
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
    refreshCatalog: () => Effect.void,
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
      refreshCatalog: () => Effect.void,
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
      refreshCatalog: () => Effect.void,
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
      refreshCatalog: () => Effect.void,
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
        refreshCatalog: () => Effect.void,
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
      refreshCatalog: () => Effect.void,
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
