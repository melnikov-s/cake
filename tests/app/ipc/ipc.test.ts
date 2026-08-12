import { describe, expect, it } from "vitest";
import { desktopEventSchema, desktopRequestSchema } from "../../../src/ipc/desktop-ipc";

describe("process IPC", () => {
  it("accepts session lifecycle and prompt requests", () => {
    const requestId = crypto.randomUUID();
    expect(desktopRequestSchema.parse({ type: "open-workspace", requestId, path: "/project", newSession: true })).toMatchObject({ type: "open-workspace", requestId, newSession: true });
    expect(desktopRequestSchema.parse({ type: "respond-workspace-trust", requestId, path: "/project", approved: true })).toMatchObject({ approved: true });
    expect(desktopRequestSchema.parse({ type: "prompt", requestId, workspacePath: "/project", sessionId: "session", text: "hello", delivery: "prompt", attachments: [] })).toMatchObject({ text: "hello" });
    expect(desktopRequestSchema.parse({ type: "list-sessions" })).toEqual({ type: "list-sessions" });
    expect(desktopRequestSchema.parse({ type: "load-session", workspacePath: "/project", sessionId: "session" })).toEqual({ type: "load-session", workspacePath: "/project", sessionId: "session" });
    expect(desktopRequestSchema.parse({ type: "suggest-files", workspacePath: "/project", prefix: "src/app" })).toEqual({ type: "suggest-files", workspacePath: "/project", prefix: "src/app" });
    expect(desktopRequestSchema.parse({ type: "set-pi-setting", requestId, workspacePath: "/project", sessionId: "session", update: { key: "transport", value: "websocket" } })).toMatchObject({ update: { key: "transport", value: "websocket" } });
    expect(desktopRequestSchema.parse({ type: "get-changelog", requestId, workspacePath: "/project", sessionId: "session" })).toMatchObject({ type: "get-changelog", requestId });
    const anchor = { path: "src/app.ts", start: { diffLine: 1, newLine: 4 }, end: { diffLine: 1, newLine: 4 }, selectedText: "value", contextBefore: "", contextAfter: "", diff: "+value" };
    expect(desktopRequestSchema.parse({ type: "create-review-thread", workspacePath: "/project", sessionId: "session", anchor, body: "Why?" })).toMatchObject({ body: "Why?" });
    expect(desktopRequestSchema.parse({ type: "submit-review-threads", requestId, workspacePath: "/project", sessionId: "session", threadIds: [crypto.randomUUID()] })).toMatchObject({ type: "submit-review-threads" });
    expect(desktopEventSchema.parse({ type: "changelog-snapshot", requestId, workspacePath: "/project", sessionId: "session", markdown: "# Changelog" })).toMatchObject({ markdown: "# Changelog" });
    expect(desktopRequestSchema.safeParse({ type: "set-pi-setting", requestId, workspacePath: "/project", sessionId: "session", update: { key: "transport", value: "invalid" } }).success).toBe(false);
  });

  it("rejects oversized transcript parts", () => {
    const result = desktopEventSchema.safeParse({
      type: "part-updated",
      sessionId: "session",
      part: { id: "message", kind: "text", role: "assistant", text: "x".repeat(262_145), status: "streaming" }
    });
    expect(result.success).toBe(false);
  });

  it("validates correlated secret UI responses without logging them", () => {
    const requestId = crypto.randomUUID();
    const uiRequestId = crypto.randomUUID();
    expect(desktopEventSchema.parse({ type: "ui-request", requestId, uiRequestId, kind: "secret", title: "Sign in", message: "API key" })).toMatchObject({ uiRequestId, kind: "secret" });
    expect(desktopRequestSchema.parse({ type: "respond-ui", requestId, workspacePath: "/project", sessionId: "session", uiRequestId, value: "secret", cancelled: false })).toMatchObject({ value: "secret" });
  });

  it("rejects malformed project and UI requests", () => {
    expect(desktopRequestSchema.safeParse({ type: "open-workspace", requestId: "bad", path: "/project" }).success).toBe(false);
    expect(desktopRequestSchema.safeParse({ type: "respond-ui", requestId: crypto.randomUUID(), uiRequestId: "bad", cancelled: false }).success).toBe(false);
  });
});
