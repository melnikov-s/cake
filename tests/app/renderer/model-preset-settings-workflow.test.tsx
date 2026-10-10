/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { ModelOption, ModelPreset } from "../../../src/ipc/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const preset: ModelPreset = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Deep review",
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high",
  fastMode: true,
};
const model: ModelOption = {
  provider: preset.provider,
  providerName: "OpenAI Codex",
  id: preset.modelId,
  name: "GPT-5.6 Sol",
  reasoning: true,
  availableThinkingLevels: ["off", "high"],
  fastMode: true,
  input: ["text"],
  authenticated: true,
  available: true,
  authTypes: ["oauth"],
};
type Projection = Awaited<ReturnType<Client["modelPresets"]["create"]>>;

async function renderSettings(client: TestClientOverrides = {}, presets: ModelPreset[] = [preset]) {
  const fixture = createRendererStoreFixture({
    client: { ...client, models: { list: async () => [model], ...client.models } },
  });
  fixture.root.settingsStore.applyApplicationState(0, {
    ...defaultApplicationState(),
    modelPresets: presets,
  });
  await fixture.root.settingsStore.modelPresets.hydrate();
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  let applicationRevision = 0;
  return {
    user: userEvent.setup(),
    async publishPresets(projection: Projection) {
      await act(async () => {
        fixture.root.settingsStore.applyApplicationState(++applicationRevision, {
          ...defaultApplicationState(),
          modelPresets: projection.presets,
          defaultModelPresetId: projection.defaultPresetId,
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
function row(name: string) {
  const article = screen.getByText(name).closest("article");
  if (!article) throw new Error(`Missing preset row: ${name}`);
  return within(article);
}
async function rename(user: ReturnType<typeof userEvent.setup>, name: string, next: string) {
  await user.click(row(name).getByRole("button", { name: "Edit" }));
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), next);
  await user.click(screen.getByRole("button", { name: "Save preset" }));
}
afterEach(cleanup);

describe("Model preset settings workflow", () => {
  it("creates a named model configuration and edits its authoritative identity", async () => {
    const created = {
      ...preset,
      name: "Focused review",
      thinkingLevel: "off" as const,
      fastMode: false,
    };
    const create = vi.fn<Client["modelPresets"]["create"]>(async () => ({ presets: [created] }));
    const update = vi.fn<Client["modelPresets"]["update"]>(async (value) => ({ presets: [value] }));
    using fixture = await renderSettings({ modelPresets: { create, update } }, []);
    expect(screen.getByText("No presets yet. Create one for your preferred setup.")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "New preset" }));
    await fixture.user.type(screen.getByRole("textbox", { name: "Name" }), "  Focused review  ");
    await fixture.user.click(screen.getByRole("button", { name: "Preset model" }));
    await fixture.user.click(screen.getByRole("button", { name: /GPT-5.6 Sol/ }));
    await fixture.user.click(screen.getByRole("button", { name: "Apply" }));
    await fixture.user.click(screen.getByRole("button", { name: "Save preset" }));
    await screen.findByText("Focused review");
    expect(create).toHaveBeenCalledWith(
      {
        name: "Focused review",
        provider: preset.provider,
        modelId: preset.modelId,
        thinkingLevel: "off",
        fastMode: false,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await rename(fixture.user, "Focused review", "Final review");
    await screen.findByText("Final review");
    expect(update).toHaveBeenCalledWith(
      { ...created, name: "Final review" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sets and clears the new-conversation default, then deletes the preset", async () => {
    const setDefault = vi.fn<Client["modelPresets"]["setDefault"]>(async (id) => ({
      presets: [preset],
      defaultPresetId: id,
    }));
    const remove = vi.fn<Client["modelPresets"]["remove"]>(async () => ({ presets: [] }));
    using fixture = await renderSettings({ modelPresets: { setDefault, remove } });
    await fixture.user.click(row(preset.name).getByRole("button", { name: "Set default" }));
    expect(await screen.findByRole("button", { name: "Default", pressed: true })).toBeDefined();
    await waitFor(() =>
      expect(setDefault).toHaveBeenCalledWith(
        preset.id,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Clear default" }));
    await screen.findByRole("button", { name: "Set default", pressed: false });
    await waitFor(() =>
      expect(setDefault).toHaveBeenLastCalledWith(
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.user.click(row(preset.name).getByRole("button", { name: "Delete" }));
    await screen.findByText("No presets yet. Create one for your preferred setup.");
    expect(remove).toHaveBeenCalledWith(
      preset.id,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("queues deletion of a pending duplicate against the server-assigned identity", async () => {
    let complete!: (value: Projection) => void;
    const pending = new Promise<Projection>((resolve) => {
      complete = resolve;
    });
    const copy = {
      ...preset,
      id: "00000000-0000-4000-8000-000000000002",
      name: "Deep review copy",
    };
    const create = vi.fn<Client["modelPresets"]["create"]>(() => pending);
    const remove = vi.fn<Client["modelPresets"]["remove"]>(async () => ({ presets: [preset] }));
    using fixture = await renderSettings({ modelPresets: { create, remove } });
    await fixture.user.click(row(preset.name).getByRole("button", { name: "Duplicate" }));
    await screen.findByText(copy.name);
    await fixture.user.click(row(copy.name).getByRole("button", { name: "Delete" }));
    expect(screen.queryByText(copy.name)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    await act(async () => complete({ presets: [preset, copy] }));
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(
        copy.id,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.queryByText(copy.name)).toBeNull();
    expect(screen.getByText(preset.name)).toBeDefined();
  });

  it("preserves another window's newer name and default when a pending save returns stale data", async () => {
    let complete!: (value: Projection) => void;
    const pending = new Promise<Projection>((resolve) => {
      complete = resolve;
    });
    const update = vi.fn<Client["modelPresets"]["update"]>(() => pending);
    using fixture = await renderSettings({ modelPresets: { update } });

    await rename(fixture.user, preset.name, "Local edit");
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(screen.getByText("Local edit")).toBeDefined();
    expect(screen.getByRole("button", { name: "Set default", pressed: false })).toBeDefined();

    await fixture.publishPresets({
      presets: [{ ...preset, name: "Changed in another window" }],
      defaultPresetId: preset.id,
    });
    // The in-flight local edit remains visible until its command settles.
    expect(screen.getByText("Local edit")).toBeDefined();
    await act(async () => complete({ presets: [{ ...preset, name: "Local edit" }] }));

    await screen.findByText("Changed in another window");
    expect(screen.queryByText("Local edit")).toBeNull();
    expect(
      row("Changed in another window").getByRole("button", { name: "Default", pressed: true }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear default" })).toBeDefined();
  });

  it("keeps unavailable presets editable and restores their saved name after failure, allowing retry", async () => {
    const unavailable = { ...preset, provider: "missing", modelId: "gone" };
    let fail!: (reason: Error) => void;
    const pending = new Promise<Projection>((_resolve, reject) => {
      fail = reject;
    });
    const update = vi
      .fn<Client["modelPresets"]["update"]>()
      .mockImplementationOnce(() => pending)
      .mockImplementation(async (value) => ({ presets: [value] }));
    using fixture = await renderSettings(
      {
        modelPresets: { update },
        models: {
          list: async () => {
            throw new Error("Catalog offline");
          },
        },
      },
      [unavailable],
    );
    expect(screen.getByText(/Catalog offline/)).toBeDefined();
    expect(row(preset.name).getByText("Model unavailable")).toBeDefined();
    await rename(fixture.user, preset.name, "Local edit");
    expect(screen.getByText("Local edit")).toBeDefined();
    await act(async () => fail(new Error("Save failed")));
    await screen.findByText(/Save failed/);
    expect(screen.queryByText("Local edit")).toBeNull();
    expect(screen.getByText(preset.name)).toBeDefined();
    await rename(fixture.user, preset.name, "Recovered review");
    await screen.findByText("Recovered review");
    await waitFor(() => expect(screen.queryByText(/Save failed/)).toBeNull());
    expect(update).toHaveBeenLastCalledWith(
      { ...unavailable, name: "Recovered review" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
