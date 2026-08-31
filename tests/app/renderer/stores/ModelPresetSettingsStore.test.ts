/** @vitest-environment jsdom */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Deferred, Effect, Layer, Stream } from "effect";
import { mount } from "effect-state-tree";
import { observer, StoreProvider, useStore } from "effect-state-tree/react";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vitest";
import type { ModelPresetProjection } from "../../../../src/domain/modelPresets";
import type { ModelPreset as ModelPresetValue } from "../../../../src/domain/application-data";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { PiModelCatalogError, type PiModel } from "../../../../src/services/pi/model-data";
import { ApplicationWriteError } from "../../../../src/services/storage/ApplicationStorage";
import {
  ModelPresetSettingsStore,
  ModelPresetSettingsStoreFactory,
} from "../../../../src/renderer/stores/ModelPresetSettingsStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const preset = (overrides: Partial<ModelPresetValue> = {}): ModelPresetValue => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Deep review",
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high",
  fastMode: true,
  ...overrides,
});

const presetDraft = (overrides: Partial<ModelPresetValue> = {}) => {
  const value = preset(overrides);
  return {
    name: value.name,
    provider: value.provider,
    modelId: value.modelId,
    thinkingLevel: value.thinkingLevel,
    fastMode: value.fastMode,
  };
};

const catalogModel: PiModel = {
  provider: "openai-codex",
  providerName: "OpenAI Codex",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  reasoning: true,
  supportedThinkingLevels: ["off", "high"],
  fastMode: true,
  input: ["text"],
  authenticated: true,
  available: true,
  authTypes: ["oauth"],
};

function createClient(
  initial: ModelPresetProjection = { presets: [] },
  models: ReadonlyArray<PiModel> = [catalogModel],
) {
  let state: ModelPresetProjection = {
    presets: initial.presets.map((value) => ({ ...value })),
    defaultPresetId: initial.defaultPresetId,
  };
  let nextId = 2;
  let listModelsOverride: CakeIpcClientService["models"]["list"] | undefined;
  let createOverride: CakeIpcClientService["modelPresets"]["create"] | undefined;
  let updateOverride: CakeIpcClientService["modelPresets"]["update"] | undefined;

  const calls = {
    listModels: vi.fn(() => (listModelsOverride ? listModelsOverride() : Effect.succeed(models))),
    listModelPresets: vi.fn(() => Effect.succeed(state)),
    createModelPreset: vi.fn((input: ReturnType<typeof presetDraft>) => {
      if (createOverride) return createOverride(input);
      const created = {
        ...input,
        id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
      };
      state = { ...state, presets: [...state.presets, created] };
      return Effect.succeed(state);
    }),
    updateModelPreset: vi.fn((input: ModelPresetValue) => {
      if (updateOverride) return updateOverride(input);
      state = {
        ...state,
        presets: state.presets.map((value) => (value.id === input.id ? input : value)),
      };
      return Effect.succeed(state);
    }),
    removeModelPreset: vi.fn((id: string) => {
      state = {
        presets: state.presets.filter((value) => value.id !== id),
        defaultPresetId: state.defaultPresetId === id ? undefined : state.defaultPresetId,
      };
      return Effect.succeed(state);
    }),
    setDefaultModelPreset: vi.fn((id?: string) => {
      state = { ...state, defaultPresetId: id };
      return Effect.succeed(state);
    }),
  };

  const client = CakeIpcClient.of({
    application: {
      getHomeDirectory: () => Effect.succeed("/home/user"),
      getState: () =>
        Effect.succeed({
          projects: [],
          resolvedSessionIds: [],
          resolvedCakeChatSessionIds: [],
          unreadSessionIds: [],
          trustedProjectPaths: [],
          fastModeSessionIds: [],
        }),
    },
    models: { list: calls.listModels },
    modelPresets: {
      list: calls.listModelPresets,
      create: calls.createModelPreset,
      update: calls.updateModelPreset,
      remove: calls.removeModelPreset,
      setDefault: calls.setDefaultModelPreset,
      resolve: () => Effect.die("not used"),
    },
    projectSessions: {
      list: () => Effect.die("not used"),
      inspect: () => Effect.die("not used"),
      create: () => Effect.die("not used"),
      open: () => Effect.die("not used"),
      observe: () => Stream.die("not used"),
      prompt: () => Effect.die("not used"),
      steer: () => Effect.die("not used"),
      followUp: () => Effect.die("not used"),
      abort: () => Effect.die("not used"),
      rename: () => Effect.die("not used"),
      fork: () => Effect.die("not used"),
      resolve: () => Effect.die("not used"),
      restore: () => Effect.die("not used"),
    },
    foundation: {
      typedFailure: () => Effect.void,
      stream: () => Stream.empty,
      delay: () => Effect.void,
      activeRequests: () => Effect.succeed({ delays: 0, streams: 0 }),
    },
  } satisfies CakeIpcClientService);

  return {
    client,
    calls,
    state: () => state,
    failModels(message: string) {
      listModelsOverride = () =>
        Effect.fail(new PiModelCatalogError({ operation: "load", message }));
    },
    overrideCreate(operation: CakeIpcClientService["modelPresets"]["create"]) {
      createOverride = operation;
    },
    overrideUpdate(operation: CakeIpcClientService["modelPresets"]["update"]) {
      updateOverride = operation;
    },
  };
}

