import { describe, expect, it } from "vitest";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";

describe("prompt template rendering", () => {
  it("assembles and trims a template", () => {
    expect(renderPromptTemplate("\nHello, {{ name }}.\n", { name: "Cake" })).toBe("Hello, Cake.");
  });

  it("rejects missing and unused values", () => {
    expect(() => renderPromptTemplate("Hello, {{name}}.")).toThrow(
      "Missing prompt template value: name",
    );
    expect(() => renderPromptTemplate("Hello.", { name: "Cake" })).toThrow(
      "Unused prompt template values: name",
    );
  });
});
