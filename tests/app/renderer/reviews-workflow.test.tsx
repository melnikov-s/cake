/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId, type ConversationSnapshot } from "../../../src/ipc/conversation-data";
import {
  sessionAssistantThreadPath,
  type DiscussionAnchor,
} from "../../../src/ipc/discussion-session-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const anchor: DiscussionAnchor = {
  path: "session:parent-1/message/assistant-1",
  view: "message",
  start: { diffLine: 0 },
  end: { diffLine: 0 },
  selectedText: "Original selection",
  contextBefore: "",
  contextAfter: "",
  diff: "",
  messageId: "assistant-1",
};

const codeAnchor: DiscussionAnchor = {
  path: "src/example.ts",
  view: "file",
  start: { diffLine: 1, newLine: 1 },
  end: { diffLine: 1, newLine: 1 },
  selectedText: "const value = 1;",
  contextBefore: "",
  contextAfter: "",
  diff: "",
};

function conversation(sessionId: string, streaming = false): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/reviews/${sessionId}.jsonl`,
    parts: streaming
      ? [
          {
            id: "assistant-1",
            kind: "text",
            role: "assistant",
            text: "Working on the selection",
            status: "streaming",
          },
        ]
      : [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

function renderReview(
  client: TestClientOverrides,
  options: {
    observed?: boolean;
    streaming?: boolean;
    draft?: boolean;
    runtimeQueue?: boolean;
    assistant?: boolean;
    configured?: boolean;
  } = {},
) {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({
        sessionId: "parent-1",
        projectPath: "/project",
        workingDirectory: "/project",
      }),
    ],
  });
  fixture.root.sessionRegistry.load("parent-1", "/project");
  const parent = fixture.models.projectConversation("parent-1", "/project");
  applyConversationSnapshot(parent, {
    ...conversation("parent-1"),
    model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
    thinkingLevel: "high",
    availableThinkingLevels: ["off", "high"],
  });
  applyDiscussionCatalogUpdate(fixture.models.discussionCatalog("parent-1"), "parent-1", {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId: "parent-1",
    threads: [
      {
        id: "thread-1",
        workingDirectory: "/project",
        parentSessionId: "parent-1",
        sidecarSessionId: "sidecar-thread-1",
        anchor: options.assistant
          ? {
              ...anchor,
              path: sessionAssistantThreadPath("parent-1"),
              view: "session",
              selectedText: "",
            }
          : anchor,
        parts: [],
        status: "open",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  const sidecar = fixture.models.discussionConversation("sidecar-thread-1", "/project");
  const deliverSnapshot = () =>
    applyDiscussionSessionUpdate(sidecar, sidecar.sessionId, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        identity: {
          _tag: "DiscussionSession",
          sessionId: sidecar.sessionId,
          parentSessionId: "parent-1",
        },
        conversation: {
          ...conversation(sidecar.sessionId, options.streaming),
          ...(options.runtimeQueue
            ? {
                parts: [
                  {
                    id: "queued-follow-up-1",
                    kind: "text",
                    role: "user",
                    text: "First",
                    status: "complete",
                    deliveryState: "queued",
                  },
                  {
                    id: "queued-steering-1",
                    kind: "text",
                    role: "user",
                    text: "Now",
                    status: "complete",
                    deliveryState: "steering",
                  },
                ],
              }
            : {}),
          ...(options.configured
            ? {
                model: { provider: "google", id: "gemini", name: "Gemini" },
                models: [
                  {
                    provider: "google",
                    providerName: "Google",
                    id: "gemini",
                    name: "Gemini",
                    reasoning: false,
                    availableThinkingLevels: ["off"],
                    input: ["text"],
                    authenticated: true,
                    authTypes: ["api_key"],
                  },
                  {
                    provider: "openai-codex",
                    providerName: "OpenAI Codex",
                    id: "gpt-5.6-sol",
                    name: "Sol",
                    reasoning: false,
                    availableThinkingLevels: ["off"],
                    input: ["text"],
                    authenticated: true,
                    authTypes: ["api_key"],
                  },
                ],
              }
            : {}),
        },
      },
    });
  if (options.observed !== false) deliverSnapshot();
  if (options.draft) {
    fixture.root.projectWorkbenchStore.projectOpenStore.projectPath = "/project";
    fixture.root.appShellStore.selectProjectSession("parent-1");
    fixture.root.reviewsStore.prepareDraft(codeAnchor);
  }
  const chat = options.draft
    ? fixture.root.reviewsStore.draftChatStore
    : fixture.root.reviewsStore.chatStore("thread-1");
  if (!chat) throw new Error("Expected the Root to retain the discussion chat");
  const view = render(<Chat store={chat} embedded composerFocusEnabled={false} />);
  return {
    user: userEvent.setup(),
    snapshot() {
      act(deliverSnapshot);
    },
    settle() {
      act(() =>
        applyDiscussionSessionUpdate(sidecar, sidecar.sessionId, {
          _tag: "Event",
          revision: 2,
          sessionId: sidecar.sessionId,
          event: { _tag: "StreamingChanged", sessionId: sidecar.sessionId, streaming: false },
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Review side-chat workflow", () => {
  it("routes runtime-held queue controls to the sidecar", async () => {
    const steerQueuedMessage = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () => ({
      steering: [],
      followUp: [],
    }));
    const removeQueuedMessage = vi.fn<Client["sessionChats"]["removeQueuedMessage"]>(async () => ({
      steering: [],
      followUp: [],
    }));
    using fixture = renderReview(
      { sessionChats: { steerQueuedMessage, removeQueuedMessage } },
      { streaming: true, runtimeQueue: true },
    );
    expect(screen.getByRole("list", { name: "Queued prompts" }).textContent).toContain("First");
    await fixture.user.click(screen.getByRole("button", { name: "Send now as steering: First" }));
    await waitFor(() =>
      expect(steerQueuedMessage).toHaveBeenCalledWith(
        { sessionId: "sidecar-thread-1", partId: "queued-follow-up-1" },
        expect.any(Object),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Cancel queued message: First" }));
    await waitFor(() =>
      expect(removeQueuedMessage).toHaveBeenCalledWith(
        { sessionId: "sidecar-thread-1", partId: "queued-follow-up-1" },
        expect.any(Object),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Cancel steering: Now" }));
    await waitFor(() =>
      expect(removeQueuedMessage).toHaveBeenCalledWith(
        { sessionId: "sidecar-thread-1", partId: "queued-steering-1" },
        expect.any(Object),
      ),
    );
  });

  it("configures the sidecar model without addressing the parent", async () => {
    const applyConfiguration = vi.fn<Client["sessionChats"]["applyConfiguration"]>(
      async () => undefined,
    );
    using fixture = renderReview({ sessionChats: { applyConfiguration } }, { configured: true });
    expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
      "Gemini",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Model configuration" }));
    await fixture.user.click(screen.getByRole("button", { name: "Change model" }));
    await fixture.user.click(screen.getByRole("button", { name: /Sol/ }));
    await fixture.user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(applyConfiguration).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId: "sidecar-thread-1",
          configuration: {
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "off",
            fastMode: false,
          },
        },
        expect.any(Object),
      ),
    );
  });

  it("does not offer model changes for the utility-model session assistant", () => {
    using fixture = renderReview({}, { assistant: true, configured: true });
    void fixture; // Keep the disposable UI fixture alive through the assertions.
    expect(screen.getByRole("combobox", { name: "Message session assistant" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Model configuration" })).toBeNull();
  });
  it("starts a selected-code discussion on the parent model and preserves a failed draft for retry", async () => {
    const start = vi
      .fn<Client["discussionSessions"]["start"]>()
      .mockRejectedValueOnce(new Error("Discussion service unavailable"))
      .mockResolvedValueOnce({
        turnId: TurnId.make("10000000-0000-4000-8000-000000000003"),
        thread: {
          id: "thread-new",
          workingDirectory: "/project",
          parentSessionId: "parent-1",
          sidecarSessionId: "sidecar-new",
          anchor: codeAnchor,
          parts: [],
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    using fixture = renderReview({ discussionSessions: { start } }, { draft: true });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message code chat" });
    await fixture.user.type(input, "Explain this selection");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Discussion service unavailable")).toBeDefined();
    expect(input.value).toBe("Explain this selection");
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        anchor: codeAnchor,
        text: "Explain this selection",
        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
        thinkingLevel: "high",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(start).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Discussion service unavailable")).toBeNull();
  });
  it("sends a selection reply to its sidecar rather than its parent", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderReview({ sessionChats: { prompt } });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", {
      name: "Reply to selection side chat",
    });
    await fixture.user.type(input, "Explain further");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sidecar-thread-1", text: "Explain further" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(input.value).toBe("");
  });

  it("holds an early reply until the first authoritative sidecar snapshot arrives", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderReview({ sessionChats: { prompt } }, { observed: false });
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Reply to selection side chat" }),
      "Too early?",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(prompt).not.toHaveBeenCalled();
    fixture.snapshot();
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sidecar-thread-1", text: "Too early?" }),
        expect.any(Object),
      ),
    );
  });

  it("admits a follow-up to the shared runtime queue while streaming and can stop the sidecar", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000002"),
    );
    const abort = vi.fn<Client["sessionChats"]["abort"]>(async () => undefined);
    using fixture = renderReview({ sessionChats: { prompt, abort } }, { streaming: true });
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Reply to selection side chat" }),
      "And then?",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sidecar-thread-1", text: "And then?" }),
      expect.any(Object),
    );
    expect(screen.getByText("And then?")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(abort).toHaveBeenCalledWith({ sessionId: "sidecar-thread-1" }, expect.any(Object)),
    );
    fixture.settle();
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sidecar-thread-1", text: "And then?" }),
        expect.any(Object),
      ),
    );
    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});
