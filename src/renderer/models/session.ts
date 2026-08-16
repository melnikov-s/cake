import { Model, applySnapshot, batch, child, observable, state, type Snapshot } from "r-state-tree";
import type { SessionPreview, SessionSnapshot, ThinkingLevel, UiPart } from "../../ipc/session-contract";
import { MessageModel } from "./message";
import { ModelOptionModel } from "./model-option";
import { SessionTreeEntryModel } from "./session-tree-entry";
import { CompatibilityResourceModel, ResourceDiagnosticModel } from "./compatibility-resource";
import { ArtifactModel } from "./artifact";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { ReviewThread } from "../../ipc/review-contract";
import { ReviewThreadModel } from "./review-thread";

export class SessionModel extends Model {
  @state workspacePath = "";
  @state sessionId = "";
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

  applySnapshot(snapshot: SessionSnapshot) {
    batch(() => {
      // SAFETY: This partial snapshot only updates scalar SessionModel state; child collections
      // are reconciled separately below so their model identities remain stable.
      applySnapshot(this, {
        workspacePath: snapshot.workspacePath,
        sessionId: snapshot.sessionId,
        sessionFile: snapshot.sessionFile,
        model: snapshot.model,
        thinkingLevel: snapshot.thinkingLevel,
        availableThinkingLevels: snapshot.availableThinkingLevels,
        piSettings: snapshot.piSettings,
        streaming: snapshot.streaming,
        diagnostics: snapshot.diagnostics,
        commands: snapshot.commands,
        usage: snapshot.usage
      } as Snapshot<this>);
      reconcileChildren(this.parts, snapshot.parts, MessageModel);
      reconcileModelOptions(this.models, snapshot.models);
      reconcileChildren(this.tree, snapshot.tree, SessionTreeEntryModel);
      reconcileChildren(this.resources, snapshot.compatibility.resources, CompatibilityResourceModel);
      reconcileChildren(this.resourceDiagnostics, snapshot.compatibility.diagnostics, ResourceDiagnosticModel);
      reconcileArtifactRecords(this.artifacts, snapshot.artifacts ?? []);
    });
  }

  applyPreview(preview: SessionPreview) {
    batch(() => {
      this.workspacePath = preview.workspacePath;
      this.sessionId = preview.sessionId;
      this.sessionFile = preview.sessionFile;
      reconcileChildren(this.parts, preview.parts, MessageModel);
    });
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
    reconcileArtifactRecords(this.artifacts, [
      ...this.artifacts.filter((artifact) => artifact.id !== record.artifact.id).map((artifact) => artifact.value),
      record
    ]);
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

function reconcileArtifactRecords(target: ArtifactModel[], records: ArtifactRecord[]) {
  const snapshots = records.map((record) => ({ ...record.artifact, workspacePath: record.workspacePath, digest: record.digest, createdAt: record.createdAt, updatedAt: record.updatedAt }));
  reconcileChildren(target, snapshots, ArtifactModel);
}

function reconcileModelOptions(target: ModelOptionModel[], snapshots: SessionSnapshot["models"]) {
  const key = (value: { provider: string; id: string }) => `${value.provider}/${value.id}`;
  const existing = new Map(target.map((model) => [key(model), model]));
  const next = snapshots.map((snapshot) => {
    // SAFETY: ModelOptionModel mirrors each model option in the validated session snapshot.
    const modelSnapshot = snapshot as Snapshot<ModelOptionModel>;
    const model = existing.get(key(snapshot)) ?? ModelOptionModel.create(modelSnapshot);
    if (existing.has(key(snapshot))) applySnapshot(model, modelSnapshot);
    return model;
  });
  target.splice(0, target.length, ...next);
}

type ChildConstructor<T extends Model & { id: string }> = {
  create(snapshot?: Snapshot<T>): T;
};

function reconcileChildren<T extends Model & { id: string }, S extends { id: string }>(
  target: T[],
  snapshots: S[],
  Type: ChildConstructor<T>
) {
  const existing = new Map(target.map((model) => [model.id, model]));
  const next = snapshots.map((snapshot) => {
    // SAFETY: Each caller pairs a validated IPC snapshot with the model that mirrors it.
    const childSnapshot = snapshot as Snapshot<T>;
    const model = existing.get(snapshot.id) ?? Type.create(childSnapshot);
    if (existing.has(snapshot.id)) applySnapshot(model, childSnapshot);
    return model;
  });
  target.splice(0, target.length, ...next);
}
