import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../../src/ipc/artifact-contract";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { observeArtifactEvents, observeStream } from "../../../../src/renderer/observers";
import type { RendererRuntime } from "../../../../src/renderer/RendererRuntime";
import type { RootStore } from "../../../../src/renderer/stores/RootStore";

const record: ArtifactRecord = {
  artifact: {
    protocol: "cake.artifact/v1",
    id: "artifact",
    sessionId: "session",
    revision: 1,
    kind: "markdown",
    payload: { markdown: "# Artifact" },
    fallback: { markdown: "Artifact" },
  },
  workspacePath: "/project",
  digest: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const runtimeFor = (client: CakeIpcClientService): RendererRuntime => {
  const execute: RendererRuntime["execute"] = (effect, signal) =>
    Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, client),
      signal ? { signal } : undefined,
    );
  return {
    execute,
    observe: (source, consume, options) => observeStream(execute, source, consume, options),
    dispose: async () => undefined,
  };
};

describe("observeArtifactEvents", () => {
  it("patches the loaded Session projection directly", async () => {
    const projection = RootProjection.create();
    const session = projection.projectSession("session", "/project");
    const client = {
      events: {
        artifacts: () =>
          Stream.concat(Stream.make({ type: "artifact-updated" as const, record }), Stream.never),
      },
    } as unknown as CakeIpcClientService;

    const cancel = observeArtifactEvents(runtimeFor(client), projection, {} as RootStore);

    await vi.waitFor(() => expect(session.artifacts[0]?.value).toEqual(record));
    cancel();
    projection[Symbol.dispose]();
  });
});
