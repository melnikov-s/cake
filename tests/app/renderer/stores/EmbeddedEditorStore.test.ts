import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopClientEvent } from "../../../../src/renderer/desktop-client";
import { EmbeddedEditorStore } from "../../../../src/renderer/stores/EmbeddedEditorStore";
function createHarness() {
  const client = {
    getEmbeddedEditorState: vi.fn(async () => ({ status: "missing" as const })),
    installEmbeddedEditor: vi.fn(async () => undefined),
    setVscodeServerPath: vi.fn(async () => ({
      schemaVersion: 1 as const,
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    })),
    openEmbeddedEditor: vi.fn(async () => undefined),
    updateEmbeddedEditorBounds: vi.fn(async () => undefined),
    revealInEmbeddedEditor: vi.fn(async () => undefined),
  };
  const store = mount(
    createStore(EmbeddedEditorStore, {
      client,
      projectPath: () => "/tmp/project",
      schedulePersistence: vi.fn(),
    }),
  );
  return { client, store };
}

function stateEvent(status: "missing" | "downloading" | "starting" | "ready" | "failed") {
  return {
    type: "embedded-editor-state-received",
    status,
  } as Extract<DesktopClientEvent, { type: "embedded-editor-state-received" }>;
}

describe("EmbeddedEditorStore", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to the built-in reader and persists mode changes", () => {
    const { store } = createHarness();
    const persistence = vi.fn();
    store.props.schedulePersistence = persistence;

    expect(store.mode).toBe("builtin");
    store.setMode("vscode");

    expect(store.mode).toBe("vscode");
    expect(persistence).toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  it("opens the editor when switching to VS Code mode and hides it on builtin", async () => {
    const { client, store } = createHarness();

    await store.setMode("vscode");
    await vi.waitFor(() => expect(client.openEmbeddedEditor).toHaveBeenCalledWith("/tmp/project"));

    await store.setMode("builtin");
    await vi.waitFor(() =>
      expect(client.updateEmbeddedEditorBounds).toHaveBeenCalledWith({
        visible: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }),
    );
    store[Symbol.dispose]();
  });

  it("tracks companion activity only for the active project", () => {
    const { store } = createHarness();

    store.receive({
      type: "embedded-editor-activity",
      workspacePath: "/tmp/project",
      path: "src/app.ts",
    });
    store.receive({
      type: "embedded-editor-activity",
      workspacePath: "/tmp/other",
      path: "elsewhere.ts",
    });
    store.receive(stateEvent("ready"));

    expect(store.lastActivePath).toBe("src/app.ts");
    expect(store.status).toBe("ready");
    store[Symbol.dispose]();
  });

  it("reveals through the client only in VS Code mode", async () => {
    const { client, store } = createHarness();

    await store.reveal("src/app.ts", 3);
    expect(client.revealInEmbeddedEditor).not.toHaveBeenCalled();

    store.setMode("vscode");
    await vi.waitFor(() => expect(client.openEmbeddedEditor).toHaveBeenCalled());
    await store.reveal("src/app.ts", 3);

    expect(client.revealInEmbeddedEditor).toHaveBeenCalledWith("/tmp/project", "src/app.ts", 3);
    store[Symbol.dispose]();
  });

  it("reports null bounds as a hidden view and swallows stale bound failures", async () => {
    const { client, store } = createHarness();
    client.updateEmbeddedEditorBounds.mockRejectedValueOnce(new Error("stale"));

    await store.reportBounds(null);

    expect(client.updateEmbeddedEditorBounds).toHaveBeenCalledWith({
      visible: false,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    expect(store.error).toBeUndefined();
    store[Symbol.dispose]();
  });
});
