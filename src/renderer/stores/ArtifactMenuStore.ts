import { Store, child, createStore } from "r-state-tree";
import type {
  ArtifactLineageId,
  ArtifactRevisionNumber,
} from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import type { SideChatStore } from "./SideChatStore";
import { ArtifactDetailStore } from "./ArtifactDetailStore";

/** Window-local artifact selection, hosted in the conversation accessory or global fullscreen. */
export class ArtifactMenuStore extends Store<{
  model: ArtifactCatalog;
  currentSessionId(): string | undefined;
  artifactsChanged(lineageId: string): void;
  clearReferenceOperationError(lineageId?: ArtifactLineageId): void;
}> {
  sessionId: string | undefined;
  visible = false;
  pane: SideChatStore | undefined;

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
    pane?: SideChatStore,
  ) {
    this.pane = pane;
    pane?.open({ key: "artifact", title: "Artifact", artifact: this });
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
    if (this.pane?.target?.artifact === this) this.pane.close();
    this.pane = undefined;
    this.visible = false;
    this.sessionId = undefined;
  }
}
