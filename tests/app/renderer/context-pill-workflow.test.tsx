/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { projectConversationDisplay } from "../../../src/services/pi/runtime/conversation-display-projection";
import { appendToolCompactedBranch } from "../../../src/services/pi/runtime/session-tool-compaction";
import {
  formatSessionDigestReminder,
  addSessionDigestReminder,
} from "../../../src/contracts/cake-chats/session-digest-reminder";
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
  it("shows application-owned completion and exact result link with the next user message without any assistant relay", () => {
    const pi = SessionManager.inMemory("/project");
    const ref = "cake://session/worker?message=application-captured-result";
    pi.appendMessage({
      role: "user",
      timestamp: 1,
      content: addSessionDigestReminder(
        "My next question",
        formatSessionDigestReminder({
          lines: [
            {
              reference: "s:12345678",
              sessionId: "worker",
              title: "Review result",
              summary: "Finished",
              status: "completed",
              resultMessageRef: ref,
            },
          ],
          running: 0,
          interruptedReport: false,
        }),
      ),
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({
          sessionId: "notifications",
          projectPath: "/project",
          workingDirectory: "/project",
        }),
      ],
    });
    const session = fixture.root.sessionRegistry.load("notifications", "/project");
    applyConversationSnapshot(session.model, {
      sessionId: "notifications",
      sessionFile: "/sessions/notifications.jsonl",
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
    const view = render(
      <Chat
        store={session.conversationSessionStore.chatStore}
        compact
        composerFocusEnabled={false}
      />,
    );
    try {
      expect(screen.getByText("My next question", { exact: true })).toBeTruthy();
      expect(screen.getByRole("status", { name: "Session results" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Review result" }).getAttribute("href")).toBe(ref);
      expect(screen.queryByText(/Answer the user's current message first/)).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("discloses current context and hides it after Tool Compact while retaining dialogue", async () => {
    const pi = SessionManager.inMemory("/project");
    pi.appendMessage({
      role: "user",
      content: addResponseModeReminder(
        addPresentationModeReminder("Question", "normal", "vscode"),
        "text",
      ),
      timestamp: 1,
    });
    pi.appendMessage({
      role: "user",
      timestamp: 1.5,
      content: encodeCrossSessionMessage("## Session assignment\n\nA session report", {
        version: 1,
        messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
        threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
        sequence: 1,
        expectsResponse: false,
        sender: { kind: "project-session", sessionId: "source", title: "API review" },
      }),
    });
    pi.appendCustomMessageEntry(
      "cake.context",
      "## Hidden instructions\n\nExact **hidden** context",
      false,
    );
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
      expect(pills).toHaveLength(4);
      expect(screen.getByText("API review", { exact: true })).toBeTruthy();
      expect(screen.getByRole("region", { name: "Message from another session" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Session assignment" })).toBeTruthy();
      expect(screen.getByText("A session report")).toBeTruthy();
      expect(pills.every((pill) => Boolean(pill.closest('[data-slot="context-group"]')))).toBe(
        true,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "cake.context" }));
      expect(screen.getByRole("heading", { name: "Hidden instructions" })).toBeTruthy();
      expect(screen.getByText("hidden", { exact: true }).getAttribute("data-streamdown")).toBe(
        "strong",
      );
      await user.click(screen.getByRole("button", { name: "Cake · response mode" }));
      expect(screen.getByText(/Cake response mode: text/)).toBeTruthy();
      act(() => {
        appendToolCompactedBranch(pi, leaf);
        publish();
      });
      expect(view.container.querySelectorAll('[data-slot="context-pill"]')).toHaveLength(0);
      expect(screen.getByText("API review", { exact: true })).toBeTruthy();
      expect(screen.getByText("A session report")).toBeTruthy();
      expect(JSON.stringify(pi.buildSessionContext().messages)).not.toContain("A session report");
      expect(screen.getByText("Answer", { exact: true })).toBeTruthy();
      act(() => {
        pi.appendCustomMessageEntry("extension.context", "New extension context", true);
        publish();
      });
      expect(view.container.querySelectorAll('[data-slot="context-pill"]')).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: "extension.context" }));
      expect(screen.getByText("New extension context")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });
});
