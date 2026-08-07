import { describe, expect, it } from "vitest";
import { agentCommandSchema, agentEventSchema } from "./agent-ipc";
import { desktopRequestSchema } from "./desktop-ipc";

describe("process IPC", () => {
  it("accepts known desktop requests", () => {
    const requestId = crypto.randomUUID();
    expect(desktopRequestSchema.parse({ type: "start-foundation-check", requestId })).toEqual({
      type: "start-foundation-check",
      requestId
    });
  });

  it("rejects oversized agent deltas", () => {
    const result = agentEventSchema.safeParse({
      type: "text-delta",
      requestId: crypto.randomUUID(),
      text: "x".repeat(16_385)
    });

    expect(result.success).toBe(false);
  });

  it("validates correlated extension UI responses", () => {
    const requestId = crypto.randomUUID();
    const uiRequestId = crypto.randomUUID();

    expect(agentEventSchema.parse({
      type: "ui-request",
      requestId,
      uiRequestId,
      kind: "confirm",
      title: "Continue?",
      message: "Confirm the Cake UI bridge."
    })).toMatchObject({ requestId, uiRequestId });

    expect(agentCommandSchema.parse({
      type: "ui-response",
      requestId,
      uiRequestId,
      accepted: true
    })).toMatchObject({ accepted: true });
  });

  it("rejects malformed desktop UI responses", () => {
    expect(desktopRequestSchema.safeParse({
      type: "respond-ui",
      requestId: "not-a-uuid",
      uiRequestId: crypto.randomUUID(),
      accepted: true
    }).success).toBe(false);
  });
});
