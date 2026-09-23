import { batch, createStore } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorAnnotationSnapshot } from "../../../../src/ipc/editor-annotation";
import { EmbeddedEditorStore } from "../../../../src/renderer/stores/EmbeddedEditorStore";
import type { Client } from "../../../../src/renderer/client/Client";
import { mountWithClient } from "../mount-with-client";
function createHarness(annotations?: EditorAnnotationSnapshot) {
  let presentationMode: "normal" | "vscode" | "draw" | "browser" = "normal";
  let chatSidebarVisible = true;
  let chatSidebarWidth = 420;
  const client = {
    getState: vi.fn(async () => ({ status: "missing" as const })),
    install: vi.fn(async () => undefined),
    setServerPath: vi.fn(async () => ({
      projects: [],
      unreadSessionIds: [],
      trustedProjectPaths: [],
    })),
    open: vi.fn<(workingDirectory: string, options?: object) => Promise<undefined>>(
      async () => undefined,
    ),
    updateBounds: vi.fn<(input: object, options?: object) => Promise<undefined>>(
      async () => undefined,
    ),
    reveal: vi.fn(async () => ({ outcome: { view: "file" as const }, locations: [] })),
    updateSelectionHighlights: vi.fn(async () => undefined),
    openSourceControl: vi.fn(async () => undefined),
    updateAnnotations: vi.fn(async () => undefined),
  };
  const startCakeChat = vi.fn(async (prompt: string) => {
    void prompt;
  });
  const enterProjectSidebarMode = vi.fn();
  const leaveProjectSidebarMode = vi.fn();
  const { root, subject: store } = mountWithClient(
    createStore(EmbeddedEditorStore, {
      projectPath: () => "/tmp/project",
      presentationMode: () => presentationMode,
      setPresentationMode: (mode) => {
        presentationMode = mode;
      },
      chatSidebarVisible: () => chatSidebarVisible,
      toggleChatSidebar: () => {
        chatSidebarVisible = !chatSidebarVisible;
      },
      showChatSidebar: () => {
        chatSidebarVisible = true;
      },
      chatSidebarWidth: () => chatSidebarWidth,
      setChatSidebarWidth: (width) => {
        chatSidebarWidth = width;
      },
      annotations: () => annotations,
      selectionHighlights: () => ({ locations: [] }),
      startCakeChat,
      enterProjectSidebarMode,
      leaveProjectSidebarMode,
      projectSidebarWidth: () => 292,
    }),
    { vscode: client } as unknown as Client,
  );
  return {
    client,
    root,
    store,
    startCakeChat,
    enterProjectSidebarMode,
    leaveProjectSidebarMode,
  };
}

function stateEvent(status: "missing" | "downloading" | "starting" | "ready" | "failed") {
  return { status };
}

const surfaceRect = { x: 292, y: 0, width: 480, height: 820 };
const shownBounds = { visible: true, ...surfaceRect, projectSidebarWidth: 292 };
const hiddenBounds = { visible: false, ...surfaceRect, projectSidebarWidth: 292 };

