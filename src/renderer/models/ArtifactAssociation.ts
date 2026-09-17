import { Model, id, modelRef } from "r-state-tree";
import { ArtifactLineage } from "./ArtifactLineage";
import { ArtifactLink } from "./ArtifactLink";

/** One session's effective view of a canonical lineage and direct-or-family link. */
export class ArtifactAssociation extends Model {
  @id id = "";
  sessionId = "";
  @modelRef(ArtifactLineage) lineage: ArtifactLineage | undefined;
  @modelRef(ArtifactLink) link: ArtifactLink | undefined;
  selectedRevision = 1;
  latestRevision = 1;
  stableRef = "";
  exactRef = "";
}
