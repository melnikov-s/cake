import { Schema } from "effect";
import { expect, it } from "vitest";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

it("retains structured canonical data for code independently of compact agent presentation", async () => {
  const data = {
    sessions: [{ sessionId: "full-canonical-session-id", title: "A session" }],
    total: 1,
  };
  const registry = new CakeOperationRegistry(
    [
      {
        command: "sessions.fixture",
        topic: "sessions",
        summary: "Fixture",
        inputSchema: Schema.Struct({}),
        examples: [],
        result: "Session data",
        execute: async () => data,
      },
    ],
    async () => ({ sessions: [{ sessionId: "short", title: "A session" }], total: 1 }),
  );
  const result = await registry.invoke(
    { command: "sessions.fixture" },
    { signal: new AbortController().signal, toolCallId: "programmatic", runtime: {} },
  );
  // This operation has no output-schema opt-in; code must still receive data, not agent text.
  expect(result.json).toEqual(data);
  expect(result.structuredContent).toEqual({ command: "sessions.fixture", result: data });
  expect(result.text).toContain("short");
  expect(result.text).not.toContain("full-canonical-session-id");
  expect(JSON.parse(JSON.stringify(result.json))).toEqual(data);
});
