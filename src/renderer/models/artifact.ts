import { Model, id, state } from "r-state-tree";
import { cakeArtifactV1Schema, type ArtifactRecord, type CakeArtifactV1 } from "../../ipc/artifact-contract";

export class ArtifactModel extends Model {
  @id id = "";
  @state protocol: CakeArtifactV1["protocol"] = "cake.artifact/v1";
  @state sessionId = "";
  @state revision = 1;
  @state kind: CakeArtifactV1["kind"] = "markdown";
  @state title: string | undefined;
  @state payload: CakeArtifactV1["payload"] = { markdown: "" };
  @state fallback: CakeArtifactV1["fallback"] = { markdown: "" };
  @state interaction: CakeArtifactV1["interaction"] = undefined;
  @state workspacePath = "";
  @state digest = "";
  @state createdAt = "";
  @state updatedAt = "";

  get value(): ArtifactRecord {
    return {
      artifact: cakeArtifactV1Schema.parse({
        protocol: this.protocol,
        id: this.id,
        sessionId: this.sessionId,
        revision: this.revision,
        kind: this.kind,
        title: this.title,
        payload: this.payload,
        fallback: this.fallback,
        interaction: this.interaction
      }),
      workspacePath: this.workspacePath,
      digest: this.digest,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }
}
