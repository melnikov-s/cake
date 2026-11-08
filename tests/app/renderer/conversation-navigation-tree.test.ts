import { applySnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { sessionSummary } from "./fixtures/catalog-fixtures";
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
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "counts own running=%s and unread=%s independently, once per session ID",
    (running, unread) => {
      const session = sessionSummary({
        sessionId: "parent",
        projectPath: navigatorProjectPath,
        running,
        unread,
        latestTurnOutcome: "failed",
      });
      const tree = buildConversationNavigationTree({
        projectPath: navigatorProjectPath,
        sessions: [session, session],
        cakeChats: [],
        conversations: [],
      });
      expect(tree.total).toBe(1);
      expect(tree.running).toBe(Number(running));
      expect(tree.unread).toBe(Number(unread));
    },
  );

  it("excludes descendant unread without marking its parent or Project Chat unread", () => {
    using fixture = treeFixture(navigatorProjectPath);
    fixture.models.sessionCatalog.find("deep-child")!.unread = true;
    fixture.models.sessionCatalog.find("keyboard")!.running = true;
    const tree = buildConversationNavigationTree({
      projectPath: navigatorProjectPath,
      sessions: fixture.models.sessionCatalog.sessions,
      cakeChats: fixture.models.cakeChatCatalog.sessions,
      conversations: [],
    });
    expect(tree.unread).toBe(0);
    expect(tree.running).toBe(1);
    expect(tree.byKey.get(conversationNavigationKey("layout"))!.activity).toBeUndefined();
    expect(tree.byKey.get(conversationNavigationKey(navigatorHomeId))!.activity).toBeUndefined();
  });

  it("counts family roots once and excludes children even when their parent is outside the list", () => {
    const parent = sessionSummary({
      sessionId: "parent",
      projectPath: navigatorProjectPath,
      familyParentSessionId: "parent",
      unread: true,
      running: true,
    });
    const child = sessionSummary({
      sessionId: "child",
      projectPath: navigatorProjectPath,
      familyParentSessionId: "parent",
      unread: true,
      running: true,
    });
    const sessions = [
      parent,
      parent,
      child,
      child,
      sessionSummary({
        sessionId: "orphan",
        projectPath: navigatorProjectPath,
        familyParentSessionId: "missing",
        unread: true,
        running: true,
      }),
      sessionSummary({
        sessionId: "resolved",
        projectPath: navigatorProjectPath,
        resolved: true,
        unread: true,
        running: true,
      }),
      sessionSummary({ sessionId: "other", projectPath: "/other", unread: true, running: true }),
    ];
    const input = { projectPath: navigatorProjectPath, sessions, cakeChats: [], conversations: [] };
    const tree = buildConversationNavigationTree(input);
    expect(tree.total).toBe(3);
    expect(tree.unread).toBe(1);
    expect(tree.running).toBe(3);
    const withoutParent = buildConversationNavigationTree({ ...input, sessions: [child] });
    expect(withoutParent.total).toBe(1);
    expect(withoutParent.unread).toBe(0);
    expect(withoutParent.running).toBe(1);
  });

  it("does not count resolved home chats or homes from other scopes", () => {
    using fixture = treeFixture(navigatorProjectPath);
    fixture.models.cakeChatCatalog.find(navigatorHomeId)!.resolved = true;
    fixture.models.cakeChatCatalog.find(navigatorHomeId)!.running = true;
    fixture.models.cakeChatCatalog.find(navigatorHomeId)!.unread = true;
    fixture.models.cakeChatCatalog.find(CAKE_CHAT_SESSION_ID)!.unread = true;
    const input = {
      sessions: fixture.models.sessionCatalog.sessions,
      cakeChats: fixture.models.cakeChatCatalog.sessions,
      conversations: [],
    };
    const project = buildConversationNavigationTree({
      ...input,
      projectPath: navigatorProjectPath,
    });
    expect(project.unread).toBe(0);
    expect(project.running).toBe(1); // Unread filtering must not change existing running behavior.
    expect(project.byKey.has(conversationNavigationKey(navigatorHomeId))).toBe(true);
    const global = buildConversationNavigationTree({ ...input, projectPath: undefined });
    expect(global.unread).toBe(1);
    expect(global.total).toBe(1);
  });

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
      resolved: true,
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
