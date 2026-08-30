import { Context, Effect, Result, Schema, Semaphore, Stream } from "effect";
import { Store, batch, createStore, refStream, type StoreInstance } from "effect-state-tree";
import { CakeIpcClient } from "../../ipc/client/CakeIpcClient";
import {
  ModelSelection,
  PiModel,
  type ModelPresetCreateInput,
  type ModelPresetProjection,
  type ModelPresetUpdateInput as ModelPresetValue,
  type PiModel as PiModelValue,
} from "../../ipc/protocol/modelPresets";
import { describeError } from "../error-details";
import { ModelPreset } from "../models/ModelPreset";
import { ModelPresetCollection } from "../models/ModelPresetCollection";

export type ModelPresetResolutionStatus =
  | "available"
  | "unknown"
  | "unauthenticated"
  | "unavailable"
  | "unsupported-thinking-level"
  | "unsupported-fast-mode";

const toValue = (preset: ModelPreset): ModelPresetValue => ({
  id: preset.id.value,
  name: preset.name.value,
  provider: preset.provider.value,
  modelId: preset.modelId.value,
  thinkingLevel: preset.thinkingLevel.value,
  fastMode: preset.fastMode.value,
});

/**
 * Window-lifetime projection and workflow for main-owned Model Presets. The Store hydrates from
 * Effect RPC, serializes semantic commands, and never persists a second authoritative copy.
 */
