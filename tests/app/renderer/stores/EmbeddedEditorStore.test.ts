import { createStore } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorAnnotationSnapshot } from "../../../../src/ipc/editor-annotation";
import { EmbeddedEditorStore } from "../../../../src/renderer/stores/EmbeddedEditorStore";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { mountWithRendererClient } from "../mount-with-renderer-client";
function createHarness(annotations?: EditorAnnotationSnapshot) {
  const client = {
    getState: vi.fn(async () => ({ status: "missing" as const })),
    install: vi.fn(async () => undefined),
    setServerPath: vi.fn(async () => ({
      projects: [],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    })),
    open: vi.fn(async () => undefined),
    updateBounds: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    openSourceControl: vi.fn(async () => undefined),
    updateAnnotations: vi.fn(async () => undefined),
  };
  const startCakeChat = vi.fn(async (prompt: string) => {
    void prompt;
  });
  const { root, subject: store } = mountWithRendererClient(
    createStore(EmbeddedEditorStore, {
      projectPath: () => "/tmp/project",
      annotations: () => annotations,
      startCakeChat,
    }),
    { vscode: client } as unknown as RendererClient,
  );
  return { client, root, store, startCakeChat };
}

function stateEvent(status: "missing" | "downloading" | "starting" | "ready" | "failed") {
  return { status };
}

describe("EmbeddedEditorStore", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows and hides the IDE while retaining the running editor", async () => {
    const { client, root, store } = createHarness();

    await store.show();
    expect(store.visible).toBe(true);
    expect(store.chatSidebarVisible).toBe(true);
    expect(client.getState).toHaveBeenCalledOnce();
    expect(client.open).toHaveBeenCalledWith("/tmp/project", expect.any(Object));

    store.toggleChatSidebar();
    expect(store.visible).toBe(true);
    expect(store.chatSidebarVisible).toBe(false);
    store.toggleChatSidebar();
    expect(store.chatSidebarVisible).toBe(true);

    store.hide();
    expect(store.visible).toBe(false);
    await vi.waitFor(() =>
      expect(client.updateBounds).toHaveBeenCalledWith(
        {
          visible: false,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
        expect.any(Object),
      ),
    );
    root[Symbol.dispose]();
  });

  it("adopts an agent-opened editor without opening it again", async () => {
    const { client, root, store } = createHarness();

    store.showAgentLocation();

    expect(store.visible).toBe(true);
    expect(client.getState).toHaveBeenCalledOnce();
    expect(client.open).not.toHaveBeenCalled();
    root[Symbol.dispose]();
  });

  it("tracks companion activity only for the active project", () => {
    const { root, store } = createHarness();

    store.receive({
      type: "embedded-editor-selection",
      workspacePath: "/tmp/project",
      path: "src/app.ts",
      startLine: 2,
      endLine: 2,
    });
    store.receive({
      type: "embedded-editor-selection",
      workspacePath: "/tmp/other",
      path: "elsewhere.ts",
      startLine: 0,
      endLine: 0,
    });
    store.applyState(stateEvent("ready"));

    expect(store.lastActivePath).toBe("src/app.ts");
    expect(store.activeContextAttachment).toEqual({
      kind: "source",
      name: "src/app.ts",
      location: {
        path: "src/app.ts",
        range: { start: { line: 2 }, end: { line: 2 } },
      },
    });
    expect(store.status).toBe("ready");

    store.receive({
      type: "embedded-editor-selection-cleared",
      workspacePath: "/tmp/project",
    });
    expect(store.lastActivePath).toBeUndefined();
    expect(store.activeContextAttachment).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("reveals through the client only while the IDE is visible", async () => {
    const { client, root, store } = createHarness();

    await store.reveal({ path: "src/app.ts", range: { start: { line: 3 } } });
    expect(client.reveal).not.toHaveBeenCalled();

    const location = { path: "src/app.ts", range: { start: { line: 3 } } };
    await store.show(location);

    expect(client.reveal).toHaveBeenCalledWith("/tmp/project", location, expect.any(Object));
    root[Symbol.dispose]();
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
    const { client, root, store } = createHarness(snapshot);

    await store.show();

    expect(client.updateAnnotations).toHaveBeenCalledWith(
      "/tmp/project",
      snapshot,
      expect.any(Object),
    );
    root[Symbol.dispose]();
  });

  it("asks Cake Chat to set up a VS Code server with platform and project context", async () => {
    const { root, store, startCakeChat } = createHarness();

    await store.askCakeToSetUp();

    expect(startCakeChat).toHaveBeenCalledTimes(1);
    const prompt = startCakeChat.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("Platform: ");
    expect(prompt).toContain("Project: /tmp/project");
    expect(store.error).toBeUndefined();
    root[Symbol.dispose]();
  });

  it("reports ask-Cake failures on the embedded editor card", async () => {
    const { root, store, startCakeChat } = createHarness();
    startCakeChat.mockRejectedValueOnce(new Error("no chat"));

    await store.askCakeToSetUp();

    expect(store.error).toContain("no chat");
    root[Symbol.dispose]();
  });

  it("reports null bounds as a hidden view and swallows stale bound failures", async () => {
    const { client, root, store } = createHarness();
    client.updateBounds.mockRejectedValueOnce(new Error("stale"));

    await store.reportBounds(null);

    expect(client.updateBounds).toHaveBeenCalledWith(
      {
        visible: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      },
      expect.any(Object),
    );
    expect(store.error).toBeUndefined();
    root[Symbol.dispose]();
  });
});
