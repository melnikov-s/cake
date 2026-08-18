import { describe, expect, it } from "vitest";
import { desktopEventSchema, desktopRequestSchema, desktopResponseSchema } from "../../../src/ipc/desktop-ipc";
import { windowViewStateSchema } from "../../../src/ipc/session-contract";

describe("process IPC", () => {
  it("accepts session lifecycle and prompt requests", () => {
    const requestId = crypto.randomUUID();
    expect(desktopRequestSchema.parse({ type: "open-workspace", requestId, path: "/project", newSession: true })).toMatchObject({ type: "open-workspace", requestId, newSession: true });
    expect(desktopRequestSchema.parse({ type: "respond-workspace-trust", requestId, path: "/project", approved: true })).toMatchObject({ approved: true });
    expect(desktopRequestSchema.parse({ type: "prompt", requestId, sessionId: "session", text: "hello", delivery: "prompt", attachments: [] })).toMatchObject({ text: "hello" });
    expect(desktopRequestSchema.parse({ type: "prompt", requestId, sessionId: "session", text: "", delivery: "prompt", attachments: [{ kind: "image", name: "paste.png", mimeType: "image/png", data: "aW1hZ2U=" }] })).toMatchObject({ text: "", attachments: [{ kind: "image" }] });
    expect(() => desktopRequestSchema.parse({ type: "prompt", requestId, sessionId: "session", text: "", delivery: "prompt", attachments: [] })).toThrow();
    expect(desktopRequestSchema.parse({ type: "prompt-global-chat", requestId, sessionId: "cake-chat", text: "", attachments: [{ kind: "image", name: "paste.png", mimeType: "image/png", data: "aW1hZ2U=" }] })).toMatchObject({ text: "", attachments: [{ kind: "image" }] });
    expect(() => desktopRequestSchema.parse({ type: "prompt-global-chat", requestId, sessionId: "cake-chat", text: "", attachments: [] })).toThrow();
    expect(desktopRequestSchema.parse({ type: "list-sessions" })).toEqual({ type: "list-sessions" });
    expect(desktopRequestSchema.parse({ type: "set-utility-model", model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" } })).toMatchObject({ type: "set-utility-model", model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" } });
    expect(desktopRequestSchema.parse({ type: "set-utility-model" })).toEqual({ type: "set-utility-model" });
    expect(desktopRequestSchema.parse({ type: "resolve-sessions", sessionIds: ["session"], resolved: true })).toEqual({ type: "resolve-sessions", sessionIds: ["session"], resolved: true });
    expect(desktopRequestSchema.parse({ type: "load-session", sessionId: "session" })).toEqual({ type: "load-session", sessionId: "session" });
    expect(desktopRequestSchema.parse({ type: "suggest-files", workspacePath: "/project", prefix: "src/app" })).toEqual({ type: "suggest-files", workspacePath: "/project", prefix: "src/app" });
    expect(desktopRequestSchema.parse({ type: "list-workspace-files", workspacePath: "/project" })).toEqual({ type: "list-workspace-files", workspacePath: "/project" });
    expect(desktopRequestSchema.parse({ type: "read-workspace-file", workspacePath: "/project", path: "src/app.ts" })).toEqual({ type: "read-workspace-file", workspacePath: "/project", path: "src/app.ts" });
    expect(desktopRequestSchema.parse({ type: "compile-inline-widget", language: "react", capability: "request", source: "export default () => <div />" })).toMatchObject({ language: "react", capability: "request" });
    const widgetToken = "00000000-0000-4000-8000-000000000001";
    expect(desktopResponseSchema.parse({ type: "inline-widget-compiled", widget: { token: widgetToken, url: `cake-widget://document/${widgetToken}` } })).toMatchObject({ widget: { token: widgetToken } });
    expect(desktopResponseSchema.safeParse({ type: "inline-widget-compiled", widget: { token: widgetToken, url: "cake-widget://document/00000000-0000-4000-8000-000000000002" } }).success).toBe(false);
    expect(desktopRequestSchema.parse({ type: "repair-inline-widget", sessionId: "session", language: "html", capability: "display", source: "<strong>Broken</strong>", context: "Explain the result" })).toMatchObject({ type: "repair-inline-widget", language: "html", capability: "display" });
    expect(desktopRequestSchema.parse({ type: "set-pi-setting", requestId, sessionId: "session", update: { key: "transport", value: "websocket" } })).toMatchObject({ update: { key: "transport", value: "websocket" } });
    expect(desktopRequestSchema.parse({ type: "set-pi-setting", requestId, sessionId: "session", update: { key: "skills", value: ["skills", "!skills/excluded"] } })).toMatchObject({ update: { key: "skills" } });
    expect(desktopRequestSchema.parse({ type: "reload-pi", requestId, sessionId: "session" })).toMatchObject({ type: "reload-pi", requestId });
    expect(desktopRequestSchema.parse({ type: "get-changelog", requestId, sessionId: "session" })).toMatchObject({ type: "get-changelog", requestId });
    expect(desktopRequestSchema.parse({ type: "inspect-changes", requestId, sessionId: "session", source: "working-tree" })).toMatchObject({ type: "inspect-changes", sessionId: "session" });
    const anchor = { path: "src/app.ts", start: { diffLine: 1, newLine: 4 }, end: { diffLine: 1, newLine: 4 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" };
    expect(desktopRequestSchema.parse({ type: "create-review-thread", sessionId: "session", anchor, body: "Why?" })).toMatchObject({ body: "Why?" });
    expect(desktopRequestSchema.parse({ type: "submit-review-thread", requestId, sessionId: "session", threadId: crypto.randomUUID() })).toMatchObject({ type: "submit-review-thread" });
    expect(desktopEventSchema.parse({ type: "changelog-snapshot", requestId, workspacePath: "/project", sessionId: "session", markdown: "# Changelog" })).toMatchObject({ markdown: "# Changelog" });
    expect(desktopEventSchema.parse({ type: "changes-snapshot", requestId, workspacePath: "/project", sessionId: "session", source: "working-tree", turns: [], files: [] })).toMatchObject({ type: "changes-snapshot", sessionId: "session" });
    expect(desktopRequestSchema.safeParse({ type: "set-pi-setting", requestId, sessionId: "session", update: { key: "transport", value: "invalid" } }).success).toBe(false);
  });

  it("clips oversized projected metadata instead of dropping the IPC payload", () => {
    const result = desktopEventSchema.safeParse({
      type: "part-updated",
      sessionId: "session",
      part: { id: "message", kind: "text", role: "assistant", text: "x".repeat(262_145), status: "streaming" }
    });
    expect(result.success).toBe(true);
    if (!result.success || result.data.type !== "part-updated" || result.data.part.kind !== "text") throw new Error("Expected a clipped text projection");
    expect(result.data.part.text).toHaveLength(262_144);

    const ui = desktopEventSchema.parse({
      type: "ui-request",
      requestId: crypto.randomUUID(),
      uiRequestId: crypto.randomUUID(),
      kind: "text",
      title: "t".repeat(1_024),
      message: "m".repeat(8_192)
    });
    expect(ui.type === "ui-request" && ui.title).toHaveLength(512);
    expect(ui.type === "ui-request" && ui.message).toHaveLength(4_096);

    const response = desktopResponseSchema.parse({
      type: "sessions-listed",
      sessions: [{
        id: "session",
        title: "s".repeat(2_048),
        created: new Date(0).toISOString(),
        modified: new Date(0).toISOString(),
        messageCount: 1,
        resolved: false,
        workspacePath: "/project",
        workspaceName: "Project"
      }],
      reviewThreads: []
    });
    expect(response.type === "sessions-listed" && response.sessions[0]?.title).toHaveLength(1_024);
  });

  it("validates correlated secret UI responses without logging them", () => {
    const requestId = crypto.randomUUID();
    const uiRequestId = crypto.randomUUID();
    expect(desktopEventSchema.parse({ type: "ui-request", requestId, uiRequestId, kind: "secret", title: "Sign in", message: "API key" })).toMatchObject({ uiRequestId, kind: "secret" });
    expect(desktopRequestSchema.parse({ type: "respond-ui", requestId, sessionId: "session", uiRequestId, value: "secret", cancelled: false })).toMatchObject({ value: "secret" });
  });

  it("rejects malformed project and UI requests", () => {
    expect(desktopRequestSchema.safeParse({ type: "open-workspace", requestId: "bad", path: "/project" }).success).toBe(false);
    expect(desktopRequestSchema.safeParse({ type: "respond-ui", requestId: crypto.randomUUID(), uiRequestId: "bad", cancelled: false }).success).toBe(false);
  });

  it("persists session selection without an absolute Pi session filename", () => {
    expect(windowViewStateSchema.parse({
      projectPath: "/project",
      selectedSessionId: "session"
    })).toEqual({
      projectPath: "/project",
      selectedSessionId: "session",
      recentProjectPaths: [],
      draft: "",
      theme: "system",
      thinkingExpanded: false,
      draftsBySession: {}
    });
  });

  it("persists the active Cake Chat separately from the background project", () => {
    expect(windowViewStateSchema.parse({
      projectPath: "/project",
      selectedSessionId: "project-session",
      activeConversation: { kind: "cake-chat", sessionId: "cake-chat-session" }
    }).activeConversation).toEqual({ kind: "cake-chat", sessionId: "cake-chat-session" });
  });
});
