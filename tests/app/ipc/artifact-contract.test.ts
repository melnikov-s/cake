import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_INPUT_BYTES, parseArtifactInput, validateArtifactResponse } from "../../../src/ipc/artifact-contract";

function markdown(markdown = "Hello") {
  return { protocol: "cake.artifact/v1", id: "artifact-1", sessionId: "session-1", revision: 1, kind: "markdown", payload: { markdown }, fallback: { markdown }, interaction: { mode: "present" } };
}

describe("cake.artifact/v1 contract", () => {
  it("validates a bounded versioned artifact and rejects unsafe or oversized input", () => {
    expect(parseArtifactInput(markdown()).kind).toBe("markdown");
    expect(parseArtifactInput({ ...markdown(), protocol: "cake.artifact/v2" })).toMatchObject({ protocol: "cake.artifact/v1", kind: "markdown", payload: { markdown: "Hello" } });
    expect(parseArtifactInput({ ...markdown(), kind: "future-chart", payload: {} })).toMatchObject({ kind: "markdown", fallback: { markdown: "Hello" } });
    expect(() => parseArtifactInput({ ...markdown(), kind: "html", payload: { html: "<p>x</p>" }, interaction: { mode: "request" } })).toThrow("Only form");
    expect(() => parseArtifactInput({ ...markdown(), kind: "media", payload: { mediaType: "image", src: "file:///etc/passwd" } })).toThrow("Media source");
    expect(() => parseArtifactInput(markdown("x".repeat(MAX_ARTIFACT_INPUT_BYTES)))).toThrow("exceeds");
  });

  it("validates structured responses against the declared JSON schema", () => {
    const schema = { type: "object" as const, required: ["answer"], properties: { answer: { type: "string" as const, minLength: 1 } } };
    expect(validateArtifactResponse(schema, { answer: "yes" })).toEqual({ answer: "yes" });
    expect(() => validateArtifactResponse(schema, {})).toThrow("required");
    expect(() => validateArtifactResponse(schema, { answer: "" })).toThrow("length");
  });
});
