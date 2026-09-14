import { Model, child, id } from "r-state-tree";
import type {
  DiscussionAnchor,
  DiscussionThread,
} from "../../domain/discussion-sessions/discussion-session-data";
import { Message } from "./Message";

/**
 * Cake-owned Discussion Session metadata from the parent's Discussion catalog.
 * The live sidecar conversation is a separate `Session` Model in
 * `RootProjection.discussionSessions`, addressed by `sidecarSessionId`.
 */
export class ReviewThread extends Model {
  @id id = "";
  workingDirectory = "";
  parentSessionId = "";
  sidecarSessionId: string | undefined;
  anchor: DiscussionAnchor = {
    path: "",
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: "",
    contextBefore: "",
    contextAfter: "",
    diff: "",
  };
  /** Persisted transcript preview refreshed when the sidecar settles; not the live conversation. */
  @child(Message) parts: Message[] = [];
  status: DiscussionThread["status"] = "open";
  createdAt = "";
  updatedAt = "";
  resolvedAt: string | undefined;

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
}
