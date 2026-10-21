import { Option, Schema } from "effect";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { InternalInput } from "../../../contracts/conversations/internal-input";
import type { UiPart } from "../../../contracts/conversations/session-contract";

export const internalInputEntryType = "cake.internal-input/v1";
/** Written before Pi persists the immediately following user-transport message. */
const InternalInputEntry = Schema.Struct({
  timestamp: Schema.Number,
  origin: InternalInput,
});

/** A marker applies to one following transport message, not every identical string/timestamp. */
export function internalInputOrigins(entries: readonly SessionEntry[]) {
  const origins = new Map<string, InternalInput>();
  let pending: typeof InternalInputEntry.Type | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === internalInputEntryType) {
      pending = Option.getOrUndefined(Schema.decodeUnknownOption(InternalInputEntry)(entry.data));
    } else if (entry.type === "message" || entry.type === "custom_message") {
      if (
        entry.type === "message" &&
        entry.message.role === "user" &&
        pending?.timestamp === entry.message.timestamp
      )
        origins.set(entry.id, pending.origin);
      pending = undefined;
    }
  }
  return origins;
}

export function internalInputPart(origin: InternalInput, id: string): UiPart {
  return {
    id,
    kind: "context",
    title: "Workboard",
    text: `Coordination entries ${origin.sequences.map((sequence) => `#${sequence}`).join(", ")}. Application context, not a user request.`,
  };
}
