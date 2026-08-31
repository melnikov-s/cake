import type { Snapshot } from "r-state-tree";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { Artifact } from "../renderer/models/Artifact";

export function toArtifactSnapshot(record: ArtifactRecord): Snapshot<Artifact> {
  // SAFETY: Artifact mirrors the validated artifact record after its envelope is flattened.
  return {
    ...record.artifact,
    workspacePath: record.workspacePath,
    digest: record.digest,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  } as Snapshot<Artifact>;
}
