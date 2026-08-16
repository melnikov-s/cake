import { describe, expect, it, vi } from "vitest";
import type { CakeDesktopBridge, DesktopEvent, DesktopRequest, DesktopResponse } from "../../../src/ipc/desktop-ipc";
import { createDesktopClient } from "../../../src/renderer/desktop-client";

function createBridge() {
  let listener: ((event: DesktopEvent) => void) | undefined;
  const request = vi.fn(async (input: DesktopRequest): Promise<DesktopResponse> => {
    if ("requestId" in input && input.type !== "respond-ui") return { type: "accepted", requestId: input.requestId };
    if (input.type === "respond-ui") return { type: "ui-response-accepted", uiRequestId: input.uiRequestId };
    if (input.type === "choose-project") return { type: "project-chosen", path: "/project" };
    if (input.type === "get-home-directory") return { type: "home-directory", path: "/home/user" };
    if (input.type === "choose-attachments") return { type: "attachments-chosen", attachments: [] };
    if (input.type === "suggest-files") return { type: "file-suggestions", suggestions: [{ value: "@src/app.ts", label: "app.ts", description: "src/app.ts" }] };
    if (input.type === "list-workspace-files") return { type: "workspace-files", files: ["PLAN.md", "src/app.ts"] };
    if (input.type === "load-window-state") return { type: "window-state-loaded", state: { draft: "", recentProjectPaths: [], theme: "system", thinkingExpanded: false, draftsBySession: {} } };
    if (input.type === "list-sessions") return { type: "sessions-listed", sessions: [], reviewThreads: [] };
    if (input.type === "load-session") return { type: "session-loaded", session: undefined };
    if (input.type === "list-plugins" || input.type === "set-plugin-enabled" || input.type === "delete-plugin") return { type: "plugins-listed", plugins: [] };
    return { type: "window-state-saved" };
  });
  const bridge: CakeDesktopBridge = {
    request,
    subscribe(next) { listener = next; return () => { listener = undefined; }; }
  };
  return { bridge, request, emit: (event: DesktopEvent) => listener?.(event) };
}

describe("desktop client", () => {
  it("maps intent methods to validated bridge requests", async () => {
    const desktop = createBridge();
    const client = createDesktopClient(desktop.bridge);
    const operationId = crypto.randomUUID();

    expect(await client.chooseProject()).toBe("/project");
    expect(await client.listSessions()).toEqual({ sessions: [], reviewThreads: [] });
    expect(await client.loadSession("/project", "session")).toBeUndefined();
    expect(await client.suggestFiles("/project", "app")).toEqual([{ value: "@src/app.ts", label: "app.ts", description: "src/app.ts" }]);
    expect(await client.listWorkspaceFiles("/project")).toEqual(["PLAN.md", "src/app.ts"]);
    expect(await client.deletePlugin("example.calendar")).toEqual([]);
    await client.respondToWorkspaceTrust({ operationId, path: "/project", approved: true });
    await client.openWorkspace({ operationId, path: "/project" });
    await client.inspectChanges({ operationId, workspacePath: "/project", sessionId: "session" });
    await client.getChangelog({ operationId, workspacePath: "/project", sessionId: "session" });
    await client.reloadPi({ operationId, workspacePath: "/project", sessionId: "session" });
    await client.promptGlobalChat({ operationId, sessionId: "cake-chat", text: "", attachments: [{ kind: "image", name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" }] });

    expect(desktop.request).toHaveBeenCalledWith({ type: "respond-workspace-trust", requestId: operationId, path: "/project", approved: true });
    expect(desktop.request).toHaveBeenCalledWith({ type: "open-workspace", requestId: operationId, path: "/project", newSession: false, sessionId: undefined });
    expect(desktop.request).toHaveBeenCalledWith({ type: "inspect-changes", requestId: operationId, workspacePath: "/project", sessionId: "session" });
    expect(desktop.request).toHaveBeenCalledWith({ type: "get-changelog", requestId: operationId, workspacePath: "/project", sessionId: "session" });
    expect(desktop.request).toHaveBeenCalledWith({ type: "reload-pi", requestId: operationId, workspacePath: "/project", sessionId: "session" });
    expect(desktop.request).toHaveBeenCalledWith({ type: "prompt-global-chat", requestId: operationId, sessionId: "cake-chat", text: "", attachments: [{ kind: "image", name: "clipboard.png", mimeType: "image/png", data: "aW1hZ2U=" }] });
    expect(desktop.request).toHaveBeenCalledWith({ type: "load-session", workspacePath: "/project", sessionId: "session" });
    expect(desktop.request).toHaveBeenCalledWith({ type: "suggest-files", workspacePath: "/project", prefix: "app" });
    expect(desktop.request).toHaveBeenCalledWith({ type: "list-workspace-files", workspacePath: "/project" });
    expect(desktop.request).toHaveBeenCalledWith({ type: "delete-plugin", pluginId: "example.calendar" });
  });

  it("projects transport events into Cake application events", () => {
    const desktop = createBridge();
    const client = createDesktopClient(desktop.bridge);
    const listener = vi.fn();
    client.subscribe(listener);
    const requestId = crypto.randomUUID();

    desktop.emit({ type: "workspace-inspected", requestId, path: "/project", trustRequired: true });
    desktop.emit({ type: "changelog-snapshot", requestId, workspacePath: "/project", sessionId: "session", markdown: "# Changelog" });
    desktop.emit({ type: "changes-snapshot", requestId, workspacePath: "/project", sessionId: "session", files: [] });

    expect(listener).toHaveBeenCalledWith({ type: "workspace-inspected", operationId: requestId, path: "/project", trustRequired: true });
    expect(listener).toHaveBeenCalledWith({ type: "changelog-received", operationId: requestId, workspacePath: "/project", sessionId: "session", markdown: "# Changelog" });
    expect(listener).toHaveBeenCalledWith({ type: "changes-received", operationId: requestId, workspacePath: "/project", sessionId: "session", files: [] });
  });
});
