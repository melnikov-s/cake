import { Effect, Schema } from "effect";
import {
  antigravitySettingsError,
  isAntigravityModel,
  supportsAntigravitySettings,
} from "../../contracts/model-presets/antigravity-model";
import { modelPresetConfiguration } from "../../contracts/model-presets/cake-model-selection";
import {
  ModelPreset,
  type ApplicationState,
  type ModelPreset as ModelPresetValue,
} from "../../contracts/application/application-data";
import { PiModels } from "../../services/pi/PiModels";
import { ModelPresetPrompts } from "../../services/storage/ModelPresetPrompts";
import { ApplicationState as ApplicationStateOwner } from "../../services/storage/ApplicationState";
import type {
  ModelPresetCreateInput,
  ModelPresetUpdateInput,
  ModelPresetOrderInput,
  ModelPresetProjection,
} from "../../contracts/model-presets/model-preset-data";
import {
  ModelPresetValidationError,
  ModelPresetNotFoundError,
  DefaultModelPresetNotFoundError,
  DuplicateModelPresetIdError,
  ModelPresetLimitError,
} from "../../contracts/model-presets/model-preset-data";

type ModelPresetDomainError =
  | ModelPresetValidationError
  | ModelPresetNotFoundError
  | DefaultModelPresetNotFoundError
  | DuplicateModelPresetIdError
  | ModelPresetLimitError;

const project = (state: ApplicationState): ModelPresetProjection => ({
  presets: state.modelPresets,
  defaultPresetId: state.defaultModelPresetId,
});

const duplicateId = (presets: ReadonlyArray<ModelPresetValue>): string | undefined => {
  const seen = new Set<string>();
  for (const preset of presets) {
    if (seen.has(preset.id)) return preset.id;
    seen.add(preset.id);
  }
  return undefined;
};

const ensureIntegrity = Effect.fn("ModelPresets.ensureIntegrity")(function* (
  state: ApplicationState,
) {
  const duplicate = duplicateId(state.modelPresets);
  if (duplicate) return yield* new DuplicateModelPresetIdError({ id: duplicate });
  return state;
});

const decodePreset = Effect.fn("ModelPresets.decodePreset")(
  (value: ModelPresetValue & { prompt?: string }) =>
    isAntigravityModel(value) && !supportsAntigravitySettings(value)
      ? Effect.fail(new ModelPresetValidationError({ message: antigravitySettingsError }))
      : Schema.decodeUnknownEffect(ModelPreset)(value).pipe(
          Effect.mapError((cause) => new ModelPresetValidationError({ message: cause.message })),
        ),
);

const transact = Effect.fn("ModelPresets.transact")(function* (
  transition: (
    current: ApplicationState,
  ) => Effect.Effect<ApplicationState, ModelPresetDomainError>,
) {
  const owner = yield* ApplicationStateOwner;
  const state = yield* owner.transact((current) =>
    ensureIntegrity(current).pipe(Effect.flatMap(transition)),
  );
  return project(state);
});

export const list = Effect.fn("ModelPresets.list")(function* () {
  const owner = yield* ApplicationStateOwner;
  return project(yield* owner.current());
});

export const create = Effect.fn("ModelPresets.create")(function* (input: ModelPresetCreateInput) {
  const prompts = yield* ModelPresetPrompts;
  return yield* transact(
    Effect.fn("ModelPresets.createTransition")(function* (current: ApplicationState) {
      if (current.modelPresets.length >= 100)
        return yield* new ModelPresetLimitError({ limit: 100 });
      let id = crypto.randomUUID();
      while (current.modelPresets.some((preset) => preset.id === id)) id = crypto.randomUUID();
      let preset = yield* decodePreset({ ...input, id, name: input.name.trim() });
      if (input.prompt !== undefined) {
        const promptFile = yield* prompts.write(input.prompt, input.promptFile);
        preset = { ...preset, promptFile };
      } else if (preset.promptFile) yield* prompts.read(preset.promptFile);
      return {
        ...current,
        modelPresets: [...current.modelPresets, preset],
        defaultModelPresetId: current.defaultModelPresetId ?? current.modelPresets[0]?.id ?? id,
      };
    }),
  );
});

