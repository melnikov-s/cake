import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorAnnotationSnapshot } from "../../../../src/ipc/editor-annotation";
import type { DesktopClientEvent } from "../../../../src/renderer/desktop-client";
import { EmbeddedEditorStore } from "../../../../src/renderer/stores/EmbeddedEditorStore";
function createHarness(annotations?: EditorAnnotationSnapshot) {
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
    openEmbeddedEditorSourceControl: vi.fn(async () => undefined),
    updateEmbeddedEditorAnnotations: vi.fn(async () => undefined),
  };
  const startCakeChat = vi.fn(async (prompt: string) => {
    void prompt;
  });
  const store = mount(
    createStore(EmbeddedEditorStore, {
      client,
      projectPath: () => "/tmp/project",
      annotations: () => annotations,
      startCakeChat,
    }),
  );
  return { client, store, startCakeChat };
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

  it("shows and hides the IDE while retaining the running editor", async () => {
    const { client, store } = createHarness();

    await store.show();
    expect(store.visible).toBe(true);
    expect(store.chatSidebarVisible).toBe(true);
    expect(client.getEmbeddedEditorState).toHaveBeenCalledOnce();
    expect(client.openEmbeddedEditor).toHaveBeenCalledWith("/tmp/project");

    store.toggleChatSidebar();
    expect(store.visible).toBe(true);
    expect(store.chatSidebarVisible).toBe(false);
    store.toggleChatSidebar();
    expect(store.chatSidebarVisible).toBe(true);

    store.hide();
    expect(store.visible).toBe(false);
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

  it("adopts an agent-opened editor without opening it again", async () => {
    const { client, store } = createHarness();

    store.showAgentLocation();

    expect(store.visible).toBe(true);
    expect(client.getEmbeddedEditorState).toHaveBeenCalledOnce();
    expect(client.openEmbeddedEditor).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  it("tracks companion activity only for the active project", () => {
    const { store } = createHarness();

    store.receive({
      type: "embedded-editor-activity",
      workspacePath: "/tmp/project",
      path: "src/app.ts",
      documentVersion: 4,
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 5,
      selectedText: "test",
      contextBefore: "before",
      contextAfter: "after",
    });
    store.receive({
      type: "embedded-editor-activity",
      workspacePath: "/tmp/other",
      path: "elsewhere.ts",
      documentVersion: 1,
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 0,
      selectedText: "",
      contextBefore: "",
      contextAfter: "",
    });
    store.receive(stateEvent("ready"));

    expect(store.lastActivePath).toBe("src/app.ts");
    expect(store.activeContextAttachment).toMatchObject({
      location: { path: "src/app.ts", documentVersion: 4 },
      selectedText: "test",
    });
    expect(store.status).toBe("ready");

    store.receive({
      type: "embedded-editor-context-cleared",
      workspacePath: "/tmp/project",
    });
    expect(store.lastActivePath).toBeUndefined();
    expect(store.activeContextAttachment).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("reveals through the client only while the IDE is visible", async () => {
    const { client, store } = createHarness();

    await store.reveal({ path: "src/app.ts", range: { start: { line: 3 } } });
    expect(client.revealInEmbeddedEditor).not.toHaveBeenCalled();

    const location = { path: "src/app.ts", range: { start: { line: 3 } } };
    await store.show(location);

    expect(client.revealInEmbeddedEditor).toHaveBeenCalledWith("/tmp/project", location);
    store[Symbol.dispose]();
  });

  it("syncs active-session discussion annotations after opening the IDE", async () => {
    const snapshot: EditorAnnotationSnapshot = {
      sessionId: "session-a",
      annotations: [
        {
          id: "thread-a",
          location: {
            path: "src/app.ts",
            range: { start: { line: 3 }, end: { line: 5 } },
          },
          status: "answered",
          replyCount: 1,
          preview: "Why is this needed?",
        },
      ],
    };
    const { client, store } = createHarness(snapshot);

    await store.show();

    expect(client.updateEmbeddedEditorAnnotations).toHaveBeenCalledWith("/tmp/project", snapshot);
    store[Symbol.dispose]();
  });

  it("asks Cake Chat to set up a VS Code server with platform and project context", async () => {
    const { store, startCakeChat } = createHarness();

    await store.askCakeToSetUp();

    expect(startCakeChat).toHaveBeenCalledTimes(1);
    const prompt = startCakeChat.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("Platform: ");
    expect(prompt).toContain("Project: /tmp/project");
    expect(store.error).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("reports ask-Cake failures on the embedded editor card", async () => {
    const { store, startCakeChat } = createHarness();
    startCakeChat.mockRejectedValueOnce(new Error("no chat"));

    await store.askCakeToSetUp();

    expect(store.error).toContain("no chat");
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
