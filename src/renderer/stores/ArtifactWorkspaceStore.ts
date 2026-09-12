import { computed, Store } from "r-state-tree";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { Session } from "../models/Session";

export interface ArtifactWorkspaceStoreProps {
  model: Session;
  isActive(): boolean;
}

/** Owns one session's deliverable-artifact browsing and accessory-panel presentation. */
export class ArtifactWorkspaceStore extends Store<ArtifactWorkspaceStoreProps> {
  open = false;
  selectedArtifactId: string | undefined;
  width = 416;
  private readonly revisions = new Map<string, number>();

  constructor(props: ArtifactWorkspaceStore["props"]) {
    super(props);
    for (const record of this.records)
      this.revisions.set(record.artifact.id, record.artifact.revision);
  }

  @computed
  get records(): ArtifactRecord[] {
    return this.props.model.artifacts
      .map((artifact) => artifact.value)
      .filter((record) => record.artifact.kind !== "request")
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  @computed
  get selectedRecord(): ArtifactRecord | undefined {
    return this.records.find((record) => record.artifact.id === this.selectedArtifactId);
  }

  toggle() {
    if (this.open) return this.close();
    this.selectedArtifactId = undefined;
    this.open = true;
  }

  close() {
    this.open = false;
  }

  showList() {
    this.selectedArtifactId = undefined;
  }

  openArtifact(artifactId: string) {
    if (!this.records.some((record) => record.artifact.id === artifactId)) return;
    this.selectedArtifactId = artifactId;
    this.open = true;
  }

  setWidth(width: number) {
    this.width = Math.max(320, width);
  }

  /** Notices only genuinely newer deliverables; replayed events do not disturb the user. */
  receive(record: ArtifactRecord) {
    const artifact = record.artifact;
    if (artifact.kind === "request") return;
    const revision = this.revisions.get(artifact.id);
    if (revision !== undefined && revision >= artifact.revision) return;
    this.revisions.set(artifact.id, artifact.revision);
    if (!this.props.isActive()) return;
    this.selectedArtifactId = artifact.id;
    this.open = true;
  }
}
