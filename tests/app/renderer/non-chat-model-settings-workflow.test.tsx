/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { projectPiSettings } from "../../../src/services/pi/runtime/settings-translation";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { NonChatModelPreferences } from "../../../src/contracts/models/non-chat-model-data";
import type { PiNonChatModel } from "../../../src/contracts/pi/model-data";
import type { Client } from "../../../src/renderer/client/Client";
import type { ModelOption } from "../../../src/ipc/session-contract";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { nonChatModelChoiceValue } from "../../../src/renderer/lib/non-chat-model-choice";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const reference = (modelId: string) => ({ provider: "openrouter", modelId });
const imageAValue = nonChatModelChoiceValue(reference("image-a"));
const imageBValue = nonChatModelChoiceValue(reference("image-b"));
const chatModel: ModelOption = {
  provider: "openai",
  providerName: "OpenAI",
  id: "chat",
  name: "Chat fixture",
  reasoning: false,
  availableThinkingLevels: ["off"],
  input: ["text"],
  authenticated: true,
  available: true,
  authTypes: ["api_key"],
};
const catalog: PiNonChatModel[] = [
  {
    type: "image",
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "image-a",
    name: "Image A",
    input: ["text"],
    authenticated: true,
    available: true,
    authSource: "stored",
    authLabel: "API key",
    authTypes: ["api_key"],
  },
  {
    type: "image",
    provider: "openrouter",
    providerName: "OpenRouter",
    id: "image-b",
    name: "Image B",
    input: ["text"],
    authenticated: true,
    available: false,
    authSource: "stored",
    authTypes: ["api_key"],
  },
  {
    type: "image",
    provider: "custom/image",
    providerName: "Custom image",
    id: "variant/1",
    name: "Path model",
    input: ["text"],
    authenticated: true,
    available: true,
    authTypes: [],
  },
  {
    type: "classifier",
    provider: "typesafe",
    providerName: "TypeSafe",
    id: "jev-latest",
    name: "Jev",
    input: ["text"],
    authenticated: false,
    available: false,
    authTypes: ["api_key"],
  },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}
