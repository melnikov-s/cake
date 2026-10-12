import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import type { ModelPreset } from "../../../../src/contracts/conversations/session-contract";
import { observeApplicationState } from "../../../../src/renderer/observers/application-state";
import { observeStream } from "../../../../src/renderer/observers/observe-stream";
import type { Runtime } from "../../../../src/renderer/runtime";
import { createRendererStoreFixture } from "../renderer-store-fixture";

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
const externalStatus = {
  id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
  name: "In review",
  color: "cyan" as const,
};
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
                globalSessionLabels: [externalStatus],
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
    using fixture = createRendererStoreFixture();
    const cancel = observeApplicationState(runtimeFor(client), fixture.root);
    try {
      await expect
        .poll(() => fixture.root.settingsStore.modelPresets.presets[0]?.name)
        .toBe("Changed elsewhere");
      expect(fixture.root.settingsStore.modelPresets.defaultPresetId).toBe(externalPreset.id);
      expect(fixture.root.settingsStore.globalLabels.labels).toEqual([externalStatus]);
    } finally {
      cancel();
    }
  });
});
