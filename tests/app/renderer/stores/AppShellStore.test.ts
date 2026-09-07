import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { AppShellStore } from "../../../../src/renderer/stores/AppShellStore";

const createShell = (
  onProjectSessionDeparted: (sessionId: string) => void = () => undefined,
  resolved: {
    project(sessionId: string): boolean | undefined;
    cakeChat(sessionId: string): boolean | undefined;
  } = { project: () => false, cakeChat: () => false },
) =>
  mount(
    createStore(AppShellStore, {
      projectSessionResolved: resolved.project,
      cakeChatSessionResolved: resolved.cakeChat,
      onProjectSessionDeparted,
    }),
  );

describe("AppShellStore session history", () => {
  it("notifies a Project Session when navigating away from it", () => {
    const departed: string[] = [];
    const shell = createShell((sessionId) => departed.push(sessionId));

    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.showSettings();

    expect(departed).toEqual(["a", "b"]);
    shell[Symbol.dispose]();
  });

  it("selects a Project-scoped Kanban surface without replacing conversation history", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.showKanban("/work/cake");

    expect(shell.surface).toBe("kanban");
    expect(shell.selection).toEqual({ kind: "kanban", projectPath: "/work/cake" });
    expect(shell.activeConversation).toEqual({ kind: "project-session", sessionId: "a" });
    expect(shell.canGoBack).toBe(false);
    shell[Symbol.dispose]();
  });

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

  it("skips resolved sessions when stepping backward and forward", () => {
    const resolution = observable({ projectB: false, cakeChat: false });
    const shell = createShell(undefined, {
      project: (sessionId) => (sessionId === "b" ? resolution.projectB : false),
      cakeChat: (sessionId) => (sessionId === "cake-1" ? resolution.cakeChat : false),
    });
    shell.selectProjectSession("a");
    shell.selectProjectSession("b");
    shell.selectCakeChat("cake-1");
    shell.selectProjectSession("c");

    resolution.projectB = true;
    resolution.cakeChat = true;

    expect(shell.canGoBack).toBe(true);
    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "a" });
    shell.selectProjectSession("a");
    expect(shell.canGoBack).toBe(false);
    expect(shell.canGoForward).toBe(true);
    expect(shell.goForward()).toEqual({ kind: "project-session", sessionId: "c" });
    shell.selectProjectSession("c");
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

  it("preserves selection identity when the current session is reselected", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    const projectSelection = shell.selection;
    const projectConversation = shell.activeConversation;

    shell.selectProjectSession("a");

    expect(shell.selection).toBe(projectSelection);
    expect(shell.activeConversation).toBe(projectConversation);

    shell.selectCakeChat("cake-1");
    const cakeChatSelection = shell.selection;
    const cakeChatConversation = shell.activeConversation;

    shell.selectCakeChat("cake-1");

    expect(shell.selection).toBe(cakeChatSelection);
    expect(shell.activeConversation).toBe(cakeChatConversation);
    shell[Symbol.dispose]();
  });

  it("selects a resolved session preview without adding it to history", () => {
    const shell = createShell();
    shell.selectProjectSession("a");
    shell.previewResolvedProjectSession("resolved");

    expect(shell.selection).toEqual({
      kind: "project-session",
      sessionId: "resolved",
    });
    expect(shell.goBack()).toBeUndefined();
    expect(shell.goForward()).toBeUndefined();
    expect(shell.removeSessionsFromHistory(["resolved"])).toEqual({
      kind: "project-session",
      sessionId: "a",
    });
    shell[Symbol.dispose]();
  });

  it("promotes a restored Project Session preview into navigation history", () => {
    const resolution = observable({ restored: true });
    const shell = createShell(undefined, {
      project: (sessionId) => (sessionId === "restored" ? resolution.restored : false),
      cakeChat: () => false,
    });
    shell.selectProjectSession("previous");
    shell.previewResolvedProjectSession("restored");

    resolution.restored = false;

    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "previous" });
    shell[Symbol.dispose]();
  });

  it("promotes a restored Cake Chat preview into navigation history", () => {
    const resolution = observable({ restored: true });
    const shell = createShell(undefined, {
      project: () => false,
      cakeChat: (sessionId) => (sessionId === "restored" ? resolution.restored : false),
    });
    shell.selectProjectSession("previous");
    shell.previewResolvedCakeChat("restored");

    resolution.restored = false;

    expect(shell.goBack()).toEqual({ kind: "project-session", sessionId: "previous" });
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
