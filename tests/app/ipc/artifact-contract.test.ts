import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MAX_ARTIFACT_INPUT_BYTES,
  artifactPointerSchema,
  parseArtifactInput,
  validateArtifactResponse,
} from "../../../src/ipc/artifact-contract";

function markdown(markdown = "Hello") {
  return {
    protocol: "cake.artifact/v1",
    id: "artifact-1",
    sessionId: "session-1",
    revision: 1,
    kind: "markdown",
    payload: { markdown },
    fallback: { markdown },
    interaction: { mode: "present" },
  };
}

describe("cake.artifact/v1 contract", () => {
  it("validates a bounded versioned artifact and rejects unsafe or oversized input", () => {
    expect(parseArtifactInput(markdown()).kind).toBe("markdown");
    expect(() => parseArtifactInput({ ...markdown(), protocol: "cake.artifact/v2" })).toThrow();
    expect(() =>
      parseArtifactInput({ ...markdown(), kind: "future-chart", payload: {} }),
    ).toThrow();
    expect(() =>
      parseArtifactInput({
        ...markdown(),
        kind: "html",
        payload: { html: "<p>x</p>" },
        interaction: { mode: "request" },
      }),
    ).toThrow("Only request artifacts");
    expect(() =>
      parseArtifactInput({
        ...markdown(),
        kind: "media",
        payload: { mediaType: "image", src: "file:///etc/passwd" },
      }),
    ).toThrow("Media source");
    expect(() => parseArtifactInput(markdown("x".repeat(MAX_ARTIFACT_INPUT_BYTES)))).toThrow(
      "exceeds",
    );
  });

  it("validates immutable file payloads and their pointer kind", () => {
    const file = {
      ...markdown(),
      kind: "file" as const,
      payload: {
        name: "report.pdf",
        mimeType: "application/pdf",
        data: Buffer.from("PDF").toString("base64"),
        byteSize: 3,
      },
      fallback: { markdown: "File: `report.pdf` (application/pdf, 3 bytes)." },
    };

    expect(parseArtifactInput(file)).toMatchObject({ kind: "file", payload: { byteSize: 3 } });
    expect(() =>
      parseArtifactInput({ ...file, payload: { ...file.payload, name: "../report.pdf" } }),
    ).toThrow();
    expect(() =>
      parseArtifactInput({ ...file, payload: { ...file.payload, mimeType: "not a mime" } }),
    ).toThrow();
    expect(() =>
      parseArtifactInput({ ...file, payload: { ...file.payload, data: "%%%" } }),
    ).toThrow();
    expect(() =>
      parseArtifactInput({ ...file, payload: { ...file.payload, byteSize: 4 } }),
    ).toThrow("matching byteSize");
    expect(() =>
      parseArtifactInput({ ...file, payload: { ...file.payload, data: "TR==" } }),
    ).toThrow("canonical base64");
    expect(() =>
      parseArtifactInput({
        ...file,
        payload: {
          ...file.payload,
          data: Buffer.alloc(786_300).toString("base64"),
          byteSize: 786_300,
        },
      }),
    ).toThrow("exceeds");

    expect(
      Schema.decodeUnknownSync(artifactPointerSchema)({
        protocol: "cake.artifact/v1",
        lineageId: "file-1",
        revision: 1,
        kind: "file",
        digest: "a".repeat(64),
        stableRef: "cake://artifact/file-1",
        exactRef: "cake://artifact/file-1@r1",
      }).kind,
    ).toBe("file");
  });

  it("records optional assistant-message provenance on durable pointers", () => {
    const pointer = Schema.decodeUnknownSync(artifactPointerSchema)({
      protocol: "cake.artifact/v1",
      lineageId: "artifact-1",
      revision: 1,
      kind: "markdown",
      digest: "a".repeat(64),
      stableRef: "cake://artifact/artifact-1",
      exactRef: "cake://artifact/artifact-1@r1",
      origin: {
        assistantEntryId: "assistant/entry+1=",
        toolCallId: "functions.cake/0#call+abc=",
      },
    });

    expect(pointer.origin).toEqual({
      assistantEntryId: "assistant/entry+1=",
      toolCallId: "functions.cake/0#call+abc=",
    });
    expect(
      Schema.decodeUnknownSync(artifactPointerSchema)({
        ...pointer,
        lineageId: "historical-architecture",
        stableRef: "cake://artifact/historical-architecture",
        exactRef: "cake://artifact/historical-architecture@r1",
        kind: "architecture",
      }).kind,
    ).toBe("architecture");
  });

  it("validates structured responses against the declared JSON schema", () => {
    const schema = {
      type: "object" as const,
      required: ["answer"],
      properties: { answer: { type: "string" as const, minLength: 1 } },
    };
    expect(validateArtifactResponse(schema, { answer: "yes" })).toEqual({ answer: "yes" });
    expect(() => validateArtifactResponse(schema, {})).toThrow("required");
    expect(() => validateArtifactResponse(schema, { answer: "" })).toThrow("length");
  });

  it("accepts delegated widget source as Cake-owned artifact payload", () => {
    const artifact = parseArtifactInput({
      protocol: "cake.artifact/v1",
      id: "widget-1",
      sessionId: "session-1",
      revision: 1,
      kind: "widget",
      title: "Comparison",
      payload: {
        language: "react",
        source: "export default () => <strong>Hello</strong>",
        brief: "Compare the options",
        generationSessionId: "generation-1",
      },
      fallback: { markdown: "A comparison of the options." },
      interaction: { mode: "present" },
    });
    expect(artifact.kind).toBe("widget");
    expect(artifact.payload).toMatchObject({
      language: "react",
      generationSessionId: "generation-1",
    });
  });
});
