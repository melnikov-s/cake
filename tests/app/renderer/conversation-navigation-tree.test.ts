import { applySnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { RootProjection } from "../../../src/renderer/models/RootProjection";
import {
  buildConversationNavigationTree,
  conversationNavigationKey,
  conversationNavigationLineage,
  matchingConversationNavigationKeys,
  subagentNavigationKey,
} from "../../../src/renderer/lib/conversation-navigation-tree";
import {
  navigatorHomeId,
  navigatorProjectPath,
  navigatorSessions,
  populateConversationNavigationFixture,
} from "./fixtures/conversation-navigation-fixtures";

function treeFixture(projectPath: string | undefined, history = false) {
  const models = RootProjection.create();
  applySnapshot(models.sessionCatalog, { sessions: navigatorSessions });
  const { deepHandleId } = populateConversationNavigationFixture(models);
  if (history) {
    const catalog = models.subagentCatalog("layout");
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
  }
  const tree = buildConversationNavigationTree({
    projectPath,
    sessions: models.sessionCatalog.sessions,
    cakeChats: models.cakeChatCatalog.sessions,
    discussions: models.discussionCatalogs,
    subagents: models.subagentCatalogs,
    conversations: models.discussionConversations,
  });
  return {
    models,
    tree,
    deepHandleId,
    [Symbol.dispose]() {
      models[Symbol.dispose]();
    },
  };
}

describe("conversation navigation projection", () => {
  it("keeps grouping distinct from family ancestry and recursively joins real side-chat/subagent owners", () => {
    using fixture = treeFixture(navigatorProjectPath);
    const { tree } = fixture;
    expect(tree.total).toBe(15);
    expect(tree.running).toBe(5);
    expect(tree.roots.map((node) => node.target.sessionId)).toEqual([navigatorHomeId]);
    expect(
      tree.roots[0]!.children.filter((node) => node.target.kind === "project-session").map(
        (node) => node.target.sessionId,
      ),
    ).toEqual(["layout", "icons"]);
    const grouped = tree.byKey.get(conversationNavigationKey("layout"))!;
    expect(grouped.relationship).toBe("grouped");
    expect(grouped.label).toBe("Session");
    expect(grouped.parentKey).toBe(conversationNavigationKey(navigatorHomeId));
    const child = tree.byKey.get(conversationNavigationKey("keyboard"))!;
    expect(child.relationship).toBe("family-child");
    expect(child.parentKey).toBe(grouped.key);
    expect(grouped.running).toBe(false);
    expect(grouped.activity).toBeUndefined();
    expect(grouped.runningDescendants).toBe(5);
    const lineage = conversationNavigationLineage(
      tree,
      subagentNavigationKey("focus-chat", fixture.deepHandleId),
    );
    expect(lineage.map((node) => node.title)).toEqual([
      "Project Chat",
      "UI Layout Refactor",
      "Keyboard Editing & Navigation",
      "Focus restoration",
      "Selection-path audit",
    ]);
    expect(tree.byKey.get(conversationNavigationKey("deep-discussion-chat"))?.parentKey).toBe(
      conversationNavigationKey("focus-chat"),
    );
  });

  it("keeps released retained worker history visible and read-only without counting it as running", () => {
    using fixture = treeFixture(navigatorProjectPath, true);
    const node = [...fixture.tree.byKey.values()].find(
      (node) => node.title === "Retained released worker",
    );
    expect(node).toMatchObject({
      parentKey: conversationNavigationKey("layout"),
      readOnly: true,
      running: false,
      activity: undefined,
    });
    expect(fixture.tree.running).toBe(2);
  });

  it("search retains every matching ancestor but no unrelated branches", () => {
    using fixture = treeFixture(navigatorProjectPath);
    const keys = matchingConversationNavigationKeys(fixture.tree, "Selection-path audit");
    expect([...keys]).toEqual(
      conversationNavigationLineage(
        fixture.tree,
        subagentNavigationKey("focus-chat", fixture.deepHandleId),
      ).map((node) => node.key),
    );
  });

  it("scopes global Cake Chat to its real descendants", () => {
    using fixture = treeFixture(undefined);
    expect(fixture.tree.total).toBe(3);
    expect(fixture.tree.running).toBe(1);
    expect([...fixture.tree.byKey.values()].map((node) => node.title)).toEqual([
      "Cake Chat",
      "Weekly planning",
      "Global project summary",
    ]);
  });
});