async function setup(
  updatePreference: Client["nonChatModels"]["updatePreference"],
  initial: NonChatModelPreferences = { image: reference("image-a") },
) {
  let entries = catalog;
  let pi = projectPiSettings(SettingsManager.inMemory());
  const login = vi.fn<Client["models"]["login"]>(async () => {
    entries = entries.map((entry) =>
      entry.provider === "typesafe"
        ? { ...entry, available: true, authenticated: true, authSource: "stored" }
        : entry,
    );
  });
  const updatePi = vi.fn<Client["piSettings"]["update"]>(async (update) => {
    if (update.key === "defaultTools") pi = { ...pi, defaultTools: update.value };
    if (update.key === "codemodeInlineBudget") pi = { ...pi, codemodeInlineBudget: update.value };
    return pi;
  });
  const fixture = createRendererStoreFixture({
    client: {
      nonChatModels: { list: async () => entries, updatePreference },
      models: { list: async () => [chatModel], refresh: async () => {}, login },
      piSettings: { get: async () => pi, update: updatePi },
    },
  });
  fixture.root.settingsStore.applyApplicationState(0, {
    ...defaultApplicationState(),
    nonChatModelPreferences: initial,
  });
  await fixture.root.settingsStore.providers.hydrate();
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  return {
    user: userEvent.setup(),
    fixture,
    login,
    updatePi,
    publish(revision: number, preferences: NonChatModelPreferences) {
      return act(async () =>
        fixture.root.settingsStore.applyApplicationState(revision, {
          ...defaultApplicationState(),
          nonChatModelPreferences: preferences,
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
const selection = () => screen.getByRole("combobox", { name: "Preferred image model" });
afterEach(cleanup);

describe("Non-chat model settings workflow", () => {
  it("saves and clears independent advisory preferences, shows unavailable models and reuses native provider authentication", async () => {
    let saved: NonChatModelPreferences = { image: reference("image-a") };
    const update = vi.fn<Client["nonChatModels"]["updatePreference"]>(
      async ({ type, preference }) => {
        const next = { ...saved };
        if (preference === null) delete next[type];
        else next[type] = preference;
        saved = next;
        return saved;
      },
    );
    using h = await setup(update);
    await h.user.click(screen.getByRole("button", { name: /^Images\b/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Images" })).toBeTruthy();
    expect(selection()).toHaveProperty("value", imageAValue);
    await h.user.selectOptions(selection(), imageBValue);
    await screen.findByText(/This preference is not currently available/);
    expect(update).toHaveBeenLastCalledWith(
      { type: "image", preference: reference("image-b") },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await h.user.selectOptions(selection(), "");
    await waitFor(() => expect(selection()).toHaveProperty("value", ""));
    await h.user.click(screen.getByRole("button", { name: /^Classifiers\b/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Classifiers" })).toBeTruthy();
    await h.user.selectOptions(
      screen.getByRole("combobox", { name: "Preferred classifier model" }),
      nonChatModelChoiceValue({ provider: "typesafe", modelId: "jev-latest" }),
    );
    await h.user.click(screen.getByRole("button", { name: "Add API key" }));
    await screen.findByText("Connected");
    expect(h.login).toHaveBeenCalledWith(
      { provider: "typesafe", authType: "api_key" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(saved).toEqual({ classifier: { provider: "typesafe", modelId: "jev-latest" } });
    expect(
      screen.getByText(/does not enable background classification or Auto routing/),
    ).toBeTruthy();
    await h.user.click(screen.getByRole("button", { name: /^Models\b/ }));
    await h.user.click(screen.getByRole("button", { name: "Default agent model" }));
    await screen.findByRole("button", { name: /Chat fixture/ });
    expect(screen.queryByRole("button", { name: /Jev|Image A|Image B/ })).toBeNull();
  });

  it("queues optimistic changes, adopts a newer backend event and ignores stale responses", async () => {
    const first = deferred<NonChatModelPreferences>();
    const second = deferred<NonChatModelPreferences>();
    const update = vi
      .fn<Client["nonChatModels"]["updatePreference"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    using h = await setup(update);
    await h.user.click(screen.getByRole("button", { name: /^Images\b/ }));
    await h.user.selectOptions(selection(), imageBValue);
    await h.user.selectOptions(selection(), "");
    expect(update).toHaveBeenCalledTimes(1);
    expect(selection()).toHaveProperty("value", "");
    await act(async () => first.resolve({ image: reference("image-b") }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await h.publish(3, { image: reference("image-a") });
    expect(selection()).toHaveProperty("value", "");
    await act(async () => second.resolve({}));
    await waitFor(() => expect(selection()).toHaveProperty("value", imageAValue));
    await h.publish(2, {});
    expect(selection()).toHaveProperty("value", imageAValue);
  });

  it("rolls back a failed save and aborts the active and queued requests on disposal", async () => {
    const failed = deferred<NonChatModelPreferences>();
    const pending = deferred<NonChatModelPreferences>();
    const update = vi
      .fn<Client["nonChatModels"]["updatePreference"]>()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(pending.promise);
    const h = await setup(update);
    try {
      await h.user.click(screen.getByRole("button", { name: /^Images\b/ }));
      await h.user.selectOptions(selection(), "");
      await act(async () => failed.reject(new Error("Backend preference save failed")));
      await screen.findByText("Backend preference save failed");
      expect(selection()).toHaveProperty("value", imageAValue);
      await h.user.selectOptions(selection(), imageBValue);
      await h.user.selectOptions(selection(), "");
      expect(update).toHaveBeenCalledTimes(2);
    } finally {
      h[Symbol.dispose]();
    }
    expect(update.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ image: reference("image-b") }));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("preserves native provider and model IDs without interpreting them as path segments", async () => {
    const update = vi.fn<Client["nonChatModels"]["updatePreference"]>(
      async ({ type, preference }) => (preference ? { [type]: preference } : {}),
    );
    using h = await setup(update);
    await h.user.click(screen.getByRole("button", { name: /^Images\b/ }));
    const preference = { provider: "custom/image", modelId: "variant/1" };
    await h.user.selectOptions(selection(), nonChatModelChoiceValue(preference));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ type: "image", preference }, expect.anything()),
    );
    expect(selection()).toHaveProperty("value", nonChatModelChoiceValue(preference));
  });

  it("controls native codemode/tool search with additive lists, explicit empty and inherited defaults", async () => {
    using h = await setup(async () => ({}));
    await h.user.click(screen.getByRole("button", { name: "Execution & resources" }));
    await h.user.click(screen.getByRole("switch", { name: "Codemode" }));
    await waitFor(() =>
      expect(h.updatePi).toHaveBeenLastCalledWith(
        { key: "defaultTools", value: ["+codemode"] },
        expect.anything(),
      ),
    );
    await h.user.click(screen.getByRole("switch", { name: "Tool search" }));
    await waitFor(() =>
      expect(h.updatePi).toHaveBeenLastCalledWith(
        { key: "defaultTools", value: ["+codemode", "+tool_search"] },
        expect.anything(),
      ),
    );
    await h.user.click(screen.getByRole("button", { name: "Disable built-in tools" }));
    await screen.findByText("Explicit empty selection — built-in tools disabled");
    await h.user.click(screen.getByRole("button", { name: "Use Pi defaults" }));
    await screen.findByText("Inheriting Pi’s default tool selection");
    expect(h.updatePi).toHaveBeenLastCalledWith(
      { key: "defaultTools", value: null },
      expect.anything(),
    );
    const budget = screen.getByRole("textbox", { name: /^Codemode inline budget/ });
    await h.user.clear(budget);
    await h.user.type(budget, "invalid");
    await h.user.tab();
    await screen.findByText("Codemode inline budget must be an integer from 0 to 100000.");
    expect(h.updatePi).toHaveBeenCalledTimes(4);
    await h.user.clear(budget);
    await h.user.type(budget, "0");
    await h.user.tab();
    await waitFor(() =>
      expect(h.updatePi).toHaveBeenLastCalledWith(
        { key: "codemodeInlineBudget", value: 0 },
        expect.anything(),
      ),
    );
  });
});
