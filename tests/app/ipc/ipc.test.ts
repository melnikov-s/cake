import { describe, expect, it } from "vitest";
import {
  desktopEventSchema,
  desktopRequestSchema,
  desktopResponseSchema,
} from "../../../src/ipc/desktop-ipc";

describe("process IPC", () => {
  it("requires an actual selection before opening the composer reword menu", () => {
    expect(
      desktopRequestSchema.parse({
        type: "show-composer-context-menu",
        selection: "selected words",
        x: 12,
        y: 34,
      }),
    ).toEqual({
      type: "show-composer-context-menu",
      selection: "selected words",
      x: 12,
      y: 34,
    });
    expect(() =>
      desktopRequestSchema.parse({
        type: "show-composer-context-menu",
        selection: "",
        x: 12,
        y: 34,
      }),
    ).toThrow();
  });

  it("accepts an optional project workspace for composer rewording", () => {
    expect(
      desktopRequestSchema.parse({
        type: "reword-composer-selection",
        selection: "selected words",
        workspacePath: "/project",
      }),
    ).toEqual({
      type: "reword-composer-selection",
      selection: "selected words",
      workspacePath: "/project",
    });
    expect(
      desktopRequestSchema.parse({
        type: "reword-composer-selection",
        selection: "selected words",
      }),
    ).toEqual({ type: "reword-composer-selection", selection: "selected words" });
  });

  it("accepts remaining desktop requests", () => {
    const requestId = crypto.randomUUID();
    expect(
      desktopRequestSchema.parse({
        type: "respond-workspace-trust",
        requestId,
        path: "/project",
        approved: true,
      }),
    ).toMatchObject({ approved: true });
    expect(
      desktopRequestSchema.parse({
        type: "set-utility-model",
        model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" },
      }),
    ).toMatchObject({
      type: "set-utility-model",
      model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" },
    });
    expect(desktopRequestSchema.parse({ type: "set-utility-model" })).toEqual({
      type: "set-utility-model",
    });
    expect(
      desktopRequestSchema.parse({
        type: "suggest-files",
        workspacePath: "/project",
        prefix: "src/app",
      }),
    ).toEqual({ type: "suggest-files", workspacePath: "/project", prefix: "src/app" });
    expect(
      desktopRequestSchema.parse({
        type: "read-workspace-file",
        workspacePath: "/project",
        path: "src/app.ts",
      }),
    ).toEqual({ type: "read-workspace-file", workspacePath: "/project", path: "src/app.ts" });
    expect(
      desktopRequestSchema.parse({
        type: "compile-inline-widget",
        language: "react",
        capability: "request",
        source: "export default () => <div />",
      }),
    ).toMatchObject({ language: "react", capability: "request" });
    const widgetToken = "00000000-0000-4000-8000-000000000001";
    expect(
      desktopResponseSchema.parse({
        type: "inline-widget-compiled",
        widget: { token: widgetToken, url: `cake-widget://document/${widgetToken}` },
      }),
    ).toMatchObject({ widget: { token: widgetToken } });
    expect(
      desktopResponseSchema.safeParse({
        type: "inline-widget-compiled",
        widget: {
          token: widgetToken,
          url: "cake-widget://document/00000000-0000-4000-8000-000000000002",
        },
      }).success,
    ).toBe(false);
    expect(
      desktopRequestSchema.parse({
        type: "repair-inline-widget",
        sessionId: "session",
        language: "html",
        capability: "display",
        source: "<strong>Broken</strong>",
        context: "Explain the result",
      }),
    ).toMatchObject({ type: "repair-inline-widget", language: "html", capability: "display" });
    expect(
      desktopRequestSchema.parse({
        type: "set-pi-setting",
        requestId,
        sessionId: "session",
        update: { key: "transport", value: "websocket" },
      }),
    ).toMatchObject({ update: { key: "transport", value: "websocket" } });
    expect(
      desktopRequestSchema.parse({
        type: "set-pi-setting",
        requestId,
        sessionId: "session",
        update: { key: "skills", value: ["skills", "!skills/excluded"] },
      }),
    ).toMatchObject({ update: { key: "skills" } });
    expect(
      desktopRequestSchema.parse({ type: "reload-pi", requestId, sessionId: "session" }),
    ).toMatchObject({ type: "reload-pi", requestId });
    expect(
      desktopRequestSchema.parse({ type: "refresh-models", requestId, sessionId: "session" }),
    ).toMatchObject({ type: "refresh-models", requestId });
    expect(
      desktopRequestSchema.parse({ type: "get-changelog", requestId, sessionId: "session" }),
    ).toMatchObject({ type: "get-changelog", requestId });
    expect(
      desktopEventSchema.parse({
        type: "changelog-snapshot",
        requestId,
        workspacePath: "/project",
        sessionId: "session",
        markdown: "# Changelog",
      }),
    ).toMatchObject({ markdown: "# Changelog" });
    expect(
      desktopRequestSchema.safeParse({
        type: "set-pi-setting",
        requestId,
        sessionId: "session",
        update: { key: "transport", value: "invalid" },
      }).success,
    ).toBe(false);
  });

  it("clips oversized projected metadata instead of dropping the IPC payload", () => {
    const result = desktopEventSchema.safeParse({
      type: "part-updated",
      sessionId: "session",
      part: {
        id: "message",
        kind: "text",
        role: "assistant",
        text: "x".repeat(262_145),
        status: "streaming",
      },
    });
    expect(result.success).toBe(true);
    if (!result.success || result.data.type !== "part-updated" || result.data.part.kind !== "text")
      throw new Error("Expected a clipped text projection");
    expect(result.data.part.text).toHaveLength(262_144);

    const ui = desktopEventSchema.parse({
      type: "ui-request",
      requestId: crypto.randomUUID(),
      uiRequestId: crypto.randomUUID(),
      kind: "text",
      title: "t".repeat(1_024),
      message: "m".repeat(8_192),
    });
    expect(ui.type === "ui-request" && ui.title).toHaveLength(512);
    expect(ui.type === "ui-request" && ui.message).toHaveLength(4_096);
  });

  it("validates correlated secret UI responses without logging them", () => {
    const requestId = crypto.randomUUID();
    const uiRequestId = crypto.randomUUID();
    expect(
      desktopEventSchema.parse({
        type: "ui-request",
        requestId,
        uiRequestId,
        kind: "secret",
        title: "Sign in",
        message: "API key",
      }),
    ).toMatchObject({ uiRequestId, kind: "secret" });
    expect(
      desktopRequestSchema.parse({
        type: "respond-ui",
        requestId,
        sessionId: "session",
        uiRequestId,
        value: "secret",
        cancelled: false,
      }),
    ).toMatchObject({ value: "secret" });
  });

  it("rejects malformed project and UI requests", () => {
    expect(
      desktopRequestSchema.safeParse({
        type: "inspect-workspace",
        requestId: "bad",
        path: "/project",
      }).success,
    ).toBe(false);
    expect(
      desktopRequestSchema.safeParse({
        type: "respond-ui",
        requestId: crypto.randomUUID(),
        uiRequestId: "bad",
        cancelled: false,
      }).success,
    ).toBe(false);
  });
});
