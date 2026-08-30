import assert from "node:assert/strict";
import { Effect, Layer, SynchronizedRef } from "effect";
import { describe, it } from "vitest";
import {
  create,
  list,
  remove,
  resolve,
  setDefault,
  update,
} from "../../../src/domain/modelPresets";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/domain/application-data";
import { makePiModelsLayer, type PiModels } from "../../../src/services/pi/PiModels";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import {
  ApplicationStorage,
  ApplicationWriteError,
} from "../../../src/services/storage/ApplicationStorage";

const input = (name = "Deep review") => ({
  name,
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high" as const,
  fastMode: true,
});

const model = {
  provider: "openai-codex",
  providerName: "OpenAI Codex",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  reasoning: true,
  supportedThinkingLevels: ["off", "high"] as const,
  fastMode: true,
  input: ["text"] as const,
  authenticated: true,
  available: true,
  authTypes: ["oauth"] as const,
};

const makeTestLayer = (options?: {
  initial?: ApplicationStateValue;
  failSave?: boolean;
  saveDelayMs?: number;
}) => {
  let persisted = options?.initial ?? defaultApplicationState();
  let activeSaves = 0;
  let maximumActiveSaves = 0;
  const storage = ApplicationStorage.of({
    load: Effect.succeed({ state: persisted, source: "current" as const }),
    save: (state) =>
      options?.failSave
        ? Effect.fail(
            new ApplicationWriteError({ stage: "write", message: "injected save failure" }),
          )
        : Effect.acquireUseRelease(
            Effect.sync(() => {
              activeSaves += 1;
              maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
            }),
            () =>
              Effect.sleep(options?.saveDelayMs ?? 0).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    persisted = state;
                  }),
                ),
              ),
            () =>
              Effect.sync(() => {
                activeSaves -= 1;
              }),
          ),
  });
  const applicationLayer = ApplicationState.layer.pipe(
    Layer.provide(Layer.succeed(ApplicationStorage)(storage)),
  );
  const modelsLayer = makePiModelsLayer({
    loadCatalog: async () => [model],
    refreshCatalog: async () => undefined,
    complete: async () => "",
  });
  return {
    layer: Layer.merge(applicationLayer, modelsLayer),
    persisted: () => persisted,
    maximumActiveSaves: () => maximumActiveSaves,
  };
};

const run = <A, E>(
  effect: Effect.Effect<A, E, ApplicationState | PiModels>,
  options?: Parameters<typeof makeTestLayer>[0],
) => {
  const test = makeTestLayer(options);
  return {
    test,
    effect: Effect.gen(function* () {
      yield* (yield* ApplicationState).initialize;
      return yield* effect;
    }).pipe(Effect.provide(test.layer)),
  };
};

const createOne = Effect.gen(function* () {
  yield* create(input());
  return (yield* list()).presets[0]!;
});

