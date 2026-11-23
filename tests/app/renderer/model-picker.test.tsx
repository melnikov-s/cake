/** @vitest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import {
  configurationModel,
  configurationSnapshot,
  renderChatConfiguration,
} from "./chat-configuration-workflow-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// Visible text cannot prove that closed pickers avoid reading the grouping getter.
// The spy observes the real getter; it never replaces the Store or its implementation.
it("renders the active model summary without deriving picker groups until opening", async () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "picker-session", projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load("picker-session", "/project");
  applyConversationUpdate(session.model, {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      ...configurationSnapshot("picker-session", [configurationModel()]),
      thinkingLevel: "medium",
    },
  });
  const configuration = session.conversationSessionStore.configurationStore;
  const groups = vi.spyOn(configuration, "connectedModelsByProvider", "get");
  const view = render(
    <Chat store={session.conversationSessionStore.chatStore} composerFocusEnabled={false} />,
  );
  try {
    const trigger = screen.getByRole("button", { name: "Model configuration" });
    expect(trigger.textContent).toContain("GPT-5");
    expect(trigger.textContent).toContain("Medium");
    expect(groups).not.toHaveBeenCalled();

    await userEvent.setup().click(trigger);
    expect(screen.getByRole("dialog", { name: "Model configuration" })).toBeDefined();
    expect(groups).toHaveBeenCalled();
  } finally {
    view.unmount();
    groups.mockRestore();
  }
});

it("updates current and draft capabilities without recomputing provider groups", async () => {
  const model = configurationModel();
  using fixture = renderChatConfiguration({ models: [model] });
  const configuration = fixture.chatStore.configuration!;
  await fixture.user.click(screen.getByRole("button", { name: "Model configuration" }));
  const dialog = within(screen.getByRole("dialog", { name: "Model configuration" }));
  const connected = configuration.connectedModelsByProvider;
  const all = configuration.modelsByProvider;
  expect(dialog.getByRole("button", { name: "High" })).toBeDefined();
  expect(dialog.queryByRole("switch", { name: "Fast mode" })).toBeNull();

  const changed = configurationModel({
    availableThinkingLevels: ["off", "max"],
    fastMode: true,
    input: ["text", "image"],
    authTypes: ["api_key"],
  });
  fixture.publish(configurationSnapshot("first", [changed]));
  // Each evaluation of groupModels returns a fresh array, so reuse proves no recompute.
  expect(configuration.connectedModelsByProvider).toBe(connected);
  expect(configuration.modelsByProvider).toBe(all);
  expect(dialog.queryByRole("button", { name: "High" })).toBeNull();
  expect(dialog.getByRole("button", { name: "Max" })).toBeDefined();
  expect(dialog.getByRole("switch", { name: "Fast mode" })).toBeDefined();

  await fixture.user.click(dialog.getByRole("button", { name: "Change model" }));
  await fixture.user.click(dialog.getByRole("button", { name: "GPT-5 gpt-5" }));
  await fixture.user.click(dialog.getByRole("button", { name: "Max" }));
  expect(dialog.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", false);
  fixture.publish(configurationSnapshot("first", [model]));
  expect(configuration.connectedModelsByProvider).toBe(connected);
  expect(configuration.modelsByProvider).toBe(all);
  expect(dialog.queryByRole("button", { name: "Max" })).toBeNull();
  expect(dialog.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true);
  expect(dialog.queryByRole("switch", { name: "Fast mode" })).toBeNull();
  await fixture.user.click(dialog.getByRole("button", { name: "High" }));
  expect(dialog.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", false);
});

it("updates provider groups and returns to the list when a draft option disappears", async () => {
  const current = configurationModel();
  const other = configurationModel({
    provider: "anthropic",
    providerName: "Anthropic",
    id: "claude",
    name: "Claude",
    authenticated: false,
  });
  using fixture = renderChatConfiguration({ models: [current, other] });
  const configuration = fixture.chatStore.configuration!;
  const all = configuration.modelsByProvider;
  const connected = () => configuration.connectedModelsByProvider.map(({ id }) => id);
  expect(connected()).toEqual(["openai"]);
  expect(all.map(({ id }) => id)).toEqual(["openai", "anthropic"]);

  const authenticated = { ...other, authenticated: true };
  fixture.publish(configurationSnapshot("first", [current, authenticated]));
  expect(connected()).toEqual(["openai", "anthropic"]);
  expect(configuration.modelsByProvider).toBe(all);

  const moved = { ...authenticated, provider: "custom", providerName: "Custom" };
  fixture.publish(configurationSnapshot("first", [current, moved]));
  expect(connected()).toEqual(["openai", "custom"]);
  const renamed = { ...moved, providerName: "Renamed provider" };
  fixture.publish(configurationSnapshot("first", [current, renamed]));
  expect(configuration.connectedModelsByProvider.map(({ name }) => name)).toEqual([
    "OpenAI",
    "Renamed provider",
  ]);
  expect(configuration.modelsByProvider.map(({ name }) => name)).toEqual([
    "OpenAI",
    "Renamed provider",
  ]);

  await fixture.user.click(screen.getByRole("button", { name: "Model configuration" }));
  const dialog = within(screen.getByRole("dialog", { name: "Model configuration" }));
  await fixture.user.click(dialog.getByRole("button", { name: "Change model" }));
  await fixture.user.click(dialog.getByRole("button", { name: "Claude claude" }));
  expect(dialog.getByRole("button", { name: "Apply" })).toBeDefined();
  fixture.publish(configurationSnapshot("first", [current]));
  expect(connected()).toEqual(["openai"]);
  expect(dialog.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(dialog.getByRole("button", { name: "GPT-5 gpt-5" })).toBeDefined();
});

it("refreshes matches and row labels with an unchanged search query and provider groups", async () => {
  const current = configurationModel();
  const other = configurationModel({ id: "other", name: "Original" });
  using fixture = renderChatConfiguration({ models: [current, other] });
  const configuration = fixture.chatStore.configuration!;
  await fixture.user.click(screen.getByRole("button", { name: "Model configuration" }));
  const dialog = within(screen.getByRole("dialog", { name: "Model configuration" }));
  await fixture.user.click(dialog.getByRole("button", { name: "Change model" }));
  await fixture.user.type(
    dialog.getByRole("textbox", { name: "Search presets and models" }),
    "nova",
  );
  const connected = configuration.connectedModelsByProvider;
  expect(dialog.getByText("No matching models")).toBeDefined();

  fixture.publish(configurationSnapshot("first", [current, { ...other, name: "Nova" }]));
  expect(configuration.connectedModelsByProvider).toBe(connected);
  expect(dialog.getByRole("button", { name: "Nova other" })).toBeDefined();
  fixture.publish(configurationSnapshot("first", [current, other]));
  expect(configuration.connectedModelsByProvider).toBe(connected);
  expect(dialog.queryByRole("button", { name: "Nova other" })).toBeNull();
  expect(dialog.getByText("No matching models")).toBeDefined();
});
