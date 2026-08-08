import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../../../src/ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../../../../src/renderer/desktop-client";
import { mountRootStore } from "../../../../src/renderer/stores/root-store";
import type { WindowStore } from "../../../../src/renderer/stores/window-store";

const snapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/one.jsonl",
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  sessions: [],
  tree: []
};

function createDesktopClient(restoredPath?: string) {
  let listener: ((event: DesktopClientEvent) => void) | undefined;
  const client: DesktopClient = {
    chooseProject: vi.fn(async () => "/project"),
    getHomeDirectory: vi.fn(async () => "/home/user"),
    chooseAttachments: vi.fn(async () => []),
    loadWindowState: vi.fn(async () => ({ projectPath: restoredPath, recentProjectPaths: restoredPath ? [restoredPath] : [], trustedProjectPaths: [], draft: "saved", theme: "system" as const, thinkingExpanded: false, sessionSearch: "", draftsBySession: {} })),
    saveWindowState: vi.fn(async () => undefined),
    loadApplicationState: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [] })),
    registerProject: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [] })),
    renameProject: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [] })),
    removeProject: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [] })),
    archiveSession: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [] })),
    createWindow: vi.fn(async () => undefined),
    restartPi: vi.fn(async () => undefined),
    inspectWorkspace: vi.fn(async () => undefined),
    openWorkspace: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => undefined),
    navigateSession: vi.fn(async () => undefined),
    inspectChanges: vi.fn(async () => undefined),
    respondToUi: vi.fn(async () => undefined),
    subscribe(next) { listener = next; return vi.fn(); }
  };
  return { client, emit: (event: DesktopClientEvent) => listener?.(event) };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountTestStore(client: DesktopClient) {
  const root = mountRootStore(client);
  return { root, store: root.windowStore };
}

async function openSnapshot(store: WindowStore, desktop: ReturnType<typeof createDesktopClient>, nextSnapshot = snapshot) {
  await store.chooseProject();
  const inspectId = store.activeOperations.at(-1)!;
  desktop.emit({ type: "workspace-inspected", operationId: inspectId, path: nextSnapshot.workspacePath, trustRequired: false });
  const openId = store.activeOperations.at(-1)!;
  desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot: nextSnapshot });
}

