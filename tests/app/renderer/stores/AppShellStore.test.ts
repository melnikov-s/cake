import { describe, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/ipc/cake-chat-data";
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
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    const cakeSelection = shell.selection;
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    expect(shell.selection).toBe(cakeSelection);
    shell.selectProjectSession("b");
    expect(shell.canGoBack).toBe(true);
    expect(shell.canGoForward).toBe(false);
    expect(shell.goBack()).toEqual({ kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID });
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    shell.selectProjectSession("a");
    expect(shell.canGoBack).toBe(false);
    expect(shell.goForward()).toEqual({ kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID });
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    expect(shell.goForward()).toEqual({ kind: "project-session", sessionId: "b" });
    shell.selectProjectSession("b");
    expect(shell.canGoForward).toBe(false);
  });

  it("skips resolved Project Sessions while retaining the permanent Cake Chat", () => {
    using fixture = createRendererStoreFixture({
      sessions: [sessionSummary({ sessionId: "b", projectPath: "/project" })],
    });
    const shell = fixture.root.appShellStore;
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    shell.selectProjectSession("c");
    fixture.models.sessionCatalog.find("b")!.resolved = true;
    expect(shell.goBack()).toEqual({ kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID });
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    shell.selectProjectSession("a");
    expect(shell.canGoBack).toBe(false);
    expect(shell.goForward()).toEqual({ kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID });
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    expect(shell.goForward()).toEqual({ kind: "project-session", sessionId: "c" });
    shell.selectProjectSession("c");
    expect(shell.canGoForward).toBe(false);
  });

  it("promotes a restored Project Session preview into history only after resolution changes", () => {
    using fixture = createRendererStoreFixture({
      sessions: [
        sessionSummary({ sessionId: "restored", projectPath: "/project", resolved: true }),
      ],
    });
    const shell = fixture.root.appShellStore;
    shell.selectProjectSession("previous");
    shell.previewResolvedProjectSession("restored");
    expect(shell.goBack()).toBeUndefined();
    expect(shell.goForward()).toBeUndefined();
    fixture.models.sessionCatalog.find("restored")!.resolved = false;
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "previous" });
  });

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
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    shell.goBack();
    expect(shell.canGoForward).toBe(false);
    shell.selectProjectSession("b");
    expect(shell.canGoForward).toBe(true);
    shell.goForward();
    shell.selectCakeChat(CAKE_CHAT_SESSION_ID);
    expect(shell.canGoForward).toBe(false);
    shell.goBack();
    shell.selectProjectSession("d");
    expect(shell.goForward()).toBeUndefined();
    expect(shell.goBack()).toEqual({ kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID });
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
