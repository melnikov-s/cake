import { Stream } from "effect";
import { expect, it, vi } from "vitest";
import { SubagentHandleId } from "../../../../src/contracts/subagents/subagent-data";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { SubagentActivity } from "../../../../src/renderer/models/SubagentActivity";
import { ReviewThread } from "../../../../src/renderer/models/ReviewThread";
import { createModelObserver } from "../../../../src/renderer/observers/models";
import { observerClient, observerRuntime } from "./observer-test-runtime";

it("metadata snapshots never replace already loaded worker or side-chat history", async () => {
  const projection = RootProjection.create();
  const discussions = projection.discussionCatalog("parent");
  const subagents = projection.subagentCatalog("parent");
  const handleId = SubagentHandleId.make("10000000-0000-4000-8000-000000000001");
  const original = {
    id: "original",
    kind: "text" as const,
    role: "assistant" as const,
    text: "Real retained transcript",
    status: "complete" as const,
  };
  subagents.activities.push(
    SubagentActivity.create({
      handleId,
      parentSessionId: "parent",
      status: "complete",
      task: "Retained worker",
      parts: [original],
    }),
  );
  discussions.threads.push(
    ReviewThread.create({
      id: "thread",
      parentSessionId: "parent",
      sidecarSessionId: "sidecar",
      workingDirectory: "/cake",
    }),
  );
  const sidecar = projection.discussionConversation("sidecar", "/cake", "parent");
  sidecar.earlierParts.push(original);
  const observer = createModelObserver(
    observerRuntime(
      observerClient({
        projects: { observeCatalog: () => Stream.never },
        cakeChats: { observeCatalog: () => Stream.never },
        subagents: {
          observeMetadata: () =>
            Stream.succeed([
              {
                parentSessionId: "parent",
                handleId,
                anchorPartId: "anchor",
                task: "Retained worker",
                status: "complete",
                streaming: false,
                released: false,
                resolved: false,
              },
            ]),
        },
        discussionSessions: {
          observeMetadata: () =>
            Stream.succeed([
              {
                id: "thread",
                parentSessionId: "parent",
                workingDirectory: "/cake",
                sidecarSessionId: "sidecar",
                title: "Saved title",
                running: false,
                status: "open",
                createdAt: "",
                updatedAt: "",
              },
            ]),
        },
      }),
    ),
  );
  try {
    observer.sync({
      projects: projection.projects,
      sessionCatalog: projection.sessionCatalog,
      cakeChatCatalog: projection.cakeChatCatalog,
      projectSessions: [],
      cakeChats: [],
      navigationCatalogs: [
        {
          target: { sessionId: "parent", workingDirectory: "/cake", kind: "project-session" },
          discussions,
          subagents,
        },
      ],
    });
    await vi.waitFor(() =>
      expect(subagents.metadataLoaded && discussions.metadataLoaded).toBe(true),
    );
    expect(subagents.activities[0]?.parts).toEqual([original]);
    expect(discussions.threads[0]?.sidecarSessionId).toBe("sidecar");
    expect(sidecar.earlierParts).toEqual([original]);
    observer.stop();
    expect(subagents.activities[0]?.parts).toEqual([original]);
    expect(sidecar.earlierParts).toEqual([original]);
  } finally {
    observer.stop();
    projection[Symbol.dispose]();
  }
});
