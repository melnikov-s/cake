/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectConversationDisplay } from "../../../src/services/pi/runtime/conversation-display-projection";
import { appendToolCompactedBranch } from "../../../src/services/pi/runtime/session-tool-compaction";
import { addResponseModeReminder } from "../../../src/contracts/conversations/response-mode-reminders";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { addPresentationModeReminder } from "../../../src/contracts/conversations/presentation-mode-reminders";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
afterEach(cleanup);

describe("Context visibility through the authoritative projection and shared Chat", () => {
  it("discloses hidden context beside injected reminders and retains labeled history after Tool Compact", async () => {
    const pi = SessionManager.inMemory("/project");
    pi.appendMessage({
      role: "user",
      content: addResponseModeReminder(
        addPresentationModeReminder("Question", "normal", "draw"),
        "text",
      ),
      timestamp: 1,
    });
    pi.appendMessage({
      role: "user",
      timestamp: 1.5,
      content: encodeCrossSessionMessage("A session report", {
        version: 1,
        messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
        threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
        sequence: 1,
        expectsResponse: false,
        sender: { kind: "project-session", sessionId: "source", title: "API review" },
      }),
    });
    pi.appendCustomMessageEntry("cake.context", "Exact hidden context", false);
    pi.appendCustomMessageEntry("extension.context", "Exact extension context", true);
    const leaf = pi.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      stopReason: "stop",
      timestamp: 2,
      usage,
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({
          sessionId: "context",
          projectPath: "/project",
          workingDirectory: "/project",
        }),
      ],
    });
    const session = fixture.root.sessionRegistry.load("context", "/project");
    const publish = () =>
      applyConversationSnapshot(session.model, {
        sessionId: "context",
        sessionFile: "/sessions/context.jsonl",
        parts: projectConversationDisplay(pi),
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: false,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      });
    publish();
    const view = render(
      <Chat
        store={session.conversationSessionStore.chatStore}
        compact
        composerFocusEnabled={false}
      />,
    );
    try {
      expect(screen.getByText("Question", { exact: true })).toBeTruthy();
      const pills = Array.from(view.container.querySelectorAll('[data-slot="context-pill"]'));
      expect(pills).toHaveLength(5);
      await userEvent.setup().click(screen.getByRole("button", { name: "Session · API review" }));
      expect(screen.getByText(/A session report/)).toBeTruthy();
      expect(pills.every((pill) => Boolean(pill.closest('[data-slot="context-group"]')))).toBe(
        true,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "cake.context" }));
      expect(screen.getByText("Exact hidden context")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Cake · response mode" }));
      expect(screen.getByText(/Cake response mode: text/)).toBeTruthy();
      act(() => {
        appendToolCompactedBranch(pi, leaf);
        publish();
      });
      expect(
        view.container.querySelectorAll('[data-slot="context-pill"][data-origin="compacted"]'),
      ).toHaveLength(5);
      expect(screen.getAllByText("· removed from context")).toHaveLength(5);
      expect(JSON.stringify(pi.buildSessionContext().messages)).not.toContain("A session report");
      expect(screen.getByText("Answer", { exact: true })).toBeTruthy();
      await user.click(
        screen.getByRole("button", { name: "extension.context · removed from context" }),
      );
      expect(screen.getByText("Exact extension context")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });
});
