import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ModelOption, ModelPreset } from "../../../../src/ipc/session-contract";
import { ModelPresetSettingsStore } from "../../../../src/renderer/stores/ModelPresetSettingsStore";
import type { Client } from "../../../../src/renderer/client/Client";
import { ClientContext } from "../../../../src/renderer/stores/context/ClientContext";

interface Projection {
  presets: readonly ModelPreset[];
  defaultPresetId?: string;
}

const preset = (overrides: Partial<ModelPreset> = {}): ModelPreset => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Deep review",
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high",
  fastMode: true,
  ...overrides,
});

const presetDraft = (overrides: Partial<ModelPreset> = {}): Omit<ModelPreset, "id"> => {
  const value = preset(overrides);
  return {
    name: value.name,
    provider: value.provider,
    modelId: value.modelId,
    thinkingLevel: value.thinkingLevel,
    fastMode: value.fastMode,
  };
};

const catalogModel: ModelOption = {
  provider: "openai-codex",
  providerName: "OpenAI Codex",
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  reasoning: true,
  availableThinkingLevels: ["off", "high"],
  fastMode: true,
  input: ["text"],
  authenticated: true,
  available: true,
  authTypes: ["oauth"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createClient(initial: Projection = { presets: [] }, models = [catalogModel]) {
  let state: Projection = {
    presets: initial.presets.map((value) => ({ ...value })),
    defaultPresetId: initial.defaultPresetId,
  };
  let nextId = 2;
  const client = {
    listModels: vi.fn(async () => models),
    listModelPresets: vi.fn(async () => state),
    createModelPreset: vi.fn(async (input: Omit<ModelPreset, "id">) => {
      const created = {
        ...input,
        id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
      };
      state = { ...state, presets: [...state.presets, created] };
      return state;
    }),
    updateModelPreset: vi.fn(async (input: ModelPreset) => {
      state = {
        ...state,
        presets: state.presets.map((value) => (value.id === input.id ? input : value)),
      };
      return state;
    }),
    reorderModelPresets: vi.fn(async ({ ids }: { ids: readonly string[] }) => {
      const indexById = new Map(ids.map((id, index) => [id, index]));
      state = {
        ...state,
        presets: [...state.presets].sort(
          (left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0),
        ),
      };
      return state;
    }),
    removeModelPreset: vi.fn(async (id: string) => {
      state = {
        presets: state.presets.filter((value) => value.id !== id),
        defaultPresetId: state.defaultPresetId === id ? undefined : state.defaultPresetId,
      };
      return state;
    }),
    setDefaultModelPreset: vi.fn(async (id?: string) => {
      state = { ...state, defaultPresetId: id };
      return state;
    }),
  };
  return { client, state: () => state };
}

class HarnessStore extends Store<{ client: Client }> {
  [ClientContext.provide]() {
    return this.props.client;
  }

  @child get settings() {
    return createStore(ModelPresetSettingsStore);
  }
}

function mountStore(initial?: Projection, models?: ModelOption[]) {
  const controlled = createClient(initial, models);
  const client = {
    models: {
      list: controlled.client.listModels,
      refresh: vi.fn(),
    },
    modelPresets: {
      list: controlled.client.listModelPresets,
      create: controlled.client.createModelPreset,
      update: controlled.client.updateModelPreset,
      reorder: controlled.client.reorderModelPresets,
      remove: controlled.client.removeModelPreset,
      setDefault: controlled.client.setDefaultModelPreset,
      resolve: vi.fn(),
    },
  } as unknown as Client;
  const root = mount(createStore(HarnessStore, { client: client }));
  return {
    ...controlled,
    store: root.settings,
    dispose: () => root[Symbol.dispose](),
  };
}

describe("ModelPresetSettingsStore", () => {
  it("hydrates presets and the session-less model catalog through focused queries", async () => {
    const existing = preset();
    const { client, store, dispose } = mountStore({
      presets: [existing],
      defaultPresetId: existing.id,
    });
    await store.hydrate();
    expect(client.listModelPresets).toHaveBeenCalledOnce();
    expect(client.listModels).toHaveBeenCalledOnce();
    expect(store.presets).toEqual([existing]);
    expect(store.defaultPresetId).toBe(existing.id);
    expect(store.loading).toBe(false);
    dispose();
  });

  it("keeps stored presets visible when catalog loading fails", async () => {
    const existing = preset({ provider: "missing", modelId: "gone" });
    const { client, store, dispose } = mountStore({ presets: [existing] });
    client.listModels.mockRejectedValueOnce(new Error("catalog failed"));
    await store.hydrate();
    expect(store.presets).toEqual([existing]);
    expect(store.resolutionStatus(existing)).toBe("unknown");
    expect(store.error).toMatch(/catalog failed/);
    dispose();
  });

  it("creates, edits, duplicates, deletes, and reconciles authoritative IDs", async () => {
    const { client, store, dispose } = mountStore();
    await store.hydrate();
    const create = store.createPreset(presetDraft());
    expect(store.presets).toHaveLength(1);
    const optimisticId = store.presets[0]!.id;
    await create;
    expect(store.presets[0]!.id).not.toBe(optimisticId);

    await store.updatePreset({ ...store.presets[0]!, name: "Updated" });
    expect(store.presets[0]!.name).toBe("Updated");
    await store.duplicatePreset(store.presets[0]!.id);
    expect(store.presets).toHaveLength(2);
    expect(store.presets[1]!.name).toBe("Updated copy");
    await store.deletePreset(store.presets[0]!.id);
    expect(store.presets).toHaveLength(1);
    expect(client.createModelPreset).toHaveBeenCalledTimes(2);
    expect(client.updateModelPreset).toHaveBeenCalledOnce();
    expect(client.removeModelPreset).toHaveBeenCalledOnce();
    dispose();
  });

  it("optimistically reorders presets and persists their order", async () => {
    const first = preset({ name: "First" });
    const second = preset({ id: "00000000-0000-4000-8000-000000000002", name: "Second" });
    const third = preset({ id: "00000000-0000-4000-8000-000000000003", name: "Third" });
    const { client, store, dispose } = mountStore({ presets: [first, second, third] });
    await store.hydrate();

    const save = store.reorderPreset(first.id, third.id);
    expect(store.presets.map((value) => value.name)).toEqual(["Second", "Third", "First"]);
    await save;
    expect(client.reorderModelPresets).toHaveBeenCalledWith(
      { ids: [second.id, third.id, first.id] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(store.presets.map((value) => value.name)).toEqual(["Second", "Third", "First"]);
    dispose();
  });

  it("sets and clears the default and derives last-used fallback", async () => {
    const existing = preset();
    const { store, dispose } = mountStore({ presets: [existing] });
    await store.hydrate();
    store.recordUsage({
      provider: "other",
      modelId: "fallback",
      thinkingLevel: "low",
      fastMode: false,
    });
    expect(store.defaultConfiguration?.modelId).toBe("fallback");
    await store.setDefaultPreset(existing.id);
    expect(store.defaultConfiguration).toEqual({
      provider: existing.provider,
      modelId: existing.modelId,
      thinkingLevel: existing.thinkingLevel,
      fastMode: existing.fastMode,
    });
    await store.setDefaultPreset(undefined);
    expect(store.defaultConfiguration?.modelId).toBe("fallback");
    dispose();
  });

  it("keeps optimistic state while serializing commands and rejects stale responses", async () => {
    const first = deferred<Projection>();
    const { client, store, dispose } = mountStore();
    client.createModelPreset.mockReturnValueOnce(first.promise);
    await store.hydrate();

    const firstSave = store.createPreset(presetDraft({ name: "First" }));
    const secondSave = store.createPreset(presetDraft({ name: "Latest" }));
    expect(store.presets.map((value) => value.name)).toEqual(["First", "Latest"]);
    await vi.waitFor(() => expect(client.createModelPreset).toHaveBeenCalledOnce());

    first.resolve({
      presets: [preset({ id: "00000000-0000-4000-8000-000000000010", name: "First" })],
    });
    await firstSave;
    expect(store.presets.map((value) => value.name)).toEqual(["First", "Latest"]);
    await secondSave;
    expect(client.createModelPreset).toHaveBeenCalledTimes(2);
    expect(store.presets.at(-1)?.name).toBe("Latest");
    dispose();
  });

  it("rolls the latest failed command back to the authoritative projection", async () => {
    const existing = preset();
    const { client, store, dispose } = mountStore({ presets: [existing] });
    await store.hydrate();
    client.updateModelPreset.mockRejectedValueOnce(new Error("save failed"));
    const save = store.updatePreset({ ...existing, name: "Optimistic" });
    expect(store.presets[0]!.name).toBe("Optimistic");
    await save;
    expect(store.presets[0]!.name).toBe(existing.name);
    expect(store.error).toMatch(/save failed/);
    dispose();
  });

  it("does not publish a pending command result after disposal", async () => {
    const pending = deferred<Projection>();
    const existing = preset();
    const { client, store, dispose } = mountStore({ presets: [existing] });
    await store.hydrate();
    client.updateModelPreset.mockReturnValueOnce(pending.promise);
    const save = store.updatePreset({ ...existing, name: "Optimistic" });
    dispose();
    pending.resolve({ presets: [{ ...existing, name: "Late" }] });
    await save;
    expect(store.presets[0]!.name).toBe("Optimistic");
  });

  it("keeps unresolved presets visible and editable", async () => {
    const unresolved = preset({ provider: "missing", modelId: "gone" });
    const { store, dispose } = mountStore({ presets: [unresolved] });
    await store.hydrate();
    expect(store.resolutionStatus(store.presets[0]!)).toBe("unknown");
    await store.updatePreset({ ...unresolved, name: "Still editable" });
    expect(store.presets[0]!.name).toBe("Still editable");
    dispose();
  });
});
