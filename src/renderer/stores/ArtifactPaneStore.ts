import { Store, child, createStore } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactRevisionNumber,
} from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ArtifactDetailStore } from "./ArtifactDetailStore";

/** Window-local isolated artifact viewer; selection belongs to the originating conversation. */
export class ArtifactPaneStore extends Store<{
  model: ArtifactCatalog;
  currentSessionId(): string | undefined;
  artifactsChanged(lineageId: string): void;
  clearReferenceOperationError(lineageId?: ArtifactLineageId): void;
}> {
  sessionId: string | undefined;
  width = 560;

  constructor(props: ArtifactPaneStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.currentSessionId(),
      () => this.close(),
    );
  }

  @child
  get detailStore(): ArtifactDetailStore {
    return createStore(ArtifactDetailStore, {
      model: this.props.model,
      artifactsChanged: this.props.artifactsChanged,
      clearReferenceOperationError: this.props.clearReferenceOperationError,
    });
  }

  open(sessionId: string, lineageId: ArtifactLineageId, revision?: ArtifactRevisionNumber) {
    this.sessionId = sessionId;
    void this.detailStore.select(lineageId, revision);
  }

  receiveBoardChange(lineageId?: string) {
    if (!this.sessionId) return;
    const detail = this.detailStore;
    if (detail.selectedLineageId && (!lineageId || detail.selectedLineageId === lineageId))
      detail.messageBoardStore.receive();
  }

  close() {
    this.sessionId = undefined;
  }

  setWidth(width: number) {
    this.width = Math.max(320, width);
  }
}
