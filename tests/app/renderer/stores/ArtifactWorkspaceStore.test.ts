import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { ArtifactRecord, CakeArtifactV1 } from "../../../../src/ipc/artifact-contract";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { applyArtifactUpdate } from "../../../../src/renderer/reducers/ArtifactReducer";
import { ArtifactWorkspaceStore } from "../../../../src/renderer/stores/ArtifactWorkspaceStore";

function record(artifact: CakeArtifactV1): ArtifactRecord {
  return {
    artifact,
    workspacePath: "/project",
    digest: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-01-01T00:00:0${artifact.revision}.000Z`,
  };
}

function markdown(id: string, revision = 1): ArtifactRecord {
  return record({
    protocol: "cake.artifact/v1",
    id,
    sessionId: "session",
    revision,
    kind: "markdown",
    payload: { markdown: `# ${id}` },
    fallback: { markdown: id },
    interaction: { mode: "present" },
  });
}

describe("ArtifactWorkspaceStore", () => {
  it("auto-opens a new active-session deliverable once and follows its projection", () => {
    const projection = RootProjection.create();
    const model = projection.projectSession("session", "/project");
    const store = mount(createStore(ArtifactWorkspaceStore, { model, isActive: () => true }));
    const first = markdown("report");

    store.receive(first);
    applyArtifactUpdate(model, first);
    expect(store.open).toBe(true);
    expect(store.selectedRecord?.artifact.id).toBe("report");
    expect(store.records).toHaveLength(1);

    store.close();
    store.receive(first);
    applyArtifactUpdate(model, first);
    expect(store.open).toBe(false);
    expect(store.records).toHaveLength(1);

    const revision = markdown("report", 2);
    store.receive(revision);
    applyArtifactUpdate(model, revision);
    expect(store.open).toBe(true);
    expect(store.records).toHaveLength(1);
    expect(store.selectedRecord?.artifact.revision).toBe(2);

    store[Symbol.dispose]();
    projection[Symbol.dispose]();
  });

  it("excludes requests and does not move the workspace for inactive sessions", () => {
    const projection = RootProjection.create();
    const model = projection.projectSession("session", "/project");
    const store = mount(createStore(ArtifactWorkspaceStore, { model, isActive: () => false }));
    const deliverable = markdown("inactive");
    const request = record({
      protocol: "cake.artifact/v1",
      id: "question",
      sessionId: "session",
      revision: 1,
      kind: "request",
      payload: { request: {} },
      fallback: { markdown: "Question" },
      interaction: { mode: "request" },
    });

    store.receive(deliverable);
    applyArtifactUpdate(model, deliverable);
    store.receive(request);
    applyArtifactUpdate(model, request);

    expect(store.open).toBe(false);
    expect(store.records.map((item) => item.artifact.id)).toEqual(["inactive"]);

    store[Symbol.dispose]();
    projection[Symbol.dispose]();
  });
});
