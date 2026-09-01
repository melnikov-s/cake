import { Model, id } from "r-state-tree";
import type { ArtifactRecord, CakeArtifactV1 } from "../../ipc/artifact-contract";

function createEmptyArtifact(): CakeArtifactV1 {
  return {
    protocol: "cake.artifact/v1",
    id: "",
    sessionId: "",
    revision: 1,
    kind: "markdown",
    payload: { markdown: "" },
    fallback: { markdown: "" },
  };
}

export class Artifact extends Model {
  @id id = "";
  artifact: CakeArtifactV1 = createEmptyArtifact();
  workspacePath = "";
  digest = "";
  createdAt = "";
  updatedAt = "";

  get value(): ArtifactRecord {
    return {
      artifact: this.artifact,
      workspacePath: this.workspacePath,
      digest: this.digest,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
