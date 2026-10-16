import { describe, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// App shell navigation/Settings/library workflows live in app-shell-navigation-workflow.test.tsx.
// Keep only history regressions not exercised by those UI journeys, using the real Root metadata.
describe("AppShellStore uncovered history regressions", () => {
  // Restoration of an archived preview is not driven by the navigation workflow.
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

  // Preview removal is distinct from resolving an active worktree in workbench-workflow.
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

  // The UI suite uses hydrated destinations; retain the unlanded traversal/cancellation invariant.
  it("commits a traversal only when its target lands and cancels a divergent pending target", () => {
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

  // Bulk deletion deduplication and nearest retained targets exceed the active-worktree UI case.
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

  // No UI journey removes an unknown/non-current history entry while traversal is pending.
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
