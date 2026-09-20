import { describe, expect, it } from "vitest";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";

describe("RootProjection", () => {
  it("keeps Conversation and focused authorities as stable separate Models", () => {
    const root = RootProjection.create();
    const conversation = root.projectConversation("one", "/project");
    const discussions = root.discussionCatalog("one");
    const subagents = root.subagentCatalog("one");
    const schedules = root.scheduledMessageCatalog("one");

    expect(root.projectConversation("one", "/project")).toBe(conversation);
    expect(root.discussionCatalog("one")).toBe(discussions);
    expect(root.subagentCatalog("one")).toBe(subagents);
    expect(root.scheduledMessageCatalog("one")).toBe(schedules);
    expect(conversation).not.toHaveProperty("reviewThreads");
    expect(conversation).not.toHaveProperty("artifacts");
    expect(conversation).not.toHaveProperty("controlRequests");

    root[Symbol.dispose]();
  });
});