describe("EmbeddedEditorStore", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows and hides the IDE while retaining the running editor", async () => {
    const { client, root, store, enterProjectSidebarMode, leaveProjectSidebarMode } =
      createHarness();

    await store.show();
    expect(store.visible).toBe(true);
    expect(enterProjectSidebarMode).toHaveBeenCalledTimes(1);
    expect(store.chatSidebarVisible).toBe(true);
    expect(client.getState).not.toHaveBeenCalled();
    expect(client.open).toHaveBeenCalledWith("/tmp/project", expect.any(Object));

    store.toggleChatSidebar();
    expect(store.visible).toBe(true);
    expect(store.chatSidebarVisible).toBe(false);
    store.toggleChatSidebar();
    expect(store.chatSidebarVisible).toBe(true);

    store.setMeasuredBounds(surfaceRect);
    expect(client.updateBounds).toHaveBeenLastCalledWith(shownBounds, expect.any(Object));

    store.hide();
    expect(store.visible).toBe(false);
    expect(leaveProjectSidebarMode).toHaveBeenCalledTimes(1);
    expect(client.updateBounds).toHaveBeenLastCalledWith(hiddenBounds, expect.any(Object));
    root[Symbol.dispose]();
  });

  it("positions the native view while the workbench is still loading and draws it once open", async () => {
    const { client, root, store } = createHarness();
    let finishOpen!: () => void;
    client.open.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishOpen = () => resolve(undefined);
        }),
    );

    const showing = store.show();
    store.setMeasuredBounds(surfaceRect);

    expect(store.nativeViewReady).toBe(false);
    expect(client.updateBounds).toHaveBeenLastCalledWith(hiddenBounds, expect.any(Object));

    finishOpen();
    await showing;

    expect(store.nativeViewReady).toBe(true);
    expect(client.updateBounds).toHaveBeenLastCalledWith(shownBounds, expect.any(Object));

    store.setMeasuredBounds(undefined);
    expect(client.updateBounds).toHaveBeenLastCalledWith(
      { visible: false, x: 0, y: 0, width: 0, height: 0, projectSidebarWidth: 292 },
      expect.any(Object),
    );
    root[Symbol.dispose]();
  });

  it("keeps the native view visible when a session switch suspends and restores in one action", async () => {
    const { client, root, store } = createHarness();
    await store.show();
    store.setMeasuredBounds(surfaceRect);
    expect(client.updateBounds).toHaveBeenLastCalledWith(shownBounds, expect.any(Object));
    client.updateBounds.mockClear();

    let restored!: Promise<void>;
    batch(() => {
      store.suspend();
      restored = store.restore();
    });
    await restored;

    expect(store.visible).toBe(true);
    expect(store.nativeViewReady).toBe(true);
    const lastBounds = client.updateBounds.mock.calls.at(-1)?.[0];
    if (lastBounds) expect(lastBounds).toEqual(shownBounds);

    client.updateBounds.mockClear();
    store.suspend();
    expect(client.updateBounds).toHaveBeenLastCalledWith(hiddenBounds, expect.any(Object));
    await store.restore();
    expect(client.updateBounds).toHaveBeenLastCalledWith(shownBounds, expect.any(Object));
    root[Symbol.dispose]();
  });

  it("shares one in-flight open between a user request and a session restore", async () => {
    const { client, root, store } = createHarness();
    let finishOpen!: () => void;
    client.open.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishOpen = () => resolve(undefined);
        }),
    );

    const shown = store.show();
    const restored = store.restore();
    expect(client.open).toHaveBeenCalledTimes(1);

    finishOpen();
    await Promise.all([shown, restored]);
    expect(store.nativeViewReady).toBe(true);

    await store.open();
    expect(client.open).toHaveBeenCalledTimes(2);
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

  it("keeps the state stream authoritative while changing the server path", async () => {
    const { client, root, store } = createHarness();
    let finish!: () => void;
    client.setServerPath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              projects: [],
              unreadSessionIds: [],
              trustedProjectPaths: [],
            });
        }),
    );
    const request = store.useExistingInstallation("/usr/local/bin/code-server");
    store.applyState(stateEvent("ready"));

    finish();
    await request;

    expect(store.status).toBe("ready");
    expect(client.getState).not.toHaveBeenCalled();
    root[Symbol.dispose]();
  });

  it("reveals through the client only while the IDE is visible", async () => {
    const { client, root, store } = createHarness();

    await expect(
      store.reveal({
        kind: "working-directory",
        path: "src/app.ts",
        range: { start: { line: 3 } },
      }),
    ).rejects.toThrow("not visible");
    expect(client.reveal).not.toHaveBeenCalled();

    const location = {
      kind: "working-directory" as const,
      path: "src/app.ts",
      range: { start: { line: 3 } },
    };
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

  it("swallows a failed bounds push without surfacing an editor error", async () => {
    const { client, root, store } = createHarness();
    client.updateBounds.mockRejectedValueOnce(new Error("stale"));

    store.setMeasuredBounds(surfaceRect);
    await Promise.resolve();

    expect(client.updateBounds).toHaveBeenCalledWith(hiddenBounds, expect.any(Object));
    expect(store.error).toBeUndefined();
    root[Symbol.dispose]();
  });
});
