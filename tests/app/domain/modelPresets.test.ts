import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream, SynchronizedRef } from "effect";
import { TestClock } from "effect/testing";
import { describe } from "vitest";
import {
  create,
  list,
  remove,
  reorder,
  resolve,
  setDefault,
  update,
} from "../../../src/domain/modelPresets";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/domain/application/application-data";
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
    load: Effect.fn("ApplicationStorage.Test.load")(() =>
      Effect.succeed({ state: persisted, source: "current" as const }),
    ),
    save: Effect.fn("ApplicationStorage.Test.save")(function* (state) {
      if (options?.failSave)
        return yield* new ApplicationWriteError({
          stage: "write",
          message: "injected save failure",
        });
      yield* Effect.acquireUseRelease(
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
      );
    }),
  });
  const applicationLayer = ApplicationState.layer.pipe(
    Layer.provide(Layer.succeed(ApplicationStorage)(storage)),
  );
  const modelsLayer = makePiModelsLayer({
    loadCatalog: () => Effect.succeed([model]),
    refreshCatalog: () => Effect.void,
    complete: () => Effect.succeed(""),
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
      yield* (yield* ApplicationState).initialize();
      return yield* effect;
    }).pipe(Effect.provide(test.layer)),
  };
};

const createOne = Effect.gen(function* () {
  yield* create(input());
  const preset = (yield* list()).presets[0];
  assert.ok(preset);
  return preset;
});

describe("Model Presets domain", () => {
  it.effect("lists empty and populated presets and creates main-owned IDs", () => {
    const { effect } = run(
      Effect.gen(function* () {
        assert.deepEqual(yield* list(), { presets: [], defaultPresetId: undefined });
        const created = yield* create(input());
        assert.equal(created.presets.length, 1);
        const preset = created.presets[0];
        assert.ok(preset);
        assert.match(preset.id, /^[0-9a-f-]{36}$/);
        assert.equal(preset.name, "Deep review");
      }),
    );
    return effect;
  });

  it.effect("trims names and rejects empty or overlong names", () => {
    const { effect } = run(
      Effect.gen(function* () {
        const trimmed = yield* create(input("  Review  "));
        assert.equal(trimmed.presets[0]?.name, "Review");
        assert.equal((yield* Effect.flip(create(input("   "))))._tag, "ModelPresetValidationError");
        assert.equal(
          (yield* Effect.flip(create(input("x".repeat(81)))))._tag,
          "ModelPresetValidationError",
        );
      }),
    );
    return effect;
  });

  it.effect("updates presets, preserves the default reference, and rejects missing IDs", () => {
    const { effect } = run(
      Effect.gen(function* () {
        const preset = yield* createOne;
        yield* setDefault(preset.id);
        const changed = yield* update({ ...preset, name: "Updated" });
        assert.equal(changed.presets[0]?.name, "Updated");
        assert.equal(changed.defaultPresetId, preset.id);
        const missing = yield* Effect.flip(
          update({ ...preset, id: "00000000-0000-4000-8000-000000000099" }),
        );
        assert.equal(missing._tag, "ModelPresetNotFoundError");
      }),
    );
    return effect;
  });

  it.effect("reorders presets and rejects incomplete or duplicate orders", () => {
    const { effect } = run(
      Effect.gen(function* () {
        const first = (yield* create(input("First"))).presets[0];
        const second = (yield* create(input("Second"))).presets[1];
        const third = (yield* create(input("Third"))).presets[2];
        assert.ok(first && second && third);

        const reordered = yield* reorder({ ids: [third.id, first.id, second.id] });
        assert.deepEqual(
          reordered.presets.map((preset) => preset.name),
          ["Third", "First", "Second"],
        );
        assert.equal(
          (yield* Effect.flip(reorder({ ids: [first.id, second.id] })))._tag,
          "ModelPresetValidationError",
        );
        assert.equal(
          (yield* Effect.flip(reorder({ ids: [first.id, first.id, third.id] })))._tag,
          "ModelPresetValidationError",
        );
      }),
    );
    return effect;
  });

  it.effect("removes presets and clears the current default", () => {
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
    return effect;
  });

  it.effect("sets, clears, and rejects an unknown default", () => {
    const { effect } = run(
      Effect.gen(function* () {
        const preset = yield* createOne;
        assert.equal((yield* setDefault(preset.id)).defaultPresetId, preset.id);
        assert.equal((yield* setDefault(undefined)).defaultPresetId, undefined);
        const error = yield* Effect.flip(setDefault("00000000-0000-4000-8000-000000000099"));
        assert.equal(error._tag, "DefaultModelPresetNotFoundError");
      }),
    );
    return effect;
  });

  it.effect("rejects duplicate IDs and the 100-preset limit", () =>
    Effect.gen(function* () {
      const duplicate = {
        ...input(),
        id: "00000000-0000-4000-8000-000000000001",
      };
      const duplicateState = {
        ...defaultApplicationState(),
        modelPresets: [duplicate, duplicate],
      } satisfies ApplicationStateValue;
      const stateRef = yield* SynchronizedRef.make<ApplicationStateValue>(duplicateState);
      const duplicateOwner = ApplicationState.of({
        initialize: Effect.fn("ApplicationState.Test.initialize")(() =>
          Effect.succeed(duplicateState),
        ),
        current: Effect.fn("ApplicationState.Test.current")(() => SynchronizedRef.get(stateRef)),
        snapshot: () => SynchronizedRef.getUnsafe(stateRef),
        changes: () =>
          Stream.fromEffect(
            SynchronizedRef.get(stateRef).pipe(Effect.map((state) => ({ revision: 0, state }))),
          ),
        transact: (transition) => SynchronizedRef.updateAndGetEffect(stateRef, transition),
      });
      const duplicateError = yield* Effect.flip(update({ ...duplicate, name: "Changed" })).pipe(
        Effect.provide(Layer.succeed(ApplicationState)(duplicateOwner)),
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
      assert.equal((yield* effect)._tag, "ModelPresetLimitError");
    }),
  );

  it.effect("persists unresolved presets and resolves exact available presets", () => {
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
        const unknown = unknownState.presets.find((preset) => preset.modelId === "missing");
        assert.ok(unknown);
        assert.equal((yield* Effect.flip(resolve(unknown.id)))._tag, "UnknownPiModelError");
        return unknown;
      }),
    );
    return Effect.gen(function* () {
      const unknown = yield* effect;
      assert.ok(test.persisted().modelPresets.some((preset) => preset.id === unknown.id));
    });
  });

  it.effect("does not publish a failed persistence mutation", () => {
    const { effect } = run(
      Effect.gen(function* () {
        const owner = yield* ApplicationState;
        const before = yield* owner.current();
        assert.equal((yield* Effect.flip(create(input())))._tag, "ApplicationWriteError");
        assert.deepEqual(yield* owner.current(), before);
      }),
      { failSave: true },
    );
    return effect;
  });

  it.effect("serializes concurrent mutations", () => {
    const { test, effect } = run(
      Effect.all([create(input("One")), create(input("Two"))], { concurrency: "unbounded" }),
      { saveDelayMs: 10 },
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect);
      yield* TestClock.adjust(20);
      const states = yield* Fiber.join(fiber);
      assert.equal(states.at(-1)?.presets.length, 2);
      assert.equal(test.persisted().modelPresets.length, 2);
      assert.equal(test.maximumActiveSaves(), 1);
    });
  });
});