describe("Model Presets domain", () => {
  it("lists empty and populated presets and creates main-owned IDs", async () => {
    const { effect } = run(
      Effect.gen(function* () {
        assert.deepEqual(yield* list(), { presets: [], defaultPresetId: undefined });
        const created = yield* create(input());
        assert.equal(created.presets.length, 1);
        assert.match(created.presets[0]!.id, /^[0-9a-f-]{36}$/);
        assert.equal(created.presets[0]!.name, "Deep review");
        return created.presets[0]!.id;
      }),
    );
    assert.ok(await Effect.runPromise(effect));
  });

  it("trims names and rejects empty or overlong names", async () => {
    const { effect } = run(
      Effect.gen(function* () {
        const trimmed = yield* create(input("  Review  "));
        assert.equal(trimmed.presets[0]!.name, "Review");
        assert.equal((yield* Effect.flip(create(input("   "))))._tag, "ModelPresetValidationError");
        assert.equal(
          (yield* Effect.flip(create(input("x".repeat(81)))))._tag,
          "ModelPresetValidationError",
        );
      }),
    );
    await Effect.runPromise(effect);
  });

  it("updates presets, preserves the default reference, and rejects missing IDs", async () => {
    const { effect } = run(
      Effect.gen(function* () {
        const preset = yield* createOne;
        yield* setDefault(preset.id);
        const changed = yield* update({ ...preset, name: "Updated" });
        assert.equal(changed.presets[0]!.name, "Updated");
        assert.equal(changed.defaultPresetId, preset.id);
        const missing = yield* Effect.flip(
          update({ ...preset, id: "00000000-0000-4000-8000-000000000099" }),
        );
        assert.equal(missing._tag, "ModelPresetNotFoundError");
      }),
    );
    await Effect.runPromise(effect);
  });

  it("removes presets and clears the current default", async () => {
    const { effect } = run(
      Effect.gen(function* () {
        const preset = yield* createOne;
        yield* setDefault(preset.id);
        assert.deepEqual(yield* remove(preset.id), {
          presets: [],
          defaultPresetId: undefined,
        });
      }),
    );
    await Effect.runPromise(effect);
  });

  it("sets, clears, and rejects an unknown default", async () => {
    const { effect } = run(
      Effect.gen(function* () {
        const preset = yield* createOne;
        assert.equal((yield* setDefault(preset.id)).defaultPresetId, preset.id);
        assert.equal((yield* setDefault(undefined)).defaultPresetId, undefined);
        const error = yield* Effect.flip(setDefault("00000000-0000-4000-8000-000000000099"));
        assert.equal(error._tag, "DefaultModelPresetNotFoundError");
      }),
    );
    await Effect.runPromise(effect);
  });

  it("rejects duplicate IDs and the 100-preset limit", async () => {
    const duplicate = {
      ...input(),
      id: "00000000-0000-4000-8000-000000000001",
    };
    const duplicateState = {
      ...defaultApplicationState(),
      modelPresets: [duplicate, duplicate],
    } as ApplicationStateValue;
    const stateRef = await Effect.runPromise(SynchronizedRef.make(duplicateState));
    const duplicateOwner = ApplicationState.of({
      initialize: Effect.succeed(duplicateState),
      current: SynchronizedRef.get(stateRef),
      unsafeCurrent: () => SynchronizedRef.getUnsafe(stateRef),
      transact: (transition) => SynchronizedRef.updateAndGetEffect(stateRef, transition),
    });
    const duplicateError = await Effect.runPromise(
      Effect.flip(update({ ...duplicate, name: "Changed" })).pipe(
        Effect.provide(Layer.succeed(ApplicationState)(duplicateOwner)),
      ),
    );
    assert.equal(duplicateError._tag, "DuplicateModelPresetIdError");

    const fullState: ApplicationStateValue = {
      ...defaultApplicationState(),
      modelPresets: Array.from({ length: 100 }, (_, index) => ({
        ...input(`Preset ${index}`),
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    };
    const { effect } = run(Effect.flip(create(input("Overflow"))), { initial: fullState });
    assert.equal((await Effect.runPromise(effect))._tag, "ModelPresetLimitError");
  });

  it("persists unresolved presets and resolves exact available presets", async () => {
    const { test, effect } = run(
      Effect.gen(function* () {
        const known = yield* createOne;
        assert.deepEqual(yield* resolve(known.id), {
          provider: known.provider,
          modelId: known.modelId,
          thinkingLevel: known.thinkingLevel,
          fastMode: known.fastMode,
        });
        const unknownState = yield* create({ ...input("Unavailable"), modelId: "missing" });
        const unknown = unknownState.presets.find((preset) => preset.modelId === "missing")!;
        assert.equal((yield* Effect.flip(resolve(unknown.id)))._tag, "UnknownPiModelError");
        return unknown;
      }),
    );
    const unknown = await Effect.runPromise(effect);
    assert.ok(test.persisted().modelPresets.some((preset) => preset.id === unknown.id));
  });

  it("does not publish a failed persistence mutation", async () => {
    const { effect } = run(
      Effect.gen(function* () {
        const owner = yield* ApplicationState;
        const before = yield* owner.current;
        assert.equal((yield* Effect.flip(create(input())))._tag, "ApplicationWriteError");
        assert.deepEqual(yield* owner.current, before);
      }),
      { failSave: true },
    );
    await Effect.runPromise(effect);
  });

  it("serializes concurrent mutations", async () => {
    const { test, effect } = run(
      Effect.all([create(input("One")), create(input("Two"))], { concurrency: "unbounded" }),
      { saveDelayMs: 10 },
    );
    const states = await Effect.runPromise(effect);
    assert.equal(states.at(-1)!.presets.length, 2);
    assert.equal(test.persisted().modelPresets.length, 2);
    assert.equal(test.maximumActiveSaves(), 1);
  });
});
