import { z } from "zod";
import { sourceRangeSchema } from "./source-location";

/** A transcript-derived agent edit projected into embedded VS Code. */
export const agentChangeSchema = z.object({
  id: z.string().min(1).max(256),
  path: z.string().min(1).max(8_192),
  range: sourceRangeSchema.optional(),
  currentTurn: z.boolean(),
});

export type AgentChange = z.infer<typeof agentChangeSchema>;
