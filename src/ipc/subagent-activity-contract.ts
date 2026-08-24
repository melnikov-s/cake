import { z } from "zod";
import { ipcProjectionArray, ipcProjectionString } from "./projection";
import { resolvedAgentModelSchema } from "./plugin-agent-contract";
import { sessionUsageSchema, uiPartSchema } from "./session-contract";

export const subagentActivityStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "error",
  "aborted",
]);

/** A transient, parent-owned projection of one private subagent runtime. */
export const subagentActivitySchema = z.object({
  parentSessionId: z.string().min(1).max(256),
  anchorPartId: z.string().min(1).max(256),
  handleId: z.uuid(),
  revision: z.number().int().nonnegative(),
  task: ipcProjectionString(262_144),
  profile: z.enum(["scout", "planner", "reviewer", "worker"]),
  status: subagentActivityStatusSchema,
  resolvedModel: resolvedAgentModelSchema,
  fastMode: z.boolean(),
  retained: z.boolean(),
  streaming: z.boolean(),
  parts: ipcProjectionArray(uiPartSchema, 10_000),
  usage: sessionUsageSchema.optional(),
  error: ipcProjectionString(16_384).optional(),
});

export type SubagentActivity = z.infer<typeof subagentActivitySchema>;
