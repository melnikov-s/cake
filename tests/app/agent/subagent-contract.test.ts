import { describe, expect, it } from "vitest";
import {
  subagentTaskSchema,
  toolsForSubagentProfile,
} from "../../../src/services/pi/runtime/subagent-contract";

describe("subagent contract", () => {
  it("defaults to isolated one-shot work without recursive delegation", () => {
    expect(subagentTaskSchema.parse({ task: "Inspect the adapter" })).toMatchObject({
      profile: "worker",
      model: { prefer: "current" },
      fastMode: false,
      maxDepth: 0,
      retain: false,
    });
  });

  it("enforces read-only profiles and removes every delegation tool", () => {
    const parentTools = [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "cake",
      "custom_tool",
      "agent_open",
    ];
    expect(toolsForSubagentProfile("reviewer", parentTools)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "cake",
    ]);
    expect(toolsForSubagentProfile("worker", parentTools)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "cake",
    ]);
  });
});
