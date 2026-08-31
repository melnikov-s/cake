import { z } from "zod";
import { agentModelPreferenceSchema } from "../../../ipc/plugin-agent-contract";

const subagentProfileSchema = z.enum(["scout", "planner", "reviewer", "worker"]);

export const subagentTaskSchema = z.object({
  task: z.string().min(1).max(262_144),
  profile: subagentProfileSchema.default("worker"),
  model: agentModelPreferenceSchema.default({ prefer: "current" }),
  instructions: z.string().max(32_768).optional(),
  fastMode: z.boolean().default(false),
  maxDepth: z.number().int().min(0).max(1).default(0),
  retain: z.boolean().default(false),
});
export type SubagentTaskInput = z.input<typeof subagentTaskSchema>;

export const parallelSubagentSchema = z.object({
  tasks: z.array(subagentTaskSchema).min(1).max(8),
});
export type ParallelSubagentTasksInput = z.input<typeof parallelSubagentSchema>;
