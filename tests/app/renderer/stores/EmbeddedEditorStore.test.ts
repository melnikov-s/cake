import { batch, createStore } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../../src/contracts/application/application-data";
import type { EditorAnnotationSnapshot } from "../../../../src/ipc/editor-annotation";
import { EmbeddedEditorStore } from "../../../../src/renderer/stores/EmbeddedEditorStore";
import type { Client } from "../../../../src/renderer/client/Client";
import { mountWithClient } from "../mount-with-client";
import { createTestClient } from "../test-client";
import { TerminalStore } from "../../../../src/renderer/stores/TerminalStore";
import { WorkingDirectoryRetirementStore } from "../../../../src/renderer/stores/WorkingDirectoryRetirementStore";

function createHarness(
  annotations?: EditorAnnotationSnapshot,
  terminalTopInset: () => number = () => 0,
) {
  let presentationMode: "normal" | "vscode" | "draw" | "browser" = "normal";
  let chatSidebarVisible = true;
  let chatSidebarWidth = 420;
  const client = {
    getState: vi.fn(async () => ({ status: "missing" as const })),
    install: vi.fn(async () => undefined),
    setServerPath: vi.fn<Client["vscode"]["setServerPath"]>(async () => defaultApplicationState()),
    open: vi.fn<Client["vscode"]["open"]>(async () => undefined),
    release: vi.fn<Client["vscode"]["release"]>(async () => undefined),
    setTheme: vi.fn<Client["vscode"]["setTheme"]>(async () => undefined),
    updateBounds: vi.fn<Client["vscode"]["updateBounds"]>(async () => undefined),
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
    createTestClient({ vscode: client }),
    terminalTopInset,
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

  // Lease lifecycle, malformed endpoints, advisory sync failures and stale acquisition
  // regressions now run through the real App in embedded-editor-workflow.test.tsx.

  // Retained: jsdom cannot establish native bounds or project-sidebar geometry.
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

  it("fits the native editor below a floating terminal and restores it on dock, hide, and unmount", async () => {
    const terminalClient = createTestClient({
      terminals: {
        open: vi.fn(async () => ({ terminalId: "terminal-1", shell: "zsh" })),
        close: vi.fn(async () => undefined),
      },
    });
    const retirement = mountWithClient(
      createStore(WorkingDirectoryRetirementStore, { onRetired: () => undefined }),
      terminalClient,
    );
    const terminal = mountWithClient(
      createStore(TerminalStore, {
        activeTarget: () => ({ workingDirectory: "/tmp/project", label: "project" }),
        retirement: () => retirement.subject,
        toggleAcceleratorHint: () => "Ctrl+`",
        newTabHotkey: () => "Mod+T",
      }),
      terminalClient,
    );
    const { client, root, store } = createHarness(undefined, () => terminal.subject.editorTopInset);
    const assertBounds = (y: number, height: number, visible = true) =>
      expect(client.updateBounds).toHaveBeenLastCalledWith(
        { ...shownBounds, y, height, visible },
        expect.any(Object),
      );
    try {
      await store.show();
      store.setMeasuredBounds(surfaceRect);
      terminal.subject.setMeasuredOverlayHeight(365);
      assertBounds(0, 820); // A mounted but closed terminal does not occlude.
      terminal.subject.readyForEvents();
      await terminal.subject.toggle();
      assertBounds(365, 455);
      terminal.subject.setMeasuredOverlayHeight(413);
      assertBounds(413, 407); // Resizing retains the editor's bottom edge.
      terminal.subject.dock();
      assertBounds(0, 820); // Docked geometry comes from the editor host's layout.
      terminal.subject.moveToTop();
      assertBounds(413, 407);
      terminal.subject.hide();
      assertBounds(0, 820);
      await terminal.subject.toggle();
      terminal.subject.setMeasuredOverlayHeight(0);
      assertBounds(0, 820); // Unmount clears the transient occlusion.
      store.setMeasuredBounds({ ...surfaceRect, y: 450, height: 370 });
      terminal.subject.setMeasuredOverlayHeight(413);
      assertBounds(450, 370); // A surface already below the terminal is unchanged.
      terminal.subject.setMeasuredOverlayHeight(900);
      assertBounds(820, 0, false); // Fully covered surfaces hide without a negative height.
      expect(store.nativeViewReady).toBe(true);
      expect(client.open).toHaveBeenCalledTimes(1);
      expect(client.release).not.toHaveBeenCalled();
    } finally {
      root[Symbol.dispose]();
      terminal.root[Symbol.dispose]();
      retirement.root[Symbol.dispose]();
    }
  });

  // Retained native-only portion; the React workflow covers reconnect and annotation resend.
  it("resends unchanged native geometry after a disconnected view explicitly reopens", async () => {
    const { client, root, store } = createHarness();
    store.setMeasuredBounds(surfaceRect);
    await store.show();
    store.disconnected();
    expect(client.updateBounds).toHaveBeenLastCalledWith(hiddenBounds, expect.any(Object));
    client.updateBounds.mockClear();
    await store.show();
    expect(client.updateBounds).toHaveBeenLastCalledWith(shownBounds, expect.any(Object));
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

  // Retained: session restore/native reopen concurrency has no equivalent UI trigger here.
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

  // Retained: companion source-context translation/clearing is not exercised by these
  // lease workflows (the native editor itself is deliberately not mocked).
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

  // Retained: the editor workflow does not exercise Settings' server-path operation race.
  it("keeps the state stream authoritative while changing the server path", async () => {
    const { client, root, store } = createHarness();
    let finish!: () => void;
    client.setServerPath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(defaultApplicationState());
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

  // Retained: direct source-navigation visibility guards are not covered by opening the IDE.
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

  // Retained: nonempty review-thread annotation content is outside these lease workflows.
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

  // Retained: missing-installation Cake Chat setup and its failure are a separate workflow.
  it("asks Cake Chat to install on the actual backend with project context", async () => {
    const { root, store, startCakeChat } = createHarness();

    await store.askCakeToSetUp();

    expect(startCakeChat).toHaveBeenCalledTimes(1);
    const prompt = startCakeChat.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("backend's actual operating system");
    expect(prompt).toContain("Remote desktops require code-server");
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

  // Retained: native geometry transport rejection cannot be proved by jsdom layout.
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
