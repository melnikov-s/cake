import { Model, child, id, observable } from "r-state-tree";
import type { SessionSnapshot, ThinkingLevel, UiPart } from "../../ipc/session-contract";
import type { CakeChatControlRequest } from "../../domain/cake-chat-data";
import { Artifact } from "./Artifact";
import { CompatibilityResource } from "./CompatibilityResource";
import { Message } from "./Message";
import { ModelOption } from "./ModelOption";
import { ReviewThread } from "./ReviewThread";
import { ResourceDiagnostic } from "./ResourceDiagnostic";
import { SessionTreeEntry } from "./SessionTreeEntry";
import { SubagentActivity } from "./SubagentActivity";
import { ExtensionUi } from "./ExtensionUi";

export class Session extends Model {
  workingDirectory = "";
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
  /** Pi-accepted turns bridge command acceptance to the first streaming event. */
  activeTurnIds: string[] = observable([]);
  diagnostics: string[] = observable([]);
  commands: SessionSnapshot["commands"] = observable([]);
  usage: SessionSnapshot["usage"] = undefined;
  @child(CompatibilityResource) resources: CompatibilityResource[] = observable([]);
  @child(ResourceDiagnostic) resourceDiagnostics: ResourceDiagnostic[] = observable([]);
  @child(SessionTreeEntry) tree: SessionTreeEntry[] = observable([]);
  @child(Artifact) artifacts: Artifact[] = observable([]);
  @child(ReviewThread) reviewThreads: ReviewThread[] = observable([]);
  @child(SubagentActivity) subagentActivities: SubagentActivity[] = observable([]);
  releasedSubagentHandleIds: string[] = observable([]);
  backgroundWorkActive = false;
  @child(ExtensionUi) extensionUi = ExtensionUi.create();
  controlRequests: CakeChatControlRequest[] = observable([]);

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
}
