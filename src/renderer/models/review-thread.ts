import { Model, applySnapshot, child, id, state, type Snapshot } from "r-state-tree";
import type { ReviewAnchor, ReviewThread } from "../../ipc/review-contract";
import type { UiPart } from "../../ipc/session-contract";
import { MessageModel } from "./message";

export class ReviewThreadModel extends Model {
  @id id = "";
  @state workspacePath = "";
  @state sessionId = "";
  @state agentSessionId: string | undefined;
  @state anchor: ReviewAnchor = { path: "", start: { diffLine: 0 }, end: { diffLine: 0 }, selectedText: "", contextBefore: "", contextAfter: "", diff: "" };
  @child(MessageModel) parts: MessageModel[] = [];
  @state usage: ReviewThread["usage"] = undefined;
  @state status: ReviewThread["status"] = "open";
  @state createdAt = "";
  @state updatedAt = "";
  @state resolvedAt: string | undefined;

  get uiParts() { return this.parts.map((part) => part.value); }
  get textParts() { return this.parts.filter((part) => part.kind === "text"); }
  get latestTextPart() { return this.textParts.at(-1); }
  get pendingUserParts() { return this.textParts.filter((part) => part.role === "user" && part.deliveryState === "sending"); }
  get pending() { return this.status === "open" && this.pendingUserParts.length > 0; }
  get actionableCommentCount() { return this.status === "open" && this.latestTextPart?.role === "user" ? this.pendingUserParts.length : 0; }
  get messageCount() { return this.textParts.length; }

  upsertPart(part: UiPart) {
    // SAFETY: MessageModel's persisted fields mirror the validated UiPart discriminated union.
    const snapshot = part as Snapshot<MessageModel>;
    const existing = this.parts.find((current) => current.id === part.id);
    if (existing) applySnapshot(existing, snapshot);
    else this.parts.push(MessageModel.create(snapshot));
  }

  get value(): ReviewThread { return { id: this.id, workspacePath: this.workspacePath, sessionId: this.sessionId, agentSessionId: this.agentSessionId, anchor: this.anchor, parts: this.uiParts, usage: this.usage, status: this.status, createdAt: this.createdAt, updatedAt: this.updatedAt, resolvedAt: this.resolvedAt }; }
}
