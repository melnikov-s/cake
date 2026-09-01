import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  privilegedEventSchema,
  privilegedRequestSchema,
  privilegedResponseSchema,
} from "../../../src/ipc/privileged-contract";

describe("process IPC", () => {
  it("requires an actual selection before opening the composer reword menu", () => {
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
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
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "show-composer-context-menu",
        selection: "",
        x: 12,
        y: 34,
      }),
    ).toThrow();
  });

  it("accepts an optional project workspace for composer rewording", () => {
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
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
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "reword-composer-selection",
        selection: "selected words",
      }),
    ).toEqual({ type: "reword-composer-selection", selection: "selected words" });
  });

  it("accepts remaining desktop requests", () => {
    const requestId = crypto.randomUUID();
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "respond-workspace-trust",
        requestId,
        path: "/project",
        approved: true,
      }),
    ).toMatchObject({ approved: true });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "set-utility-model",
        model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" },
      }),
    ).toMatchObject({
      type: "set-utility-model",
      model: { provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" },
    });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({ type: "set-utility-model" }),
    ).toEqual({
      type: "set-utility-model",
    });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "suggest-files",
        workspacePath: "/project",
        prefix: "src/app",
      }),
    ).toEqual({ type: "suggest-files", workspacePath: "/project", prefix: "src/app" });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "read-workspace-file",
        workspacePath: "/project",
        path: "src/app.ts",
      }),
    ).toEqual({ type: "read-workspace-file", workspacePath: "/project", path: "src/app.ts" });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "compile-inline-widget",
        language: "react",
        capability: "request",
        source: "export default () => <div />",
      }),
    ).toMatchObject({ language: "react", capability: "request" });
    const widgetToken = "00000000-0000-4000-8000-000000000001";
    expect(
      Schema.decodeUnknownSync(privilegedResponseSchema)({
        type: "inline-widget-compiled",
        widget: { token: widgetToken, url: `cake-widget://document/${widgetToken}` },
      }),
    ).toMatchObject({ widget: { token: widgetToken } });
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(privilegedResponseSchema)({
          type: "inline-widget-compiled",
          widget: {
            token: widgetToken,
            url: "cake-widget://document/00000000-0000-4000-8000-000000000002",
          },
        }),
      ),
    ).toBe(false);
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "repair-inline-widget",
        sessionId: "session",
        language: "html",
        capability: "display",
        source: "<strong>Broken</strong>",
        context: "Explain the result",
      }),
    ).toMatchObject({ type: "repair-inline-widget", language: "html", capability: "display" });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "set-pi-setting",
        requestId,
        sessionId: "session",
        update: { key: "transport", value: "websocket" },
      }),
    ).toMatchObject({ update: { key: "transport", value: "websocket" } });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "set-pi-setting",
        requestId,
        sessionId: "session",
        update: { key: "skills", value: ["skills", "!skills/excluded"] },
      }),
    ).toMatchObject({ update: { key: "skills" } });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "reload-pi",
        requestId,
        sessionId: "session",
      }),
    ).toMatchObject({ type: "reload-pi", requestId });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "refresh-models",
        requestId,
        sessionId: "session",
      }),
    ).toMatchObject({ type: "refresh-models", requestId });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
        type: "get-changelog",
        requestId,
        sessionId: "session",
      }),
    ).toMatchObject({ type: "get-changelog", requestId });
    expect(
      Schema.decodeUnknownSync(privilegedEventSchema)({
        type: "changelog-snapshot",
        requestId,
        workspacePath: "/project",
        sessionId: "session",
        markdown: "# Changelog",
      }),
    ).toMatchObject({ markdown: "# Changelog" });
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(privilegedRequestSchema)({
          type: "set-pi-setting",
          requestId,
          sessionId: "session",
          update: { key: "transport", value: "invalid" },
        }),
      ),
    ).toBe(false);
  });

  it("clips oversized projected metadata instead of dropping the IPC payload", () => {
    const result = Schema.decodeUnknownOption(privilegedEventSchema)({
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
    expect(Option.isSome(result)).toBe(true);
    if (
      Option.isNone(result) ||
      result.value.type !== "part-updated" ||
      result.value.part.kind !== "text"
    )
      throw new Error("Expected a clipped text projection");
    expect(result.value.part.text).toHaveLength(262_144);

    const ui = Schema.decodeUnknownSync(privilegedEventSchema)({
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
      Schema.decodeUnknownSync(privilegedEventSchema)({
        type: "ui-request",
        requestId,
        uiRequestId,
        kind: "secret",
        title: "Sign in",
        message: "API key",
      }),
    ).toMatchObject({ uiRequestId, kind: "secret" });
    expect(
      Schema.decodeUnknownSync(privilegedRequestSchema)({
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
      Option.isSome(
        Schema.decodeUnknownOption(privilegedRequestSchema)({
          type: "inspect-workspace",
          requestId: "bad",
          path: "/project",
        }),
      ),
    ).toBe(false);
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(privilegedRequestSchema)({
          type: "respond-ui",
          requestId: crypto.randomUUID(),
          uiRequestId: "bad",
          cancelled: false,
        }),
      ),
    ).toBe(false);
  });
});
