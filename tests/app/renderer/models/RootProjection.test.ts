import { describe, expect, it } from "vitest";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { applyProjectSessionProjection } from "../../../../src/renderer/reducers/ProjectSessionReducer";

const projection = (sessionId: string) => ({
  identity: {
    _tag: "ProjectSession" as const,
    sessionId,
    projectPath: "/project",
    workingDirectory: "/project",
  },
  project: { path: "/project", name: "Project" },
  workingDirectory: { path: "/project" },
  lifecycle: { resolved: false, unread: false },
  primaryConversation: { sessionId },
  discussionSessions: [],
  subagentSessions: [],
  reviewThreads: [],
  artifactLinks: [],
});

describe("RootProjection", () => {
  it("keeps aggregate, Conversation, and focused authorities as stable separate Models", () => {
    const root = RootProjection.create();
    const aggregate = root.projectSession("one");
    const conversation = root.projectConversation("one", "/project");
    const discussions = root.discussionCatalog("one");
    const subagents = root.subagentCatalog("one");
    const schedules = root.scheduledMessageCatalog("one");

    applyProjectSessionProjection(aggregate, projection("one"));

    expect(root.projectSession("one")).toBe(aggregate);
    expect(root.projectConversation("one", "/project")).toBe(conversation);
    expect(root.discussionCatalog("one")).toBe(discussions);
    expect(root.subagentCatalog("one")).toBe(subagents);
    expect(root.scheduledMessageCatalog("one")).toBe(schedules);
    expect(aggregate.primaryConversationId).toBe("one");
    expect(conversation).not.toHaveProperty("reviewThreads");
    expect(conversation).not.toHaveProperty("artifacts");
    expect(conversation).not.toHaveProperty("controlRequests");

    root[Symbol.dispose]();
  });
});
