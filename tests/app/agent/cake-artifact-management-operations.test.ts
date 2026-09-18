import { describe, expect, it, vi } from "vitest";
import type { ArtifactProjectionMetadata } from "../../../src/services/artifacts/ArtifactProjection";
import type { ArtifactRecord, CakeArtifactV1 } from "../../../src/ipc/artifact-contract";
import {
  createCakeArtifactOperations,
  type CakeArtifactOperationOptions,
} from "../../../src/services/pi/runtime/cake-artifact-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const runtime = {
  sessionManager: { getSessionId: () => "session-1", getLeafId: () => "assistant-1" },
  model: { provider: "provider", id: "model" },
};
const context = (toolCallId = "tool-1") => ({
  signal: new AbortController().signal,
  toolCallId,
  runtime,
});
const record = (artifact: CakeArtifactV1): ArtifactRecord => ({
  artifact,
  workspacePath: "/workspace",
  digest: String(artifact.revision).padStart(64, "a").slice(-64),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const metadata = (artifact: CakeArtifactV1): ArtifactProjectionMetadata => ({
  lineageId: artifact.id,
  ...(artifact.title === undefined ? null : { title: artifact.title }),
  kind: artifact.kind,
  selectedRevision: artifact.revision,
  latestRevision: artifact.revision,
  digest: record(artifact).digest,
  linkMode: "follow-latest",
  stableRef: `cake://artifact/${artifact.id}`,
  exactRef: `cake://artifact/${artifact.id}@r${artifact.revision}`,
  exactPath: `/cache/${artifact.id}/r${artifact.revision}`,
  latestPath: `/cache/${artifact.id}/r${artifact.revision}`,
  files: [
    {
      name: "content.md",
      path: `/cache/${artifact.id}/r${artifact.revision}/content.md`,
      byteSize: 4,
      sha256: "b".repeat(64),
    },
  ],
});
const markdown = (revision: number, value: string): CakeArtifactV1 => ({
  protocol: "cake.artifact/v1",
  id: "design-plan",
  sessionId: "session-1",
  revision,
  kind: "markdown",
  title: "Design plan",
  payload: { markdown: value },
  fallback: { markdown: value },
  interaction: { mode: "present" },
});

function makeHarness(initial: CakeArtifactV1 = markdown(1, "one")) {
  let current = initial;
  const appendEntry = vi.fn();
  const callbacks: CakeArtifactOperationOptions = {
    persistArtifact: vi.fn(async (artifact) => {
      current = artifact;
      return record(artifact);
    }),
    requestArtifact: vi.fn(),
    resolveArtifact: vi.fn(async (reference) => {
      const match = /@r(\d+)$/.exec(reference);
      const selected = match
        ? markdown(Number(match[1]), Number(match[1]) === 1 ? "one" : "two")
        : current;
      return { record: record(selected), metadata: metadata(selected) };
    }),
    listArtifactMetadata: vi.fn(async () => [metadata(current)]),
    historyArtifact: vi.fn(async () => [metadata(markdown(1, "one")), metadata(current)]),
    restoreArtifact: vi.fn(async ({ sourceRevision, expectedRevision }) => {
      current = markdown(expectedRevision + 1, sourceRevision === 1 ? "one" : "two");
      return { record: record(current), metadata: metadata(current) };
    }),
    linkArtifact: vi.fn(async () => metadata(current)),
    unlinkArtifact: vi.fn(async () => undefined),
  };
  return {
    appendEntry,
    callbacks,
    registry: new CakeOperationRegistry(createCakeArtifactOperations({ appendEntry }, callbacks)),
  };
}

describe("Cake artifact management operations", () => {
  it("exposes bounded metadata operations without a payload-returning read command", async () => {
    const { registry } = makeHarness();
    expect(registry.definitions().map((item) => item.command)).not.toContain("artifacts.read");
    const listed = await registry.invoke({ command: "artifacts.list" }, context());
    expect(listed.details).toMatchObject({
      result: {
        total: 1,
        artifacts: [{ lineageId: "design-plan", exactPath: "/cache/design-plan/r1" }],
      },
    });
    const resolved = await registry.invoke(
      { command: "artifacts.resolve-reference", input: { reference: "design-plan@r1" } },
      context(),
    );
    expect(JSON.stringify(resolved.details)).not.toContain('"payload"');
    expect(resolved.details).toMatchObject({
      result: { exactRef: "cake://artifact/design-plan@r1" },
    });
  });

  it("requires expectedRevision, publishes one exact pointer, and rejects a stale update", async () => {
    const { registry, appendEntry, callbacks } = makeHarness();
    await registry.invoke(
      {
        command: "artifacts.update",
        input: { lineageId: "design-plan", expectedRevision: 1, markdown: "two" },
      },
      context("tool-update"),
    );
    expect(callbacks.persistArtifact).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(
      "cake.artifact/v1",
      expect.objectContaining({
        lineageId: "design-plan",
        revision: 2,
        stableRef: "cake://artifact/design-plan",
        exactRef: "cake://artifact/design-plan@r2",
      }),
    );
    expect(JSON.stringify(appendEntry.mock.calls[0]?.[1])).not.toContain("fallback");
    await expect(
      registry.invoke(
        {
          command: "artifacts.update",
          input: { lineageId: "design-plan", expectedRevision: 1, markdown: "stale" },
        },
        context(),
      ),
    ).rejects.toThrow("expected 1");
  });

  it("appends one restore pointer while link and unlink append none", async () => {
    const { registry, appendEntry, callbacks } = makeHarness(markdown(2, "two"));
    await registry.invoke(
      { command: "artifacts.link", input: { reference: "cake://artifact/design-plan@r1" } },
      context(),
    );
    await registry.invoke(
      { command: "artifacts.unlink", input: { lineageId: "design-plan" } },
      context(),
    );
    expect(appendEntry).not.toHaveBeenCalled();
    expect(callbacks.linkArtifact).toHaveBeenCalledWith("cake://artifact/design-plan@r1");
    await registry.invoke(
      {
        command: "artifacts.restore",
        input: { lineageId: "design-plan", sourceRevision: 1, expectedRevision: 2 },
      },
      context("tool-restore"),
    );
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith(
      "cake.artifact/v1",
      expect.objectContaining({ revision: 3, exactRef: "cake://artifact/design-plan@r3" }),
    );
  });

  it("adds only metadata-free system guidance when effective links currently exist", async () => {
    let linked = false;
    let beforeAgentStart:
      | ((event: {
          systemPrompt: string;
        }) => void | { systemPrompt: string } | Promise<void | { systemPrompt: string }>)
      | undefined;
    const listArtifactMetadata = vi.fn(async () => [metadata(markdown(1, "secret payload"))]);
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        {
          appendEntry: vi.fn(),
          on: (_event, handler) => {
            beforeAgentStart = handler;
          },
        },
        {
          persistArtifact: vi.fn(),
          requestArtifact: vi.fn(),
          hasLinkedArtifacts: vi.fn(async () => linked),
          listArtifactMetadata,
          linkArtifact: vi.fn(async () => {
            linked = true;
            return metadata(markdown(1, "secret payload"));
          }),
          unlinkArtifact: vi.fn(async () => {
            linked = false;
          }),
        },
      ),
    );
    if (!beforeAgentStart) throw new Error("Expected artifact system-guidance handler");

    await expect(beforeAgentStart({ systemPrompt: "base" })).resolves.toBeUndefined();
    await registry.invoke(
      { command: "artifacts.link", input: { reference: "cake://artifact/design-plan" } },
      context(),
    );
    await expect(beforeAgentStart({ systemPrompt: "base" })).resolves.toEqual({
      systemPrompt:
        "base\n\nThis session has linked artifacts. Use artifacts.list to inspect them when relevant.",
    });
    await registry.invoke(
      { command: "artifacts.unlink", input: { lineageId: "design-plan" } },
      context(),
    );
    await expect(beforeAgentStart({ systemPrompt: "base" })).resolves.toBeUndefined();
    expect(listArtifactMetadata).not.toHaveBeenCalled();
  });
});
