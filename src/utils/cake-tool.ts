import { z } from "zod";
import type { UiPart } from "../ipc/session-contract";

export type ToolPart = Extract<UiPart, { kind: "tool" }>;

/** Returns the semantic operation name used for specialized rendering. */
const cakeEnvelopeProjectionSchema = z
  .object({ command: z.string().min(1).max(256) })
  .passthrough();

export function toolOperationName(part: ToolPart) {
  if (part.name !== "cake") return part.name;
  if (part.command) return part.command;
  try {
    const envelope = cakeEnvelopeProjectionSchema.safeParse(JSON.parse(part.input));
    return envelope.success ? envelope.data.command : part.name;
  } catch {
    return part.name;
  }
}
