import { describe, expect, it } from "vitest";
import { subagentTaskSchema, toolsForSubagentProfile } from "../../../src/agent/subagent-contract";

describe("subagent contract", () => {
  it("defaults to isolated one-shot work without recursive delegation", () => {
    expect(subagentTaskSchema.parse({ task: "Inspect the adapter" })).toMatchObject({
      profile: "worker",
      model: { prefer: "current" },
      maxDepth: 0,
      retain: false
    });
  });

  it("enforces read-only profiles and removes every delegation tool", () => {
    const parentTools = ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent", "subagent_spawn", "agent_open"];
    expect(toolsForSubagentProfile("reviewer", parentTools, false)).toEqual(["read", "grep", "find", "ls"]);
    expect(toolsForSubagentProfile("worker", parentTools, false)).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
  });
});
