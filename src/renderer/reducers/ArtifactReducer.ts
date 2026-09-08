import { applySnapshot, batch } from "r-state-tree";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import { artifactSnapshot } from "../../utils/session-snapshot";
import { Artifact } from "../models/Artifact";
import type { Session } from "../models/Session";

export function applyArtifactUpdate(session: Session, record: ArtifactRecord) {
  batch(() => {
    const existing = session.artifacts.find((artifact) => artifact.id === record.artifact.id);
    if (existing) {
      if (record.artifact.revision <= existing.artifact.revision) return;
      applySnapshot(existing, artifactSnapshot(record));
      return;
    }
    session.artifacts.push(Artifact.create(artifactSnapshot(record)));
  });
}
