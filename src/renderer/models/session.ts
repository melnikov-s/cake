import { Model, applySnapshot, child, id, observable, state, type Snapshot } from "r-state-tree";
import type { SessionSnapshot, ThinkingLevel, UiPart } from "../../ipc/session-contract";
import { MessageModel } from "./message";
import { ModelOptionModel } from "./model-option";
import { SessionTreeEntryModel } from "./session-tree-entry";
import { CompatibilityResourceModel, ResourceDiagnosticModel } from "./compatibility-resource";
import { ArtifactModel, toArtifactSnapshot } from "./artifact";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { ReviewThread } from "../../ipc/review-contract";
import { ReviewThreadModel } from "./review-thread";

export class SessionModel extends Model {
  @state workspacePath = "";
  @id sessionId = "";
  @state sessionFile = "";
  @child(MessageModel) parts: MessageModel[] = observable([]);
  @state model: SessionSnapshot["model"] = undefined;
  @child(ModelOptionModel) models: ModelOptionModel[] = observable([]);
  @state thinkingLevel: ThinkingLevel = "off";
  @state availableThinkingLevels: ThinkingLevel[] = observable([]);
  @state piSettings: SessionSnapshot["piSettings"] = undefined;
  @state streaming = false;
  @state diagnostics: string[] = observable([]);
  @state commands: SessionSnapshot["commands"] = observable([]);
  @state usage: SessionSnapshot["usage"] = undefined;
  @child(CompatibilityResourceModel) resources: CompatibilityResourceModel[] = observable([]);
  @child(ResourceDiagnosticModel) resourceDiagnostics: ResourceDiagnosticModel[] = observable([]);
  @child(SessionTreeEntryModel) tree: SessionTreeEntryModel[] = observable([]);
  @child(ArtifactModel) artifacts: ArtifactModel[] = observable([]);
  @child(ReviewThreadModel) reviewThreads: ReviewThreadModel[] = observable([]);

  get loaded() {
    return Boolean(this.sessionId);
  }

  get uiParts(): UiPart[] {
    return this.parts.map((part) => part.value);
  }

  get compatibility(): SessionSnapshot["compatibility"] {
    return { resources: this.resources.map((item) => item.value), diagnostics: this.resourceDiagnostics.map((item) => item.value) };
  }

  upsertPart(part: UiPart) {
    // SAFETY: MessageModel's persisted fields are the UiPart discriminated union.
    const partSnapshot = part as Snapshot<MessageModel>;
    const existing = this.parts.find((current) => current.id === part.id);
    if (existing) {
      applySnapshot(existing, partSnapshot);
      return;
    }
    this.parts.push(MessageModel.create(partSnapshot));
  }

  removePart(partId: string) {
    const index = this.parts.findIndex((part) => part.id === partId);
    if (index >= 0) this.parts.splice(index, 1);
  }

  setStreaming(streaming: boolean) {
    this.streaming = streaming;
  }

  upsertArtifact(record: ArtifactRecord) {
    const artifactSnapshot = toArtifactSnapshot(record);
    const existing = this.artifacts.find((artifact) => artifact.id === record.artifact.id);
    if (existing) {
      applySnapshot(existing, artifactSnapshot);
      return;
    }
    this.artifacts.push(ArtifactModel.create(artifactSnapshot));
  }

  applyReviewThreads(threads: ReviewThread[]) {
    for (const thread of threads) this.upsertReviewThread(thread);
  }

  upsertReviewThread(thread: ReviewThread) {
    // SAFETY: ReviewThreadModel mirrors the validated ReviewThread IPC contract.
    const threadSnapshot = thread as Snapshot<ReviewThreadModel>;
    const existing = this.reviewThreads.find((item) => item.id === thread.id);
    if (existing) {
      if (existing.updatedAt <= thread.updatedAt) applySnapshot(existing, threadSnapshot);
      return;
    }
    this.reviewThreads.push(ReviewThreadModel.create(threadSnapshot));
  }
}
