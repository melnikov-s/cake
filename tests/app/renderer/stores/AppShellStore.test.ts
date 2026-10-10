import { describe, expect, it } from "vitest";
import { CakeChatSummary } from "../../../../src/renderer/models/CakeChatSummary";
import { sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Low-level history invariants supplement project-navigation-workflow.test.tsx.
// Use the real Root so resolution is read through the production metadata provider.
describe("AppShellStore session history", () => {
  it("clears the active conversation for the Artifact Library but retains it under Settings", () => {
    using fixture = createRendererStoreFixture();
    const shell = fixture.root.appShellStore;
    shell.selectProjectSession("saved-draft");
    shell.showSettings();
    expect(shell.selection).toEqual({ kind: "settings" });
    expect(shell.activeConversation).toEqual({ kind: "project-session", sessionId: "saved-draft" });
    shell.selectProjectSession(shell.activeConversation!.sessionId);
    shell.showArtifactLibrary();
    expect(shell.selection).toEqual({ kind: "artifact-library" });
    expect(shell.surface).toBe("artifact-library");
    expect(shell.activeConversation).toBeUndefined();
  });

  it("records sessions and traverses both directions without duplicating reselections", () => {
    using fixture = createRendererStoreFixture();
    const shell = fixture.root.appShellStore;
    expect(shell.goBack()).toBeUndefined();
    expect(shell.goForward()).toBeUndefined();
    shell.selectCakeChat();
    shell.selectProjectSession("a");
    const selection = shell.selection;
    const conversation = shell.activeConversation;
    shell.selectProjectSession("a");
    expect(shell.selection).toBe(selection);
    expect(shell.activeConversation).toBe(conversation);
    shell.selectCakeChat("cake-1");
    const cakeSelection = shell.selection;
    shell.selectCakeChat("cake-1");
    expect(shell.selection).toBe(cakeSelection);
    shell.selectProjectSession("b");
    expect(shell.canGoBack).toBe(true);
    expect(shell.canGoForward).toBe(false);
    expect(shell.goBack()).toEqual({ kind: "cake-chat", sessionId: "cake-1" });
    shell.selectCakeChat("cake-1");
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    shell.selectProjectSession("a");
    expect(shell.canGoBack).toBe(false);
    expect(shell.goForward()).toEqual({ kind: "cake-chat", sessionId: "cake-1" });
    shell.selectCakeChat("cake-1");
    expect(shell.goForward()).toEqual({ kind: "project-session", sessionId: "b" });
    shell.selectProjectSession("b");
    expect(shell.canGoForward).toBe(false);
  });

  it("skips resolved Project Sessions and Cake Chats while retaining unresolved neighbors", () => {
    using fixture = createRendererStoreFixture({
      sessions: [sessionSummary({ sessionId: "b", projectPath: "/project" })],
    });
    fixture.models.cakeChatCatalog.sessions.push(CakeChatSummary.create({ sessionId: "cake-1" }));
    const shell = fixture.root.appShellStore;
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.selectCakeChat("cake-1");
    shell.selectProjectSession("c");
    fixture.models.sessionCatalog.find("b")!.resolved = true;
    fixture.models.cakeChatCatalog.find("cake-1")!.resolved = true;
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    shell.selectProjectSession("a");
    expect(shell.canGoBack).toBe(false);
    expect(shell.goForward()).toEqual({ kind: "project-session", sessionId: "c" });
    shell.selectProjectSession("c");
    expect(shell.canGoForward).toBe(false);
  });

  it.each(["project-session", "cake-chat"] as const)(
    "promotes a restored %s preview into history only after resolution changes",
    (kind) => {
      using fixture = createRendererStoreFixture({
        sessions: [
          sessionSummary({ sessionId: "restored", projectPath: "/project", resolved: true }),
        ],
      });
      fixture.models.cakeChatCatalog.sessions.push(
        CakeChatSummary.create({ sessionId: "restored", resolved: true }),
      );
      const shell = fixture.root.appShellStore;
      shell.selectProjectSession("previous");
      if (kind === "project-session") shell.previewResolvedProjectSession("restored");
      else shell.previewResolvedCakeChat("restored");
      expect(shell.goBack()).toBeUndefined();
      expect(shell.goForward()).toBeUndefined();
      if (kind === "project-session")
        fixture.models.sessionCatalog.find("restored")!.resolved = false;
      else fixture.models.cakeChatCatalog.find("restored")!.resolved = false;
      expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "previous" });
    },
  );

  it("removes a preview without adding it to history", () => {
    using fixture = createRendererStoreFixture();
    const shell = fixture.root.appShellStore;
    shell.selectProjectSession("a");
    shell.previewResolvedProjectSession("resolved");
    expect(shell.selection).toEqual({ kind: "project-session", sessionId: "resolved" });
    expect(shell.removeSessionsFromHistory(["resolved"])).toEqual({
      kind: "project-session",
      sessionId: "a",
    });
  });

  it("commits a traversal only when its target lands and truncates a divergent branch", () => {
    using fixture = createRendererStoreFixture();
    const shell = fixture.root.appShellStore;
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.selectCakeChat("cake-1");
    shell.goBack();
    expect(shell.canGoForward).toBe(false);
    shell.selectProjectSession("b");
    expect(shell.canGoForward).toBe(true);
    shell.goForward();
    shell.selectCakeChat("cake-1");
    expect(shell.canGoForward).toBe(false);
    shell.goBack();
    shell.selectCakeChat("cake-9");
    expect(shell.goForward()).toBeUndefined();
    expect(shell.goBack()).toEqual({ kind: "cake-chat", sessionId: "cake-1" });
  });

  it("truncates the forward branch on a newly visited session", () => {
    using fixture = createRendererStoreFixture();
    const shell = fixture.root.appShellStore;
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.selectProjectSession("a");
    expect(shell.goForward()).toBeUndefined();
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "b" });
  });

  it.each([
    { visits: ["a", "b"], removed: ["b"], target: "a" },
    { visits: ["a", "b", "a"], removed: ["a"], target: "b" },
    {
      visits: ["previous", "worktree-a", "worktree-b"],
      removed: ["worktree-a", "worktree-b"],
      target: "previous",
    },
  ])("removes all matching history entries atomically: $removed", ({ visits, removed, target }) => {
    using fixture = createRendererStoreFixture();
    const shell = fixture.root.appShellStore;
    for (const id of visits) shell.selectProjectSession(id);
    expect(shell.removeSessionsFromHistory(removed)).toEqual({
      kind: "project-session",
      sessionId: target,
    });
    expect(shell.canGoBack).toBe(false);
    expect(shell.canGoForward).toBe(false);
  });

  it("keeps the current entry when removing a non-current or unknown session", () => {
    using fixture = createRendererStoreFixture();
    const shell = fixture.root.appShellStore;
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    expect(shell.removeSessionsFromHistory(["nope"])).toBeUndefined();
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    expect(shell.removeSessionsFromHistory(["a"])).toBeUndefined();
    expect(shell.goBack()).toBeUndefined();
    expect(shell.canGoForward).toBe(false);
  });
});
