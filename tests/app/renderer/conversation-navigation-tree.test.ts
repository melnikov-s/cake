import { applySnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { RootProjection } from "../../../src/renderer/models/RootProjection";
import { conversationOwnedNavigation } from "../../../src/renderer/lib/conversation-owned-navigation";
import {
  buildConversationNavigationTree,
  conversationNavigationKey,
  conversationNavigationLineage,
  matchingConversationNavigationKeys,
} from "../../../src/renderer/lib/conversation-navigation-tree";
import {
  navigatorHomeId,
  navigatorProjectPath,
  navigatorSessions,
  populateConversationNavigationFixture,
} from "./fixtures/conversation-navigation-fixtures";

function treeFixture(projectPath: string | undefined) {
  const models = RootProjection.create();
  applySnapshot(models.sessionCatalog, { sessions: navigatorSessions });
  populateConversationNavigationFixture(models);
  const tree = buildConversationNavigationTree({
    projectPath,
    sessions: models.sessionCatalog.sessions,
    cakeChats: models.cakeChatCatalog.sessions,
    conversations: models.discussionConversations,
  });
  return {
    models,
    tree,
    owned(sessionId: string) {
      return conversationOwnedNavigation(
        sessionId,
        models.discussionCatalog(sessionId),
        models.subagentCatalog(sessionId),
        models.discussionConversations,
      );
    },
    [Symbol.dispose]() {
      models[Symbol.dispose]();
    },
  };
}

describe("conversation navigation projection", () => {
  it("keeps actual Project Sessions and family/context-fork children in Sessions, with private conversations in their owner's menu", () => {
    using fixture = treeFixture(navigatorProjectPath);
    const { tree } = fixture;
    expect(tree.total).toBe(5);
    expect(tree.running).toBe(0);
    expect(tree.roots.map((node) => node.target.sessionId)).toEqual([navigatorHomeId]);
    expect(tree.roots[0]!.children.map((node) => node.target.sessionId)).toEqual([
      "layout",
      "icons",
    ]);
    const grouped = tree.byKey.get(conversationNavigationKey("layout"))!;
    expect(grouped.relationship).toBe("grouped");
    expect(grouped.parentKey).toBe(conversationNavigationKey(navigatorHomeId));
    const child = tree.byKey.get(conversationNavigationKey("keyboard"))!;
    expect(child.relationship).toBe("family-child");
    expect(child.parentKey).toBe(grouped.key);
    expect(
      conversationNavigationLineage(tree, conversationNavigationKey("deep-child")).map(
        (node) => node.target.sessionId,
      ),
    ).toEqual([navigatorHomeId, "layout", "keyboard", "deep-child"]);
    expect(fixture.owned("layout").map((node) => [node.title, node.target.kind])).toEqual([
      ["Pane widths", "side-chat"],
      ["Breadcrumb audit", "subagent"],
      ["Icon and tooltip audit", "subagent"],
      ["Dense tree review", "subagent"],
    ]);
    expect(fixture.owned("focus-chat").map((node) => node.title)).toEqual([
      "Selection-path discussion",
      "Selection-path audit",
    ]);
  });

  it("keeps released retained worker history in its owner's menu without counting it as running", () => {
    using fixture = treeFixture(navigatorProjectPath);
    const catalog = fixture.models.subagentCatalog("layout");
    catalog.metadataLoaded = true;
    catalog.metadata.push({
      parentSessionId: "layout",
      handleId: SubagentHandleId.make("10000000-0000-4000-8000-000000000099"),
      anchorPartId: "saved-start",
      task: "Retained released worker",
      status: "running",
      streaming: false,
      released: true,
    });
    expect(fixture.owned("layout")[1]).toMatchObject({
      title: "Retained released worker",
      readOnly: true,
      running: false,
      activity: undefined,
    });
    expect(fixture.tree.total).toBe(5);
  });

  it("search retains matching Project Session ancestors but not unrelated branches", () => {
    using fixture = treeFixture(navigatorProjectPath);
    const keys = matchingConversationNavigationKeys(fixture.tree, "Nested child implementation");
    expect([...keys]).toEqual(
      conversationNavigationLineage(fixture.tree, conversationNavigationKey("deep-child")).map(
        (node) => node.key,
      ),
    );
  });

  it("scopes global and Project Chat menus to direct owners, not siblings or descendants", () => {
    using fixture = treeFixture(undefined);
    expect(fixture.tree.total).toBe(1);
    expect(fixture.tree.roots[0]!.title).toBe("Cake Chat");
    expect(fixture.owned(CAKE_CHAT_SESSION_ID).map((node) => node.title)).toEqual([
      "Weekly planning",
    ]);
    expect(fixture.owned("planning-chat").map((node) => node.title)).toEqual([
      "Global project summary",
    ]);
    expect(fixture.owned(navigatorHomeId).map((node) => node.title)).toEqual([
      "Navigation decisions",
    ]);
  });
});
