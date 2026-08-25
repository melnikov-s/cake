import { Model, applySnapshot, child, id, observable, type Snapshot } from "r-state-tree";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { ReviewThread as ReviewThreadRecord } from "../ipc/review-contract";
import type { SessionSnapshot, ThinkingLevel, UiPart } from "../ipc/session-contract";
import { toArtifactSnapshot } from "../utils/artifact-snapshot";
import { Artifact } from "./Artifact";
import { CompatibilityResource } from "./CompatibilityResource";
import { Message } from "./Message";
import { ModelOption } from "./ModelOption";
import { ReviewThread } from "./ReviewThread";
import { ResourceDiagnostic } from "./ResourceDiagnostic";
import { SessionTreeEntry } from "./SessionTreeEntry";

export class Session extends Model {
  workspacePath = "";
  @id sessionId = "";
  sessionFile = "";
  @child(Message) parts: Message[] = observable([]);
  model: SessionSnapshot["model"] = undefined;
  fastMode = false;
  fastModeAvailable = false;
  @child(ModelOption) models: ModelOption[] = observable([]);
  thinkingLevel: ThinkingLevel = "off";
  availableThinkingLevels: ThinkingLevel[] = observable([]);
  piSettings: SessionSnapshot["piSettings"] = undefined;
  streaming = false;
  diagnostics: string[] = observable([]);
  commands: SessionSnapshot["commands"] = observable([]);
  usage: SessionSnapshot["usage"] = undefined;
  @child(CompatibilityResource) resources: CompatibilityResource[] = observable([]);
  @child(ResourceDiagnostic) resourceDiagnostics: ResourceDiagnostic[] = observable([]);
  @child(SessionTreeEntry) tree: SessionTreeEntry[] = observable([]);
  @child(Artifact) artifacts: Artifact[] = observable([]);
  @child(ReviewThread) reviewThreads: ReviewThread[] = observable([]);

  get loaded() {
    return Boolean(this.sessionId);
  }

  get uiParts(): UiPart[] {
    return this.parts.map((part) => part.value);
  }

  get compatibility(): SessionSnapshot["compatibility"] {
    return {
      resources: this.resources.map((item) => item.value),
      diagnostics: this.resourceDiagnostics.map((item) => item.value),
    };
  }

  upsertPart(part: UiPart) {
    // SAFETY: Message's persisted fields are the UiPart discriminated union.
    const partSnapshot = part as Snapshot<Message>;
    const existing = this.parts.find((current) => current.id === part.id);
    if (existing) {
      // Live text/reasoning updates arrive for nearly every streamed token. Updating
      // only the fields carried by that part avoids snapshotting dozens of unrelated
      // optional Message fields on every event.
      if (!existing.update(part)) applySnapshot(existing, partSnapshot);
      this.removeDuplicateArtifactParts(part, existing.id);
      return;
    }
    this.removeDuplicateArtifactParts(part, part.id);
    this.parts.push(Message.create(partSnapshot));
  }

  private removeDuplicateArtifactParts(part: UiPart, keepId: string) {
    if (part.kind !== "tool" || !part.artifactId) return;
    for (let index = this.parts.length - 1; index >= 0; index -= 1) {
      const current = this.parts[index];
      if (
        current?.id !== keepId &&
        current?.kind === "tool" &&
        current.artifactId === part.artifactId
      )
        this.parts.splice(index, 1);
    }
  }

  removePart(partId: string) {
    const index = this.parts.findIndex((part) => part.id === partId);
    if (index >= 0) this.parts.splice(index, 1);
  }

  setStreaming(streaming: boolean) {
    this.streaming = streaming;
  }

  applyArtifacts(records: readonly ArtifactRecord[]) {
    for (const record of records) this.upsertArtifact(record);
  }

  upsertArtifact(record: ArtifactRecord) {
    const artifactSnapshot = toArtifactSnapshot(record);
    const existing = this.artifacts.find((artifact) => artifact.id === record.artifact.id);
    if (existing) {
      if (record.artifact.revision >= existing.revision) applySnapshot(existing, artifactSnapshot);
      return;
    }
    this.artifacts.push(Artifact.create(artifactSnapshot));
  }

  applyReviewThreads(threads: ReviewThreadRecord[]) {
    for (const thread of threads) this.upsertReviewThread(thread);
  }

  upsertReviewThread(thread: ReviewThreadRecord) {
    // SAFETY: ReviewThread mirrors the validated ReviewThread IPC contract.
    const threadSnapshot = thread as Snapshot<ReviewThread>;
    const existing = this.reviewThreads.find((item) => item.id === thread.id);
    if (existing) {
      if (existing.updatedAt <= thread.updatedAt) applySnapshot(existing, threadSnapshot);
      return;
    }
    this.reviewThreads.push(ReviewThread.create(threadSnapshot));
  }
}
