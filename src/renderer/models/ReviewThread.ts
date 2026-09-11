import { Model, child, id } from "r-state-tree";
import type {
  DiscussionAnchor,
  DiscussionThread,
} from "../../domain/discussion-sessions/discussion-session-data";
import type { SessionUsage, ThinkingLevel } from "../../ipc/session-contract";
import { Message } from "./Message";

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
  @child(Message) parts: Message[] = [];
  usage: SessionUsage | undefined;
  /** The sidecar session's current model, once it has run. */
  model: { provider: string; modelId: string; name: string } | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  status: DiscussionThread["status"] = "open";
  streaming = false;
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
