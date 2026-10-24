/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { Chat } from "../../../src/renderer/components/chat";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { createLiveMessageProjector } from "../../../src/services/pi/runtime/session-projection";
import { internalInputEntryType } from "../../../src/services/pi/runtime/internal-input-projection";
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
  it("renders a typed Workboard wake as application context, then labels only the genuine user quotation You", () => {
    const pi = SessionManager.inMemory("/project");
    const text =
      "<system-reminder>\nWorkboard delivery (family-board-private): entries #3. Read boards.read.\n</system-reminder>";
    pi.appendCustomEntry(internalInputEntryType, {
      timestamp: 1,
      origin: { _tag: "WorkboardDelivery", boardId: "family-board-private", sequences: [3] },
    });
    pi.appendMessage({ role: "user", content: text, timestamp: 1 });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({
          sessionId: "workboard",
          projectPath: "/project",
          workingDirectory: "/project",
        }),
      ],
    });
    const session = fixture.root.sessionRegistry.load("workboard", "/project");
    const publish = () =>
      applyConversationSnapshot(session.model, {
        sessionId: "workboard",
        sessionFile: "/sessions/workboard.jsonl",
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
      expect(screen.getByRole("button", { name: "Workboard" })).toBeTruthy();
      expect(screen.queryByText("You", { exact: true })).toBeNull();
      expect(view.container.textContent).not.toContain("family-board-private");
      expect(view.container.textContent).not.toContain("<system-reminder>");
      act(() => {
        pi.appendMessage({ role: "user", content: text, timestamp: 2 });
        publish();
      });
      expect(screen.getByText("You", { exact: true })).toBeTruthy();
      expect(screen.getByText(/Workboard delivery \(family-board-private\)/)).toBeTruthy();
      expect(view.container.textContent).toContain("<system-reminder>");
      expect(screen.getByRole("button", { name: "Workboard" })).toBeTruthy();
    } finally {
      view.unmount();
    }
  });
  it("shows application-owned report disclosures with the next user message without any assistant relay", () => {
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
      expect(
        screen.getByRole("button", { name: "Review result" }).getAttribute("aria-expanded"),
      ).toBe("false");
      expect(
        view.container
          .querySelector("[data-message-reference]")
          ?.getAttribute("data-message-reference"),
      ).toBe(ref);
      expect(screen.queryByText(/Answer the user's current message first/)).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("renders attached reminder batches above their input with identical live and reloaded chronology", () => {
    const pi = SessionManager.inMemory("/project");
    pi.appendMessage({ role: "user", content: "Earlier question", timestamp: 1 });
    pi.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      timestamp: 2,
      usage,
      stopReason: "stop",
    });
    const message = {
      role: "user" as const,
      timestamp: 3,
      content: addResponseModeReminder(
        addPresentationModeReminder(
          addSessionDigestReminder(
            "My newly sent question",
            formatSessionDigestReminder({
              lines: [
                {
                  reference: "first",
                  sessionId: "worker-one",
                  title: "First result",
                  summary: "First report",
                  status: "completed",
                  resultMessageRef: "cake://session/worker-one?message=result-one",
                },
                {
                  reference: "second",
                  sessionId: "worker-two",
                  title: "Second result",
                  summary: "Second report",
                  status: "completed",
                  resultMessageRef: "cake://session/worker-two?message=result-two",
                },
              ],
              running: 0,
              interruptedReport: false,
            }),
          ),
          "normal",
          "vscode",
        ),
        "text",
      ),
    };
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [
        sessionSummary({
          sessionId: "ordered",
          projectPath: "/project",
          workingDirectory: "/project",
        }),
      ],
    });
    const session = fixture.root.sessionRegistry.load("ordered", "/project");
    const publish = () =>
      applyConversationSnapshot(session.model, {
        sessionId: "ordered",
        sessionFile: "/ordered.jsonl",
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
    act(() => {
      for (const part of createLiveMessageProjector()({ type: "message_start", message }))
        applyConversationUpdate(session.model, {
          _tag: "Event",
          revision: 2,
          event: { _tag: "PartUpdated", sessionId: "ordered", part },
        });
    });
    const assertOrder = () => {
      const ordered = [
        screen.getByText("Earlier question", { exact: true }),
        screen.getByText("Earlier answer", { exact: true }),
        screen.getByRole("button", { name: "Cake · presentation mode" }),
        screen.getByRole("status", { name: "Session results" }),
        screen.getByRole("button", { name: "Cake · response mode" }),
        screen.getByText("My newly sent question", { exact: true }),
      ];
      for (let index = 1; index < ordered.length; index++)
        expect(
          ordered[index - 1]!.compareDocumentPosition(ordered[index]!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      const results = screen.getByRole("status", { name: "Session results" }).textContent!;
      expect(results.indexOf("First result")).toBeLessThan(results.indexOf("Second result"));
      expect(screen.getAllByText("You", { exact: true })).toHaveLength(2);
      expect(screen.getByText("My newly sent question").textContent).not.toContain(
        "system-reminder",
      );
    };
    assertOrder();
    act(() => {
      pi.appendMessage(message);
      publish();
    });
    assertOrder();
    view.unmount();
    const reloaded = render(
      <Chat
        store={session.conversationSessionStore.chatStore}
        compact
        composerFocusEnabled={false}
      />,
    );
    assertOrder();
    expect(pi.getEntries().filter((entry) => entry.type === "message")).toHaveLength(3);
    reloaded.unmount();
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
