import { describe, expect, it } from "vitest";
import { subagentTitle } from "../../../src/renderer/lib/subagent-title";
import { textPreview } from "../../../src/renderer/lib/text-preview";

describe("subagentTitle", () => {
  const task = `Investigate.\n\n${"Long assignment text. ".repeat(40)}`;

  it("prefers the generated title", () => {
    expect(subagentTitle({ title: "Trace callers", task })).toBe("Trace callers");
  });

  it("falls back to the shared task preview while pending, empty or failed", () => {
    expect(subagentTitle({ task })).toBe(textPreview(task));
    expect(subagentTitle({ title: "  ", task })).toBe(textPreview(task));
    expect(subagentTitle({ title: undefined, task: "" })).toBe("Subagent");
  });
});
