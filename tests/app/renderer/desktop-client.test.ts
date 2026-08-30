import { describe, expect, it, vi } from "vitest";
import type {
  CakeDesktopBridge,
  DesktopEvent,
  DesktopRequest,
  DesktopResponse,
} from "../../../src/ipc/desktop-ipc";
import type { ModelPreset } from "../../../src/ipc/session-contract";
import { createDesktopClient } from "../../../src/renderer/desktop-client";

function createBridge() {
  let listener: ((event: DesktopEvent) => void) | undefined;
  const request = vi.fn(async (input: DesktopRequest): Promise<DesktopResponse> => {
    if ("requestId" in input && input.type !== "respond-ui")
      return { type: "accepted", requestId: input.requestId };
    if (input.type === "respond-ui")
      return { type: "ui-response-accepted", uiRequestId: input.uiRequestId };
    if (input.type === "choose-project") return { type: "project-chosen", path: "/project" };
    if (input.type === "open-external-url") return { type: "external-url-opened" };
    if (input.type === "show-transcript-selection-context-menu")
      return {
        type: "transcript-selection-context-menu-closed",
        action: "chat-about-selection",
      };
    if (input.type === "show-composer-context-menu")
      return { type: "composer-context-menu-closed", action: "reword" };
    if (input.type === "reword-composer-selection")
      return { type: "composer-selection-reworded", text: "Clear text" };
    if (input.type === "show-session-context-menu")
      return { type: "session-context-menu-closed", action: "rename" };
    if (input.type === "show-project-context-menu")
      return { type: "project-context-menu-closed", action: "remove-project" };
    if (
      input.type === "set-session-unread" ||
      input.type === "delete-session" ||
      input.type === "delete-cake-chat-session"
    )
      return {
        type: "application-state-updated",
        state: {
          projects: [],
          resolvedSessionIds: [],
          resolvedCakeChatSessionIds: [],
          unreadSessionIds: [],
          trustedProjectPaths: [],
        },
      };
    if (input.type === "choose-attachments") return { type: "attachments-chosen", attachments: [] };
    if (input.type === "suggest-files")
      return {
        type: "file-suggestions",
        suggestions: [{ value: "@src/app.ts", label: "app.ts", description: "src/app.ts" }],
      };
    if (input.type === "load-window-state")
      return {
        type: "window-state-loaded",
        state: {
          draft: "",
          recentProjectPaths: [],
          theme: "system",
          workLogViewMode: "auto",
          workLogsExpansion: "collapsed",
          draftsBySession: {},
          pendingProjectSessions: [],
        },
      };
    if (input.type === "list-sessions")
      return { type: "sessions-listed", sessions: [], reviewThreads: [] };
    if (input.type === "list-cake-chat-sessions")
      return { type: "cake-chat-sessions-listed", sessions: [] };
    if (input.type === "load-session") return { type: "session-loaded", session: undefined };
    if (
      input.type === "list-plugins" ||
      input.type === "set-plugin-enabled" ||
      input.type === "delete-plugin"
    )
      return { type: "plugins-listed", plugins: [] };
    return { type: "window-state-saved" };
  });
  const bridge: CakeDesktopBridge = {
    rpc: {
      send() {},
      subscribe() {
        return () => {};
      },
    },
    request,
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    bridge,
    rpcClient: {
      application: {
        getHomeDirectory: async () => "/home/user",
        getState: async () => ({
          projects: [],
          resolvedSessionIds: [],
          resolvedCakeChatSessionIds: [],
          unreadSessionIds: [],
          trustedProjectPaths: [],
          fastModeSessionIds: [],
        }),
      },
      models: {
        list: async () => [],
      },
      modelPresets: {
        list: async () => ({ presets: [] }),
        create: async (preset: Omit<ModelPreset, "id">) => ({
          presets: [{ ...preset, id: crypto.randomUUID() }],
        }),
        update: async (preset: ModelPreset) => ({ presets: [preset] }),
        remove: async () => ({ presets: [] }),
        setDefault: async (defaultPresetId?: string) => ({ presets: [], defaultPresetId }),
        resolve: async () => {
          throw new Error("not mocked");
        },
      },
    },
    request,
    emit: (event: DesktopEvent) => listener?.(event),
  };
}

