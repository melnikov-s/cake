import { describe, expect, it } from "vitest";
import { parseRequestInput } from "../../../src/ipc/request-contract";

const base = {
  protocol: "cake.request/v1",
  id: "deployment-choice",
  title: "Choose deployment",
  responseSchema: { type: "object", required: ["choice"], properties: { choice: { enum: ["staging", "production"] } } },
  fallback: { markdown: "Choose staging or production." }
};

describe("cake.request/v1 contract", () => {
  it("accepts trusted form and sandboxed widget views", () => {
    expect(parseRequestInput({ ...base, view: { type: "form", fields: [{ id: "choice", label: "Environment", type: "select", options: [{ value: "staging", label: "Staging" }] }] } }).view.type).toBe("form");
    expect(parseRequestInput({ ...base, id: "visual-choice", view: { type: "widget", language: "react", source: "export default ({ submit }) => <button onClick={() => submit({choice:'staging'})}>Staging</button>" } }).view.type).toBe("widget");
  });

  it("rejects unknown protocols, views, and missing response schemas", () => {
    expect(() => parseRequestInput({ ...base, protocol: "cake.request/v2", view: { type: "form", fields: [] } })).toThrow();
    expect(() => parseRequestInput({ ...base, view: { type: "canvas", source: "" } })).toThrow();
    expect(() => parseRequestInput({ ...base, responseSchema: undefined, view: { type: "widget", language: "html", source: "<button>Yes</button>" } })).toThrow();
  });
});
