import { Model, child, computed, id, modelRef, observable, transient } from "r-state-tree";
import type { SessionSnapshot, ThinkingLevel, UiPart } from "../../ipc/session-contract";
import type { CakeChatControlRequest } from "../../domain/cake-chats/cake-chat-data";
import { Artifact } from "./Artifact";
import { CompatibilityResource } from "./CompatibilityResource";
import { Message } from "./Message";
import { LlmModel } from "./LlmModel";
import { ModelOption } from "./ModelOption";
import { ReviewThread } from "./ReviewThread";
import { ResourceDiagnostic } from "./ResourceDiagnostic";
import { SessionTreeEntry } from "./SessionTreeEntry";
import { SubagentActivity } from "./SubagentActivity";
import { ScheduledMessage } from "./ScheduledMessage";
import { ExtensionUi } from "./ExtensionUi";

export class Session extends Model {
  workingDirectory = "";
  @id sessionId = "";
  sessionFile = "";
  @child(Message) parts: Message[] = observable([]);
  @modelRef(LlmModel) model: LlmModel | undefined;
  fastMode = false;
  fastModeAvailable = false;
  @child(ModelOption) modelOptions: ModelOption[] = observable([]);
  thinkingLevel: ThinkingLevel = "off";
  availableThinkingLevels: readonly ThinkingLevel[] = observable([]);
  piSettings: SessionSnapshot["piSettings"] = undefined;
  streaming = false;
  /** Pi-accepted turns bridge command acceptance to the first streaming event. */
  activeTurnIds: string[] = observable([]);
  /** Window-local ordering marker for turn settlements observed after this Model was created. */
  @transient settledTurnRevision = 0;
  /** Bounded window-local acknowledgement projection for correlated coordination turns. */
  @transient
  settledTurns: Array<{
    turnId: string;
    outcome: "complete" | "failed" | "aborted";
  }> = observable([]);
  diagnostics: string[] = observable([]);
  commands: SessionSnapshot["commands"] = observable([]);
  usage: SessionSnapshot["usage"] = undefined;
  @child(CompatibilityResource) resources: CompatibilityResource[] = observable([]);
  @child(ResourceDiagnostic) resourceDiagnostics: ResourceDiagnostic[] = observable([]);
  @child(SessionTreeEntry) tree: SessionTreeEntry[] = observable([]);
  @child(Artifact) artifacts: Artifact[] = observable([]);
  @child(ReviewThread) reviewThreads: ReviewThread[] = observable([]);
  @child(SubagentActivity) subagentActivities: SubagentActivity[] = observable([]);
  @child(ScheduledMessage) scheduledMessages: ScheduledMessage[] = observable([]);
  releasedSubagentHandleIds: string[] = observable([]);
  backgroundWorkActive = false;
  @child(ExtensionUi) extensionUi = ExtensionUi.create();
  controlRequests: CakeChatControlRequest[] = observable([]);

  get loaded() {
    return Boolean(this.sessionId);
  }

  @computed
  get uiParts(): UiPart[] {
    return this.parts.map((part) => part.value);
  }

  get compatibility(): SessionSnapshot["compatibility"] {
    return {
      resources: this.resources.map((item) => item.value),
      diagnostics: this.resourceDiagnostics.map((item) => item.value),
    };
  }
}
