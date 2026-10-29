/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { configurationModel, configurationSnapshot } from "./chat-configuration-workflow-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// Model/reasoning selection is already a real runtime workflow in
// chat-configuration-workflow.test.tsx. Native search typing, focus retention,
// filtering and keyboard reopening are covered by electron/model-picker.smoke.
// Retain only lazy catalog derivation: visible text cannot prove that closed
// pickers avoid reading the grouping getter. The spy observes the real getter;
// it never replaces the Store, its implementation, or a parent callback.
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
