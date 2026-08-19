import { z } from "zod";
import { agentModelPreferenceSchema } from "../ipc/plugin-agent-contract";

export const subagentProfileSchema = z.enum(["scout", "planner", "reviewer", "worker"]);
export type SubagentProfile = z.infer<typeof subagentProfileSchema>;

export const subagentTaskSchema = z.object({
  task: z.string().min(1).max(262_144),
  profile: subagentProfileSchema.default("worker"),
  model: agentModelPreferenceSchema.default({ prefer: "current" }),
  instructions: z.string().max(32_768).optional(),
  maxDepth: z.number().int().min(0).max(1).default(0),
  retain: z.boolean().default(false),
});
export type SubagentTask = z.infer<typeof subagentTaskSchema>;
export type SubagentTaskInput = z.input<typeof subagentTaskSchema>;

export const parallelSubagentSchema = z.object({
  tasks: z.array(subagentTaskSchema).min(1).max(8),
});
export type ParallelSubagentTasks = z.infer<typeof parallelSubagentSchema>;
export type ParallelSubagentTasksInput = z.input<typeof parallelSubagentSchema>;

export const SUBAGENT_PROFILE_INSTRUCTIONS = {
  scout: "Explore the codebase and report concise, evidence-backed findings. Do not modify files.",
  planner:
    "Analyze the requested work and return an implementation plan with relevant files, dependencies, risks, and verification. Do not modify files.",
  reviewer:
    "Review the requested code for correctness, security, and maintainability. Report concrete findings with file and line references. Do not modify files.",
  worker:
    "Complete the bounded implementation task, verify the result, and summarize changed files and checks. Do not delegate unless the caller explicitly granted delegation depth.",
} satisfies Record<SubagentProfile, string>;

export const subagentSpawnReceiptSchema = z.object({ handleId: z.uuid() }).passthrough();

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const AUXILIARY_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "ui_request",
  "ui_widget",
]);

export function toolsForSubagentProfile(
  profile: SubagentProfile,
  parentTools: readonly string[],
  allowSubagents: boolean,
) {
  const nonDelegating = parentTools.filter((name) => AUXILIARY_TOOLS.has(name));
  const bounded =
    profile === "worker"
      ? nonDelegating
      : nonDelegating.filter((name) => READ_ONLY_TOOLS.has(name));
  if (!allowSubagents) return bounded;
  return [...bounded, ...parentTools.filter((name) => name.startsWith("subagent_"))];
}

export function subagentSystemPrompt(profile: SubagentProfile, instructions?: string) {
  const profilePrompt = `## Subagent role: ${profile}\n\n${SUBAGENT_PROFILE_INSTRUCTIONS[profile]}`;
  return instructions
    ? `${profilePrompt}\n\n## Additional instructions\n\n${instructions}`
    : profilePrompt;
}
