import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../src/ipc/artifact-contract";
import { createCakeArtifactOperations } from "../../../src/services/pi/runtime/cake-artifact-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

describe("Cake architecture artifact operation", () => {
  it("persists a validated graph and appends an originating pointer", async () => {
    const appendEntry = vi.fn();
    const persistArtifact = vi.fn(async (artifact): Promise<ArtifactRecord> => ({
      artifact,
      workspacePath: "/workspace",
      digest: "a".repeat(64),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }));
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        { persistArtifact, requestArtifact: vi.fn(async () => undefined) },
      ),
    );

    const result = await registry.invoke(
      {
        command: "artifacts.presentArchitecture",
        input: {
          architecture: {
            id: "runtime-overview",
            title: "Runtime overview",
            graph: {
              direction: "LR",
              nodes: [
                { id: "renderer", label: "Renderer", category: "interface" },
                { id: "main", label: "Main", category: "process" },
              ],
              edges: [
                {
                  id: "renderer-main",
                  source: "renderer",
                  target: "main",
                  kind: "control",
                },
              ],
            },
            fallback: { markdown: "Renderer communicates with main." },
          },
        },
      },
      {
        signal: new AbortController().signal,
        toolCallId: "tool-1",
        runtime: {
          sessionManager: {
            getSessionId: () => "session-1",
            getLeafId: () => "assistant-1",
          },
        },
      },
    );

    expect(result.details).toMatchObject({
      command: "artifacts.presentArchitecture",
      result: { artifactId: "runtime-overview" },
    });
    expect(persistArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "architecture",
        sessionId: "session-1",
        payload: expect.objectContaining({ direction: "LR" }),
      }),
    );
    expect(appendEntry).toHaveBeenCalledWith(
      "cake.artifact/v1",
      expect.objectContaining({
        artifactId: "runtime-overview",
        kind: "architecture",
        origin: { assistantEntryId: "assistant-1", toolCallId: "tool-1" },
      }),
    );
  });
});
