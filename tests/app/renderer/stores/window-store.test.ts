import { describe, expect, it, vi } from "vitest";
import { reaction } from "r-state-tree";
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
    suggestFiles: vi.fn(async () => []),
    readWorkspaceFile: vi.fn(async () => ""),
    loadWindowState: vi.fn(async () => ({ projectPath: restoredPath, recentProjectPaths: restoredPath ? [restoredPath] : [], draft: "saved", theme: "system" as const, thinkingExpanded: false, sessionSearch: "", draftsBySession: {} })),
    saveWindowState: vi.fn(async () => undefined),
    loadApplicationState: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [], trustedProjectPaths: [] })),
    listSessions: vi.fn(async () => ({ sessions: [], reviewThreads: [] })),
    loadSession: vi.fn(async () => undefined),
    listReviewThreads: vi.fn(async () => []),
    createReviewThread: vi.fn(async () => { throw new Error("not mocked"); }),
    replyReviewThread: vi.fn(async () => { throw new Error("not mocked"); }),
    resolveReviewThread: vi.fn(async () => { throw new Error("not mocked"); }),
    submitReviewThreads: vi.fn(async () => undefined),
    registerProject: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [], trustedProjectPaths: [] })),
    renameProject: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [], trustedProjectPaths: [] })),
    removeProject: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [], trustedProjectPaths: [] })),
    archiveSession: vi.fn(async () => ({ schemaVersion: 1 as const, projects: [], trustedProjectPaths: [] })),
    createWindow: vi.fn(async () => undefined),
    restartPi: vi.fn(async () => undefined),
    inspectWorkspace: vi.fn(async () => undefined),
    respondToWorkspaceTrust: vi.fn(async () => undefined),
    openWorkspace: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    setPiSetting: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => undefined),
    navigateSession: vi.fn(async () => undefined),
    refreshSession: vi.fn(async () => undefined),
    inspectChanges: vi.fn(async () => undefined),
    getChangelog: vi.fn(async () => undefined),
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
  it("inserts files chosen from the attachment browser as visible path mentions", async () => {
    const desktop = createDesktopClient();
    vi.mocked(desktop.client.chooseAttachments).mockResolvedValue([
      { kind: "file", name: "foo", path: "/tmp/foo" },
      { kind: "file", name: "notes.txt", path: "/tmp/my notes.txt" },
      { kind: "image", name: "preview.png", mimeType: "image/png", data: "aW1hZ2U=" }
    ]);
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    store.setDraft("Review");

    await store.addAttachments();

    expect(store.draft).toBe('Review @/tmp/foo @"/tmp/my notes.txt"');
    expect(store.attachments).toEqual([
      { kind: "image", name: "preview.png", mimeType: "image/png", data: "aW1hZ2U=" }
    ]);
    root[Symbol.dispose]();
  });

  it("offers only authenticated models while retaining all providers in settings", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, {
      ...snapshot,
      models: [
        { provider: "openai", providerName: "OpenAI", id: "gpt", name: "GPT", reasoning: true, input: ["text"], authenticated: true, authTypes: ["api_key"] },
        { provider: "anthropic", providerName: "Anthropic", id: "claude", name: "Claude", reasoning: true, input: ["text"], authenticated: false, authTypes: ["api_key", "oauth"] }
      ]
    });

    expect(store.modelsByProvider.map((group) => group.id)).toEqual(["openai", "anthropic"]);
    expect(store.connectedModelsByProvider).toHaveLength(1);
    expect(store.connectedModelsByProvider[0]).toMatchObject({ id: "openai", models: [expect.objectContaining({ id: "gpt" })] });
    root[Symbol.dispose]();
  });

  it("routes Pi-owned settings through the active session", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush(); await openSnapshot(store, desktop);

    await store.setPiSetting({ key: "autoCompact", value: false });
    const operationId = store.activeOperations.at(-1)!;
    expect(desktop.client.setPiSetting).toHaveBeenCalledWith({ operationId, workspacePath: "/project", sessionId: "session-1", update: { key: "autoCompact", value: false } });
    desktop.emit({ type: "operation-completed", operationId });
    expect(store.activeOperations).not.toContain(operationId);
    root[Symbol.dispose]();
  });

  it("tracks provider disconnects and exposes failures for a retry", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush(); await openSnapshot(store, desktop);

    await store.logout("openai-codex");
    const operationId = store.activeOperations.at(-1)!;
    expect(store.providerOperation("openai-codex")).toBe("logout");
    expect(desktop.client.logout).toHaveBeenCalledWith(expect.objectContaining({ operationId, provider: "openai-codex" }));

    desktop.emit({ type: "operation-failed", operationId, message: "Credential store delete failed" });
    expect(store.providerOperation("openai-codex")).toBeUndefined();
    expect(store.error).toBe("Credential store delete failed");

    await store.logout("openai-codex");
    expect(desktop.client.logout).toHaveBeenCalledTimes(2);
    root[Symbol.dispose]();
  });

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
    expect(desktop.client.respondToWorkspaceTrust).toHaveBeenCalledWith({ operationId: inspectId, path: "/project", approved: true });
    expect(desktop.client.openWorkspace).toHaveBeenCalledWith(expect.objectContaining({ path: "/project" }));
    const openId = store.activeOperations[0]!;
    desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot });

    expect(store.session?.sessionFile).toBe("/sessions/one.jsonl");
    await store.startNewSession();
    expect(store.pendingTrustPath).toBeUndefined();
    expect(desktop.client.openWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/project", newSession: true }));
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

  it("combines durable session edits with a newly completed live edit", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, {
      ...snapshot,
      sessionChanges: [{ id: "edit-result-1", toolCallId: "edit-1", path: "src/one.ts", additions: 1, deletions: 1, diff: "-1 old\n+1 new", timestamp: new Date(0).toISOString() }]
    });

    desktop.emit({ type: "part-updated", sessionId: "session-1", part: { id: "tool-edit-2", kind: "tool", name: "edit", input: "", filePath: "src/two.ts", diff: "+2 added", state: "success" } });

    expect(store.sessionChanges).toEqual([
      expect.objectContaining({ toolCallId: "edit-1", path: "src/one.ts" }),
      expect.objectContaining({ toolCallId: "edit-2", path: "src/two.ts", additions: 1, deletions: 0 })
    ]);
    root[Symbol.dispose]();
  });

  it("combines repeated session edits into one change per file", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, {
      ...snapshot,
      sessionChanges: [
        { id: "edit-result-1", toolCallId: "edit-1", toolName: "edit", path: "PLAN.md", additions: 2, deletions: 1, diff: "-1 old\n+1 new\n+2 more", timestamp: new Date(0).toISOString() },
        { id: "edit-result-2", toolCallId: "edit-2", toolName: "edit", path: "PLAN.md", additions: 3, deletions: 2, diff: "-4 before\n-5 before\n+4 after\n+5 after\n+6 added", timestamp: new Date(1).toISOString() }
      ]
    });

    expect(store.sessionChanges).toEqual([
      expect.objectContaining({ id: "file:PLAN.md", path: "PLAN.md", additions: 5, deletions: 3, diff: expect.stringContaining("+6 added") })
    ]);
    await store.openSessionChanges();
    expect(store.selectedSessionChange).toMatchObject({ path: "PLAN.md", additions: 5, deletions: 3 });
    expect(store.commandPane).toBeUndefined();
    store.closeChangeExplorer();
    expect(store.changeExplorerPath).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("opens the fullscreen change explorer and refreshes the authoritative session snapshot", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush(); await openSnapshot(store, desktop, { ...snapshot, sessionChanges: [{ id: "edit-result", toolCallId: "edit-1", path: "PLAN.md", additions: 1, deletions: 0, diff: "+1 plan", timestamp: new Date(0).toISOString() }] });

    await store.openSessionChanges();
    expect(store.changeExplorerPath).toBe("PLAN.md");
    expect(desktop.client.refreshSession).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/project", sessionId: "session-1" }));

    store.closeChangeExplorer();
    expect(store.changeExplorerPath).toBeUndefined();
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

  it("submits pending review threads with an empty composer without adding to the primary prompt", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);
    await flush();
    const now = new Date(0).toISOString();
    desktop.emit({ type: "review-thread-updated", thread: {
      id: "review-1", workspacePath: "/project", sessionId: "session-1", status: "open", createdAt: now, updatedAt: now,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 2 }, end: { diffLine: 1, newLine: 2 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" },
      messages: [{ id: "comment-1", role: "user", body: "Rename this", createdAt: now, delivered: false, status: "complete" }]
    } });
    store.setDraft("");

    expect(store.canSubmit).toBe(true);
    await store.submit();

    expect(desktop.client.submitReviewThreads).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/project", sessionId: "session-1", threadIds: ["review-1"], instruction: undefined }));
    expect(desktop.client.submit).not.toHaveBeenCalled();
    expect(store.pendingReviewThreads).toHaveLength(0);
    expect(store.chatReviewCommentCount).toBe(0);
    expect(store.openReviewThreads).toHaveLength(1);
    expect(store.sessionReviewRuns).toEqual([expect.objectContaining({ commentCount: 1, status: "running" })]);
    const operationId = vi.mocked(desktop.client.submitReviewThreads).mock.calls[0]![0].operationId;
    desktop.emit({ type: "operation-completed", operationId });
    expect(store.sessionReviewRuns).toEqual([expect.objectContaining({ commentCount: 1, status: "complete" })]);
    expect(store.openReviewThreads).toHaveLength(1);
    expect(store.parts).toEqual([]);
    root[Symbol.dispose]();
  });

  it("excludes assistant-ended review threads from the chat comment count", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);
    const now = new Date(0).toISOString();
    desktop.emit({ type: "review-thread-updated", thread: {
      id: "review-1", workspacePath: "/project", sessionId: "session-1", status: "open", createdAt: now, updatedAt: now,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 2 }, end: { diffLine: 1, newLine: 2 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" },
      messages: [
        { id: "comment-1", role: "user", body: "Rename this", createdAt: now, delivered: true, status: "complete" },
        { id: "reply-1", role: "assistant", body: "Renamed it.", createdAt: now, delivered: true, status: "complete" }
      ]
    } });

    expect(store.openReviewThreads).toHaveLength(1);
    expect(store.chatReviewThreads).toHaveLength(0);
    expect(store.chatReviewCommentCount).toBe(0);
    expect(store.chatReviewCommentCountForSession("/project", "session-1")).toBe(0);
    root[Symbol.dispose]();
  });

  it("derives inactive-session and active-chat counts from the same review model", async () => {
    const desktop = createDesktopClient();
    const now = new Date(0).toISOString();
    const thread = {
      id: "review-shared", workspacePath: "/other", sessionId: "session-2", status: "open" as const, createdAt: now, updatedAt: now,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 2 }, end: { diffLine: 1, newLine: 2 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" },
      messages: [{ id: "comment-shared", role: "user" as const, body: "Rename this", createdAt: now, delivered: false, status: "complete" as const }]
    };
    desktop.client.listSessions = vi.fn(async () => ({
      sessions: [{ id: "session-2", title: "Review", created: now, modified: now, messageCount: 1, archived: false, workspacePath: "/other", workspaceName: "Other" }],
      reviewThreads: [thread]
    }));
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    const model = root.sessionCache.find("session-2", "/other")!.reviewThreads[0]!;
    expect(store.chatReviewCommentCountForSession("/other", "session-2")).toBe(1);
    expect("reviewCount" in store.globalSessions[0]!).toBe(false);
    const observedCounts: number[] = [];
    const stop = reaction(() => store.chatReviewCommentCountForSession("/other", "session-2"), (count) => observedCounts.push(count));

    desktop.emit({ type: "review-thread-updated", thread: {
      ...thread,
      messages: [
        { ...thread.messages[0]!, delivered: true },
        { id: "reply-shared", role: "assistant", body: "Renamed it.", createdAt: now, delivered: true, status: "complete" }
      ]
    } });

    expect(root.sessionCache.find("session-2", "/other")!.reviewThreads[0]).toBe(model);
    expect(store.chatReviewCommentCountForSession("/other", "session-2")).toBe(0);
    expect(observedCounts).toEqual([0]);
    stop();
    root[Symbol.dispose]();
  });

  it("sends composer text to the primary conversation while also dispatching pending review comments", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);
    await flush();
    const now = new Date(0).toISOString();
    desktop.emit({ type: "review-thread-updated", thread: {
      id: "review-1", workspacePath: "/project", sessionId: "session-1", status: "open", createdAt: now, updatedAt: now,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 2 }, end: { diffLine: 1, newLine: 2 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" },
      messages: [{ id: "comment-1", role: "user", body: "Rename this", createdAt: now, delivered: false, status: "complete" }]
    } });
    store.setDraft("Also explain the overall change");

    await store.submit();

    expect(desktop.client.submit).toHaveBeenCalledWith(expect.objectContaining({ text: "Also explain the overall change", delivery: "prompt" }));
    expect(desktop.client.submitReviewThreads).toHaveBeenCalledWith(expect.objectContaining({ threadIds: ["review-1"], instruction: "Also explain the overall change" }));
    expect(store.parts).toEqual([expect.objectContaining({ role: "user", text: "Also explain the overall change" })]);
    expect(store.pendingReviewThreads).toHaveLength(0);
    root[Symbol.dispose]();
  });

  it("shows a submitted user message immediately and reconciles it with Pi's canonical part", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);

    store.setDraft("Show this now");
    const submission = store.submit();

    expect(store.parts).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^optimistic-user-/), role: "user", text: "Show this now" })
    ]);
    await submission;

    desktop.emit({ type: "part-updated", sessionId: "session-1", part: { id: "user-canonical", kind: "text", role: "user", text: "Show this now", status: "complete" } });

    expect(store.parts).toEqual([
      { id: "user-canonical", kind: "text", role: "user", text: "Show this now", status: "complete" }
    ]);
    expect(store.pendingUserMessages).toHaveLength(0);
    root[Symbol.dispose]();
  });

  it("keeps streamed reasoning below an optimistic user message", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);

    store.setDraft("Think about this");
    await store.submit();
    desktop.emit({ type: "part-updated", sessionId: "session-1", part: { id: "reasoning-1", kind: "reasoning", text: "Working it out", status: "streaming" } });

    expect(store.parts.map((part) => part.id)).toEqual([
      expect.stringMatching(/^optimistic-user-/),
      "reasoning-1"
    ]);
    root[Symbol.dispose]();
  });

  it("does not restore a submitted draft when a session snapshot arrives", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop);

    store.setDraft("Already sent");
    await store.submit();
    desktop.emit({ type: "session-snapshot-received", snapshot: { ...snapshot, streaming: false } });

    expect(store.draft).toBe("");
    expect(store.draftsBySession["session-1"]).toBe("");
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
      trustedProjectPaths: [],
      projects: [
        { path: "/project", name: "Project", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: ["session-2"] },
        { path: "/other", name: "Other", addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(), archivedSessionIds: [] }
      ]
    };
    desktop.client.loadApplicationState = vi.fn(async () => applicationState);
    desktop.client.listSessions = vi.fn(async () => ({
      sessions: [{ id: "session-3", title: "Alpha elsewhere", created: new Date(0).toISOString(), modified: new Date(0).toISOString(), messageCount: 3, archived: false, workspacePath: "/other", workspaceName: "Other" }],
      reviewThreads: []
    }));
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
    const applicationState = { schemaVersion: 1 as const, projects, trustedProjectPaths: [] };
    desktop.client.loadApplicationState = vi.fn(async () => applicationState);
    desktop.client.loadWindowState = vi.fn(async () => ({
      projectPath: "/first",
      recentProjectPaths: projects.map((project) => project.path),
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

  it("tracks running sessions and marks background completions unread until opened", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);

    await store.openSession("/project", "session-2");
    const secondOpenId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "session-snapshot-received", operationId: secondOpenId, snapshot: { ...snapshot, sessionId: "session-2", sessionFile: "/sessions/two.jsonl" } });

    desktop.emit({ type: "streaming-changed", sessionId: "session-1", streaming: true });
    expect(store.sessionActivity("/project", "session-1")).toBe("running");

    desktop.emit({ type: "streaming-changed", sessionId: "session-1", streaming: false });
    expect(store.sessionActivity("/project", "session-1")).toBe("unread");

    await store.openSession("/project", "session-1");
    expect(store.sessionActivity("/project", "session-1")).toBeUndefined();
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
    desktop.client.listSessions = vi.fn(async () => ({
      sessions: Array.from({ length: 12 }, (_, index) => ({
        id: `other-${index}`,
        title: `Other task ${index}`,
        created: new Date(0).toISOString(),
        modified: new Date(index).toISOString(),
        messageCount: index,
        archived: false,
        workspacePath: "/other",
        workspaceName: "Other"
      })),
      reviewThreads: []
    }));
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

  it("renames the session targeted from the sidebar", async () => {
    const desktop = createDesktopClient();
    desktop.client.listSessions = vi.fn(async () => ({ sessions: [{
      id: "session-2",
      title: "Old title",
      created: new Date(0).toISOString(),
      modified: new Date(0).toISOString(),
      messageCount: 1,
      archived: false,
      workspacePath: "/other",
      workspaceName: "Other"
    }], reviewThreads: [] }));
    const { root, store } = mountTestStore(desktop.client);
    await flush();

    await store.renameSession("/other", "session-2", " New title ");

    expect(desktop.client.renameSession).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/other", sessionId: "session-2", name: "New title" }));
    expect(store.projectSessions("/other")[0]?.title).toBe("New title");
    root[Symbol.dispose]();
  });

  it("opens Cake panes locally and forwards Pi resource commands", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    desktop.emit({ type: "pi-state-changed", state: "ready" });
    await openSnapshot(store, desktop, { ...snapshot, tree: [{ id: "entry-1", type: "message", preview: "Hello", active: true, children: [] }] });
    store.setDraft("/tree");
    await store.submit();

    expect(store.commandPane).toBe("tree");
    expect(desktop.client.submit).not.toHaveBeenCalled();

    store.closeCommandPane();
    store.setDraft("/changelog");
    await store.submit();

    expect(store.commandPane).toBe("changelog");
    expect(desktop.client.getChangelog).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "/project", sessionId: "session-1" }));
    expect(desktop.client.submit).not.toHaveBeenCalled();
    const changelogId = store.activeOperations.at(-1)!;
    desktop.emit({ type: "changelog-received", operationId: changelogId, workspacePath: "/project", sessionId: "session-1", markdown: "# Changelog\n\n## 0.84.0" });
    expect(store.changelogMarkdown).toContain("0.84.0");

    store.closeCommandPane();
    store.setDraft("/skill:review");
    await store.submit();

    expect(desktop.client.submit).toHaveBeenCalledWith(expect.objectContaining({ text: "/skill:review", delivery: "prompt" }));
    expect(store.commandPane).toBeUndefined();
    expect(store.draft).toBe("");
    root[Symbol.dispose]();
  });

  it("restores a selected user message into the composer when navigating the tree", async () => {
    const desktop = createDesktopClient();
    const { root, store } = mountTestStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop, { ...snapshot, tree: [{ id: "user-entry", type: "message", messageRole: "user", editorText: "Original user message\nwith formatting", preview: "Original user message with formatting", active: true, children: [] }] });

    await store.navigateTo("user-entry");

    expect(desktop.client.navigateSession).toHaveBeenCalledWith(expect.objectContaining({ entryId: "user-entry" }));
    expect(store.draft).toBe("Original user message\nwith formatting");
    expect(store.commandPane).toBeUndefined();
    root[Symbol.dispose]();
  });
});
