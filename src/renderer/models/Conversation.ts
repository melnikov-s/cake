import type { PresetContext } from "../../contracts/model-presets/preset-context";
import { Model, child, computed, id, modelRef, observable, transient } from "r-state-tree";
import type {
  ConversationSnapshot,
  ThinkingLevel,
  UiPart,
} from "../../contracts/conversations/session-contract";
import { CompatibilityResource } from "./CompatibilityResource";
import { Message } from "./Message";
import { LlmModel } from "./LlmModel";
import { ModelOption } from "./ModelOption";
import { ResourceDiagnostic } from "./ResourceDiagnostic";
import { SessionTreeEntry } from "./SessionTreeEntry";
import { ExtensionUi } from "./ExtensionUi";

/** Renderer projection of transcript and live Conversation display/runtime state. */
export class Conversation extends Model {
  @id sessionId = "";
  sessionFile = "";
  /** Window-local marker for an active, complete Conversation snapshot. */
  @transient observedSnapshotRevision = 0;
  /** Persisted history can be visible before the live agent is assembled. */
  @transient historyOnly = false;
  /** Window-local observation failure; never persisted or owned by Pi. */
  @transient observationError: string | undefined;
  @child(Message) parts: Message[] = observable([]);
  historyCursor: string | undefined;
  /** Originals explicitly paged by the user, never persisted in window snapshots. */
  @transient earlierParts: UiPart[] = observable([]);
  @modelRef(LlmModel) model: LlmModel | undefined;
  preset: PresetContext | undefined;
  fastMode = false;
  fastModeAvailable = false;
  @child(ModelOption) modelOptions: ModelOption[] = observable([]);
  thinkingLevel: ThinkingLevel = "off";
  availableThinkingLevels: readonly ThinkingLevel[] = observable([]);
  piSettings: ConversationSnapshot["piSettings"] = undefined;
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
  commands: ConversationSnapshot["commands"] = observable([]);
  usage: ConversationSnapshot["usage"] = undefined;
  @child(CompatibilityResource) resources: CompatibilityResource[] = observable([]);
  @child(ResourceDiagnostic) resourceDiagnostics: ResourceDiagnostic[] = observable([]);
  @child(SessionTreeEntry) tree: SessionTreeEntry[] = observable([]);
  @child(ExtensionUi) extensionUi = ExtensionUi.create();

  get loaded() {
    return Boolean(this.sessionId);
  }

  @computed
  get uiParts(): UiPart[] {
    const current = this.parts.map((part) => part.value);
    if (!this.earlierParts.length) return current;
    const currentIds = new Set(current.map((part) => part.id));
    return [...this.earlierParts.filter((part) => !currentIds.has(part.id)), ...current];
  }

  get compatibility(): ConversationSnapshot["compatibility"] {
    return {
      resources: this.resources.map((item) => item.value),
      diagnostics: this.resourceDiagnostics.map((item) => item.value),
    };
  }
}
