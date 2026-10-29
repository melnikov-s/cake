/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Queue, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  defaultApplicationState,
  type RendererApplicationProjection,
} from "../../../../src/contracts/application/application-data";
import type { ModelPreset } from "../../../../src/contracts/conversations/session-contract";
import { LabelSettings } from "../../../../src/renderer/components/label-settings";
import { ModelPresetSettings } from "../../../../src/renderer/components/model-preset-settings";
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
afterEach(cleanup);

it("updates open preset and label settings from ordered authority, without replaying stale or cancelled observations", async () => {
  const updates = Effect.runSync(Queue.unbounded<RendererApplicationProjection>());
  const runtime = observerRuntime(
    observerClient({ application: { observeState: () => Stream.fromQueue(updates) } }),
  );
  using fixture = createRendererStoreFixture();
  const cancel = observeApplicationState(runtime, fixture.root);
  const view = render(
    <>
      <ModelPresetSettings settings={fixture.root.settingsStore.modelPresets} />
      <LabelSettings
        store={fixture.root.settingsStore.globalLabels}
        title="Global labels"
        description="Labels available across projects."
      />
    </>,
  );
  const user = userEvent.setup();
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
  const emit = async (update: RendererApplicationProjection) => {
    await act(async () => {
      Queue.offerUnsafe(updates, update);
      await Effect.runPromise(Queue.take(runtime.consumed));
    });
  };
  try {
    await emit({ revision: 7, state });
    expect(screen.getByText("Changed elsewhere")).toBeDefined();
    expect(screen.getByRole("button", { name: "Default" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Edit In review" }));
    expect(screen.getByRole("radiogroup", { name: "Color for In review" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await emit({
      revision: 8,
      state: {
        ...state,
        modelPresets: [{ ...externalPreset, name: "Newest authority" }],
        globalSessionLabels: [],
      },
    });
    await emit({ revision: 7, state });
    expect(screen.getByText("No labels yet.")).toBeDefined();
    expect(screen.queryByText("Changed elsewhere")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty(
      "value",
      "Newest authority",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    cancel();
    await runtime.dispose();
    await act(async () => {
      Queue.offerUnsafe(updates, { revision: 9, state });
    });
    expect(screen.getByText("Newest authority")).toBeDefined();
    expect(screen.getByText("No labels yet.")).toBeDefined();
  } finally {
    view.unmount();
    cancel();
    await runtime.dispose();
  }
});
