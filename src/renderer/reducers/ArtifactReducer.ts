import { applySnapshot, batch } from "r-state-tree";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import { projectionId } from "../../utils/projection-id";
import { Artifact } from "../models/Artifact";
import type { Conversation } from "../models/Conversation";

export function applyArtifactUpdate(session: Conversation, record: ArtifactRecord) {
  batch(() => {
    const snapshot = artifactSnapshot(record);
    const existing = session.artifacts.find((artifact) => artifact.id === snapshot.id);
    if (existing) {
      if (record.artifact.revision <= existing.artifact.revision) return;
      applySnapshot(existing, snapshot);
      return;
    }
    session.artifacts.push(Artifact.create(snapshot));
  });
}

export function artifactSnapshot(record: ArtifactRecord) {
  return {
    id: projectionId(record.artifact.sessionId, record.artifact.id),
    artifact: record.artifact,
    workspacePath: record.workspacePath,
    digest: record.digest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
