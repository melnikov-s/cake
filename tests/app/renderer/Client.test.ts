import { describe, expect, it, vi } from "vitest";
import { createStore, mount } from "r-state-tree";
import { BrowserFiles } from "../../../src/renderer/client/BrowserFiles";
import { BrowserMenuStore } from "../../../src/renderer/stores/BrowserMenuStore";
import { makeClient } from "../../../src/renderer/client/ClientLive";
import { ClientError } from "../../../src/renderer/client/Client";
import type { Runtime } from "../../../src/renderer/runtime";
import {
  ResolutionRejected,
  ResolutionCleanupFailed,
} from "../../../src/contracts/project-sessions/project-session-resolution";
import type { EditorLease } from "../../../src/contracts/vscode/editor-endpoint";

function controlledRuntime(execute: Runtime["execute"]): Pick<Runtime, "execute"> {
  return { execute };
}

const browserDevices = () => ({
  files: new BrowserFiles(),
  menus: mount(createStore(BrowserMenuStore)),
  saveDrawExport: vi.fn(async () => "board.svg"),
  showNotification: vi.fn(async () => undefined),
  setFullscreenSurfaceOpen: vi.fn(async () => undefined),
});

describe("Client", () => {
  const cleanupFailure = new ResolutionCleanupFailed({
    operation: "resolve",
    resolvedSessionIds: ["session"],
    cleanupFailures: [{ workingDirectory: "/worktree", message: "Checkout busy" }],
    message: "Resolved; cleanup failed",
  });
  it.each([
    new ResolutionRejected({
      operation: "resolve",
      sessionIds: ["session"],
      message: "Turn active",
    }),
    cleanupFailure,
  ])("retains validated $_tag resolution failures without uncertain delivery", async (failure) => {
    const uncertain = vi.fn();
    const client = makeClient(
      controlledRuntime(async () => {
        throw failure;
      }),
      {
        kind: "remote",
        connected: () => true,
        blocked: () => false,
        uncertain,
      },
    );
    await expect(client.projectSessions.resolve({ sessionId: "session" })).rejects.toMatchObject({
      kind: "rejected",
      domainFailure: failure,
    });
    expect(uncertain).not.toHaveBeenCalled();
  });
  it.each([
    {
      _tag: "ResolutionCleanupFailed",
      resolvedSessionIds: [],
      cleanupFailures: [],
      message: "Invalid",
    },
    { _tag: "ResolutionRejected", sessionIds: [42], message: "Invalid" },
    { _tag: "OtherFailure", sessionIds: ["session"], message: "Unrelated" },
  ])(
    "does not attach malformed or unrelated tagged values as domainFailure: $_tag",
    async (failure) => {
      const client = makeClient(
        controlledRuntime(async () => {
          throw failure;
        }),
      );
      await expect(client.projectSessions.resolve({ sessionId: "session" })).rejects.toMatchObject({
        domainFailure: undefined,
      });
    },
  );
  it("does not erase an already received committed outcome when the caller signal later aborts", async () => {
    const controller = new AbortController();
    const uncertain = vi.fn();
    const client = makeClient(
      controlledRuntime(async () => {
        controller.abort();
        throw cleanupFailure;
      }),
      { kind: "remote", connected: () => true, blocked: () => false, uncertain },
    );
    await expect(
      client.projectSessions.resolve({ sessionId: "session" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "rejected", domainFailure: cleanupFailure });
    expect(uncertain).not.toHaveBeenCalled();
  });

  it("cancelled optional cleanup does not block remote commands as uncertain delivery", async () => {
    const controller = new AbortController();
    const uncertain = vi.fn();
    const client = makeClient(
      controlledRuntime(async () => {
        throw new Error("Cancelled");
      }),
      {
        kind: "remote",
        connected: () => true,
        blocked: () => false,
        uncertain,
      },
    );
    controller.abort();
    await expect(
      client.workspaces.postProcessDictation("Speech", { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "interrupted" });
    expect(uncertain).not.toHaveBeenCalled();
  });
  it("browser file tokens never resolve to browser paths after their tab grant is gone", () => {
    expect(() => new BrowserFiles().get("browser-file:expired")).toThrowError(
      "Selected browser file is no longer available. Select it again.",
    );
  });

  it("browser menu resolves an action once and cancellation does not run a command", async () => {
    const menu = mount(createStore(BrowserMenuStore));
    const chosen = menu.show("Session actions", [{ label: "Rename", action: "rename" }]);
    const rename = menu.items[0];
    if (!rename) throw new Error("Menu action was not registered");
    await menu.choose(rename);
    expect(await chosen).toBe("rename");
    const cancelled = menu.show("Session actions", [{ label: "Delete", action: "delete" }]);
    menu.close();
    expect(await cancelled).toBeUndefined();
    menu[Symbol.dispose]();
  });
  it("remote client refuses device paths and unavailable integrations even while offline", async () => {
    const client = makeClient(
      controlledRuntime(async () => {
        throw new Error("Must not dispatch");
      }),
      {
        kind: "remote",
        connected: () => false,
        blocked: () => false,
        uncertain: () => {
          throw new Error("Not an uncertain delivery");
        },
      },
    );
    for (const url of [
      "file:///vm/project/file.ts",
      "/vm/project/file.ts",
      "vscode://file/vm/project/file.ts",
    ])
      await expect(client.electron.openExternalUrl(url)).rejects.toMatchObject({
        kind: "unsupported",
      });
    await expect(client.electron.chooseProject()).rejects.toMatchObject({ kind: "unsupported" });
    await expect(client.vscode.install()).rejects.toMatchObject({
      kind: "rejected",
      message: "Disconnected. No command was sent.",
    });
    await expect(
      client.sessionChats.prompt({
        sessionId: "s",
        text: "offline",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      }),
    ).rejects.toMatchObject({ kind: "rejected", message: "Disconnected. No command was sent." });
  });
  it("browser native capabilities fail locally and external links open on the viewing device", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Unexpected network command");
    });
    const openExternalUrl = vi.fn(async () => undefined);
    const client = makeClient(controlledRuntime(execute), {
      kind: "browser",
      connected: () => true,
      blocked: () => false,
      uncertain: () => {},
      openExternalUrl,
      ...browserDevices(),
    });
    for (const command of [
      () => client.dictation.install(),
      () => client.dictation.detectSpeech({ captureId: "browser-capture", pcm: "AAAAAA==" }),
      () => client.desktopSharing.configure({ enabled: true, bind: "127.0.0.1", port: 4317 }),
      () => client.windowState.load(),
      () => client.electron.chooseProject(),
      () =>
        client.electron.startScreenCapture({
          projects: [],
          cakeChats: [],
          defaultDestination: { kind: "cake-chat", sessionId: "session" },
        }),
      () => client.electron.configureScreenCapture({ shortcut: "Mod+Shift+6", maxDimension: 2048 }),
      () => client.electron.screenCaptureState(),
      () => client.electron.finishScreenCapture(),
      () => client.vscode.install(),
      () => client.browser.open("session"),
      () => client.models.login({ provider: "test", authType: "api_key" }),
    ])
      await expect(command()).rejects.toMatchObject({ kind: "unsupported" });
    await client.electron.openExternalUrl("https://example.com");
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    expect(execute).not.toHaveBeenCalled();
    for (const command of [
      () => client.filesystem.readImage("/project", "image.png"),
      () => client.draw.list({ sessionId: "session" }),
    ])
      await expect(command()).rejects.toMatchObject({ kind: "unexpected" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("browser editor refuses malformed or same-origin leases and releases each acquired capability", async () => {
    const id = "a".repeat(64);
    const app = new URL("http://127.0.0.1:3000/");
    vi.stubGlobal("window", { location: { href: app.href, protocol: app.protocol } });
    vi.stubGlobal("document", { documentElement: { dataset: { theme: "dark" } } });
    const appPort = Number(app.port || (app.protocol === "https:" ? 443 : 80));
    let lease: EditorLease = {
      id,
      endpoint: `/editor/1/${id}/`,
      editorPort: appPort === 4317 ? 4318 : 4317,
      editorOrigin: "https://editor.example.com",
    };
    // SAFETY: the controlled runtime only supplies the lease fixture for acquisition; release ignores its response.
    const execute = vi.fn(async () => lease) as Runtime["execute"];
    const client = makeClient(controlledRuntime(execute), {
      kind: "browser",
      connected: () => true,
      blocked: () => false,
      uncertain: () => {},
      openExternalUrl: async () => undefined,
      ...browserDevices(),
    });
    const valid = await client.vscode.open("/workspace");
    expect(valid?.endpoint).toBe(
      `${app.protocol}//${app.hostname}:${lease.editorPort}${lease.endpoint}`,
    );
    for (const invalid of [
      { ...lease, editorPort: undefined },
      { ...lease, editorPort: appPort },
      { ...lease, editorPort: 65536 },
      { ...lease, endpoint: `//evil.test/editor/1/${id}/` },
      { ...lease, endpoint: `/editor/1/${id}/?redirect=evil` },
      { ...lease, endpoint: `/editor/1/${"b".repeat(64)}/` },
    ]) {
      lease = invalid;
      await expect(client.vscode.open("/workspace")).rejects.toThrow(
        /Invalid isolated editor lease/,
      );
    }
    expect(execute).toHaveBeenCalledTimes(13);
    vi.unstubAllGlobals();
  });

  it("browser HTTPS editor accepts only the exact isolated public origin and releases invalid leases", async () => {
    const id = "a".repeat(64);
    const endpoint = `/editor/12/${id}/`;
    vi.stubGlobal("window", {
      location: { href: "https://cake.example.com/workspace?session=1", protocol: "https:" },
    });
    vi.stubGlobal("document", { documentElement: { dataset: { theme: "dark" } } });
    let lease: EditorLease = {
      id,
      endpoint,
      editorPort: 4318,
      editorOrigin: "https://editor.example.com",
    };
    // SAFETY: the controlled runtime only supplies the lease fixture for acquisition; release ignores its response.
    const execute = vi.fn(async () => lease) as Runtime["execute"];
    const uncertain = vi.fn();
    const client = makeClient(controlledRuntime(execute), {
      kind: "browser",
      connected: () => true,
      blocked: () => false,
      uncertain,
      openExternalUrl: async () => undefined,
      ...browserDevices(),
    });
    try {
      expect(await client.vscode.open("/workspace")).toEqual({
        id,
        endpoint: `https://editor.example.com${endpoint}`,
      });
      expect(execute).toHaveBeenCalledTimes(1);

      for (const invalid of [
        { ...lease, editorOrigin: undefined },
        { ...lease, editorOrigin: "https://cake.example.com" },
        { ...lease, editorOrigin: "http://editor.example.com" },
        { ...lease, editorOrigin: "https://user:pass@editor.example.com" },
        { ...lease, editorOrigin: "https://editor.example.com/path" },
        { ...lease, editorOrigin: "https://editor.example.com/?redirect=evil" },
        { ...lease, editorOrigin: "https://editor.example.com/#evil" },
        { ...lease, editorOrigin: "//editor.example.com" },
        { ...lease, editorOrigin: "https://editor.example.com:443" },
        { ...lease, endpoint: `//editor.example.com${endpoint}` },
        { ...lease, endpoint: `/editor/12/${"b".repeat(64)}/` },
        { ...lease, endpoint: `${endpoint}?redirect=evil` },
      ]) {
        lease = invalid;
        await expect(client.vscode.open("/workspace")).rejects.toMatchObject({
          kind: "rejected",
          operation: "vscode.open",
        });
      }
      expect(execute).toHaveBeenCalledTimes(25); // acquisition and release for every invalid lease
      expect(uncertain).not.toHaveBeenCalled();
      lease = { id, endpoint, editorPort: 4318 };
      await expect(client.vscode.open("/workspace")).rejects.toThrow(
        "Browser VS Code requires a configured public HTTPS editor origin",
      );
      expect(execute).toHaveBeenCalledTimes(27);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disconnected browser commands fail before dispatch and are not queued for replay", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Unexpected network command");
    });
    const client = makeClient(controlledRuntime(execute), {
      kind: "browser",
      connected: () => false,
      blocked: () => false,
      uncertain: () => {},
      openExternalUrl: async () => undefined,
      ...browserDevices(),
    });
    await expect(
      client.sessionChats.prompt({
        sessionId: "session",
        text: "Never queue",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      }),
    ).rejects.toMatchObject({ kind: "transport", message: "Disconnected. No command was sent." });
    expect(execute).not.toHaveBeenCalled();
  });
  it("exposes focused command groups without observation methods", () => {
    const runtime = controlledRuntime(vi.fn(async () => undefined) as Runtime["execute"]);
    const client = makeClient(runtime);

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
      "piSettings",
      "modelPresets",
      "draw",
      "drawControl",
      "savedDrafts",
      "scheduledMessages",
      "projectWorkflow",
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
    expect("observe" in client.projectSessions).toBe(false);
    expect("observe" in client.cakeChats).toBe(false);
    expect("observe" in client.discussionSessions).toBe(false);
    expect("observe" in client.subagents).toBe(false);
  });

  it("remote provider auth and non-chat settings dispatch only while connected", async () => {
    const execute = vi.fn(async () => undefined) as Runtime["execute"];
    let connected = true;
    const client = makeClient(controlledRuntime(execute), {
      kind: "remote",
      connected: () => connected,
      uncertain: () => {},
      blocked: () => false,
    });
    await client.models.login({ provider: "test", authType: "api_key" });
    await client.models.logout({ provider: "test" });
    await client.sessionChats.login({ sessionId: "session", provider: "test", authType: "oauth" });
    await client.sessionChats.logout({ sessionId: "session", provider: "test" });
    await client.nonChatModels.list();
    await client.nonChatModels.updatePreference({ type: "image", preference: null });
    expect(execute).toHaveBeenCalledTimes(6);
    connected = false;
    await expect(
      client.models.login({ provider: "test", authType: "api_key" }),
    ).rejects.toMatchObject({
      kind: "rejected",
      message: "Disconnected. No command was sent.",
    });
    await expect(
      client.nonChatModels.updatePreference({ type: "image", preference: null }),
    ).rejects.toMatchObject({ kind: "rejected", message: "Disconnected. No command was sent." });
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("remote workspace reads dispatch through the backend", async () => {
    const execute = vi.fn(async () => ({ content: "server content" })) as Runtime["execute"];
    const client = makeClient(controlledRuntime(execute), {
      kind: "remote",
      connected: () => true,
      uncertain: () => {},
      blocked: () => false,
    });
    expect(await client.filesystem.readFile("/server/project", "note.txt")).toBe("server content");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("passes AbortSignal to the window runtime and reports interruption stably", async () => {
    const execute = vi.fn(async () => {
      throw new Error("fiber interrupted");
    }) as Runtime["execute"];
    const client = makeClient(controlledRuntime(execute));
    const controller = new AbortController();
    controller.abort();

    const failure = await client.foundation
      .delay({ durationMs: 10_000 }, { signal: controller.signal })
      .catch((error: unknown) => error);

    expect(execute).toHaveBeenCalledWith(expect.anything(), controller.signal);
    expect(failure).toBeInstanceOf(ClientError);
    expect(failure).toMatchObject({
      _tag: "ClientError",
      kind: "interrupted",
      operation: "foundation.delay",
      message: "The operation was cancelled",
    });
  });

  it("does not expose arbitrary command rejection values", async () => {
    const execute = vi.fn(async () => {
      throw { _tag: "ModelPresetNotFoundError", id: "missing" };
    }) as Runtime["execute"];
    const client = makeClient(controlledRuntime(execute));

    const failure = await client.modelPresets.resolve("missing").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClientError);
    expect(failure).toMatchObject({
      kind: "rejected",
      operation: "modelPresets.resolve",
    });
  });
});
