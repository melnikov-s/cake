import { describe, expect, it } from "vitest";
import { subagentTitle } from "../../../src/renderer/lib/subagent-title";

describe("subagentTitle", () => {
  const task = "Investigate.\n\n  Report findings.  ";

  it("prefers the generated title", () => {
    expect(subagentTitle({ title: "Trace callers", task })).toBe("Trace callers");
  });

  it("falls back to the shared task preview while pending, empty or failed", () => {
    expect(subagentTitle({ task })).toBe("Investigate. Report findings.");
    expect(subagentTitle({ title: "  ", task })).toBe("Investigate. Report findings.");
    expect(subagentTitle({ title: undefined, task: "" })).toBe("Subagent");
  });
});
