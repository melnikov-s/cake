import { Model, applySnapshot, child, id, state, type Snapshot } from "r-state-tree";
import type { ReviewAnchor, ReviewThread as ReviewThreadRecord } from "../ipc/review-contract";
import type { UiPart } from "../ipc/session-contract";
import { Message } from "./Message";

export class ReviewThread extends Model {
  @id id = "";
  @state workspacePath = "";
  @state sessionId = "";
  @state agentSessionId: string | undefined;
  @state anchor: ReviewAnchor = {
    path: "",
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: "",
    contextBefore: "",
    contextAfter: "",
    diff: "",
  };
  @child(Message) parts: Message[] = [];
  @state usage: ReviewThreadRecord["usage"] = undefined;
  @state status: ReviewThreadRecord["status"] = "open";
  @state createdAt = "";
  @state updatedAt = "";
  @state resolvedAt: string | undefined;

  get uiParts() {
    return this.parts.map((part) => part.value);
  }
  get textParts() {
    return this.parts.filter((part) => part.kind === "text");
  }
  get pendingUserParts() {
    return this.textParts.filter(
      (part) => part.role === "user" && part.deliveryState === "sending",
    );
  }
  get pending() {
    return this.status === "open" && this.pendingUserParts.length > 0;
  }
  get messageCount() {
    return this.textParts.length;
  }

  upsertPart(part: UiPart) {
    // SAFETY: Message's persisted fields mirror the validated UiPart discriminated union.
    const snapshot = part as Snapshot<Message>;
    const existing = this.parts.find((current) => current.id === part.id);
    if (existing) applySnapshot(existing, snapshot);
    else this.parts.push(Message.create(snapshot));
  }

  get value(): ReviewThreadRecord {
    return {
      id: this.id,
      workspacePath: this.workspacePath,
      sessionId: this.sessionId,
      agentSessionId: this.agentSessionId,
      anchor: this.anchor,
      parts: this.uiParts,
      usage: this.usage,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      resolvedAt: this.resolvedAt,
    };
  }
}
