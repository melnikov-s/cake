import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { mountWindowStore } from "./window-store";

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
  sessions: []
};

function createDesktopClient(restoredPath?: string) {
  let listener: ((event: DesktopClientEvent) => void) | undefined;
  const client: DesktopClient = {
    chooseProject: vi.fn(async () => "/project"),
    getHomeDirectory: vi.fn(async () => "/home/user"),
    chooseAttachments: vi.fn(async () => []),
    loadWindowState: vi.fn(async () => ({ projectPath: restoredPath, recentProjectPaths: restoredPath ? [restoredPath] : [], trustedProjectPaths: [], draft: "saved", theme: "system" as const, thinkingExpanded: false })),
    saveWindowState: vi.fn(async () => undefined),
    inspectWorkspace: vi.fn(async () => undefined),
    openWorkspace: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    respondToUi: vi.fn(async () => undefined),
    subscribe(next) { listener = next; return vi.fn(); }
  };
  return { client, emit: (event: DesktopClientEvent) => listener?.(event) };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function openSnapshot(store: ReturnType<typeof mountWindowStore>, desktop: ReturnType<typeof createDesktopClient>, nextSnapshot = snapshot) {
  await store.chooseProject();
  const inspectId = store.activeOperations.at(-1)!;
  desktop.emit({ type: "workspace-inspected", operationId: inspectId, path: nextSnapshot.workspacePath, trustRequired: false });
  const openId = store.activeOperations.at(-1)!;
  desktop.emit({ type: "session-snapshot-received", operationId: openId, snapshot: nextSnapshot });
}

describe("WindowStore", () => {
  it("hydrates before persistence and reopens the persisted project", async () => {
    const desktop = createDesktopClient("/project");
    const store = mountWindowStore(desktop.client);
    await flush();

    expect(store.hydrated).toBe(true);
    expect(store.draft).toBe("saved");
    expect(desktop.client.inspectWorkspace).toHaveBeenCalledWith(expect.objectContaining({ path: "/project" }));
    expect(desktop.client.saveWindowState).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  it("gates project resources on trust and applies the authoritative snapshot", async () => {
    const desktop = createDesktopClient();
    const store = mountWindowStore(desktop.client);
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
    store[Symbol.dispose]();
  });

  it("routes transcript deltas and correlated UI responses", async () => {
    const desktop = createDesktopClient();
    const store = mountWindowStore(desktop.client);
    await flush();
    await openSnapshot(store, desktop);
    desktop.emit({ type: "part-updated", sessionId: "stale", part: { id: "stale", kind: "text", role: "assistant", text: "ignored", status: "complete" } });
    desktop.emit({ type: "part-updated", sessionId: "session-1", part: { id: "live", kind: "text", role: "assistant", text: "hello", status: "streaming" } });
    const operationId = crypto.randomUUID();
    const uiRequestId = crypto.randomUUID();
    desktop.emit({ type: "ui-requested", operationId, uiRequestId, kind: "confirm", title: "Continue?", message: "Confirm" });
    await store.respondToUi("true");

    expect(store.parts.map((part) => part.id)).toEqual(["live"]);
    expect(desktop.client.respondToUi).toHaveBeenCalledWith({ operationId, uiRequestId, value: "true", cancelled: false });
    store[Symbol.dispose]();
  });

  it("queues by default during a run and only steers when explicitly requested", async () => {
    const desktop = createDesktopClient();
    const store = mountWindowStore(desktop.client);
    await flush();
    desktop.emit({ type: "agent-state-changed", state: "ready" });
    await openSnapshot(store, desktop, { ...snapshot, streaming: true });

    store.setDraft("Do this next");
    await store.submit();
    expect(desktop.client.submit).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Do this next", delivery: "follow-up" }));

    store.setDraft("Change direction");
    await store.submit("steer");
    expect(desktop.client.submit).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Change direction", delivery: "steer" }));
    store[Symbol.dispose]();
  });

  it("clears the previous transcript and rejects late snapshots while opening a new session", async () => {
    const desktop = createDesktopClient();
    const store = mountWindowStore(desktop.client);
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
    store[Symbol.dispose]();
  });

  it("refuses a non-empty snapshot for a newly created session", async () => {
    const desktop = createDesktopClient();
    const store = mountWindowStore(desktop.client);
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
    store[Symbol.dispose]();
  });
});
