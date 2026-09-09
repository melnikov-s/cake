import { Effect, Schema } from "effect";
import {
  ModelPreset,
  type ApplicationState,
  type ModelPreset as ModelPresetValue,
} from "./application/application-data";
import { PiModels } from "../services/pi/PiModels";
import type { ModelSelection } from "../services/pi/model-data";
import { ApplicationState as ApplicationStateOwner } from "../services/storage/ApplicationState";

export const ModelPresetCreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(80)),
  provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  thinkingLevel: ModelPreset.fields.thinkingLevel,
  fastMode: Schema.Boolean,
});

export const ModelPresetUpdateInput = ModelPreset;

export const ModelPresetOrderInput = Schema.Struct({
  ids: Schema.Array(Schema.String.check(Schema.isUUID(4))).check(Schema.isMaxLength(100)),
});

export const ModelPresetProjection = Schema.Struct({
  presets: Schema.Array(ModelPreset).check(Schema.isMaxLength(100)),
  // Projection constructors always include this key; undefined means no default.
  defaultPresetId: Schema.optional(Schema.String.check(Schema.isUUID(4))),
}).check(
  Schema.makeFilter(
    (state) => {
      const ids = state.presets.map((preset) => preset.id);
      return (
        new Set(ids).size === ids.length &&
        (state.defaultPresetId === undefined || ids.includes(state.defaultPresetId))
      );
    },
    { expected: "unique Model Preset identities with a valid default preset" },
  ),
);

export class ModelPresetValidationError extends Schema.TaggedError<ModelPresetValidationError>()(
  "ModelPresetValidationError",
  { message: Schema.String },
) {}

export class ModelPresetNotFoundError extends Schema.TaggedError<ModelPresetNotFoundError>()(
  "ModelPresetNotFoundError",
  { id: Schema.String },
) {}

export class DefaultModelPresetNotFoundError extends Schema.TaggedError<DefaultModelPresetNotFoundError>()(
  "DefaultModelPresetNotFoundError",
  { id: Schema.String },
) {}

export class DuplicateModelPresetIdError extends Schema.TaggedError<DuplicateModelPresetIdError>()(
  "DuplicateModelPresetIdError",
  { id: Schema.String },
) {}

export class ModelPresetLimitError extends Schema.TaggedError<ModelPresetLimitError>()(
  "ModelPresetLimitError",
  { limit: Schema.Int },
) {}

export interface ModelPresetCreateInput extends Schema.Schema.Type<typeof ModelPresetCreateInput> {}
export interface ModelPresetUpdateInput extends Schema.Schema.Type<typeof ModelPresetUpdateInput> {}
export interface ModelPresetOrderInput extends Schema.Schema.Type<typeof ModelPresetOrderInput> {}
export interface ModelPresetProjection extends Schema.Schema.Type<typeof ModelPresetProjection> {}

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

const decodePreset = Effect.fn("ModelPresets.decodePreset")((value: ModelPresetValue) =>
  Schema.decodeUnknownEffect(ModelPreset)(value).pipe(
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
  return yield* transact((current) => {
    if (current.modelPresets.length >= 100)
      return Effect.fail(new ModelPresetLimitError({ limit: 100 }));
    let id = crypto.randomUUID();
    while (current.modelPresets.some((preset) => preset.id === id)) id = crypto.randomUUID();
    return decodePreset({ ...input, id, name: input.name.trim() }).pipe(
      Effect.map((preset) => ({
        ...current,
        modelPresets: [...current.modelPresets, preset],
      })),
    );
  });
});

export const update = Effect.fn("ModelPresets.update")(function* (input: ModelPresetUpdateInput) {
  return yield* transact((current) => {
    if (!current.modelPresets.some((preset) => preset.id === input.id))
      return Effect.fail(new ModelPresetNotFoundError({ id: input.id }));
    return decodePreset({ ...input, name: input.name.trim() }).pipe(
      Effect.map((preset) => ({
        ...current,
        modelPresets: current.modelPresets.map((candidate) =>
          candidate.id === preset.id ? preset : candidate,
        ),
      })),
    );
  });
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
    const next = {
      ...withoutDefault,
      modelPresets: current.modelPresets.filter((preset) => preset.id !== id),
    };
    return Effect.succeed(
      defaultModelPresetId === id || defaultModelPresetId === undefined
        ? next
        : { ...next, defaultModelPresetId },
    );
  });
});

export const setDefault = Effect.fn("ModelPresets.setDefault")(function* (id: string | undefined) {
  return yield* transact((current) => {
    if (id !== undefined && !current.modelPresets.some((preset) => preset.id === id))
      return Effect.fail(new DefaultModelPresetNotFoundError({ id }));
    const withoutDefault = { ...current };
    Reflect.deleteProperty(withoutDefault, "defaultModelPresetId");
    return Effect.succeed(
      id === undefined ? withoutDefault : { ...withoutDefault, defaultModelPresetId: id },
    );
  });
});

export const resolve = Effect.fn("ModelPresets.resolve")(function* (id: string) {
  const state = yield* list();
  const preset = state.presets.find((candidate) => candidate.id === id);
  if (!preset) return yield* new ModelPresetNotFoundError({ id });
  const models = yield* PiModels;
  return yield* models.resolve({
    provider: preset.provider,
    modelId: preset.modelId,
    thinkingLevel: preset.thinkingLevel,
    fastMode: preset.fastMode,
  } satisfies ModelSelection);
});