export const ModelPresetSettingsStoreFactory = createStore(
  "ModelPresetSettingsStore",
  Store.schema({
    catalog: Schema.Array(PiModel),
    lastUsed: Schema.optional(ModelSelection),
    loading: Schema.Boolean,
    saving: Schema.Boolean,
    sectionRequestRevision: Schema.Int,
    revision: Schema.Int,
    error: Schema.optional(Schema.String),
    errorDetails: Schema.optional(Schema.String),
  }),
  function* ({ self, autorun }) {
    const client = yield* CakeIpcClient;
    const projection = yield* ModelPresetCollection.make({ presets: [] }).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => Effect.sync(() => projection[Symbol.dispose]()));

    const commandLock = Semaphore.makeUnsafe(1);
    const authoritativeIds = new Map<string, string>();
    let commandRevision = 0;
    let persisted: ModelPresetProjection = { presets: [] };

    const reconcile = Effect.fn("ModelPresetSettingsStore.reconcile")(function* (
      state: ModelPresetProjection,
    ) {
      const current = new Map(projection.presets.value.map((preset) => [preset.id.value, preset]));
      const next: ModelPreset[] = [];
      const updates: Array<readonly [ModelPreset, ModelPresetValue]> = [];
      for (const value of state.presets) {
        const existing = current.get(value.id);
        if (existing) {
          next.push(existing);
          updates.push([existing, value]);
        } else {
          next.push(yield* ModelPreset.make(value).pipe(Effect.orDie));
        }
      }
      batch(() => {
        for (const [preset, value] of updates) {
          preset.name.set(value.name);
          preset.provider.set(value.provider);
          preset.modelId.set(value.modelId);
          preset.thinkingLevel.set(value.thinkingLevel);
          preset.fastMode.set(value.fastMode);
        }
        projection.replace(next, state.defaultPresetId);
        self.revision.update((revision) => revision + 1);
      });
    });

    const acceptAuthoritative = (state: ModelPresetProjection) => {
      persisted = {
        presets: state.presets.map((preset) => ({ ...preset })),
        defaultPresetId: state.defaultPresetId,
      };
    };

    const restorePersisted = Effect.fn("ModelPresetSettingsStore.restorePersisted")(() =>
      reconcile(persisted),
    );

    const setError = (error: unknown) => {
      const described = describeError(error);
      batch(() => {
        self.error.set(described.message);
        self.errorDetails.set(described.details);
      });
    };

    const beginOptimistic = Effect.fn("ModelPresetSettingsStore.beginOptimistic")(function* (
      presets: ReadonlyArray<ModelPresetValue>,
      defaultPresetId: string | undefined,
    ) {
      const revision = ++commandRevision;
      batch(() => {
        self.saving.set(true);
        self.error.set(undefined);
        self.errorDetails.set(undefined);
      });
      yield* reconcile({ presets, defaultPresetId });
      return revision;
    });

    const enqueue = Effect.fn("ModelPresetSettingsStore.enqueue")(function* <E>(
      revision: number,
      command: Effect.Effect<ModelPresetProjection, E>,
    ) {
      yield* commandLock.withPermit(
        command.pipe(
          Effect.tap((state) => {
            acceptAuthoritative(state);
            return revision === commandRevision ? restorePersisted() : Effect.void;
          }),
          Effect.catch((error) =>
            revision === commandRevision
              ? restorePersisted().pipe(Effect.andThen(Effect.sync(() => setError(error))))
              : Effect.void,
          ),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (revision === commandRevision) self.saving.set(false);
            }),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              if (revision === commandRevision) self.saving.set(false);
            }),
          ),
          Effect.asVoid,
        ),
      );
    });

    const currentPresets = () => projection.presets.value.map(toValue);
    const resolveAuthoritativeId = (id: string) => authoritativeIds.get(id) ?? id;
    const createPreset = Effect.fn("ModelPresetSettingsStore.createPreset")(function* (
      input: ModelPresetCreateInput,
    ) {
      const optimisticId = crypto.randomUUID();
      const revision = yield* beginOptimistic(
        [...currentPresets(), { ...input, id: optimisticId }],
        projection.defaultPresetId.value,
      );
      return yield* enqueue(
        revision,
        Effect.suspend(() => {
          const knownIds = new Set(persisted.presets.map((preset) => preset.id));
          return client.modelPresets.create(input).pipe(
            Effect.tap((state) =>
              Effect.sync(() => {
                const created = state.presets.find((preset) => !knownIds.has(preset.id));
                if (created) authoritativeIds.set(optimisticId, created.id);
              }),
            ),
          );
        }),
      );
    });

    const hydrate = Effect.fn("ModelPresetSettingsStore.hydrate")(function* () {
      const [presetResult, modelResult] = yield* Effect.all(
        [Effect.result(client.modelPresets.list()), Effect.result(client.models.list())] as const,
        { concurrency: "unbounded" },
      );
      if (Result.isSuccess(presetResult)) {
        acceptAuthoritative(presetResult.success);
        yield* restorePersisted();
      } else {
        setError(presetResult.failure);
      }
      if (Result.isSuccess(modelResult)) self.catalog.set([...modelResult.success]);
      else if (Result.isSuccess(presetResult)) setError(modelResult.failure);
      self.loading.set(false);
    });
    autorun("hydrate", hydrate());

    return {
      get presets(): ReadonlyArray<ModelPresetValue> {
        return currentPresets();
      },
      get defaultPresetId() {
        return projection.defaultPresetId.value;
      },
      get catalogModels(): ReadonlyArray<PiModelValue> {
        return self.catalog.value;
      },
      get modelsByProvider() {
        const groups = new Map<
          string,
          {
            name: string;
            models: Array<
              Omit<PiModelValue, "supportedThinkingLevels" | "input" | "authTypes"> & {
                availableThinkingLevels: Array<PiModelValue["supportedThinkingLevels"][number]>;
                input: Array<PiModelValue["input"][number]>;
                authTypes: Array<PiModelValue["authTypes"][number]>;
              }
            >;
          }
        >();
        for (const model of self.catalog.value) {
          const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
          const { supportedThinkingLevels, ...rest } = model;
          group.models.push({
            ...rest,
            input: [...rest.input],
            authTypes: [...rest.authTypes],
            availableThinkingLevels: [...supportedThinkingLevels],
          });
          groups.set(model.provider, group);
        }
        return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
      },
      resolutionStatus(preset: ModelPresetValue): ModelPresetResolutionStatus {
        const model = self.catalog.value.find(
          (candidate) => candidate.provider === preset.provider && candidate.id === preset.modelId,
        );
        if (!model) return "unknown";
        if (!model.authenticated) return "unauthenticated";
        if (!model.available) return "unavailable";
        if (!model.supportedThinkingLevels.includes(preset.thinkingLevel))
          return "unsupported-thinking-level";
        if (preset.fastMode && !model.fastMode) return "unsupported-fast-mode";
        return "available";
      },
      get defaultConfiguration() {
        const preset = currentPresets().find(
          (candidate) => candidate.id === projection.defaultPresetId.value,
        );
        if (preset)
          return {
            provider: preset.provider,
            modelId: preset.modelId,
            thinkingLevel: preset.thinkingLevel,
            fastMode: preset.fastMode,
          } satisfies typeof ModelSelection.Type;
        const lastUsed = self.lastUsed.value;
        return lastUsed ? { ...lastUsed } : undefined;
      },
      recordUsage(configuration: typeof ModelSelection.Type) {
        const current = self.lastUsed.value;
        if (
          current?.provider === configuration.provider &&
          current.modelId === configuration.modelId &&
          current.thinkingLevel === configuration.thinkingLevel &&
          current.fastMode === configuration.fastMode
        )
          return;
        self.lastUsed.set({ ...configuration });
      },
      restoreLastUsed(configuration: typeof ModelSelection.Type | undefined) {
        self.lastUsed.set(configuration ? { ...configuration } : undefined);
      },
      get lastUsedConfiguration() {
        const configuration = self.lastUsed.value;
        return configuration ? { ...configuration } : undefined;
      },
      requestSection() {
        self.sectionRequestRevision.update((revision) => revision + 1);
      },
      awaitHydrated: Effect.fn("ModelPresetSettingsStore.awaitHydrated")(function* () {
        if (!self.loading.value) return;
        yield* refStream(self.loading).pipe(
          Stream.filter((loading) => !loading),
          Stream.take(1),
          Stream.runDrain,
        );
      }),
      createPreset,
      updatePreset: Effect.fn("ModelPresetSettingsStore.updatePreset")(function* (
        preset: ModelPresetValue,
      ) {
        const revision = yield* beginOptimistic(
          currentPresets().map((current) => (current.id === preset.id ? { ...preset } : current)),
          projection.defaultPresetId.value,
        );
        return yield* enqueue(
          revision,
          Effect.suspend(() =>
            client.modelPresets.update({
              ...preset,
              id: resolveAuthoritativeId(preset.id),
            }),
          ),
        );
      }),
      duplicatePreset: Effect.fn("ModelPresetSettingsStore.duplicatePreset")(function* (
        id: string,
      ) {
        const source = currentPresets().find((preset) => preset.id === id);
        if (source)
          yield* createPreset({
            ...source,
            name: `${source.name.slice(0, 75).trimEnd()} copy`,
          });
      }),
      deletePreset: Effect.fn("ModelPresetSettingsStore.deletePreset")(function* (id: string) {
        const revision = yield* beginOptimistic(
          currentPresets().filter((preset) => preset.id !== id),
          projection.defaultPresetId.value === id ? undefined : projection.defaultPresetId.value,
        );
        return yield* enqueue(
          revision,
          Effect.suspend(() => client.modelPresets.remove(resolveAuthoritativeId(id))),
        );
      }),
      setDefaultPreset: Effect.fn("ModelPresetSettingsStore.setDefaultPreset")(function* (
        id: string | undefined,
      ) {
        const revision = yield* beginOptimistic(currentPresets(), id);
        return yield* enqueue(
          revision,
          Effect.suspend(() =>
            client.modelPresets.setDefault(
              id === undefined ? undefined : resolveAuthoritativeId(id),
            ),
          ),
        );
      }),
    };
  },
);

export type ModelPresetSettingsStoreInstance = StoreInstance<
  typeof ModelPresetSettingsStoreFactory
>;

export class ModelPresetSettingsStore extends Context.Service<
  ModelPresetSettingsStore,
  ModelPresetSettingsStoreInstance
>()("cake/renderer/stores/ModelPresetSettingsStore") {}
