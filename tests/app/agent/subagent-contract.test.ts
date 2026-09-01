import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { subagentTaskSchema } from "../../../src/services/pi/runtime/subagent-contract";

describe("subagent contract", () => {
  it("defaults to isolated one-shot work without recursive delegation", () => {
    expect(
      Schema.decodeUnknownSync(subagentTaskSchema)({ task: "Inspect the adapter" }),
    ).toMatchObject({
      profile: "worker",
      model: { prefer: "current" },
      fastMode: false,
      maxDepth: 0,
      retain: false,
    });
  });
});
