import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationState, UtilityModel } from "../../../../src/ipc/session-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { UtilityModelSettingsStore } from "../../../../src/renderer/stores/UtilityModelSettingsStore";
import { mountWithClient } from "../mount-with-client";

const applicationState = (utilityModel?: UtilityModel): ApplicationState => ({
  projects: [],
  unreadSessionIds: [],
  trustedProjectPaths: [],
  fastModeSessionIds: [],
  modelPresets: [],
  utilityModel,
});

function mountUtility(setUtilityModel: Client["workspaces"]["setUtilityModel"]) {
  return mountWithClient(createStore(UtilityModelSettingsStore), {
    workspaces: { setUtilityModel },
  } as unknown as Client);
}

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
    const { root, subject: store } = mountUtility(setUtilityModel);

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
    root[Symbol.dispose]();
  });

  it("retains an authoritative application event received while a save is in flight", async () => {
    const pending = deferred<ApplicationState>();
    const setUtilityModel = vi.fn(() => pending.promise);
    const { root, subject: store } = mountUtility(setUtilityModel);
    store.applyApplicationState(
      0,
      applicationState({ provider: "openai", modelId: "confirmed", thinkingLevel: "low" }),
    );
    const save = store.select("openai/optimistic", "high");
    await vi.waitFor(() => expect(setUtilityModel).toHaveBeenCalledOnce());

    store.applyApplicationState(
      1,
      applicationState({ provider: "openai", modelId: "authoritative", thinkingLevel: "off" }),
    );
    expect(store.model?.modelId).toBe("optimistic");

    pending.resolve(
      applicationState({ provider: "openai", modelId: "optimistic", thinkingLevel: "high" }),
    );
    await save;
    expect(store.model?.modelId).toBe("authoritative");
    root[Symbol.dispose]();
  });

  it("ignores stale and duplicate application revisions", () => {
    const { root, subject: store } = mountUtility(vi.fn());
    store.applyApplicationState(
      2,
      applicationState({ provider: "openai", modelId: "current", thinkingLevel: "high" }),
    );
    store.applyApplicationState(
      1,
      applicationState({ provider: "openai", modelId: "older", thinkingLevel: "low" }),
    );
    store.applyApplicationState(
      2,
      applicationState({ provider: "openai", modelId: "duplicate", thinkingLevel: "off" }),
    );

    expect(store.model?.modelId).toBe("current");
    root[Symbol.dispose]();
  });

  it("ignores a save completion after disposal", async () => {
    const pending = deferred<ApplicationState>();
    const { root, subject: store } = mountUtility(vi.fn(() => pending.promise));
    const save = store.select("openai/model", "medium");
    root[Symbol.dispose]();

    pending.resolve(
      applicationState({ provider: "openai", modelId: "server-value", thinkingLevel: "high" }),
    );
    await save;

    expect(store.model?.modelId).toBe("model");
  });
});
