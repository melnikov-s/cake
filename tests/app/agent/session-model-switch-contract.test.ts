import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  BackendAgentInvocation,
  backendAgentCommands,
} from "../../../src/contracts/application/backend-agent-control";
import { backendAgentTools } from "../../../src/contracts/application/backend-agent-tools";
import { SessionModelSwitchInput } from "../../../src/contracts/conversations/session-model-switch";
import { createSessionFamilyOperations } from "../../../src/domain/session-families/cake-session-family-operations";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";

const selection = {
  provider: "fixture",
  modelId: "new",
  thinkingLevel: "off" as const,
  fastMode: false,
};
describe("sessions.set-model contract", () => {
  it("requires an explicit target and model; shares preset/explicit selection decoding", () => {
    const decode = Schema.decodeUnknownSync(SessionModelSwitchInput);
    expect(decode({ sessionId: "parent", model: "Fast" }).model).toBe("Fast");
    expect(decode({ sessionId: "cake-chat", model: selection }).model).toEqual(selection);
    for (const input of [
      { model: "Fast" },
      { sessionId: "parent" },
      { sessionId: "parent", model: { provider: "x", modelId: "y" } },
    ])
      expect(() => decode(input)).toThrow();
    expect(
      Schema.decodeUnknownSync(BackendAgentInvocation)({
        name: "sessions.set-model",
        arguments: { sessionId: "parent", model: "Fast" },
      }).name,
    ).toBe("sessions.set-model");
  });

  it("publishes help and status discovery to both Project Sessions and permanent chats", () => {
    const tools = backendAgentTools();
    for (const command of ["sessions.set-model", "sessions.model-switch-status"]) {
      expect(backendAgentCommands.has(command)).toBe(true);
      const help = tools.find((tool) => tool.command === command);
      expect(help?.topic).toBe("sessions");
      expect(help?.parameters.required).toContain("sessionId");
      expect(help?.guidance?.join(" ")).toMatch(/receipt|accepted/);
    }
  });

  it("carries the trusted tool-call ID, never a model-supplied self-switch escape hatch", async () => {
    const invoke = vi.fn(async () => ({}));
    const project = createSessionFamilyOperations(() => ({
      invokeAppControl: invoke,
      createChildSession: vi.fn(),
    }));
    const operation = project.find((entry) => entry.command === "sessions.set-model");
    expect(operation).toBeDefined();
    const context = {
      signal: new AbortController().signal,
      toolCallId: "trusted",
      runtime: { sessionId: "caller" },
    };
    await operation?.execute({ sessionId: "caller", model: selection }, context);
    expect(invoke.mock.calls[0]).toEqual([
      "sessions.set-model",
      { sessionId: "caller", model: selection },
      context.signal,
      undefined,
      "trusted",
    ]);
    const globalInvoke = vi.fn(async () => ({}));
    const global = createGlobalControlOperations(
      {
        tools: backendAgentTools().filter((tool) => tool.command === "sessions.set-model"),
        invoke: globalInvoke,
      },
      () => selection,
    );
    await global[0]?.execute({ sessionId: "caller", model: "Fast" }, context);
    expect(globalInvoke.mock.calls[0]).toEqual([
      {
        name: "sessions.set-model",
        arguments: { sessionId: "caller", model: "Fast" },
        toolCallId: "trusted",
      },
      context.signal,
    ]);
    expect(() =>
      Schema.decodeUnknownSync(SessionModelSwitchInput)(
        { sessionId: "caller", model: "Fast", toolCallId: "spoofed" },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});
