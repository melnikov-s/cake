import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../src/contracts/artifacts/artifact-contract";
import { createCakeArtifactOperations } from "../../../src/domain/artifacts/cake-artifact-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const runtime = {
  sessionId: "session-1",
  sessionFile: "/sessions/source.jsonl",
  entryId: "assistant-1",
  model: { provider: "provider", id: "model" },
};

const widgetRequest = {
  command: "widgets.present",
  input: {
    widget: {
      id: "runtime-overview",
      title: "Runtime overview",
      brief: "Explain the verified runtime boundaries and relationships to maintainers.",
      data: {
        facts: ["The renderer is sandboxed", "Electron main owns Pi runtimes"],
        sources: ["docs/architecture/cake-architecture.md"],
      },
      fallback: { markdown: "The sandboxed renderer communicates with Electron main." },
    },
  },
};

describe("Cake widget presentation operation", () => {
  it("generates an accepted widget, persists it, and appends its originating pointer", async () => {
    const appendEntry = vi.fn();
    const persistArtifact = vi.fn(async (artifact): Promise<ArtifactRecord> => ({
      artifact,
      workspacePath: "/workspace",
      digest: "a".repeat(64),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }));
    const generateInlineWidget = vi.fn(async () => ({
      language: "react" as const,
      source: "export default function Widget() { return <main>Runtime</main>; }",
      generationSessionId: "generation-1",
      browser: { digest: "a".repeat(64) },
      preview: { mimeType: "image/png" as const, data: "cG5n" },
    }));
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        {
          persistArtifact,
          generateInlineWidget,
        },
      ),
    );

    const result = await registry.invoke(widgetRequest, {
      signal: new AbortController().signal,
      toolCallId: "tool-1",
      runtime,
    });

    expect(generateInlineWidget).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        parentConversation: {
          sessionId: "session-1",
          sessionFile: "/sessions/source.jsonl",
          entryId: "assistant-1",
        },
        brief: widgetRequest.input.widget.brief,
        data: widgetRequest.input.widget.data,
        fallback: widgetRequest.input.widget.fallback.markdown,
        model: runtime.model,
      }),
    );
    expect(result.details).toMatchObject({
      command: "widgets.present",
      result: { artifactId: "runtime-overview", exactRef: "cake://artifact/runtime-overview@r1" },
    });
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
    expect(result.text).not.toContain("export default");
    expect(result.text).not.toContain("generation-1");
    expect(JSON.stringify(result.details)).not.toContain("cG5n");
    expect(persistArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "widget",
        sessionId: "session-1",
        payload: expect.objectContaining({ generationSessionId: "generation-1" }),
      }),
    );
    expect(appendEntry).toHaveBeenCalledWith(
      "cake.artifact/v1",
      expect.objectContaining({
        lineageId: "runtime-overview",
        kind: "widget",
        origin: { assistantEntryId: "assistant-1", toolCallId: "tool-1" },
      }),
    );
  });

  it.each([
    ["malformed preview", "not base64"],
    ["oversized immutable snapshot", "a".repeat(1_048_576)],
  ])("rejects %s before publication instead of dropping visual evidence", async (_name, data) => {
    const persistArtifact = vi.fn();
    const appendEntry = vi.fn();
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        {
          persistArtifact,
          generateInlineWidget: async () => ({
            language: "react",
            source: "export default () => null",
            generationSessionId: "generation-1",
            browser: { digest: "a".repeat(64) },
            preview: { mimeType: "image/png", data },
          }),
        },
      ),
    );
    await expect(
      registry.invoke(widgetRequest, {
        signal: new AbortController().signal,
        toolCallId: "tool-1",
        runtime,
      }),
    ).rejects.toThrow();
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("does not persist or append a pointer when cancellation wins after generation", async () => {
    const controller = new AbortController();
    const persistArtifact = vi.fn();
    const appendEntry = vi.fn();
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        {
          persistArtifact,
          generateInlineWidget: vi.fn(async () => {
            controller.abort();
            return {
              language: "react" as const,
              source: "export default function Widget() { return null; }",
              generationSessionId: "generation-1",
              browser: { digest: "a".repeat(64) },
              preview: { mimeType: "image/png" as const, data: "cG5n" },
            };
          }),
        },
      ),
    );

    await expect(
      registry.invoke(widgetRequest, {
        signal: controller.signal,
        toolCallId: "tool-1",
        runtime,
      }),
    ).rejects.toThrow("cancelled");
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(appendEntry).not.toHaveBeenCalled();
  });
});
