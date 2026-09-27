import { describe, expect, it, vi } from "vitest";
import { makeClient } from "../../../src/renderer/client/ClientLive";
import { ClientError } from "../../../src/renderer/client/Client";
import type { Runtime } from "../../../src/renderer/runtime";

function controlledRuntime(execute: Runtime["execute"]): Pick<Runtime, "execute"> {
  return { execute };
}

describe("Client", () => {
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
      openExternalUrl,
    });
    for (const command of [
      () => client.dictation.install(),
      () => client.desktopSharing.configure({ enabled: true, bind: "127.0.0.1", port: 4317 }),
      () => client.windowState.load(),
      () => client.electron.chooseProject(),
      () => client.electron.showComposerContextMenu({ selection: "text", x: 0, y: 0 }),
      () => client.filesystem.chooseAttachments(),
      () => client.filesystem.readImage("/project", "image.png"),
      () => client.draw.list({ sessionId: "session" }),
      () => client.vscode.install(),
      () => client.browser.open("session"),
      () => client.models.login({ provider: "test", authType: "api_key" }),
    ])
      await expect(command()).rejects.toMatchObject({ kind: "unsupported" });
    await client.electron.openExternalUrl("https://example.com");
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    expect(execute).not.toHaveBeenCalled();
  });

  it("disconnected browser commands fail before dispatch and are not queued for replay", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Unexpected network command");
    });
    const client = makeClient(controlledRuntime(execute), {
      kind: "browser",
      connected: () => false,
      openExternalUrl: async () => undefined,
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
      "dictation",
      "desktopHost",
      "backendConnection",
      "desktopSharing",
      "application",
      "windowState",
      "models",
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

  it("remote provider auth dispatches only while connected", async () => {
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
    expect(execute).toHaveBeenCalledTimes(4);
    connected = false;
    await expect(
      client.models.login({ provider: "test", authType: "api_key" }),
    ).rejects.toMatchObject({
      kind: "rejected",
      message: "Disconnected. No command was sent.",
    });
    expect(execute).toHaveBeenCalledTimes(4);
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