describe("desktop client", () => {
  it("maps intent methods to validated bridge requests", async () => {
    const desktop = createBridge();
    const client = createDesktopClient(desktop.bridge, desktop.rpcClient);
    const operationId = crypto.randomUUID();

    expect(await client.chooseProject()).toBe("/project");
    expect(await client.loadApplicationState()).toMatchObject({ projects: [] });
    expect(desktop.request).not.toHaveBeenCalledWith({ type: "load-application-state" });
    await client.openExternalUrl("https://example.com/docs");
    expect(desktop.request).toHaveBeenCalledWith({
      type: "open-external-url",
      url: "https://example.com/docs",
    });
    expect(
      await client.showTranscriptSelectionContextMenu({ canChat: true, canAnnotate: false }),
    ).toBe("chat-about-selection");
    expect(desktop.request).toHaveBeenCalledWith({
      type: "show-transcript-selection-context-menu",
      canChat: true,
      canAnnotate: false,
    });
    expect(await client.showComposerContextMenu({ selection: "rough words", x: 12, y: 34 })).toBe(
      "reword",
    );
    expect(desktop.request).toHaveBeenCalledWith({
      type: "show-composer-context-menu",
      selection: "rough words",
      x: 12,
      y: 34,
    });
    expect(
      await client.rewordComposerSelection({
        selection: "rough words",
        prompt: "Be concise",
        workspacePath: "/project",
      }),
    ).toBe("Clear text");
    expect(desktop.request).toHaveBeenCalledWith({
      type: "reword-composer-selection",
      selection: "rough words",
      prompt: "Be concise",
      workspacePath: "/project",
    });
    expect(
      await client.showSessionContextMenu({ sessionId: "session", x: 12, y: 34, resolved: false }),
    ).toBe("rename");
    expect(desktop.request).toHaveBeenCalledWith({
      type: "show-session-context-menu",
      sessionId: "session",
      x: 12,
      y: 34,
      resolved: false,
    });
    expect(
      await client.showSessionContextMenu({
        sessionId: "session",
        x: 12,
        y: 34,
        resolved: false,
        unread: true,
      }),
    ).toBe("rename");
    expect(desktop.request).toHaveBeenCalledWith({
      type: "show-session-context-menu",
      sessionId: "session",
      x: 12,
      y: 34,
      resolved: false,
      unread: true,
    });
    expect(
      await client.showProjectContextMenu({
        path: "/project",
        x: 21,
        y: 43,
        resolvedWorktreeCount: 2,
      }),
    ).toBe("remove-project");
    expect(desktop.request).toHaveBeenCalledWith({
      type: "show-project-context-menu",
      path: "/project",
      x: 21,
      y: 43,
      resolvedWorktreeCount: 2,
    });
    await client.deleteSession("session");
    expect(desktop.request).toHaveBeenCalledWith({ type: "delete-session", sessionId: "session" });
    await client.deleteCakeChatSession("cake-chat");
    expect(desktop.request).toHaveBeenCalledWith({
      type: "delete-cake-chat-session",
      sessionId: "cake-chat",
    });
    await client.setSessionUnread("session", true);
    expect(desktop.request).toHaveBeenCalledWith({
      type: "set-session-unread",
      sessionId: "session",
      unread: true,
    });
    expect(await client.listSessions()).toEqual({ sessions: [], reviewThreads: [] });
    expect(await client.listCakeChatSessions()).toEqual([]);
    expect(await client.loadSession("session")).toBeUndefined();
    expect(await client.suggestFiles("/project", "app")).toEqual([
      { value: "@src/app.ts", label: "app.ts", description: "src/app.ts" },
    ]);
    expect(await client.deletePlugin("example.calendar")).toEqual([]);
    await client.respondToWorkspaceTrust({ operationId, path: "/project", approved: true });
    await client.openWorkspace({ operationId, path: "/project" });
    await client.openEmbeddedEditorSourceControl("/project");
    await client.getChangelog({ operationId, sessionId: "session" });
    await client.reloadPi({ operationId, sessionId: "session" });
    await client.refreshModels({ operationId, sessionId: "session" });
    await client.promptGlobalChat({
      operationId,
      sessionId: "cake-chat",
      text: "",
      renderUserMessageAsMarkdown: true,
      attachments: [
        { kind: "image", name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      newSession: {
        tools: [
          {
            command: "app.state",
            topic: "app",
            summary: "Read application state",
            parameters: { type: "object", properties: {} },
          },
        ],
        configuration: {
          provider: "openai",
          modelId: "gpt-test",
          thinkingLevel: "high",
          fastMode: false,
        },
        name: "Pending title",
      },
    });
    await client.renameGlobalChat({ operationId, sessionId: "cake-chat", name: "Renamed" });
    await client.handoffGlobalChat({
      operationId,
      sessionId: "cake-chat",
      entryId: "assistant-entry",
      prompt: "Continue here",
      resolveSource: true,
    });
    const handleId = crypto.randomUUID();
    await client.steerSubagent({
      parentSessionId: "session",
      handleId,
      text: "Check cancellation too",
    });
    await client.abortSubagent({ parentSessionId: "session", handleId });
    await client.compactSession({ operationId, sessionId: "session" });
    await client.compactGlobalChat({
      operationId,
      sessionId: "cake-chat",
      instructions: "Keep the migration notes",
    });

    expect(desktop.request).toHaveBeenCalledWith({
      type: "respond-workspace-trust",
      requestId: operationId,
      path: "/project",
      approved: true,
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "open-workspace",
      requestId: operationId,
      path: "/project",
      newSession: false,
      sessionId: undefined,
    });
    expect(desktop.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "open-embedded-editor-source-control",
        workspacePath: "/project",
      }),
    );
    expect(desktop.request).toHaveBeenCalledWith({
      type: "get-changelog",
      requestId: operationId,
      sessionId: "session",
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "reload-pi",
      requestId: operationId,
      sessionId: "session",
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "refresh-models",
      requestId: operationId,
      sessionId: "session",
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "prompt-global-chat",
      requestId: operationId,
      sessionId: "cake-chat",
      text: "",
      renderUserMessageAsMarkdown: true,
      attachments: [
        { kind: "image", name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      newSession: {
        tools: [
          {
            command: "app.state",
            topic: "app",
            summary: "Read application state",
            parameters: { type: "object", properties: {} },
          },
        ],
        configuration: {
          provider: "openai",
          modelId: "gpt-test",
          thinkingLevel: "high",
          fastMode: false,
        },
        name: "Pending title",
      },
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "rename-global-chat",
      requestId: operationId,
      sessionId: "cake-chat",
      name: "Renamed",
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "handoff-global-chat",
      requestId: operationId,
      sessionId: "cake-chat",
      entryId: "assistant-entry",
      prompt: "Continue here",
      resolveSource: true,
    });
    expect(desktop.request).toHaveBeenCalledWith({ type: "load-session", sessionId: "session" });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "steer-subagent",
      requestId: expect.any(String),
      parentSessionId: "session",
      handleId,
      text: "Check cancellation too",
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "abort-subagent",
      requestId: expect.any(String),
      parentSessionId: "session",
      handleId,
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "compact-session",
      requestId: operationId,
      sessionId: "session",
      instructions: undefined,
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "compact-global-chat",
      requestId: operationId,
      sessionId: "cake-chat",
      instructions: "Keep the migration notes",
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "suggest-files",
      workspacePath: "/project",
      prefix: "app",
    });
    expect(desktop.request).toHaveBeenCalledWith({
      type: "delete-plugin",
      pluginId: "example.calendar",
    });
  });

  it("projects transport events into Cake application events", () => {
    const desktop = createBridge();
    const client = createDesktopClient(desktop.bridge, desktop.rpcClient);
    const listener = vi.fn();
    client.subscribe(listener);
    const requestId = crypto.randomUUID();

    desktop.emit({ type: "workspace-inspected", requestId, path: "/project", trustRequired: true });
    desktop.emit({
      type: "changelog-snapshot",
      requestId,
      workspacePath: "/project",
      sessionId: "session",
      markdown: "# Changelog",
    });
    desktop.emit({
      type: "notification",
      tone: "error",
      title: "Cleanup failed",
      message: "The worktree remains on disk.",
    });
    expect(listener).toHaveBeenCalledWith({
      type: "workspace-inspected",
      operationId: requestId,
      path: "/project",
      trustRequired: true,
    });
    expect(listener).toHaveBeenCalledWith({
      type: "changelog-received",
      operationId: requestId,
      workspacePath: "/project",
      sessionId: "session",
      markdown: "# Changelog",
    });
    expect(listener).toHaveBeenCalledWith({
      type: "notification",
      tone: "error",
      title: "Cleanup failed",
      message: "The worktree remains on disk.",
    });
  });
});
