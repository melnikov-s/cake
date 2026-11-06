import { Stream } from "effect";
import { expect, it, vi } from "vitest";
import type {
  DiscussionThread,
  DiscussionSessionUpdate,
} from "../../../../src/contracts/discussion-sessions/discussion-session-data";
import type { DiscussionCatalogUpdate } from "../../../../src/contracts/application/catalog-data";
import type { SubagentUpdate } from "../../../../src/contracts/subagents/subagent-data";
import { ReviewThread } from "../../../../src/renderer/models/ReviewThread";
import { createModelObserver } from "../../../../src/renderer/observers/models";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { workerActivity } from "../subagent-activity-workflow-fixture";
import { observerClient, observerRuntime } from "./observer-test-runtime";

it("observes explicit Discussion focus demand through real sidecar and public worker channels without opening a primary", async () => {
  using fixture = createRendererStoreFixture();
  const thread: DiscussionThread = {
    id: "nested-thread",
    parentSessionId: "sidecar-owner",
    sidecarSessionId: "nested-sidecar",
    workingDirectory: "/cake",
    anchor: {
      path: "message",
      view: "message",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: "Nested discussion",
      contextBefore: "",
      contextAfter: "",
      diff: "",
    },
    parts: [],
    status: "open",
    createdAt: "",
    updatedAt: "",
  };
  const catalog = fixture.models.discussionCatalog("sidecar-owner");
  catalog.threads.push(
    ReviewThread.create({
      id: thread.id,
      parentSessionId: thread.parentSessionId,
      sidecarSessionId: thread.sidecarSessionId,
      workingDirectory: thread.workingDirectory,
      anchor: thread.anchor,
      status: thread.status,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }),
  );
  const model = fixture.models.discussionConversation("nested-sidecar", "/cake", "sidecar-owner");
  const subagents = fixture.models.subagentCatalog("sidecar-owner");
  const primary = vi.fn(() => Stream.never);
  const observeDiscussion = vi.fn(() =>
    Stream.succeed({
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        identity: {
          _tag: "DiscussionSession",
          sessionId: "nested-sidecar",
          parentSessionId: "sidecar-owner",
        },
        conversation: {
          sessionId: "nested-sidecar",
          sessionFile: "/sidecar-sessions/nested.jsonl",
          parts: [
            {
              id: "retained-sidecar",
              kind: "text",
              role: "assistant",
              text: "Original nested discussion parts",
              status: "complete",
            },
          ],
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: [],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      },
    } satisfies DiscussionSessionUpdate).pipe(Stream.concat(Stream.never)),
  );
  const observeWorkers = vi.fn(() =>
    Stream.succeed({
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "sidecar-owner",
      activities: [
        workerActivity({
          parentSessionId: "sidecar-owner",
          parts: [
            {
              id: "worker-original",
              kind: "text",
              role: "assistant",
              text: "Original public worker parts",
              status: "complete",
            },
          ],
        }),
      ],
      backgroundActive: true,
    } satisfies SubagentUpdate).pipe(Stream.concat(Stream.never)),
  );
  const observer = createModelObserver(
    observerRuntime(
      observerClient({
        projects: { observeCatalog: () => Stream.never },
        conversations: { observe: primary },
        subagents: { observe: observeWorkers },
        discussionSessions: {
          observe: observeDiscussion,
          observeCatalog: () =>
            Stream.succeed({
              _tag: "Snapshot",
              revision: 1,
              parentSessionId: "sidecar-owner",
              threads: [thread],
            } satisfies DiscussionCatalogUpdate).pipe(Stream.concat(Stream.never)),
        },
      }),
    ),
  );
  try {
    observer.sync({
      projects: fixture.models.projects,
      sessionCatalog: fixture.models.sessionCatalog,
      cakeChatCatalog: fixture.models.cakeChatCatalog,
      projectSessionCatalogQueries: [],
      cakeChatCatalogQueries: [],
      projectSessions: [],
      cakeChats: [],
      focusedDiscussionCatalogs: [
        {
          target: { sessionId: "sidecar-owner", workingDirectory: "/cake", kind: "side-chat" },
          discussions: catalog,
          subagents,
        },
      ],
      discussionSessions: [{ thread: catalog.threads[0]!, model }],
    });
    await vi.waitFor(() =>
      expect(model.uiParts).toContainEqual(
        expect.objectContaining({ text: "Original nested discussion parts" }),
      ),
    );
    await vi.waitFor(() =>
      expect(subagents.activities[0]?.parts).toContainEqual(
        expect.objectContaining({ text: "Original public worker parts" }),
      ),
    );
    expect(observeDiscussion).toHaveBeenCalledWith({
      parentSessionId: "sidecar-owner",
      threadId: "nested-thread",
      workingDirectory: "/cake",
    });
    expect(observeWorkers).toHaveBeenCalledWith("sidecar-owner");
    expect(primary).not.toHaveBeenCalled();
    expect(fixture.root.sessionRegistry.targets).toHaveLength(0);
    expect(fixture.models.projectConversations).toHaveLength(0);
  } finally {
    observer.stop();
  }
});
