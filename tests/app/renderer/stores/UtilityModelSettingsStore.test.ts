import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationState, UtilityModel } from "../../../../src/ipc/session-contract";
import { UtilityModelSettingsStore } from "../../../../src/renderer/stores/UtilityModelSettingsStore";

const applicationState = (utilityModel?: UtilityModel): ApplicationState => ({
  schemaVersion: 1,
  projects: [],
  resolvedSessionIds: [],
  resolvedCakeChatSessionIds: [],
  trustedProjectPaths: [],
  utilityModel,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("UtilityModelSettingsStore", () => {
  it("serializes saves while retaining the latest optimistic selection", async () => {
    const first = deferred<ApplicationState>();
    const setUtilityModel = vi
      .fn<(model: UtilityModel | undefined) => Promise<ApplicationState>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (model) => applicationState(model));
    const store = mount(createStore(UtilityModelSettingsStore, { client: { setUtilityModel } }));

    const firstSave = store.select("openai/first", "low");
    const secondSave = store.select("openai/latest", "high");
    expect(store.model?.modelId).toBe("latest");
    await vi.waitFor(() => expect(setUtilityModel).toHaveBeenCalledOnce());

    first.resolve(applicationState({ provider: "openai", modelId: "first", thinkingLevel: "low" }));
    await firstSave;
    await secondSave;

    expect(setUtilityModel).toHaveBeenCalledTimes(2);
    expect(store.model).toEqual({ provider: "openai", modelId: "latest", thinkingLevel: "high" });
    expect(store.saving).toBe(false);
    store[Symbol.dispose]();
  });

  it("does not let a stale application event overwrite an optimistic edit", async () => {
    const pending = deferred<ApplicationState>();
    const store = mount(
      createStore(UtilityModelSettingsStore, {
        client: { setUtilityModel: vi.fn(() => pending.promise) },
      }),
    );
    store.applyApplicationState(
      applicationState({ provider: "openai", modelId: "confirmed", thinkingLevel: "low" }),
    );
    const save = store.select("openai/optimistic", "high");

    store.applyApplicationState(
      applicationState({ provider: "openai", modelId: "stale", thinkingLevel: "off" }),
    );
    expect(store.model?.modelId).toBe("optimistic");

    pending.resolve(
      applicationState({ provider: "openai", modelId: "optimistic", thinkingLevel: "high" }),
    );
    await save;
    expect(store.model?.modelId).toBe("optimistic");
    store[Symbol.dispose]();
  });

  it("ignores a save completion after disposal", async () => {
    const pending = deferred<ApplicationState>();
    const store = mount(
      createStore(UtilityModelSettingsStore, {
        client: { setUtilityModel: vi.fn(() => pending.promise) },
      }),
    );
    const save = store.select("openai/model", "medium");
    store[Symbol.dispose]();

    pending.resolve(
      applicationState({ provider: "openai", modelId: "server-value", thinkingLevel: "high" }),
    );
    await save;

    expect(store.model?.modelId).toBe("model");
  });
});
