import { Effect, Stream } from "effect";
import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import type { ModelPreset } from "../../../../src/ipc/session-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { observeApplicationState } from "../../../../src/renderer/observers/application-state";
import { observeStream } from "../../../../src/renderer/observers/observe-stream";
import type { Runtime } from "../../../../src/renderer/runtime";
import type { RootStore } from "../../../../src/renderer/stores/RootStore";
import { SettingsStore } from "../../../../src/renderer/stores/SettingsStore";
import { ClientContext } from "../../../../src/renderer/stores/context/ClientContext";

const runtimeFor = (client: CakeIpcClientService): Runtime => {
  const execute: Runtime["execute"] = (effect, signal) =>
    Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, client),
      signal ? { signal } : undefined,
    );
  return {
    execute,
    observe: (source, consume, options) => observeStream(execute, source, consume, options),
    dispose: async () => undefined,
  };
};

class HarnessStore extends Store {
  [ClientContext.provide]() {
    return {} as Client;
  }

  @child get settings() {
    return createStore(SettingsStore, {
      operations: {} as never,
      activeSession: () => undefined,
      workbenchError: () => undefined,
    });
  }
}

const externalPreset: ModelPreset = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Changed elsewhere",
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high",
  fastMode: true,
};

describe("observeApplicationState", () => {
  it("projects authoritative preset revisions into visible settings state", async () => {
    const client = {
      application: {
        observeState: () =>
          Stream.concat(
            Stream.make({
              revision: 7,
              state: {
                projects: [],
                unreadSessionIds: [],
                trustedProjectPaths: [],
                fastModeSessionIds: [],
                modelPresets: [externalPreset],
                defaultModelPresetId: externalPreset.id,
              },
            }),
            Stream.never,
          ),
      },
    } as unknown as CakeIpcClientService;
    const harness = mount(createStore(HarnessStore));
    const root = { settingsStore: harness.settings } as unknown as RootStore;

    const cancel = observeApplicationState(runtimeFor(client), root);

    await expect
      .poll(() => harness.settings.modelPresets.presets[0]?.name)
      .toBe("Changed elsewhere");
    expect(harness.settings.modelPresets.defaultPresetId).toBe(externalPreset.id);

    cancel();
    harness[Symbol.dispose]();
  });
});