describe("WindowStore", () => {
  it("hydrates before persistence and reopens the persisted project", async () => {
    const desktop = createDesktopClient("/project");
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    expect(store.hydrated).toBe(true);
    expect(store.draft).toBe("saved");
    expect(desktop.client.inspectWorkspace).toHaveBeenCalledWith(expect.objectContaining({ path: "/project" }));
    expect(desktop.client.saveWindowState).not.toHaveBeenCalled();
    root[Symbol.dispose]();
  });

  it("gates project resources on trust and applies the authoritative snapshot", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await store.chooseProject();
    const inspectId = store.activeOperations[0]!;
    desktop.emit({ type: "workspace-inspected", operationId: inspectId, path: "/project", trustRequired: true });

    expect(store.pendingTrustPath).toBe("/project");
    await store.resolveProjectTrust(true);
    expect(desktop.client.openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ path: "/project", trusted: true }));
    const openId = store.activeOperations[0]!;
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot });

    expect(store.session?.sessionFile).toBe("/sessions/one.jsonl");
    expect(store.trustedProjectPaths).toContain("/project");

    await store.startNewSession();
    const secondInspectId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "workspace-inspected", operationId: secondInspectId, path: "/project", trustRequired: true });
    expect(store.pendingTrustPath).toBeUndefined();
    expect(desktop.client.openWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/project", trusted: true, newSession: true }));
    root[Symbol.dispose]();
  });

  it("routes transcript deltas and correlated UI responses", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    desktop.emit({ type: "part-updated", sessionId: "stale", part: { id: "stale", kind: "text", role: "assistant", text: "ignored", status: "complete" } });
    desktop.emit({ type: "part-updated", sessionId: "session-1", part: { id: "live", kind: "text", role: "assistant", text: "hello", status: "streaming" } });
    const operationId = crypto.randomUUID();
    const uiRequestId = crypto.randomUUID();
    store.activeOperations.push(operationId);
    desktop.emit({ type: "ui-requested", operationId, uiRequestId, kind: "confirm", title: "Continue?", message: "Confirm" });
    await store.respondToUi("true");

    expect(store.parts.map((part) => part.id)).toEqual(["live"]);
    expect(desktop.client.respondToUi).toHaveBeenCalledWith({ operationId, workspacePath: "/project", sessionId: "session-1", uiRequestId, value: "true", cancelled: false });
    root[Symbol.dispose]();
  });

  it("queues by default during a run and only steers when explicitly requested", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop, { ...snapshot, streaming: true });

    store.setDraft("Do this next");
    await store.submit();
    expect(desktop.client.submit).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Do this next", delivery: "follow-up" }));

    store.setDraft("Change direction");
    await store.submit("steer");
    expect(desktop.client.submit).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Change direction", delivery: "steer" }));
    root[Symbol.dispose]();
  });

  it("clears the previous transcript and rejects late snapshots while opening a new session", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    const oldSnapshot: SessionSnapshot = {
      ...snapshot,
      parts: [{ id: "old-tool", kind: "tool", name: "old", input: "", state: "success" }]
    };
    await openSnapshot(store, desktop, oldSnapshot);
    expect(store.parts).toHaveLength(1);

    await store.startNewSession();
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "workspace-inspected", operationId: inspectId, path: "/project", trustRequired: false });
    const openId = store.activeOperations.at(-1)!;
    expect(store.session).toBeUndefined();
    expect(store.parts).toEqual([]);

    desktop.emit({ type: "session-snapshot-received", snapshot: oldSnapshot });
    desktop.emit({ type: "session-snapshot-received", operationId: crypto.randomUUID(), snapshot: oldSnapshot });
    expect(store.parts).toEqual([]);

    const newSnapshot = { ...snapshot, sessionId: "session-2", sessionFile: "/sessions/two.jsonl" };
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot: newSnapshot });
    expect(store.session?.sessionId).toBe("session-2");
    expect(store.parts).toEqual([]);
    root[Symbol.dispose]();
  });

  it("refuses a non-empty snapshot for a newly created session", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.startNewSession();
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "workspace-inspected", operationId: inspectId, path: "/project", trustRequired: false });
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: openId,
      snapshot: { ...snapshot, sessionId: "contaminated", parts: [{ id: "foreign-tool", kind: "tool", name: "read", input: "", state: "success" }] }
    });

    expect(store.session).toBeUndefined();
    expect(store.parts).toEqual([]);
    expect(store.error).toContain("refused to mount history");
    root[Symbol.dispose]();
  });

  it("keeps drafts per session and filters archived/search results from Cake metadata", async () => {
    const desktop = createDesktopClient();
    const applicationState = {
      schemaVersion: 1 as const,
      projects: [{ path: "/project", name: "Project", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: ["session-2"] }]
    };
    desktop.client.loadApplicationState = vi.fn(async () => applicationState);
    desktop.client.registerProject = vi.fn(async () => applicationState);
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    const draftsBySession = store.draftsBySession;
    const sessions = [
      { id: "session-1", title: "Alpha task", created: new Date(0).toISOString(), modified: new Date(0).toISOString(), messageCount: 1, archived: false },
      { id: "session-2", title: "Beta task", created: new Date(0).toISOString(), modified: new Date(0).toISOString(), messageCount: 2, archived: false }
    ];
    await openSnapshot(store, desktop, { ...snapshot, sessions });
    store.setDraft("alpha draft");
    await store.openSession("session-2");
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "workspace-inspected", operationId: inspectId, path: "/project", trustRequired: false });
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot: { ...snapshot, sessionId: "session-2", sessions } });
    store.setDraft("beta draft");
    expect(store.draftsBySession).toBe(draftsBySession);
    expect(store.draftsBySession["session-1"]).toBe("alpha draft");
    store.toggleArchived();
    expect(store.currentSessions.map((item) => item.id)).toEqual(["session-2"]);
    store.setSessionSearch("alpha");
    expect(store.currentSessions).toEqual([]);
    root[Symbol.dispose]();
  });

  it("opens tree and changes as local slash-command panes", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, { ...snapshot, tree: [{ id: "entry-1", type: "message", preview: "Hello", active: true, children: [] }] });
    await store.renameCurrentSession("Renamed");
    await store.forkAt("entry-1");
    desktop.emit({ type: "session-snapshot-received", operationId: store.activeOperations.at(-1), snapshot: { ...snapshot, sessionId: "forked" } });
    store.setDraft("/changes");
    await store.submit();
    const changesId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "changes-received", operationId: changesId, workspacePath: "/project", files: [{ path: "README.md", status: " M", staged: false, additions: 1, deletions: 0, diff: "+hello" }] });
    expect(store.commandPane).toBe("changes");
    store.setDraft("/tree");
    await store.submit();

    expect(desktop.client.renameSession).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/project", sessionId: "session-1", name: "Renamed" }));
    expect(desktop.client.forkSession).toHaveBeenCalledWith(expect.objectContaining({ entryId: "entry-1" }));
    expect(store.changedFiles[0]?.path).toBe("README.md");
    expect(store.commandPane).toBe("tree");
    expect(store.draft).toBe("");
    expect(desktop.client.submit).not.toHaveBeenCalled();
    root[Symbol.dispose]();
  });
});
