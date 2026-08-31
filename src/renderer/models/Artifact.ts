import { Model, id } from "r-state-tree";
import {
  cakeArtifactV1Schema,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../ipc/artifact-contract";

export class Artifact extends Model {
  @id id = "";
  protocol: CakeArtifactV1["protocol"] = "cake.artifact/v1";
  sessionId = "";
  revision = 1;
  kind: CakeArtifactV1["kind"] = "markdown";
  title: string | undefined;
  payload: CakeArtifactV1["payload"] = { markdown: "" };
  fallback: CakeArtifactV1["fallback"] = { markdown: "" };
  interaction: CakeArtifactV1["interaction"] = undefined;
  workspacePath = "";
  digest = "";
  createdAt = "";
  updatedAt = "";

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
        interaction: this.interaction,
      }),
      workspacePath: this.workspacePath,
      digest: this.digest,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