const handles: Array<{ dispose: Effect.Effect<void> }> = [];

async function mountStore(initial?: ModelPresetProjection, models?: ReadonlyArray<PiModel>) {
  const controlled = createClient(initial, models);
  const handle = await Effect.runPromise(
    mount(ModelPresetSettingsStoreFactory, {
      catalog: [],
      loading: true,
      saving: false,
      sectionRequestRevision: 0,
      revision: 0,
    }).pipe(Effect.provide(Layer.succeed(CakeIpcClient)(controlled.client))),
  );
  handles.push(handle);
  await Effect.runPromise(handle.instance.awaitHydrated());
  return { ...controlled, store: handle.instance, handle };
}

const run = (effect: Effect.Effect<void>) => Effect.runPromise(effect);

afterEach(async () => {
  document.body.innerHTML = "";
  await Promise.all(handles.splice(0).map((handle) => Effect.runPromise(handle.dispose)));
});

describe("ModelPresetSettingsStore", () => {
  it("hydrates the authoritative projection and model catalog through its autorun", async () => {
    const existing = preset();
    const { calls, store } = await mountStore({
      presets: [existing],
      defaultPresetId: existing.id,
    });
    expect(calls.listModelPresets).toHaveBeenCalledOnce();
    expect(calls.listModels).toHaveBeenCalledOnce();
    expect(store.presets).toEqual([existing]);
    expect(store.defaultPresetId).toBe(existing.id);
    expect(store.resolutionStatus(existing)).toBe("available");
  });

  it("keeps stored presets visible when catalog loading fails", async () => {
    const existing = preset({ provider: "missing", modelId: "gone" });
    const controlled = createClient({ presets: [existing] });
    controlled.failModels("catalog failed");
    const handle = await Effect.runPromise(
      mount(ModelPresetSettingsStoreFactory, {
        catalog: [],
        loading: true,
        saving: false,
        sectionRequestRevision: 0,
        revision: 0,
      }).pipe(Effect.provide(Layer.succeed(CakeIpcClient)(controlled.client))),
    );
    handles.push(handle);
    await Effect.runPromise(handle.instance.awaitHydrated());
    expect(handle.instance.presets).toEqual([existing]);
    expect(handle.instance.resolutionStatus(existing)).toBe("unknown");
    expect(handle.instance.error.value).toMatch(/catalog failed/);
  });

  it("creates, edits, duplicates, deletes, and reconciles authoritative IDs", async () => {
    const { calls, store } = await mountStore();
    await run(store.createPreset(presetDraft()));
    expect(store.presets).toHaveLength(1);

    await run(store.updatePreset({ ...store.presets[0]!, name: "Updated" }));
    await run(store.duplicatePreset(store.presets[0]!.id));
    await run(store.deletePreset(store.presets[0]!.id));
    expect(store.presets).toHaveLength(1);
    expect(store.presets[0]!.name).toBe("Updated copy");
    expect(calls.createModelPreset).toHaveBeenCalledTimes(2);
    expect(calls.updateModelPreset).toHaveBeenCalledOnce();
    expect(calls.removeModelPreset).toHaveBeenCalledOnce();
  });

  it("sets and clears the default and derives the last-used fallback", async () => {
    const existing = preset();
    const { store } = await mountStore({ presets: [existing] });
    store.restoreLastUsed({
      provider: "other",
      modelId: "fallback",
      thinkingLevel: "low",
      fastMode: false,
    });
    expect(store.defaultConfiguration?.modelId).toBe("fallback");
    await run(store.setDefaultPreset(existing.id));
    expect(store.defaultConfiguration?.modelId).toBe(existing.modelId);
    await run(store.setDefaultPreset(undefined));
    expect(store.defaultConfiguration?.modelId).toBe("fallback");
  });

  it("keeps optimistic state while serializing commands", async () => {
    const first = Deferred.makeUnsafe<ModelPresetProjection>();
    const firstStarted = Deferred.makeUnsafe<void>();
    const controlled = await mountStore();
    controlled.overrideCreate(() =>
      Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(first))),
    );

    const firstSave = run(controlled.store.createPreset(presetDraft({ name: "First" })));
    const secondSave = run(controlled.store.createPreset(presetDraft({ name: "Latest" })));
    await Effect.runPromise(Deferred.await(firstStarted));
    expect(controlled.store.presets.map((value) => value.name)).toEqual(["First", "Latest"]);
    expect(controlled.calls.createModelPreset).toHaveBeenCalledOnce();

    controlled.overrideCreate(() =>
      Effect.succeed({
        presets: [
          preset({ id: "00000000-0000-4000-8000-000000000010", name: "First" }),
          preset({ id: "00000000-0000-4000-8000-000000000011", name: "Latest" }),
        ],
      }),
    );
    Effect.runSync(
      Deferred.succeed(first, {
        presets: [preset({ id: "00000000-0000-4000-8000-000000000010", name: "First" })],
      }),
    );
    await Promise.all([firstSave, secondSave]);
    expect(controlled.calls.createModelPreset).toHaveBeenCalledTimes(2);
    expect(controlled.store.presets.at(-1)?.name).toBe("Latest");
  });

  it("rolls the latest failed command back to the authoritative projection", async () => {
    const existing = preset();
    const controlled = await mountStore({ presets: [existing] });
    const updateStarted = Deferred.makeUnsafe<void>();
    const continueUpdate = Deferred.makeUnsafe<void>();
    controlled.overrideUpdate(() =>
      Deferred.succeed(updateStarted, undefined).pipe(
        Effect.andThen(Deferred.await(continueUpdate)),
        Effect.andThen(
          Effect.fail(new ApplicationWriteError({ stage: "write", message: "save failed" })),
        ),
      ),
    );
    const save = run(controlled.store.updatePreset({ ...existing, name: "Optimistic" }));
    await Effect.runPromise(Deferred.await(updateStarted));
    expect(controlled.store.presets[0]!.name).toBe("Optimistic");
    Effect.runSync(Deferred.succeed(continueUpdate, undefined));
    await save;
    expect(controlled.store.presets[0]!.name).toBe(existing.name);
    expect(controlled.store.error.value).toMatch(/save failed/);
  });

  it("interrupts an active command when its Store Scope closes", async () => {
    const existing = preset();
    const controlled = await mountStore({ presets: [existing] });
    let interrupted = false;
    const updateStarted = Deferred.makeUnsafe<void>();
    controlled.overrideUpdate(() =>
      Deferred.succeed(updateStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const save = run(controlled.store.updatePreset({ ...existing, name: "Pending" }));
    void save.catch(() => undefined);
    await Effect.runPromise(Deferred.await(updateStarted));
    expect(controlled.calls.updateModelPreset).toHaveBeenCalledOnce();
    await Effect.runPromise(controlled.handle.dispose);
    await expect(save).rejects.toBeDefined();
    expect(interrupted).toBe(true);
  });

  it("publishes updates through the React Store facade", async () => {
    const existing = preset();
    const { store } = await mountStore({ presets: [existing] });
    const Probe = observer(function Probe() {
      const settings = useStore(ModelPresetSettingsStore);
      return React.createElement(
        "span",
        null,
        `${settings.presets.length}:${settings.presets[0]?.name}`,
      );
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(
        React.createElement(StoreProvider, {
          stores: [[ModelPresetSettingsStore, store]],
          children: React.createElement(Probe),
        }),
      );
    });
    expect(container.textContent).toBe("1:Deep review");
    await React.act(async () => {
      await run(store.updatePreset({ ...existing, name: "Updated" }));
    });
    expect(container.textContent).toBe("1:Updated");
    await React.act(async () => root.unmount());
  });
});
