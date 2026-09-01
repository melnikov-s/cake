import type { AgentModelPreference, ResolvedAgentModel } from "../ipc/plugin-agent-contract";
import type { SessionSnapshot, UtilityModel } from "../ipc/session-contract";
import { resolveModel } from "./subagents";

export const resolveAgentModel = (
  preference: AgentModelPreference,
  snapshot: SessionSnapshot,
  utility: UtilityModel | undefined,
): ResolvedAgentModel => {
  const resolved = resolveModel(preference, snapshot, utility);
  return { ...resolved, fallbacks: [...resolved.fallbacks] };
};
