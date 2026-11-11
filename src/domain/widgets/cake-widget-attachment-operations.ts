import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../../contracts/serialization/json-contract";
import { widgetAttachmentContracts } from "../../contracts/widgets/widget-attachment";

export function createWidgetAttachmentOperations(
  call: (command: string, input: JsonObject, signal: AbortSignal) => Promise<JsonValue>,
): CakeOperationDefinition[] {
  return widgetAttachmentContracts.map((contract) => ({
    ...contract,
    topic: "widgets",
    outputSchema: Schema.Json,
    guidance: [
      "Attachments reference existing widget lineages. Move an attachment by presenting the same ID with another slot; identity and saved state survive.",
      "Targets are session categories across Cake, not sessions within one project. Broad attachments share one widget instance. Independent state requires widgets.instantiate with a new lineage ID.",
      'Slot tab is global-only: use target: {kind: "global"}. It adds a full Workspace pane chosen beside To-dos/Sessions. Only visible tab attachments appear in its dropdown; tab widgets stay active when unselected or changing conversations. One tab placement per widget lineage.',
      "User requests authorize agents to attach directly. Widget code cannot attach itself or manage permissions.",
    ],
    examples: [],
    result: "Structured attachment receipt or current attachments.",
    execute: (input, context) =>
      call(contract.command, Schema.decodeUnknownSync(jsonObjectSchema)(input), context.signal),
  }));
}
