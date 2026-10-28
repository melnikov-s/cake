import { Schema } from "effect";
import { INITIAL_WIDGET_PREVIEW_LABEL } from "../contracts/widgets/widget-view-evidence";
import type { UiPart } from "../contracts/conversations/session-contract";

export type ToolPart = Extract<UiPart, { kind: "tool" }>;

/** Returns the semantic operation name used for specialized rendering. */
const cakeEnvelopeProjectionSchema = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export function toolImageCaption(part: ToolPart) {
  return [
    "widgets.present",
    "widgets.instantiate",
    "artifacts.preview",
    "artifacts.replace",
    "artifacts.restore",
  ].includes(toolOperationName(part))
    ? INITIAL_WIDGET_PREVIEW_LABEL
    : undefined;
}

/**
 * Script `image()` output and widget/artifact previews are results shown to the user, so they
 * stay visible beneath a collapsed work log. Other tool images (file and attachment reads,
 * browser screenshots) are inspection details shown inside the expanded tool entry.
 */
export function toolImagesAreConversationResults(part: ToolPart) {
  return part.name === "codemode" || toolImageCaption(part) !== undefined;
}

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
