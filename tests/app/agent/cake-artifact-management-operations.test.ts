import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, CakeArtifactV1 } from "../../../src/ipc/artifact-contract";
import { createCakeArtifactOperations } from "../../../src/services/pi/runtime/cake-artifact-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const runtime = {
  sessionManager: {
    getSessionId: () => "session-1",
    getLeafId: () => "assistant-1",
  },
  model: { provider: "provider", id: "model" },
};

const record = (artifact: CakeArtifactV1): ArtifactRecord => ({
  artifact,
  workspacePath: "/workspace",
  digest: "a".repeat(64),
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(1).toISOString(),
});

const markdownArtifact: CakeArtifactV1 = {
  protocol: "cake.artifact/v1",
  id: "design-plan",
  sessionId: "session-1",
  revision: 1,
  kind: "markdown",
  title: "Design plan",
  payload: { markdown: "# Design plan" },
  fallback: { markdown: "# Design plan" },
  interaction: { mode: "present" },
};

const invokeContext = (toolCallId = "tool-1", runtimeOverride: unknown = runtime) => ({
  signal: new AbortController().signal,
  toolCallId,
  runtime: runtimeOverride,
});

describe("Cake durable artifact operations", () => {
  it("lists and reads the current session without exposing widget source", async () => {
    const widget = record({
      protocol: "cake.artifact/v1",
      id: "runtime-overview",
      sessionId: "session-1",
      revision: 2,
      kind: "widget",
      title: "Runtime overview",
      payload: {
        language: "react",
        source: "SECRET GENERATED SOURCE",
        brief: "Explain the runtime",
        generationSessionId: "generation-1",
      },
      fallback: { markdown: "Runtime overview." },
      interaction: { mode: "present" },
    });
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry: vi.fn() },
        {
          persistArtifact: vi.fn(),
          requestArtifact: vi.fn(),
          getArtifact: vi.fn(async () => widget),
          listArtifacts: vi.fn(async () => [record(markdownArtifact), widget]),
        },
      ),
    );

    const listed = await registry.invoke({ command: "artifacts.list" }, invokeContext());
    expect(listed.details).toMatchObject({
      result: {
        count: 2,
        artifacts: [
          { id: "design-plan", kind: "markdown", revision: 1 },
          { id: "runtime-overview", kind: "widget", revision: 2 },
        ],
      },
    });

    const read = await registry.invoke(
      { command: "artifacts.read", input: { id: "runtime-overview" } },
      invokeContext(),
    );
    expect(JSON.stringify(read.details)).not.toContain("SECRET GENERATED SOURCE");
    expect(read.details).toMatchObject({
      result: {
        id: "runtime-overview",
        revision: 2,
        payload: { brief: "Explain the runtime" },
      },
    });
  });

  it("creates Markdown with derived session and revision and accepts opaque provenance IDs", async () => {
    const appendEntry = vi.fn();
    const persistArtifact = vi.fn(async (artifact: CakeArtifactV1) => record(artifact));
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        {
          persistArtifact,
          requestArtifact: vi.fn(),
          getArtifact: vi.fn(async () => undefined),
          listArtifacts: vi.fn(async () => []),
        },
      ),
    );
    const opaqueRuntime = {
      ...runtime,
      sessionManager: {
        ...runtime.sessionManager,
        getLeafId: () => "assistant/entry+1=",
      },
    };

    await registry.invoke(
      {
        command: "artifacts.create",
        input: {
          artifact: {
            id: "design-plan",
            title: "Design plan",
            kind: "markdown",
            markdown: "# Design plan",
          },
        },
      },
      invokeContext("functions.cake/0#call+abc=", opaqueRuntime),
    );

    expect(persistArtifact).toHaveBeenCalledWith(markdownArtifact);
    expect(appendEntry).toHaveBeenCalledWith(
      "cake.artifact/v1",
      expect.objectContaining({
        artifactId: "design-plan",
        origin: {
          assistantEntryId: "assistant/entry+1=",
          toolCallId: "functions.cake/0#call+abc=",
        },
      }),
    );
  });

  it("imports a workspace file with derived ownership and can replace its snapshot", async () => {
    const appendEntry = vi.fn();
    const fileArtifact = (revision: number): CakeArtifactV1 => ({
      protocol: "cake.artifact/v1",
      id: "report",
      sessionId: "session-1",
      revision,
      kind: "file",
      title: "Report",
      payload: {
        name: revision === 1 ? "report.pdf" : "revised-report.pdf",
        mimeType: "application/pdf",
        data: "cGRm",
        byteSize: 3,
      },
      fallback: { markdown: "PDF report." },
      interaction: { mode: "present" },
    });
    const importArtifactFile = vi
      .fn()
      .mockResolvedValueOnce(fileArtifact(1))
      .mockResolvedValueOnce(fileArtifact(2));
    const persistArtifact = vi.fn(async (artifact: CakeArtifactV1) => record(artifact));
    const getArtifact = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(record(fileArtifact(1)));
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        {
          persistArtifact,
          requestArtifact: vi.fn(),
          getArtifact,
          listArtifacts: vi.fn(async () => []),
          importArtifactFile,
        },
      ),
    );

    await registry.invoke(
      {
        command: "artifacts.create",
        input: {
          artifact: { id: "report", title: "Report", kind: "file", path: "out/report.pdf" },
        },
      },
      invokeContext(),
    );
    await registry.invoke(
      { command: "artifacts.update", input: { id: "report", path: "out/revised-report.pdf" } },
      invokeContext("tool-2"),
    );

    expect(importArtifactFile).toHaveBeenNthCalledWith(1, {
      id: "report",
      title: "Report",
      path: "out/report.pdf",
      revision: 1,
    });
    expect(importArtifactFile).toHaveBeenNthCalledWith(2, {
      id: "report",
      title: "Report",
      path: "out/revised-report.pdf",
      revision: 2,
    });
    expect(persistArtifact).toHaveBeenNthCalledWith(1, fileArtifact(1));
    expect(persistArtifact).toHaveBeenNthCalledWith(2, fileArtifact(2));
    expect(appendEntry).toHaveBeenCalledTimes(2);
  });

  it("publishes the next complete Markdown revision", async () => {
    const appendEntry = vi.fn();
    const persistArtifact = vi.fn(async (artifact: CakeArtifactV1) => record(artifact));
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry },
        {
          persistArtifact,
          requestArtifact: vi.fn(),
          getArtifact: vi.fn(async () => record(markdownArtifact)),
          listArtifacts: vi.fn(async () => [record(markdownArtifact)]),
        },
      ),
    );

    const result = await registry.invoke(
      {
        command: "artifacts.update",
        input: { id: "design-plan", markdown: "# Revised plan" },
      },
      invokeContext("tool-2"),
    );

    expect(result.details).toMatchObject({ result: { artifactId: "design-plan", revision: 2 } });
    expect(persistArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "design-plan",
        revision: 2,
        payload: { markdown: "# Revised plan" },
        fallback: { markdown: "# Revised plan" },
      }),
    );
    expect(appendEntry).toHaveBeenCalledOnce();
  });

  it("revises a widget in isolation and persists only the accepted source", async () => {
    const current = record({
      protocol: "cake.artifact/v1",
      id: "runtime-overview",
      sessionId: "session-1",
      revision: 1,
      kind: "widget",
      payload: {
        language: "react",
        source: "old source",
        brief: '{"brief":"Runtime"}',
        generationSessionId: "generation-1",
      },
      fallback: { markdown: "Runtime." },
      interaction: { mode: "present" },
    });
    const persistArtifact = vi.fn(async (artifact: CakeArtifactV1) => record(artifact));
    const reviseInlineWidget = vi.fn(async () => ({
      language: "react" as const,
      source: "accepted revised source",
      generationSessionId: "generation-2",
    }));
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        { appendEntry: vi.fn() },
        {
          persistArtifact,
          requestArtifact: vi.fn(),
          getArtifact: vi.fn(async () => current),
          listArtifacts: vi.fn(async () => [current]),
          reviseInlineWidget,
        },
      ),
    );

    await registry.invoke(
      {
        command: "artifacts.update",
        input: { id: "runtime-overview", instructions: "Increase contrast" },
      },
      invokeContext("tool-2"),
    );

    expect(reviseInlineWidget).toHaveBeenCalledWith(
      expect.objectContaining({ source: "old source", instructions: "Increase contrast" }),
    );
    expect(persistArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 2,
        payload: expect.objectContaining({
          source: "accepted revised source",
          generationSessionId: "generation-2",
        }),
      }),
    );
  });
});