export const update = Effect.fn("ModelPresets.update")(function* (input: ModelPresetUpdateInput) {
  const prompts = yield* ModelPresetPrompts;
  return yield* transact(
    Effect.fn("ModelPresets.updateTransition")(function* (current: ApplicationState) {
      const previous = current.modelPresets.find((preset) => preset.id === input.id);
      if (!previous) return yield* new ModelPresetNotFoundError({ id: input.id });
      // The update carries the complete configuration. A switch to Antigravity
      // must not keep the prior model's prompt file attached.
      let preset = yield* decodePreset({
        ...(isAntigravityModel(input) ? undefined : previous),
        ...input,
        name: input.name.trim(),
      });
      if (input.prompt !== undefined) {
        const promptFile = yield* prompts.write(input.prompt, preset.promptFile);
        preset = { ...preset, promptFile };
      } else if (preset.promptFile) yield* prompts.read(preset.promptFile);
      return {
        ...current,
        modelPresets: current.modelPresets.map((candidate) =>
          candidate.id === preset.id ? preset : candidate,
        ),
      };
    }),
  );
});

export const readPrompt = Effect.fn("ModelPresets.readPrompt")(function* (id: string) {
  const state = yield* list();
  const preset = state.presets.find((candidate) => candidate.id === id);
  if (!preset) return yield* new ModelPresetNotFoundError({ id });
  const prompts = yield* ModelPresetPrompts;
  const prompt = preset.promptFile ? yield* prompts.read(preset.promptFile) : "";
  return { ...(preset.promptFile ? { promptFile: preset.promptFile } : null), prompt };
});

export const reorder = Effect.fn("ModelPresets.reorder")(function* (input: ModelPresetOrderInput) {
  return yield* transact((current) => {
    const currentIds = new Set(current.modelPresets.map((preset) => preset.id));
    const orderedIds = new Set(input.ids);
    if (
      orderedIds.size !== input.ids.length ||
      orderedIds.size !== currentIds.size ||
      input.ids.some((id) => !currentIds.has(id))
    )
      return Effect.fail(
        new ModelPresetValidationError({
          message: "Preset order must contain every preset exactly once",
        }),
      );
    const indexById = new Map(input.ids.map((id, index) => [id, index]));
    return Effect.succeed({
      ...current,
      modelPresets: [...current.modelPresets].sort(
        (left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0),
      ),
    });
  });
});

export const remove = Effect.fn("ModelPresets.remove")(function* (id: string) {
  return yield* transact((current) => {
    if (!current.modelPresets.some((preset) => preset.id === id))
      return Effect.fail(new ModelPresetNotFoundError({ id }));
    const { defaultModelPresetId, ...withoutDefault } = current;
    const modelPresets = current.modelPresets.filter((preset) => preset.id !== id);
    const nextDefault = defaultModelPresetId === id ? modelPresets[0]?.id : defaultModelPresetId;
    return Effect.succeed({
      ...withoutDefault,
      modelPresets,
      ...(nextDefault ? { defaultModelPresetId: nextDefault } : null),
    });
  });
});

export const setDefault = Effect.fn("ModelPresets.setDefault")(function* (id: string | undefined) {
  return yield* transact((current) => {
    if (id !== undefined && !current.modelPresets.some((preset) => preset.id === id))
      return Effect.fail(new DefaultModelPresetNotFoundError({ id }));
    if (id === undefined)
      return current.modelPresets.length
        ? Effect.fail(
            new ModelPresetValidationError({
              message:
                "Choose a default preset. The default cannot be cleared while presets exist.",
            }),
          )
        : Effect.succeed(current);
    return Effect.succeed({ ...current, defaultModelPresetId: id });
  });
});

export const resolve = Effect.fn("ModelPresets.resolve")(function* (id: string) {
  const state = yield* list();
  const preset = state.presets.find((candidate) => candidate.id === id);
  if (!preset) return yield* new ModelPresetNotFoundError({ id });
  const selection = modelPresetConfiguration(preset);
  if (isAntigravityModel(selection)) return selection;
  const models = yield* PiModels;
  return yield* models.resolve(selection);
});
