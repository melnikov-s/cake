import { describe, expect, it } from "vitest";
import { windowControlDefinitions } from "../../../src/contracts/application/window-control-definitions";

describe("permanent-chat delegation tool guidance", () => {
  it("makes fresh implementation examples isolated, asynchronous tasks even with a requested model", () => {
    const examples = windowControlDefinitions["sessions.create"].discovery.examples;
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example.input.worktreeName).toBeTruthy();
      expect(example.input.resultDelivery).toBe("notification");
    }
  });
});
