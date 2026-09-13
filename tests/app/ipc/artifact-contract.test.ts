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

  it("records optional assistant-message provenance on durable pointers", () => {
    const pointer = Schema.decodeUnknownSync(artifactPointerSchema)({
      protocol: "cake.artifact/v1",
      artifactId: "artifact-1",
      sessionId: "session-1",
      revision: 1,
      kind: "markdown",
      digest: "a".repeat(64),
      fallback: { markdown: "Hello" },
      origin: { assistantEntryId: "assistant-1", toolCallId: "tool-1" },
    });

    expect(pointer.origin).toEqual({
      assistantEntryId: "assistant-1",
      toolCallId: "tool-1",
    });
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

  it("validates architecture graphs and their references", () => {
    const architecture = {
      protocol: "cake.artifact/v1",
      id: "architecture-1",
      sessionId: "session-1",
      revision: 1,
      kind: "architecture",
      title: "Architecture",
      payload: {
        direction: "LR",
        groups: [{ id: "runtime", label: "Runtime" }],
        nodes: [
          {
            id: "renderer",
            label: "Renderer",
            category: "interface",
            group: "runtime",
            source: { path: "src/renderer/main.ts", range: { start: { line: 0 } } },
          },
          { id: "main", label: "Main", category: "process", group: "runtime" },
        ],
        edges: [
          {
            id: "renderer-main",
            source: "renderer",
            target: "main",
            label: "RPC",
            kind: "control",
          },
        ],
      },
      fallback: { markdown: "Renderer communicates with main." },
      interaction: { mode: "present" },
    } as const;

    expect(parseArtifactInput(architecture).kind).toBe("architecture");
    expect(() =>
      parseArtifactInput({
        ...architecture,
        payload: {
          ...architecture.payload,
          edges: [{ id: "invalid", source: "missing", target: "main" }],
        },
      }),
    ).toThrow("unknown source missing");
    expect(() =>
      parseArtifactInput({
        ...architecture,
        payload: {
          ...architecture.payload,
          nodes: [{ id: "renderer", label: "Renderer", group: "missing" }],
          edges: [],
        },
      }),
    ).toThrow("unknown group missing");
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
