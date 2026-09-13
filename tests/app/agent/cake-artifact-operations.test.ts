import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../src/ipc/artifact-contract";
import { createCakeArtifactOperations } from "../../../src/services/pi/runtime/cake-artifact-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const runtime = {
  sessionManager: {
    getSessionId: () => "session-1",
    getLeafId: () => "assistant-1",
  },
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
    }));
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        {
          persistArtifact,
          requestArtifact: vi.fn(async () => undefined),
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
        brief: widgetRequest.input.widget.brief,
        data: widgetRequest.input.widget.data,
        fallback: widgetRequest.input.widget.fallback.markdown,
        model: runtime.model,
      }),
    );
    expect(result.details).toMatchObject({
      command: "widgets.present",
      result: { artifactId: "runtime-overview" },
    });
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
        artifactId: "runtime-overview",
        kind: "widget",
        origin: { assistantEntryId: "assistant-1", toolCallId: "tool-1" },
      }),
    );
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
          requestArtifact: vi.fn(async () => undefined),
          generateInlineWidget: vi.fn(async () => {
            controller.abort();
            return {
              language: "react" as const,
              source: "export default function Widget() { return null; }",
              generationSessionId: "generation-1",
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
