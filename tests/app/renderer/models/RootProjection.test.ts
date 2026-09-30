import { applySnapshot, effect, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";

describe("RootProjection", () => {
  it("indexes warm lookups without traversing the Conversation collection", () => {
    const root = RootProjection.create({
      projectConversations: Array.from({ length: 100 }, (_, index) => ({
        sessionId: `session-${index}`,
      })),
    });
    const traverse = vi.spyOn(root.projectConversations, Symbol.iterator);
    const expected = root.projectConversations[75];
    expect(root.findProjectConversation("session-75")).toBe(expected);
    traverse.mockClear();

    for (let index = 0; index < 100; index += 1) {
      expect(root.findProjectConversation("session-75")).toBe(expected);
      expect(root.projectConversation("session-75", "/project")).toBe(expected);
      expect(root.findProjectConversation("missing")).toBeUndefined();
    }
    expect(traverse).not.toHaveBeenCalled();
    root[Symbol.dispose]();
  });

  it("invalidates indexed membership on removal, recreation, and external collection changes", () => {
    const root = RootProjection.create();
    const original = root.projectConversation("one", "/project");
    let found: Conversation | undefined;
    const stop = effect(() => {
      found = root.findProjectConversation("one");
    });
    try {
      expect(found).toBe(original);
      root.removeProjectSessionProjections("one");
      expect(found).toBeUndefined();
      expect(root.findProjectConversation("one")).toBeUndefined();
      const recreated = root.projectConversation("one", "/project");
      expect(recreated).not.toBe(original);
      expect(found).toBe(recreated);

      const external = Conversation.create({ sessionId: "one" });
      root.projectConversations.splice(0, 1, external);
      expect(found).toBe(external);
      expect(root.projectConversation("one", "/project")).toBe(external);
      external.sessionId = "renamed";
      expect(found).toBeUndefined();
      expect(root.findProjectConversation("renamed")).toBe(external);
      root.projectConversations.splice(0, 1);
      expect(root.findProjectConversation("renamed")).toBeUndefined();
    } finally {
      stop();
      root[Symbol.dispose]();
    }
  });

  it("reacts to the first identity attachment and clears indexed lookup on Model disposal", () => {
    const root = RootProjection.create();
    let found: Conversation | undefined;
    const stop = effect(() => {
      found = root.findProjectConversation("first");
    });
    expect(found).toBeUndefined();
    const first = root.projectConversation("first", "/project");
    expect(found).toBe(first);
    root[Symbol.dispose]();
    expect(found).toBeUndefined();
    expect(root.findProjectConversation("first")).toBeUndefined();
    stop();
  });

  it("scopes indexed lookup to Project Conversations across other Conversation kinds", () => {
    const root = RootProjection.create();
    const cakeChat = root.cakeChatConversation("cake-chat");
    const discussion = root.discussionConversation("discussion", "/project");
    expect(root.findProjectConversation("cake-chat")).toBeUndefined();
    expect(root.findProjectConversation("discussion")).toBeUndefined();
    root.cakeChatConversations.splice(0, 1);
    root.projectConversations.push(cakeChat);
    expect(root.findProjectConversation("cake-chat")).toBe(cakeChat);
    root.discussionConversations.splice(0, 1);
    root.projectConversations.push(discussion);
    expect(root.findProjectConversation("discussion")).toBe(discussion);
    root[Symbol.dispose]();
  });

  it("derives the index from initial and externally applied snapshots without serializing it", () => {
    const root = RootProjection.create({ projectConversations: [{ sessionId: "one" }] });
    const initial = root.findProjectConversation("one");
    expect(initial).toBe(root.projectConversations[0]);

    const snapshot = toSnapshot(root);
    expect(snapshot).not.toHaveProperty("projectConversationMembers");
    applySnapshot(root, { ...snapshot, projectConversations: [{ sessionId: "two" }] });
    expect(root.findProjectConversation("one")).toBeUndefined();
    const restored = root.findProjectConversation("two");
    expect(restored).toBe(root.projectConversations[0]);
    expect(root.projectConversation("two", "/project")).toBe(restored);
    applySnapshot(root, { ...toSnapshot(root), projectConversations: [{ sessionId: "one" }] });
    expect(root.findProjectConversation("two")).toBeUndefined();
    expect(root.findProjectConversation("one")).not.toBe(initial);
    root[Symbol.dispose]();
  });

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
