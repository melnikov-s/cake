import { Model, id } from "r-state-tree";
import type { ResolvedAgentModel, SubagentStatus } from "../../contracts/subagents/subagent-data";
import type { SessionUsage, UiPart } from "../../contracts/conversations/session-contract";

/** Passive renderer projection of one live Subagent activity. */
export class SubagentActivity extends Model {
  parentSessionId = "";
  anchorPartId = "";
  @id handleId = "";
  revision = 0;
  task = "";
  status: SubagentStatus = "queued";
  resolvedModel: ResolvedAgentModel = {
    requested: "current",
    source: "current",
    provider: "",
    modelId: "",
    thinkingLevel: "off",
    fallbacks: [],
  };
  fastMode = false;
  streaming = false;
  parts: UiPart[] = [];
  usage: SessionUsage | undefined;
  error: string | undefined;
  failurePhase: "start" | undefined;
}
