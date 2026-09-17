import { Model, id } from "r-state-tree";
import type { ArtifactLinkTarget } from "../../domain/artifacts/artifact-lineage";

export class ArtifactLink extends Model {
  @id id = "";
  lineageId = "";
  target: ArtifactLinkTarget = { type: "session", sessionId: "" };
  mode: "follow-latest" | "pinned" = "follow-latest";
  pinnedRevision: number | undefined;
  createdAt = "";
}
