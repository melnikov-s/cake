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
    if (input.type === "load-window-state") return { type: "window-state-loaded", state: { draft: "", recentProjectPaths: [], trustedProjectPaths: [], theme: "system", thinkingExpanded: false, sessionSearch: "", draftsBySession: {} } };
    if (input.type === "list-sessions") return { type: "sessions-listed", sessions: [] };
    if (input.type === "load-session") return { type: "session-loaded", session: undefined };
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
    expect(await client.listSessions()).toEqual([]);
    expect(await client.loadSession("/project", "session")).toBeUndefined();
    expect(await client.suggestFiles("/project", "app")).toEqual([{ value: "@src/app.ts", label: "app.ts", description: "src/app.ts" }]);
    await client.openWorkspace({ operationId, path: "/project", trusted: true });

    expect(desktop.request).toHaveBeenCalledWith({ type: "open-workspace", requestId: operationId, path: "/project", trusted: true, newSession: false, sessionId: undefined, sessionFile: undefined });
    expect(desktop.request).toHaveBeenCalledWith({ type: "load-session", workspacePath: "/project", sessionId: "session" });
    expect(desktop.request).toHaveBeenCalledWith({ type: "suggest-files", workspacePath: "/project", prefix: "app" });
  });

  it("projects transport events into Cake application events", () => {
    const desktop = createBridge();
    const client = createDesktopClient(desktop.bridge);
    const listener = vi.fn();
    client.subscribe(listener);
    const requestId = crypto.randomUUID();

    desktop.emit({ type: "workspace-inspected", requestId, path: "/project", trustRequired: true });

    expect(listener).toHaveBeenCalledWith({ type: "workspace-inspected", operationId: requestId, path: "/project", trustRequired: true });
  });
});
