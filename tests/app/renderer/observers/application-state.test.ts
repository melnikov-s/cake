import { it } from "@effect/vitest";
import { Effect, Queue, Stream } from "effect";
import { describe, expect } from "vitest";
import {
  defaultApplicationState,
  type RendererApplicationProjection,
} from "../../../../src/contracts/application/application-data";
import type { ModelPreset } from "../../../../src/contracts/conversations/session-contract";
import { observeApplicationState } from "../../../../src/renderer/observers/application-state";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { observerClient, observerRuntime } from "./observer-test-runtime";

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

// This is the actual transport-to-Store projection boundary, not a parallel
// settings workflow. The settings UI suites cover the consumer interactions.
describe("observeApplicationState", () => {
  it.effect(
    "applies ordered authoritative presets and labels, rejects stale revisions and stops on cancellation",
    () =>
      Effect.gen(function* () {
        const updates = yield* Queue.unbounded<RendererApplicationProjection>();
        const runtime = observerRuntime(
          observerClient({
            application: { observeState: () => Stream.fromQueue(updates) },
          }),
        );
        using fixture = createRendererStoreFixture();
        const cancel = observeApplicationState(runtime, fixture.root);
        const state: RendererApplicationProjection["state"] = {
          ...defaultApplicationState(),
          projects: [],
          globalSessionLabels: [externalStatus],
          unreadSessionIds: [],
          trustedProjectPaths: [],
          fastModeSessionIds: [],
          modelPresets: [externalPreset],
          defaultModelPresetId: externalPreset.id,
        };
        try {
          yield* Queue.offer(updates, { revision: 7, state });
          yield* Queue.take(runtime.consumed);
          expect(fixture.root.settingsStore.modelPresets.presets[0]?.name).toBe(
            "Changed elsewhere",
          );
          expect(fixture.root.settingsStore.modelPresets.defaultPresetId).toBe(externalPreset.id);
          expect(fixture.root.settingsStore.globalLabels.labels).toEqual([externalStatus]);
          const nextState = {
            ...state,
            modelPresets: [{ ...externalPreset, name: "Newest authority" }],
            globalSessionLabels: [],
          };
          yield* Queue.offer(updates, { revision: 8, state: nextState });
          yield* Queue.take(runtime.consumed);
          yield* Queue.offer(updates, { revision: 7, state });
          yield* Queue.take(runtime.consumed);
          expect(fixture.root.settingsStore.modelPresets.presets[0]?.name).toBe("Newest authority");
          expect(fixture.root.settingsStore.globalLabels.labels).toEqual([]);
          cancel();
          yield* Effect.promise(() => runtime.dispose());
          yield* Queue.offer(updates, { revision: 9, state });
          expect(fixture.root.settingsStore.modelPresets.presets[0]?.name).toBe("Newest authority");
        } finally {
          cancel();
          yield* Effect.promise(() => runtime.dispose());
        }
      }),
  );
});
