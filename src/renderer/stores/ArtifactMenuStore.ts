import { Store, child, createStore } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactRevisionNumber,
} from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import { ArtifactDetailStore } from "./ArtifactDetailStore";

/** Window-local fullscreen selection from the artifact menus. */
export class ArtifactMenuStore extends Store<{
  model: ArtifactCatalog;
  currentSessionId(): string | undefined;
  artifactsChanged(lineageId: string): void;
  clearReferenceOperationError(lineageId?: ArtifactLineageId): void;
}> {
  sessionId: string | undefined;
  visible = false;

  constructor(props: ArtifactMenuStore["props"]) {
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

  open(
    sessionId: string | undefined,
    lineageId: ArtifactLineageId,
    revision?: ArtifactRevisionNumber,
  ) {
    this.sessionId = sessionId;
    this.visible = true;
    void this.detailStore.select(lineageId, revision);
  }

  receiveBoardChange(lineageId?: string) {
    if (!this.visible) return;
    const detail = this.detailStore;
    if (detail.selectedLineageId && (!lineageId || detail.selectedLineageId === lineageId))
      detail.messageBoardStore.receive();
  }

  close() {
    this.visible = false;
    this.sessionId = undefined;
  }
}
