import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { cakeEventSchema, type CakeEvent } from "../../../src/ipc/cake-rpc-contract";
import { ProjectSessionIntegrationHost } from "../../../src/services/pi/ProjectSessionIntegrationHost";

describe("ProjectSessionIntegrationHost application controls", () => {
  it("waits for the renderer's acknowledged result", async () => {
    let request: Extract<CakeEvent, { type: "project-session-control-requested" }> | undefined;
    const host = new ProjectSessionIntegrationHost({
      workspacePath: "/projects/cake",
      agentDir: "/agent",
      sessionDir: "/sessions",
      emit: vi.fn(),
      emitApplicationControl: (event) => {
        request = event;
      },
    });

    const integrations = host.projectSessionRuntimeIntegrations("source-session");
    const pending = integrations.requestApplicationControl(
      {
        _tag: "CreateDraft",
        name: "Authentication follow-up",
        initialPrompt: "Review the authentication flow.",
      },
      new AbortController().signal,
    );

    expect(request).toEqual({
      type: "project-session-control-requested",
      sessionId: "source-session",
      controlRequestId: expect.any(String),
      invocation: {
        _tag: "CreateDraft",
        name: "Authentication follow-up",
        initialPrompt: "Review the authentication flow.",
      },
    });
    expect(() => Schema.decodeUnknownSync(cakeEventSchema)(request)).not.toThrow();
    if (!request) throw new Error("Expected a control request");
    host.dispatch({
      type: "respond-project-session-control",
      controlRequestId: request.controlRequestId,
      result: { ok: true, sessionId: "draft-session", status: "saved-draft" },
    });

    await expect(pending).resolves.toEqual({
      ok: true,
      sessionId: "draft-session",
      status: "saved-draft",
    });
    host[Symbol.dispose]();
  });

  it("settles a pending request when its tool call is aborted", async () => {
    const controller = new AbortController();
    const host = new ProjectSessionIntegrationHost({
      workspacePath: "/projects/cake",
      agentDir: "/agent",
      sessionDir: "/sessions",
      emit: vi.fn(),
      emitApplicationControl: vi.fn(),
    });

    const pending = host
      .projectSessionRuntimeIntegrations("source-session")
      .requestApplicationControl(
        {
          _tag: "CreateDraft",
          name: "Authentication follow-up",
          initialPrompt: "Review the authentication flow.",
        },
        controller.signal,
      );
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: "The request was cancelled." });
    host[Symbol.dispose]();
  });
});
