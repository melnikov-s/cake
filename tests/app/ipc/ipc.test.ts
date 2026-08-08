import { describe, expect, it } from "vitest";
import { desktopEventSchema, desktopRequestSchema } from "../../../src/ipc/desktop-ipc";

describe("process IPC", () => {
  it("accepts session lifecycle and prompt requests", () => {
    const requestId = crypto.randomUUID();
    expect(desktopRequestSchema.parse({ type: "open-workspace", requestId, path: "/project", trusted: true, newSession: true })).toMatchObject({ type: "open-workspace", requestId, newSession: true });
    expect(desktopRequestSchema.parse({ type: "prompt", requestId, workspacePath: "/project", sessionId: "session", text: "hello", delivery: "prompt", attachments: [] })).toMatchObject({ text: "hello" });
    expect(desktopRequestSchema.parse({ type: "list-sessions" })).toEqual({ type: "list-sessions" });
    expect(desktopRequestSchema.parse({ type: "load-session", workspacePath: "/project", sessionId: "session" })).toEqual({ type: "load-session", workspacePath: "/project", sessionId: "session" });
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
    expect(desktopRequestSchema.safeParse({ type: "open-workspace", requestId: "bad", path: "/project", trusted: true }).success).toBe(false);
    expect(desktopRequestSchema.safeParse({ type: "respond-ui", requestId: crypto.randomUUID(), uiRequestId: "bad", cancelled: false }).success).toBe(false);
  });
});
