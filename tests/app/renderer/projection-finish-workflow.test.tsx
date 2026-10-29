/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { renderTranscriptContent as render } from "./render-transcript-content";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { renderTranscriptRendering } from "./transcript-rendering-workflow-fixture";
import { renderProjectionFinishRun } from "./projection-finish-workflow-fixture";
import { workflowActivityFixture } from "../../fixtures/dynamic-workflow";

function projectionFinishConversation(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

function renderProjectionFinishDiscussion() {
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("00000000-0000-4000-8000-000000000001"),
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "projection-parent", projectPath: "/project" })],
    client: { sessionChats: { prompt } },
  });
  fixture.root.sessionRegistry.load("projection-parent", "/project");
  applyConversationSnapshot(
    fixture.models.projectConversation("projection-parent", "/project"),
    projectionFinishConversation("projection-parent"),
  );
  const thread: DiscussionThread = {
    id: "projection-thread",
    parentSessionId: "projection-parent",
    sidecarSessionId: "projection-sidecar",
    workingDirectory: "/project",
    anchor: {
      path: "session:projection-parent/message/answer",
      view: "message",
      messageId: "answer",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: "Original selection",
      contextBefore: "",
      contextAfter: "",
      diff: "",
    },
    parts: [],
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const catalog = fixture.models.discussionCatalog("projection-parent");
  applyDiscussionCatalogUpdate(catalog, "projection-parent", {
    _tag: "Snapshot",
    revision: 1,
    parentSessionId: "projection-parent",
    threads: [thread],
  });
  const sidecar = fixture.models.discussionConversation("projection-sidecar", "/project");
  applyDiscussionSessionUpdate(sidecar, "projection-sidecar", {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      identity: {
        _tag: "DiscussionSession",
        sessionId: "projection-sidecar",
        parentSessionId: "projection-parent",
      },
      conversation: projectionFinishConversation("projection-sidecar"),
    },
  });
  const chat = fixture.root.reviewsStore.chatStore(thread.id);
  if (!chat) throw new Error("Expected the real discussion Chat");
  chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
  const view = render(<Chat store={chat} embedded compact composerFocusEnabled={false} />);
  return {
    user: userEvent.setup(),
    prompt,
    streamAnswer() {
      act(() => {
        applyDiscussionSessionUpdate(sidecar, "projection-sidecar", {
          _tag: "Event",
          revision: 2,
          sessionId: "projection-sidecar",
          event: { _tag: "StreamingChanged", sessionId: "projection-sidecar", streaming: true },
        });
        applyDiscussionSessionUpdate(sidecar, "projection-sidecar", {
          _tag: "Event",
          revision: 3,
          sessionId: "projection-sidecar",
          event: {
            _tag: "PartUpdated",
            sessionId: "projection-sidecar",
            part: {
              id: "answer",
              kind: "text",
              role: "assistant",
              text: "Live selection answer",
              status: "streaming",
            },
          },
        });
      });
    },
    refreshCatalog() {
      act(() =>
        applyDiscussionCatalogUpdate(catalog, "projection-parent", {
          _tag: "Event",
          revision: 2,
          parentSessionId: "projection-parent",
          // Persisted previews can lag the live sidecar while its file is written.
          event: {
            _tag: "Replaced",
            threads: [{ ...thread, updatedAt: "2026-01-02T00:00:00.000Z" }],
          },
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

it("keeps a streamed discussion answer and its stop control through a stale parent catalog refresh", async () => {
  using fixture = renderProjectionFinishDiscussion();
  await fixture.user.type(screen.getByRole("combobox"), "Explain the selection");
  await fixture.user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(fixture.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "projection-sidecar", text: "Explain the selection" }),
      expect.anything(),
    ),
  );
  fixture.streamAnswer();
  expect(await screen.findByText("Live selection answer")).toBeDefined();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
  fixture.refreshCatalog();
  expect(screen.getByText("Live selection answer")).toBeDefined();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
});

it.each(["RunChanged", "Snapshot"] as const)(
  "keeps old results and activity out of a relaunched execution delivered by %s",
  async (delivery) => {
    using fixture = renderProjectionFinishRun(delivery);
    await fixture.user.click(screen.getByRole("button", { name: "Details" }));
    fixture.deliverDetails();
    expect(await screen.findByRole("region", { name: "Workflow result" })).toHaveProperty(
      "textContent",
      expect.stringContaining("Authentication audit complete"),
    );
    await fixture.user.click(screen.getByRole("button", { name: /Auth routes · complete/ }));
    expect(screen.getByRole("region", { name: "Worker result" })).toHaveProperty(
      "textContent",
      expect.stringContaining("Verified route guard"),
    );
    fixture.activity(workflowActivityFixture());
    expect(await screen.findByText("Verified the route guard against the source.")).toBeDefined();

    await fixture.user.click(screen.getByRole("button", { name: "Relaunch" }));
    await waitFor(() =>
      expect(fixture.relaunch).toHaveBeenCalledWith(
        { sessionId: fixture.run.ownerSessionId, runId: fixture.run.id },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.queryAllByRole("alert").map((alert) => alert.textContent)).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Workflow result" })).toBeNull(),
    );
    expect(screen.queryByRole("region", { name: "Worker result" })).toBeNull();
    expect(screen.queryByText("Verified the route guard against the source.")).toBeNull();

    // Both a previous execution and the wrong retry of this execution are stale.
    fixture.activity(workflowActivityFixture());
    fixture.activity({ ...workflowActivityFixture(), execution: 2, attempt: 2 });
    expect(screen.queryByText("Verified the route guard against the source.")).toBeNull();
    fixture.activity({
      ...workflowActivityFixture(),
      execution: 2,
      attempt: 1,
      parts: [
        {
          id: "new-answer",
          kind: "text",
          role: "assistant",
          text: "Current execution findings",
          status: "complete",
        },
      ],
    });
    expect(await screen.findByText("Current execution findings")).toBeDefined();
    fixture.staleRun();
    expect(screen.getByText("Current execution findings")).toBeDefined();
    expect(screen.getByRole("button", { name: /Auth routes · running · Attempt 1/ })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Workflow result" })).toBeNull();
  },
);

// The behavior is an authority replacement, not a native editing/focus contract.
it("replaces a same-ID Markdown user message with literal text when authority omits renderAs", () => {
  const plain = {
    id: "user",
    entryId: "pi-user",
    kind: "text" as const,
    role: "user" as const,
    text: "# Literal heading",
    status: "complete" as const,
  };
  using fixture = renderTranscriptRendering([{ ...plain, renderAs: "markdown" }]);
  expect(screen.getByRole("heading", { name: "Literal heading" })).toBeDefined();
  fixture.publish([plain]);
  expect(screen.getByText("# Literal heading")).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Literal heading" })).toBeNull();
});
