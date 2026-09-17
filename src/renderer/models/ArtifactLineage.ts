import { Model, child, id, observable } from "r-state-tree";
import { ArtifactRevision } from "./ArtifactRevision";

export class ArtifactLineage extends Model {
  @id id = "";
  createdAt = "";
  latestRevision = 1;
  title: string | undefined;
  stableRef = "";
  @child(ArtifactRevision) revisions: ArtifactRevision[] = observable([]);

  revision(number: number) {
    return this.revisions.find((revision) => revision.revision === number);
  }

  get latest() {
    return this.revision(this.latestRevision);
  }
}
