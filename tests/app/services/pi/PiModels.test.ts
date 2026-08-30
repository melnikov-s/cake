import assert from "node:assert/strict";
import { Effect } from "effect";
import { describe, it } from "vitest";
import {
  makePiModelsLayer,
  PiModels,
  type PiModelsAdapter,
} from "../../../../src/services/pi/PiModels";
import type { PiModel } from "../../../../src/services/pi/model-data";
import { projectModelCatalog } from "../../../../src/services/pi/live/PiModelsLive";

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
    loadCatalog: async () => models,
    refreshCatalog: async () => undefined,
    complete: async () => "completed response",
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
  it("projects the controlled Pi provider catalog", async () => {
    const projected = await projectModelCatalog({
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
              api: "openai-codex-responses",
            },
          ],
        },
      ],
      checkAuth: async () => ({ type: "oauth", source: "OAuth" }),
      getAvailable: async () => [{ id: "gpt-5.6-sol" }],
      getProviderAuthStatus: () => ({ configured: true, source: "stored", label: "OAuth" }),
    } as never);
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

  it("projects provider/model identity, authentication, thinking levels, and Fast support", async () => {
    const catalog = await Effect.runPromise(
      run(
        [model()],
        Effect.gen(function* () {
          return yield* (yield* PiModels).list();
        }),
      ),
    );
    assert.deepEqual(catalog, [model()]);
  });

  it("resolves only the exact authenticated and available selection", async () => {
    assert.deepEqual(await Effect.runPromise(resolve([model()])), selection);
    const error = await Effect.runPromise(
      resolveError([model(), model({ provider: "other", id: "fallback" })], {
        ...selection,
        modelId: "missing",
      }),
    );
    assert.equal(error._tag, "UnknownPiModelError");
    assert.equal(error.modelId, "missing");
  });

  it("distinguishes unauthenticated and unavailable models", async () => {
    assert.equal(
      (await Effect.runPromise(resolveError([model({ authenticated: false })])))._tag,
      "UnauthenticatedPiModelError",
    );
    assert.equal(
      (await Effect.runPromise(resolveError([model({ available: false })])))._tag,
      "UnavailablePiModelError",
    );
  });

  it("rejects unsupported thinking levels and Fast mode", async () => {
    assert.equal(
      (await Effect.runPromise(resolveError([model({ supportedThinkingLevels: ["off", "low"] })])))
        ._tag,
      "UnsupportedThinkingLevelError",
    );
    assert.equal(
      (await Effect.runPromise(resolveError([model({ fastMode: false })])))._tag,
      "UnsupportedFastModeError",
    );
  });

  it("reports catalog loading failures", async () => {
    const layer = makePiModelsLayer({
      loadCatalog: async () => {
        throw new Error("catalog unavailable");
      },
      refreshCatalog: async () => undefined,
      complete: async () => "",
    });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.flip((yield* PiModels).list());
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(error._tag, "PiModelCatalogError");
    assert.equal(error.operation, "load");
  });

  it("runs bounded completion with the exact resolved selection", async () => {
    let received: Parameters<PiModelsAdapter["complete"]>[0] | undefined;
    const layer = makePiModelsLayer({
      loadCatalog: async () => [model()],
      refreshCatalog: async () => undefined,
      complete: async (input) => {
        received = input;
        return "response beyond bound";
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* PiModels).complete({
          selection,
          instructions: "Return a title",
          context: "context",
          maximumOutputCharacters: 8,
          timeoutMs: 1_000,
        });
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(result, "response");
    assert.deepEqual(received?.selection, selection);
  });

  it("interrupts the provider request when bounded completion is cancelled", async () => {
    let providerSignal: AbortSignal | undefined;
    const layer = makePiModelsLayer({
      loadCatalog: async () => [model()],
      refreshCatalog: async () => undefined,
      complete: async (_input, signal) => {
        providerSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return "unreachable";
      },
    });
    const controller = new AbortController();
    const running = Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* PiModels).complete({
          selection,
          instructions: "Return a title",
          context: "context",
          maximumOutputCharacters: 80,
          timeoutMs: 1_000,
        });
      }).pipe(Effect.provide(layer)),
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await assert.rejects(running);
    assert.equal(providerSignal?.aborted, true);
  });

  it("returns a typed bounded-completion failure", async () => {
    const layer = makePiModelsLayer({
      loadCatalog: async () => [model()],
      refreshCatalog: async () => undefined,
      complete: async () => {
        throw new Error("provider failed");
      },
    });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.flip(
          (yield* PiModels).complete({
            selection,
            instructions: "Return a title",
            context: "context",
            maximumOutputCharacters: 80,
            timeoutMs: 1_000,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(error._tag, "PiModelCompletionError");
    assert.match(error.message, /provider failed/);
  });
});
