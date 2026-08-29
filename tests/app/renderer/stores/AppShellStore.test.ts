import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { AppShellStore } from "../../../../src/renderer/stores/AppShellStore";

const createShell = () =>
  mount(
    createStore(AppShellStore, {
      sessionWorkspacePath: (sessionId) => `/work/${sessionId}`,
    }),
  );

describe("AppShellStore session history", () => {
  it("records visited sessions and steps back and forward through them", () => {
    const shell = createShell();
    expect(shell.canGoBack).toBe(false);
    expect(shell.canGoForward).toBe(false);
    expect(shell.goBack()).toBeUndefined();
    expect(shell.goForward()).toBeUndefined();

    shell.selectProjectSession("a");
    shell.selectCakeChat("cake-1");
    shell.selectProjectSession("b");

    expect(shell.canGoBack).toBe(true);
    expect(shell.canGoForward).toBe(false);

    expect(shell.goBack()).toEqual({ kind: "cake-chat", sessionId: "cake-1" });
    shell.selectCakeChat("cake-1");
    expect(shell.canGoBack).toBe(true);
    expect(shell.canGoForward).toBe(true);

    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    shell.selectProjectSession("a");
    expect(shell.canGoBack).toBe(false);
    expect(shell.canGoForward).toBe(true);

    expect(shell.goForward()).toEqual({ kind: "cake-chat", sessionId: "cake-1" });
    shell.selectCakeChat("cake-1");
    expect(shell.canGoForward).toBe(true);

    expect(shell.goForward()).toEqual({ kind: "project-session", sessionId: "b" });
    shell.selectProjectSession("b");
    expect(shell.canGoForward).toBe(false);
    shell[Symbol.dispose]();
  });

  it("does not duplicate history when the current session is reselected", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.selectProjectSession("a");
    shell.selectCakeChat("cake-1");
    shell.selectCakeChat("cake-1");

    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    shell.selectProjectSession("a");
    expect(shell.canGoBack).toBe(false);
    expect(shell.goForward()).toEqual({ kind: "cake-chat", sessionId: "cake-1" });
    shell[Symbol.dispose]();
  });

  it("selects a resolved session preview without adding it to history", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.previewResolvedProjectSession("resolved");

    expect(shell.selection).toEqual({
      kind: "project-session",
      workspacePath: "/work/resolved",
      sessionId: "resolved",
    });
    expect(shell.goBack()).toBeUndefined();
    expect(shell.goForward()).toBeUndefined();
    shell[Symbol.dispose]();
  });

  it("does not record a cake chat selection that has no session yet", () => {
    const shell = createShell();
    shell.selectCakeChat();
    shell.selectProjectSession("a");

    expect(shell.goBack()).toBeUndefined();
    shell[Symbol.dispose]();
  });

  it("truncates the forward branch when a new session is visited after going back", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.selectProjectSession("a");

    expect(shell.goForward()).toBeUndefined();
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "b" });
    shell[Symbol.dispose]();
  });

  it("commits a traversal only when the selection lands on its target", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.selectCakeChat("cake-1");

    shell.goBack();
    expect(shell.canGoBack).toBe(true);
    shell.selectProjectSession("b");
    expect(shell.canGoBack).toBe(true);
    expect(shell.canGoForward).toBe(true);

    shell.goForward();
    shell.selectCakeChat("cake-1");
    expect(shell.canGoForward).toBe(false);
    expect(shell.canGoBack).toBe(true);
    shell[Symbol.dispose]();
  });

  it("cancels a pending traversal when a different selection lands first", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");

    shell.goBack();
    shell.selectCakeChat("cake-9");

    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "b" });
    shell[Symbol.dispose]();
  });

  it("returns the previous entry when the current session leaves the history", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");

    expect(shell.removeSessionsFromHistory(["b"])).toEqual({
      kind: "project-session",
      sessionId: "a",
    });
    expect(shell.canGoBack).toBe(false);
    expect(shell.canGoForward).toBe(false);
    shell[Symbol.dispose]();
  });

  it("keeps the current entry when a non-current session leaves the history", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");

    expect(shell.removeSessionsFromHistory(["a"])).toBeUndefined();
    expect(shell.goBack()).toBeUndefined();
    expect(shell.canGoForward).toBe(false);
    shell[Symbol.dispose]();
  });

  it("removes every entry of a session and lands on its nearest kept neighbor", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.selectProjectSession("a");

    expect(shell.removeSessionsFromHistory(["a"])).toEqual({
      kind: "project-session",
      sessionId: "b",
    });
    expect(shell.goBack()).toBeUndefined();
    shell[Symbol.dispose]();
  });

  it("removes a resolved workspace batch atomically and skips another removed session", () => {
    const shell = createShell();
    shell.selectProjectSession("previous");
    shell.selectProjectSession("worktree-a");
    shell.selectProjectSession("worktree-b");

    expect(shell.removeSessionsFromHistory(["worktree-a", "worktree-b"])).toEqual({
      kind: "project-session",
      sessionId: "previous",
    });
    expect(shell.canGoBack).toBe(false);
    shell[Symbol.dispose]();
  });

  it("ignores removal of a session that was never visited", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.selectCakeChat("cake-1");

    expect(shell.removeSessionsFromHistory(["nope"])).toBeUndefined();
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    shell[Symbol.dispose]();
  });
});
