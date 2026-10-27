import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import {
  cakeToolCallKey,
  reportSlowCakeToolExecution,
} from "../../../src/services/pi/runtime/cake-tool-timing";

const callId = "PRIVATE_CALL_ID";
const unmeasured = [
  "model-generation",
  "sdk-admission",
  "environment-acquisition",
  "result-settlement-delivery",
];

afterEach(() => vi.restoreAllMocks());

describe("Cake SDK execution timing diagnostics", () => {
  it.each(["pi", "durable"] as const)(
    "reuses %s SDK duration without inventing timing for unmeasured phases",
    (runtime) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const clock = vi.spyOn(performance, "now");
      reportSlowCakeToolExecution(runtime, {
        toolName: "cake",
        toolCallId: callId,
        durationMs: 1_200,
        isError: false,
      });
      expect(clock).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledExactlyOnceWith("Slow Cake tool execution", {
        runtime,
        boundary: "sdk-execute",
        call: cakeToolCallKey(callId),
        durationMs: 1_200,
        isError: false,
        unmeasured,
      });
      expect(cakeToolCallKey(callId)).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE");
    },
  );

  it("correlates the wider SDK span with unchanged overlapping gateway phases", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new CakeOperationRegistry([
      {
        command: "context.compact",
        topic: "context",
        summary: "Fixture",
        inputSchema: Schema.Struct({}),
        result: "Fixture result",
        examples: [{}],
        async execute() {
          now += 1_200;
          return "PRIVATE_RESULT";
        },
      },
    ]);
    const result = await registry.invoke(
      { command: "context.compact" },
      { toolCallId: callId, signal: new AbortController().signal, runtime: {} },
    );
    expect(result.structuredContent).toBe("PRIVATE_RESULT");
    reportSlowCakeToolExecution("pi", {
      toolName: "cake",
      toolCallId: callId,
      durationMs: 1_500,
      isError: false,
    });
    expect(warning.mock.calls).toEqual([
      [
        "Slow Cake operation",
        {
          command: "context.compact",
          call: cakeToolCallKey(callId),
          completed: true,
          phase: "format",
          phasesMs: { input: 0, execute: 1_200, validate: 0, project: 0, format: 0 },
          totalMs: 1_200,
        },
      ],
      [
        "Slow Cake tool execution",
        {
          runtime: "pi",
          boundary: "sdk-execute",
          call: cakeToolCallKey(callId),
          durationMs: 1_500,
          isError: false,
          unmeasured,
        },
      ],
    ]);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE");
  });

  it("ignores missing durations, fast execution and unrelated tools", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const execution = { toolName: "cake", toolCallId: callId, isError: false };
    reportSlowCakeToolExecution("pi", execution);
    reportSlowCakeToolExecution("durable", { ...execution, durationMs: 999 });
    reportSlowCakeToolExecution("pi", { ...execution, toolName: "PRIVATE", durationMs: 5_000 });
    expect(warning).not.toHaveBeenCalled();
  });

  it("reports failed execution at the threshold without logging the original event payload", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const event = {
      toolName: "cake",
      toolCallId: callId,
      durationMs: 1_000,
      isError: true,
      result: { content: "PRIVATE_FAILURE", details: { credential: "PRIVATE_SECRET" } },
      args: { command: "PRIVATE_COMMAND", input: "PRIVATE_INPUT" },
      timestamp: 900_000,
    };
    reportSlowCakeToolExecution("pi", event);
    expect(warning).toHaveBeenCalledExactlyOnceWith("Slow Cake tool execution", {
      runtime: "pi",
      boundary: "sdk-execute",
      call: cakeToolCallKey(callId),
      durationMs: 1_000,
      isError: true,
      unmeasured,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("PRIVATE");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("900000");
  });
});
