import { describe, expect, it } from "vitest";
import {
  InterviewDefinition,
  validateInterviewResponse,
} from "../../../src/contracts/interviews/interview";

import { Schema } from "effect";
const parseInterviewInput = Schema.decodeUnknownSync(InterviewDefinition);

const base = {
  protocol: "cake.request/v1",
  id: "deployment-choice",
  title: "Choose deployment",
  responseSchema: { type: "object", properties: { choice: { enum: ["staging", "production"] } } },
  fallback: { markdown: "Choose staging or production." },
};
describe("Interview contract", () => {
  it("accepts trusted form and sandboxed widget views", () => {
    expect(
      parseInterviewInput({
        ...base,
        view: {
          type: "form",
          fields: [
            {
              id: "choice",
              label: "Environment",
              type: "select",
              options: [{ value: "staging", label: "Staging" }],
            },
          ],
        },
      }).view.type,
    ).toBe("form");
    expect(
      parseInterviewInput({
        ...base,
        id: "visual-choice",
        view: {
          type: "widget",
          language: "react",
          source:
            "export default ({ submit }) => <button onClick={() => submit({choice:'staging'})}>Staging</button>",
        },
      }).view.type,
    ).toBe("widget");
  });
  it("validates structured responses against the declared JSON schema", () => {
    const schema = {
      type: "object" as const,
      required: ["answer"],
      properties: { answer: { type: "string" as const, minLength: 1 } },
    };
    expect(validateInterviewResponse(schema, { answer: "yes" })).toEqual({ answer: "yes" });
    expect(() => validateInterviewResponse(schema, {})).toThrow("required");
    expect(() => validateInterviewResponse(schema, { answer: "" })).toThrow("length");
    expect(() => validateInterviewResponse({ type: "integer" }, 1.5)).toThrow("integer");
    expect(
      validateInterviewResponse({ type: "array", items: { type: "boolean" } }, [true, false]),
    ).toEqual([true, false]);
  });
  it("rejects required form fields, unknown protocols, views, and missing schemas", () => {
    expect(() =>
      parseInterviewInput({
        ...base,
        responseSchema: { ...base.responseSchema, required: ["choice"] },
        view: {
          type: "form",
          fields: [{ id: "choice", label: "Environment", type: "select", required: true }],
        },
      }),
    ).toThrow();
    expect(() =>
      parseInterviewInput({
        ...base,
        protocol: "cake.request/v2",
        view: { type: "form", fields: [] },
      }),
    ).toThrow();
    expect(() => parseInterviewInput({ ...base, view: { type: "canvas", source: "" } })).toThrow();
    expect(() =>
      parseInterviewInput({
        ...base,
        responseSchema: undefined,
        view: { type: "widget", language: "html", source: "<button>Yes</button>" },
      }),
    ).toThrow();
  });
});
