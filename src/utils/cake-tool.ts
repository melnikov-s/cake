import { Schema } from "effect";
import type { UiPart } from "../ipc/session-contract";

export type ToolPart = Extract<UiPart, { kind: "tool" }>;

/** Returns the semantic operation name used for specialized rendering. */
const cakeEnvelopeProjectionSchema = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export function toolOperationName(part: ToolPart) {
  if (part.name !== "cake") return part.name;
  if (part.command) return part.command;
  try {
    const envelope = Schema.decodeUnknownResult(cakeEnvelopeProjectionSchema)(
      JSON.parse(part.input),
    );
    return envelope._tag === "Success" ? envelope.success.command : part.name;
  } catch {
    return part.name;
  }
}
