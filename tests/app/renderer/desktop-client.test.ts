import { describe, expect, it, vi } from "vitest";
import type {
  CakeDesktopBridge,
  DesktopEvent,
  DesktopRequest,
  DesktopResponse,
} from "../../../src/ipc/desktop-ipc";
import { createDesktopClient } from "../../../src/renderer/desktop-client";

function createBridge() {
  let listener: ((event: DesktopEvent) => void) | undefined;
  const request = vi.fn(async (input: DesktopRequest): Promise<DesktopResponse> => {
    if ("requestId" in input && input.type !== "respond-ui")
      return { type: "accepted", requestId: input.requestId };
    if (input.type === "respond-ui")
      return { type: "ui-response-accepted", uiRequestId: input.uiRequestId };
    if (input.type === "choose-project") return { type: "project-chosen", path: "/project" };
    if (input.type === "show-transcript-selection-context-menu")
      return {
        type: "transcript-selection-context-menu-closed",
        action: "chat-about-selection",
      };
    if (input.type === "show-session-context-menu")
      return { type: "session-context-menu-closed", action: "rename" };
    if (input.type === "get-home-directory") return { type: "home-directory", path: "/home/user" };
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
    request,
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return { bridge, request, emit: (event: DesktopEvent) => listener?.(event) };
}

describe("desktop client", () => {
  it("maps intent methods to validated bridge requests", async () => {
    const desktop = createBridge();
    const client = createDesktopClient(desktop.bridge);
    const operationId = crypto.randomUUID();

    expect(await client.chooseProject()).toBe("/project");
    expect(
      await client.showTranscriptSelectionContextMenu({ canChat: true, canAnnotate: false }),
    ).toBe("chat-about-selection");
    expect(desktop.request).toHaveBeenCalledWith({
      type: "show-transcript-selection-context-menu",
      canChat: true,
      canAnnotate: false,
    });
    expect(await client.showSessionContextMenu({ sessionId: "session", x: 12, y: 34 })).toBe(
      "rename",
    );
    expect(desktop.request).toHaveBeenCalledWith({
      type: "show-session-context-menu",
      sessionId: "session",
      x: 12,
      y: 34,
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
    const client = createDesktopClient(desktop.bridge);
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
  });
});
