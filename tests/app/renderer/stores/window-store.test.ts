import { describe, expect, it, vi } from "vitest";
import type { SessionPreview, SessionSnapshot } from "../../../../src/ipc/session-contract";
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
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [], widgets: [] },
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
    listSessions: vi.fn(async () => []),
    loadSession: vi.fn(async () => undefined),
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
    respondToArtifact: vi.fn(async () => undefined),
    exportArtifacts: vi.fn(async () => ""),
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
    expect(store.pendingTrustPath).toBeUndefined();
    expect(desktop.client.openWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/project", trusted: true, newSession: true }));
    root[Symbol.dispose]();
  });

  it("cancels a pending artifact request before replacing the active session", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush(); await openSnapshot(store, desktop);
    const operationId = crypto.randomUUID(); store.activeOperations.push(operationId);
    const record = { artifact: { protocol: "cake.artifact/v1" as const, id: "form", sessionId: "session-1", revision: 1, kind: "form" as const, payload: { fields: [{ id: "answer", label: "Answer", type: "text" as const, required: true }], submitLabel: "Send" }, fallback: { markdown: "Answer" }, interaction: { mode: "request" as const } }, workspacePath: "/project", digest: "a".repeat(64), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    desktop.emit({ type: "artifact-requested", operationId, artifactRequestId: crypto.randomUUID(), record });
    expect(store.artifactRequest).toBeDefined();
    await store.startNewSession();
    expect(desktop.client.respondToArtifact).toHaveBeenCalledWith(expect.objectContaining({ operationId, cancelled: true }));
    expect(store.artifactRequest).toBeUndefined();
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

  it("projects extension UI only for the active session and clears it on replacement", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, { ...snapshot, extensionUi: { title: "Initial", statuses: [{ key: "one", text: "ready" }], widgets: [] } });
    desktop.emit({ type: "extension-ui-received", sessionId: "stale", event: { kind: "editor-text", text: "stale", mode: "replace" } });
    desktop.emit({ type: "extension-ui-received", sessionId: "session-1", event: { kind: "widget", key: "legacy", lines: ["line"], placement: "aboveEditor" } });
    desktop.emit({ type: "extension-ui-received", sessionId: "session-1", event: { kind: "notify", id: "notice-1", message: "Hello", tone: "info" } });

    expect(store.draft).not.toBe("stale");
    expect(store.extensionTitle).toBe("Initial");
    expect(store.extensionWidgets).toEqual([{ key: "legacy", lines: ["line"], placement: "aboveEditor" }]);
    expect(store.extensionNotifications).toHaveLength(1);

    await store.startNewSession();
    expect(store.extensionTitle).toBeUndefined();
    expect(store.extensionWidgets).toEqual([]);
    expect(store.extensionNotifications).toEqual([]);
    root[Symbol.dispose]();
  });

  it("preserves the draft when an empty Pi runtime reopens with a replacement session id", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    store.setDraft("keep this draft");
    desktop.emit({ type: "pi-state-changed", state: "stopped", workspacePath: "/project" });
    desktop.emit({ type: "pi-state-changed", state: "ready", workspacePath: "/project" });
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "workspace-inspected", operationId: inspectId, path: "/project", trustRequired: false });
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot: { ...snapshot, sessionId: "replacement" } });
    expect(store.draft).toBe("keep this draft");
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

  it("retains the previous transcript and rejects late snapshots while opening a new session", async () => {
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
    const openId = store.activeOperations.at(-1)!;
    expect(store.session?.sessionId).toBe("session-1");
    expect(store.parts.map((part) => part.id)).toEqual(["old-tool"]);

    desktop.emit({ type: "session-snapshot-received", snapshot: oldSnapshot });
    desktop.emit({ type: "session-snapshot-received", operationId: crypto.randomUUID(), snapshot: oldSnapshot });
    expect(store.parts.map((part) => part.id)).toEqual(["old-tool"]);

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
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: openId,
      snapshot: { ...snapshot, sessionId: "contaminated", parts: [{ id: "foreign-tool", kind: "tool", name: "read", input: "", state: "success" }] }
    });

    expect(store.session?.sessionId).toBe("session-1");
    expect(store.parts).toEqual([]);
    expect(store.error).toContain("refused to mount history");
    root[Symbol.dispose]();
  });

  it("keeps drafts per session and searches sessions across projects", async () => {
    const desktop = createDesktopClient();
    const applicationState = {
      schemaVersion: 1 as const,
      projects: [
        { path: "/project", name: "Project", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: ["session-2"] },
        { path: "/other", name: "Other", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: [] }
      ]
    };
    desktop.client.loadApplicationState = vi.fn(async () => applicationState);
    desktop.client.listSessions = vi.fn(async () => [
      { id: "session-3", title: "Alpha elsewhere", created: new Date(0).toISOString(), modified: new Date(0).toISOString(), messageCount: 3, archived: false, workspacePath: "/other", workspaceName: "Other" }
    ]);
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
    await store.openSession("/project", "session-2");
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot: { ...snapshot, sessionId: "session-2", sessions } });
    store.setDraft("beta draft");
    expect(store.draftsBySession).toBe(draftsBySession);
    expect(store.draftsBySession["session-1"]).toBe("alpha draft");
    expect(store.currentSessions.map((item) => item.id)).toEqual(["session-1", "session-2"]);
    store.setSessionSearch("alpha");
    expect(store.searchedSessions.map((item) => `${item.workspacePath}:${item.id}`).sort()).toEqual(["/other:session-3", "/project:session-1"]);
    await store.openSession("/project", "session-1");
    expect(store.session?.sessionId).toBe("session-1");
    expect(store.draft).toBe("alpha draft");
    await store.openSession("/other", "session-3");
    expect(desktop.client.inspectWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/other" }));
    root[Symbol.dispose]();
  });

  it("keeps project order stable when selecting a project", async () => {
    const desktop = createDesktopClient();
    const projects = ["/first", "/second", "/third"].map((path) => ({
      path,
      name: path.slice(1),
      addedAt: new Date(0).toISOString(),
      lastOpenedAt: new Date(0).toISOString(),
      archivedSessionIds: []
    }));
    const applicationState = { schemaVersion: 1 as const, projects };
    desktop.client.loadApplicationState = vi.fn(async () => applicationState);
    desktop.client.loadWindowState = vi.fn(async () => ({
      projectPath: "/first",
      recentProjectPaths: projects.map((project) => project.path),
      trustedProjectPaths: [],
      draft: "",
      theme: "system" as const,
      thinkingExpanded: false,
      sessionSearch: "",
      draftsBySession: {}
    }));
    desktop.client.registerProject = vi.fn(async () => applicationState);
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    await store.switchProject("/third");
    const inspectId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "workspace-inspected", operationId: inspectId, path: "/third", trustRequired: false });
    const openId = store.activeOperations.at(-1)!;
    desktop.emit({
      type: "session-snapshot-received",
      operationId: openId,
      snapshot: { ...snapshot, workspacePath: "/third", sessionId: "session-3", sessionFile: "/sessions/three.jsonl" }
    });
    await flush();

    expect(store.projectPath).toBe("/third");
    expect(store.recentProjectPaths).toEqual(["/first", "/second", "/third"]);
    root[Symbol.dispose]();
  });

  it("keeps inactive session models live and switches back before Pi responds", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, { ...snapshot, parts: [{ id: "one", kind: "text", role: "assistant", text: "One", status: "complete" }] });

    await store.openSession("/project", "session-2");
    const secondOpenId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "session-snapshot-received", operationId: secondOpenId, snapshot: { ...snapshot, sessionId: "session-2", sessionFile: "/sessions/two.jsonl", parts: [{ id: "two", kind: "text", role: "assistant", text: "Two", status: "complete" }] } });
    desktop.emit({ type: "part-updated", sessionId: "session-1", part: { id: "late-one", kind: "text", role: "assistant", text: "Still live", status: "complete" } });

    await store.openSession("/project", "session-1");

    expect(store.session?.sessionId).toBe("session-1");
    expect(store.parts.map((part) => part.id)).toEqual(["one", "late-one"]);
    expect(desktop.client.inspectWorkspace).toHaveBeenCalledTimes(1);
    expect(desktop.client.openWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "session-1" }));
    root[Symbol.dispose]();
  });

  it("shows a fast persisted preview while an uncached Pi runtime activates", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);
    desktop.client.loadSession = vi.fn(async () => ({
      workspacePath: "/project",
      sessionId: "session-2",
      sessionFile: "/sessions/two.jsonl",
      parts: [{ id: "preview", kind: "text", role: "assistant", text: "From disk", status: "complete" }]
    } satisfies SessionPreview));

    await store.openSession("/project", "session-2");
    await flush();

    expect(store.session?.sessionId).toBe("session-2");
    expect(store.parts.map((part) => part.id)).toEqual(["preview"]);
    store.setDraft("not ready yet");
    expect(store.canSubmit).toBe(false);

    const openId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot: { ...snapshot, sessionId: "session-2", sessionFile: "/sessions/two.jsonl", parts: [{ id: "authoritative", kind: "text", role: "assistant", text: "Ready", status: "complete" }] } });
    expect(store.parts.map((part) => part.id)).toEqual(["authoritative"]);
    expect(store.canSubmit).toBe(true);
    root[Symbol.dispose]();
  });

  it("reveals project sessions in batches without selecting the project", async () => {
    const desktop = createDesktopClient();
    desktop.client.listSessions = vi.fn(async () => Array.from({ length: 12 }, (_, index) => ({
      id: `other-${index}`,
      title: `Other task ${index}`,
      created: new Date(0).toISOString(),
      modified: new Date(index).toISOString(),
      messageCount: index,
      archived: false,
      workspacePath: "/other",
      workspaceName: "Other"
    })));
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    expect(store.projectPath).toBeUndefined();
    expect(store.projectSessions("/other")).toHaveLength(12);
    expect(store.projectSessions("/other").slice(0, store.sessionLimit("/other"))).toHaveLength(10);
    store.showMoreSessions("/other");
    expect(store.projectSessions("/other").slice(0, store.sessionLimit("/other"))).toHaveLength(12);
    expect(store.projectPath).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("forwards slash commands to Pi instead of intercepting Cake-only commands", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop, { ...snapshot, tree: [{ id: "entry-1", type: "message", preview: "Hello", active: true, children: [] }] });
    store.setDraft("/skill:review");
    await store.submit();

    expect(desktop.client.submit).toHaveBeenCalledWith(expect.objectContaining({ text: "/skill:review", delivery: "prompt" }));
    expect(store.commandPane).toBeUndefined();
    expect(store.draft).toBe("");
    root[Symbol.dispose]();
  });
});
