import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserFiles } from "../../../src/renderer/client/BrowserFiles";
import { BrowserMenuStore } from "../../../src/renderer/stores/BrowserMenuStore";
import { browserMenus } from "../../../src/renderer/client/BrowserMenus";
import { makeClient } from "../../../src/renderer/client/ClientLive";
import { ClientError } from "../../../src/renderer/client/Client";
import type { EditorLease } from "../../../src/contracts/vscode/editor-endpoint";
import { commandClientFinishTransport } from "./command-client-finish-transport";
import { sessionSummary } from "./fixtures/catalog-fixtures";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import { defaultCakeChatPreferences } from "../../../src/contracts/cake-chats/cake-chat-preferences";

function browserDevices() {
  const files = new BrowserFiles();
  const menus = mount(createStore(BrowserMenuStore));
  return {
    files,
    menus,
    showNotification: vi.fn(async () => undefined),
    setFullscreenSurfaceOpen: vi.fn(async () => undefined),
    [Symbol.dispose]() {
      menus[Symbol.dispose]();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

// Client routing/security are transport/native boundaries, not UI workflows.
// Use the real runtime, generated RPC client and command adapter; control only
// encoded transport replies. Generated-client retains wire encoding, cancellation,
// attachment ordering and non-retrying Stream tests rather than duplicating them.
describe("Client transport and device integration", () => {
  it("encodes initial project settings and display-name settings saves through the validated Workspace RPC", async () => {
    const state = defaultApplicationState();
    const settings = { ...defaultProjectSettings(), worktreeLanding: "pull-request" as const };
    await using transport = commandClientFinishTransport(() => ({
      _tag: "Success",
      value: { state },
    }));
    const client = makeClient(transport.runtime);
    await client.workspaces.registerProject("/atlas", "Atlas", undefined, settings);
    await client.workspaces.setProjectSettings("/atlas", settings, undefined, "Atlas desktop");
    expect(transport.requests()).toMatchObject([
      { tag: "workspaces.register-project", payload: { path: "/atlas", name: "Atlas", settings } },
      {
        tag: "workspaces.set-project-settings",
        payload: { path: "/atlas", name: "Atlas desktop", settings },
      },
    ]);
  });

  it("routes a dialog-local icon model choice and validated static SVG artwork through Workspace RPC", async () => {
    const artwork = {
      background: "#112233",
      paths: [{ d: "M0 0 L100 0 L50 100 Z", fill: "#aabbcc" }],
    };
    await using transport = commandClientFinishTransport(() => ({
      _tag: "Success",
      value: artwork,
    }));
    const client = makeClient(transport.runtime);
    await expect(
      client.workspaces.generateProjectIcon({ name: "Atlas", model: { source: "utility" } }),
    ).resolves.toEqual(artwork);
    expect(transport.requests()).toMatchObject([
      {
        tag: "workspaces.generate-project-icon",
        payload: { name: "Atlas", model: { source: "utility" } },
      },
    ]);
  });

  it.each([
    { name: "Cake Chat", companion: undefined },
    { name: "Companion", companion: true },
  ])("encodes the $name preference owner through the real RPC schema", async ({ companion }) => {
    const preferences = { ...defaultCakeChatPreferences(), instructions: "Keep my guidance" };
    const state = {
      ...defaultApplicationState(),
      [companion ? "assistantPreferences" : "cakeChatPreferences"]: preferences,
    };
    await using transport = commandClientFinishTransport(() => ({
      _tag: "Success",
      value: { state },
    }));
    const client = makeClient(transport.runtime);
    await expect(
      client.workspaces.setCakeChatPreferences(preferences, undefined, companion),
    ).resolves.toEqual(state);
    expect(transport.requests()).toHaveLength(1);
    expect(transport.requests()[0]).toMatchObject({
      tag: "workspaces.set-cake-chat-preferences",
      payload: { preferences, companion: companion ?? false },
    });
  });

  it("allows exact-ID lookup while remote mutation delivery is blocked", async () => {
    const summary = sessionSummary({ sessionId: "session", projectPath: "/project" });
    await using transport = commandClientFinishTransport(() => ({
      _tag: "Success",
      value: summary,
    }));
    const uncertain = vi.fn();
    const client = makeClient(transport.runtime, {
      kind: "remote",
      connected: () => true,
      blocked: () => true,
      uncertain,
    });
    expect(await client.projectSessions.lookup({ sessionId: "session" })).toMatchObject({
      sessionId: "session",
      projectPath: "/project",
    });
    await expect(client.projectSessions.resolve({ sessionId: "session" })).rejects.toBeInstanceOf(
      ClientError,
    );
    expect(transport.requests().map(({ tag }) => tag)).toEqual(["projectSessions.lookup"]);
    expect(uncertain).not.toHaveBeenCalled();
  });

  it("allows registered chat metadata lookup while remote mutation delivery is blocked", async () => {
    const sessionId = `project-chat:${"c".repeat(64)}`;
    const summary = {
      sessionId,
      projectPath: "/new-project",
      title: "New project",
      createdAt: new Date(0).toISOString(),
      modifiedAt: new Date(0).toISOString(),
      messageCount: 0,
      resolved: false,
      unread: false,
    };
    await using transport = commandClientFinishTransport(() => ({
      _tag: "Success",
      value: summary,
    }));
    const uncertain = vi.fn();
    const client = makeClient(transport.runtime, {
      kind: "remote",
      connected: () => true,
      blocked: () => true,
      uncertain,
    });
    await expect(client.cakeChats.lookup({ sessionId })).resolves.toEqual(summary);
    await expect(client.projectSessions.resolve({ sessionId: "session" })).rejects.toBeInstanceOf(
      ClientError,
    );
    expect(transport.requests()).toEqual([
      expect.objectContaining({ tag: "cakeChats.lookup", payload: { sessionId } }),
    ]);
    expect(uncertain).not.toHaveBeenCalled();
  });

  it("retains unregistered chat lookup failure without remote delivery uncertainty", async () => {
    const failure = {
      _tag: "CakeChatError",
      operation: "lookup",
      message: "Cake could not find that registered chat.",
    };
    await using transport = commandClientFinishTransport(() => ({
      _tag: "Failure",
      cause: [{ _tag: "Fail", error: failure }],
    }));
    const uncertain = vi.fn();
    const client = makeClient(transport.runtime, {
      kind: "remote",
      connected: () => true,
      blocked: () => true,
      uncertain,
    });
    await expect(
      client.cakeChats.lookup({ sessionId: `project-chat:${"d".repeat(64)}` }),
    ).rejects.toMatchObject({
      kind: "rejected",
      operation: "cakeChats.lookup",
      message: failure.message,
    });
    expect(transport.requests().map(({ tag }) => tag)).toEqual(["cakeChats.lookup"]);
    expect(uncertain).not.toHaveBeenCalled();
  });

  it.each([
    {
      _tag: "ResolutionRejected",
      operation: "resolve",
      sessionIds: ["session"],
      message: "Turn active",
    },
    {
      _tag: "ResolutionCleanupFailed",
      operation: "resolve",
      resolvedSessionIds: ["session"],
      cleanupFailures: [{ workingDirectory: "/tree", message: "Checkout busy" }],
      message: "Resolved; cleanup failed",
    },
  ])(
    "retains validated $_tag through encoded RPC without marking delivery uncertain",
    async (failure) => {
      await using transport = commandClientFinishTransport(() => ({
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: failure }],
      }));
      const uncertain = vi.fn();
      const client = makeClient(transport.runtime, {
        kind: "remote",
        connected: () => true,
        blocked: () => false,
        uncertain,
      });
      await expect(client.projectSessions.resolve({ sessionId: "session" })).rejects.toMatchObject({
        kind: "rejected",
        domainFailure: failure,
      });
      expect(transport.requests()).toHaveLength(1);
      expect(uncertain).not.toHaveBeenCalled();
    },
  );

  it("does not attach malformed failures as committed outcomes or expose arbitrary rejection values", async () => {
    for (const failure of [
      {
        _tag: "ResolutionCleanupFailed",
        resolvedSessionIds: [],
        cleanupFailures: [],
        message: "Invalid",
      },
      { _tag: "ResolutionRejected", sessionIds: [42], message: "Invalid" },
      { _tag: "OtherFailure", sessionIds: ["session"], message: "Unrelated" },
    ]) {
      await using transport = commandClientFinishTransport(() => ({
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: failure }],
      }));
      const client = makeClient(transport.runtime);
      const rejected = await client.projectSessions
        .resolve({ sessionId: "session" })
        .catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(ClientError);
      expect(rejected).toMatchObject({ domainFailure: undefined });
      expect(transport.requests()).toHaveLength(1);
    }
  });

  it("reports interruption rather than a committed outcome when cancellation wins before the RPC result reaches the Client", async () => {
    const controller = new AbortController();
    const failure = {
      _tag: "ResolutionCleanupFailed",
      operation: "resolve",
      resolvedSessionIds: ["session"],
      cleanupFailures: [{ workingDirectory: "/tree", message: "Busy" }],
      message: "Resolved; cleanup failed",
    };
    await using transport = commandClientFinishTransport(
      () => ({ _tag: "Failure", cause: [{ _tag: "Fail", error: failure }] }),
      () => controller.abort(),
    );
    const uncertain = vi.fn();
    const client = makeClient(transport.runtime, {
      kind: "remote",
      connected: () => true,
      blocked: () => false,
      uncertain,
    });
    // A wire response is not yet a delivered Promise outcome. The real RPC
    // cancellation wins here; a fake Runtime.execute rejection hid that boundary.
    await expect(
      client.projectSessions.resolve({ sessionId: "session" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "interrupted", domainFailure: undefined });
    expect(uncertain).toHaveBeenCalledExactlyOnceWith("projectSessions.resolve");
    expect(transport.requests()).toHaveLength(1);
  });

  it("rejects offline mutations before dispatch, permits optional cleanup cancellation, and never queues replay", async () => {
    await using transport = commandClientFinishTransport((request) => {
      if (request.tag !== "workspaces.post-process-dictation")
        throw new Error("Offline mutation must not dispatch");
      return { _tag: "Success", value: { text: "Speech" } };
    });
    const uncertain = vi.fn();
    const client = makeClient(transport.runtime, {
      kind: "remote",
      connected: () => false,
      blocked: () => false,
      uncertain,
    });
    await expect(
      client.sessionChats.prompt({
        sessionId: "session",
        text: "Never queue",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      }),
    ).rejects.toMatchObject({ kind: "rejected", message: "Disconnected. No command was sent." });
    await expect(client.vscode.install()).rejects.toMatchObject({ kind: "rejected" });
    for (const url of [
      "file:///server/project/file.ts",
      "/server/project/file.ts",
      "vscode://file/server/file.ts",
    ])
      await expect(client.electron.openExternalUrl(url)).rejects.toMatchObject({
        kind: "unsupported",
      });
    expect(transport.requests()).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    const cleanupClient = makeClient(transport.runtime, {
      kind: "remote",
      connected: () => true,
      blocked: () => false,
      uncertain,
    });
    await expect(
      cleanupClient.workspaces.postProcessDictation("Speech", { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "interrupted" });
    expect(uncertain).not.toHaveBeenCalled();
    // Cancellation can reach the RPC after admission, but must never replay it.
    expect(transport.requests().length).toBeLessThanOrEqual(1);
    expect(
      transport.requests().every(({ tag }) => tag === "workspaces.post-process-dictation"),
    ).toBe(true);
  });

  it("keeps native-only capabilities local to the browser and opens links on the viewing device", async () => {
    await using transport = commandClientFinishTransport(() => {
      throw new Error("Unexpected network command");
    });
    using devices = browserDevices();
    const openExternalUrl = vi.fn(async () => undefined);
    const client = makeClient(transport.runtime, {
      kind: "browser",
      connected: () => true,
      blocked: () => false,
      uncertain() {},
      openExternalUrl,
      ...devices,
    });
    for (const command of [
      () => client.dictation.install(),
      () => client.dictation.detectSpeech({ captureId: "capture", pcm: "AAAAAA==" }),
      () => client.desktopSharing.configure({ enabled: true, bind: "127.0.0.1", port: 4317 }),
      () => client.windowState.load(),
      () => client.electron.chooseProject(),
      () =>
        client.electron.startScreenCapture({
          annotationColor: "yellow",
          dictation: {
            enabled: false,
            deviceId: "",
            textProcessingMode: "raw",
            recognition: {
              thresholds: { start: 0.6, continuation: 0.4 },
              minimumSpeechMs: 200,
              prerollMs: 600,
              maximumUtteranceSeconds: 30,
            },
          },
          projects: [],
          cakeChats: [],
          appearance: {
            theme: "dark",
            projectAvatarsEnabled: false,
            sessionAvatarsEnabled: false,
            sidebarCharactersEnabled: false,
          },
        }),
      () => client.electron.configureScreenCapture({ shortcut: "Mod+Shift+6", maxDimension: 2048 }),
      () => client.electron.screenCaptureState(),
      () => client.electron.finishScreenCapture(undefined, "yellow"),
      () =>
        client.electron.copyScreenCapture({
          image: "data:image/png;base64,png",
          annotationText: "1. Note",
        }),
      () => client.vscode.install(),
      () => client.browser.open("session"),
      () => client.models.login({ provider: "test", authType: "api_key" }),
    ])
      await expect(command()).rejects.toMatchObject({ kind: "unsupported" });
    await client.electron.openExternalUrl("https://example.com");
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com");
    expect(transport.requests()).toEqual([]);
  });

  it.each([false, true])(
    "offers Delete, never Resolve/Restore for a draft browser menu (resolved=%s)",
    async (resolved) => {
      using devices = browserDevices();
      const showing = browserMenus(devices.menus).showSessionContextMenu({
        sessionId: "draft",
        x: 0,
        y: 0,
        resolved,
        draft: true,
      });
      expect(devices.menus.items.map((item) => item.label)).toEqual([
        "Rename",
        "Copy Session ID",
        "Delete",
      ]);
      const remove = devices.menus.items.find((item) => item.label === "Delete");
      if (!remove) throw new Error("Missing Delete action");
      await devices.menus.choose(remove);
      expect(await showing).toEqual({ action: "delete" });
    },
  );

  it.each([false, true])(
    "offers only delegated sessions the one-way takeover action (delegated=%s)",
    async (delegated) => {
      using devices = browserDevices();
      const showing = browserMenus(devices.menus).showSessionContextMenu({
        sessionId: "session",
        x: 0,
        y: 0,
        resolved: false,
        draft: false,
        delegated,
      });
      const move = devices.menus.items.find((item) => item.label === "Move to My sessions");
      expect(Boolean(move)).toBe(delegated);
      if (move) {
        await devices.menus.choose(move);
        expect(await showing).toEqual({ action: "move-to-user" });
      } else {
        devices.menus.close();
        await showing;
      }
    },
  );

  // These two browser-local authorities are device adapters outside the Root
  // tree. Keep their capability lifecycle real rather than hand-assembling peers.
  it("expires browser file capabilities and settles native-menu emulation exactly once", async () => {
    using devices = browserDevices();
    expect(() => devices.files.get("browser-file:expired")).toThrow(
      "Selected browser file is no longer available. Select it again.",
    );
    const chosen = devices.menus.show("Session actions", [{ label: "Rename", action: "rename" }]);
    const rename = devices.menus.items[0];
    if (!rename) throw new Error("Missing registered menu action");
    await devices.menus.choose(rename);
    expect(await chosen).toBe("rename");
    const cancelled = devices.menus.show("Session actions", [
      { label: "Delete", action: "delete" },
    ]);
    devices.menus.close();
    expect(await cancelled).toBeUndefined();
  });

  it.each(["http", "https"] as const)(
    "validates %s editor isolation and releases decoded but unsafe leases",
    async (protocol) => {
      const id = "a".repeat(64);
      const endpoint = `/editor/12/${id}/`;
      const app = new URL(
        protocol === "https" ? "https://cake.example.com/" : "http://127.0.0.1:3000/",
      );
      vi.stubGlobal("window", { location: { href: app.href, protocol: app.protocol } });
      vi.stubGlobal("document", { documentElement: { dataset: { theme: "dark" } } });
      let lease: EditorLease = {
        id,
        endpoint,
        editorPort: 4318,
        editorOrigin: "https://editor.example.com",
      };
      await using transport = commandClientFinishTransport((request) => ({
        _tag: "Success",
        value: request.tag === "vscode.acquire" ? lease : null,
      }));
      using devices = browserDevices();
      const client = makeClient(transport.runtime, {
        kind: "browser",
        connected: () => true,
        blocked: () => false,
        uncertain() {},
        openExternalUrl: async () => undefined,
        ...devices,
      });
      expect(await client.vscode.open("/workspace")).toEqual({
        id,
        endpoint:
          protocol === "https"
            ? `https://editor.example.com${endpoint}`
            : `http://127.0.0.1:4318${endpoint}`,
      });
      const unsafe = [
        { ...lease, endpoint: `//evil.test${endpoint}` },
        { ...lease, endpoint: `${endpoint}?redirect=evil` },
        { ...lease, endpoint: `/editor/12/${"b".repeat(64)}/` },
        protocol === "https"
          ? { ...lease, editorOrigin: app.origin }
          : { ...lease, editorPort: 3000 },
      ];
      for (const value of unsafe) {
        lease = value;
        await expect(client.vscode.open("/workspace")).rejects.toMatchObject({
          kind: "rejected",
          operation: "vscode.open",
        });
      }
      expect(transport.requests().filter(({ tag }) => tag === "vscode.release")).toHaveLength(
        unsafe.length,
      );
      // Malformed wire data is rejected by the shared schema before capability use.
      for (const malformed of [
        { ...lease, editorPort: 65536 },
        { ...lease, editorOrigin: "https://user:pass@editor.example.com" },
        { ...lease, editorOrigin: "https://editor.example.com/path" },
        { ...lease, editorOrigin: "https://editor.example.com/#evil" },
        { ...lease, editorOrigin: "//editor.example.com" },
        { ...lease, editorOrigin: "https://editor.example.com:443" },
      ]) {
        lease = malformed;
        await expect(client.vscode.open("/workspace")).rejects.toBeInstanceOf(ClientError);
      }
      lease = { id, endpoint };
      await expect(client.vscode.open("/workspace")).rejects.toBeInstanceOf(ClientError);
    },
  );

  it("exposes focused command groups without observation methods", async () => {
    await using transport = commandClientFinishTransport(() => ({ _tag: "Success", value: null }));
    const client = makeClient(transport.runtime);

    expect(Object.keys(client)).toEqual([
      "speechOutput",
      "dictation",
      "desktopHost",
      "backendConnection",
      "desktopSharing",
      "application",
      "windowState",
      "nonChatModels",
      "models",
      "mcpSettings",
      "widgetPackages",
      "piSettings",
      "modelPresets",
      "savedDrafts",
      "scheduledMessages",
      "automations",
      "projectWorkflow",
      "projectTodos",
      "projectSessions",
      "sessionChats",
      "cakeChats",
      "discussionSessions",
      "subagents",
      "electron",
      "filesystem",
      "workspaces",
      "managedWorktrees",
      "terminals",
      "browser",
      "vscode",
      "interviews",
      "artifacts",
      "inlineWidgets",
      "foundation",
    ]);
    expect("observe" in client.savedDrafts).toBe(false);
    expect("observe" in client.scheduledMessages).toBe(false);
    expect("observe" in client.automations).toBe(false);
    expect("observe" in client.projectSessions).toBe(false);
    expect("observe" in client.cakeChats).toBe(false);
    expect("observe" in client.discussionSessions).toBe(false);
    expect("observe" in client.subagents).toBe(false);
  });

  it("dispatches connected provider/settings/workspace reads through the backend and rejects them when disconnected", async () => {
    await using transport = commandClientFinishTransport((request) => ({
      _tag: "Success",
      value:
        request.tag === "nonChatModels.list"
          ? []
          : request.tag === "nonChatModels.updatePreference"
            ? {}
            : request.tag === "filesystem.read-workspace-file"
              ? { content: "server content" }
              : null,
    }));
    let connected = true;
    const client = makeClient(transport.runtime, {
      kind: "remote",
      connected: () => connected,
      blocked: () => false,
      uncertain() {},
    });
    await client.models.login({ provider: "test", authType: "api_key" });
    await client.models.logout({ provider: "test" });
    await client.sessionChats.login({ sessionId: "session", provider: "test", authType: "oauth" });
    await client.sessionChats.logout({ sessionId: "session", provider: "test" });
    expect(await client.nonChatModels.list()).toEqual([]);
    await client.nonChatModels.updatePreference({ type: "image", preference: null });
    expect(await client.filesystem.readFile("/server/project", "note.txt")).toBe("server content");
    expect(transport.requests()).toHaveLength(7);
    connected = false;
    await expect(
      client.models.login({ provider: "test", authType: "api_key" }),
    ).rejects.toMatchObject({ kind: "rejected", message: "Disconnected. No command was sent." });
    await expect(
      client.nonChatModels.updatePreference({ type: "image", preference: null }),
    ).rejects.toMatchObject({ kind: "rejected" });
    expect(transport.requests()).toHaveLength(7);
  });
});
