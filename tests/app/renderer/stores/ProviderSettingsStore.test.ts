import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ModelOption, PiSettings } from "../../../../src/ipc/session-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { ProviderSettingsStore } from "../../../../src/renderer/stores/ProviderSettingsStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { ClientContext } from "../../../../src/renderer/stores/context/ClientContext";

const model = (overrides: Partial<ModelOption> = {}): ModelOption => ({
  provider: "anthropic",
  providerName: "Anthropic",
  id: "claude-sonnet",
  name: "Claude Sonnet",
  reasoning: true,
  availableThinkingLevels: ["off", "high"],
  fastMode: false,
  input: ["text"],
  authenticated: false,
  available: true,
  authTypes: ["api_key"],
  ...overrides,
});

class HarnessStore extends Store<{ client: Client }> {
  [ClientContext.provide]() {
    return this.props.client;
  }

  @child get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child get providers() {
    return createStore(ProviderSettingsStore, { operations: this.operations });
  }
}

function mountStore(catalogs: ReadonlyArray<ReadonlyArray<ModelOption>>) {
  let index = 0;
  const list = vi.fn(async () => catalogs[Math.min(index++, catalogs.length - 1)] ?? []);
  const refresh = vi.fn(async () => undefined);
  const login = vi.fn(async () => undefined);
  const logout = vi.fn(async () => undefined);
  const initialSettings = { shellPath: "", reloadPending: false } as PiSettings;
  const getSettings = vi.fn(async () => initialSettings);
  const updateSettings = vi.fn(async () => ({ ...initialSettings, shellPath: "/bin/fish" }));
  const reloadSettings = vi.fn(async () => initialSettings);
  const client = {
    models: { list, refresh, login, logout },
    piSettings: { get: getSettings, update: updateSettings, reload: reloadSettings },
  } as unknown as Client;
  const root = mount(createStore(HarnessStore, { client }));
  return {
    root,
    store: root.providers,
    list,
    refresh,
    login,
    logout,
    getSettings,
    updateSettings,
  };
}

describe("ProviderSettingsStore", () => {
  it("loads and groups providers without an active chat", async () => {
    const { root, store, list } = mountStore([
      [
        model(),
        model({ id: "claude-opus", name: "Claude Opus" }),
        model({
          provider: "openai",
          providerName: "OpenAI",
          id: "gpt-5",
          name: "GPT-5",
          authTypes: ["oauth"],
        }),
      ],
    ]);

    await store.hydrate();

    expect(list).toHaveBeenCalledOnce();
    expect(store.loadingModels).toBe(false);
    expect(store.loadingSettings).toBe(false);
    expect(store.piSettings?.shellPath).toBe("");
    expect(store.modelsByProvider).toEqual([
      expect.objectContaining({ id: "anthropic", name: "Anthropic", models: expect.any(Array) }),
      expect.objectContaining({ id: "openai", name: "OpenAI", models: expect.any(Array) }),
    ]);
    expect(store.modelsByProvider[0]?.models).toHaveLength(2);
    root[Symbol.dispose]();
  });

  it("loads and updates Pi settings without an active chat", async () => {
    const { root, store, getSettings, updateSettings } = mountStore([[model()]]);

    await store.hydrate();
    await store.setPiSetting({ key: "shellPath", value: "/bin/fish" });

    expect(getSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith(
      { key: "shellPath", value: "/bin/fish" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(store.piSettings?.shellPath).toBe("/bin/fish");
    root[Symbol.dispose]();
  });

  it("reloads the provider catalog after refreshing models", async () => {
    const { root, store, refresh } = mountStore([
      [model()],
      [model(), model({ provider: "openai", providerName: "OpenAI", id: "gpt-5" })],
    ]);
    await store.hydrate();

    await store.refreshModels();

    expect(refresh).toHaveBeenCalledOnce();
    expect(store.modelsByProvider.map((provider) => provider.id)).toEqual(["anthropic", "openai"]);
    root[Symbol.dispose]();
  });

  it("authenticates and reloads providers without an active chat", async () => {
    const { root, store, login } = mountStore([
      [model()],
      [model({ authenticated: true, authSource: "stored" })],
    ]);
    await store.hydrate();

    await store.authenticate("anthropic", "api_key");

    expect(login).toHaveBeenCalledWith(
      { provider: "anthropic", authType: "api_key" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(store.modelsByProvider[0]?.models[0]?.authenticated).toBe(true);
    root[Symbol.dispose]();
  });
});
