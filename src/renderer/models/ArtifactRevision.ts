import { Model, id } from "r-state-tree";
import type { CakeArtifactV1, ArtifactRecord } from "../../ipc/artifact-contract";

export class ArtifactRevision extends Model {
  @id id = "";
  lineageId = "";
  revision = 1;
  digest = "";
  kind = "markdown";
  publishedAt = "";
  publishedBySessionId = "";
  workingDirectory = "";
  restoredFromRevision: number | undefined;
  snapshot: CakeArtifactV1 | undefined;

  get record(): ArtifactRecord | undefined {
    return this.snapshot
      ? {
          artifact: this.snapshot,
          workspacePath: this.workingDirectory,
          digest: this.digest,
          createdAt: this.publishedAt,
          updatedAt: this.publishedAt,
        }
      : undefined;
  }
}
