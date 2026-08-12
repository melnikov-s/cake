import { Model, child, id, state } from "r-state-tree";
import type { ReviewAnchor, ReviewMessage, ReviewThread } from "../../ipc/review-contract";

export class ReviewMessageModel extends Model {
  @id id = "";
  @state role: ReviewMessage["role"] = "user";
  @state body = "";
  @state createdAt = "";
  @state delivered = false;
  @state status: ReviewMessage["status"] = "complete";

  get value(): ReviewMessage { return { id: this.id, role: this.role, body: this.body, createdAt: this.createdAt, delivered: this.delivered, status: this.status }; }
}

export class ReviewThreadModel extends Model {
  @id id = "";
  @state workspacePath = "";
  @state sessionId = "";
  @state agentSessionId: string | undefined;
  @state anchor: ReviewAnchor = { path: "", start: { diffLine: 0 }, end: { diffLine: 0 }, selectedText: "", contextBefore: "", contextAfter: "", diff: "" };
  @child(ReviewMessageModel) messages: ReviewMessageModel[] = [];
  @state status: ReviewThread["status"] = "open";
  @state createdAt = "";
  @state updatedAt = "";
  @state resolvedAt: string | undefined;

  get latestMessage() { return this.messages.at(-1); }
  get pendingUserMessages() { return this.messages.filter((message) => message.role === "user" && !message.delivered); }
  get pending() { return this.status === "open" && this.pendingUserMessages.length > 0; }
  get actionableCommentCount() { return this.status === "open" && this.latestMessage?.role === "user" ? this.pendingUserMessages.length : 0; }
  get value(): ReviewThread { return { id: this.id, workspacePath: this.workspacePath, sessionId: this.sessionId, agentSessionId: this.agentSessionId, anchor: this.anchor, messages: this.messages.map((message) => message.value), status: this.status, createdAt: this.createdAt, updatedAt: this.updatedAt, resolvedAt: this.resolvedAt }; }
}
