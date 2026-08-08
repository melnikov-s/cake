import { Model, applySnapshot, batch, child, observable, state, type Snapshot } from "r-state-tree";
import type { SessionSnapshot, ThinkingLevel, UiPart } from "../../ipc/session-contract";
import { MessageModel } from "./message";
import { ModelOptionModel } from "./model-option";
import { SessionSummaryModel } from "./session-summary";
import { SessionTreeNodeModel } from "./session-tree-node";
import { CompatibilityResourceModel, ResourceDiagnosticModel } from "./compatibility-resource";

export class SessionModel extends Model {
  @state workspacePath = "";
  @state sessionId = "";
  @state sessionFile = "";
  @child(MessageModel) parts: MessageModel[] = observable([]);
  @state model: SessionSnapshot["model"] = undefined;
  @child(ModelOptionModel) models: ModelOptionModel[] = observable([]);
  @state thinkingLevel: ThinkingLevel = "off";
  @state availableThinkingLevels: ThinkingLevel[] = observable([]);
  @state streaming = false;
  @state diagnostics: string[] = observable([]);
  @child(CompatibilityResourceModel) resources: CompatibilityResourceModel[] = observable([]);
  @child(ResourceDiagnosticModel) resourceDiagnostics: ResourceDiagnosticModel[] = observable([]);
  @child(SessionSummaryModel) sessions: SessionSummaryModel[] = observable([]);
  @child(SessionTreeNodeModel) tree: SessionTreeNodeModel[] = observable([]);

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
      applySnapshot(this, {
        workspacePath: snapshot.workspacePath,
        sessionId: snapshot.sessionId,
        sessionFile: snapshot.sessionFile,
        model: snapshot.model,
        thinkingLevel: snapshot.thinkingLevel,
        availableThinkingLevels: snapshot.availableThinkingLevels,
        streaming: snapshot.streaming,
        diagnostics: snapshot.diagnostics
      } as Snapshot<this>);
      reconcileChildren(this.parts, snapshot.parts, MessageModel);
      reconcileModelOptions(this.models, snapshot.models);
      reconcileChildren(this.sessions, snapshot.sessions, SessionSummaryModel);
      reconcileChildren(this.tree, snapshot.tree, SessionTreeNodeModel);
      reconcileChildren(this.resources, snapshot.compatibility.resources, CompatibilityResourceModel);
      reconcileChildren(this.resourceDiagnostics, snapshot.compatibility.diagnostics, ResourceDiagnosticModel);
    });
  }

  upsertPart(part: UiPart) {
    const existing = this.parts.find((current) => current.id === part.id);
    if (existing) {
      applySnapshot(existing, part as Snapshot<MessageModel>);
      return;
    }
    this.parts.push(MessageModel.create(part as Snapshot<MessageModel>));
  }

  removePart(partId: string) {
    const index = this.parts.findIndex((part) => part.id === partId);
    if (index >= 0) this.parts.splice(index, 1);
  }

  setStreaming(streaming: boolean) {
    this.streaming = streaming;
  }
}

function reconcileModelOptions(target: ModelOptionModel[], snapshots: SessionSnapshot["models"]) {
  const key = (value: { provider: string; id: string }) => `${value.provider}/${value.id}`;
  const existing = new Map(target.map((model) => [key(model), model]));
  const next = snapshots.map((snapshot) => {
    const model = existing.get(key(snapshot)) ?? ModelOptionModel.create(snapshot as Snapshot<ModelOptionModel>);
    if (existing.has(key(snapshot))) applySnapshot(model, snapshot as Snapshot<ModelOptionModel>);
    return model;
  });
  target.splice(0, target.length, ...next);
}

type ChildConstructor<T extends Model> = {
  create(snapshot?: Snapshot<T>): T;
};

function reconcileChildren<T extends Model, S extends { id: string }>(
  target: T[],
  snapshots: S[],
  Type: ChildConstructor<T>
) {
  const existing = new Map(target.map((model) => [(model as T & { id: string }).id, model]));
  const next = snapshots.map((snapshot) => {
    const model = existing.get(snapshot.id) ?? Type.create(snapshot as Snapshot<T>);
    if (existing.has(snapshot.id)) applySnapshot(model, snapshot as Snapshot<T>);
    return model;
  });
  target.splice(0, target.length, ...next);
}
