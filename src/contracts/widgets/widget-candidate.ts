import type { JsonValue } from "../serialization/json-contract";

/** Private, operation-local staging area. Never a live artifact or transcript authority. */
export interface WidgetCandidate {
  source: string;
  state: JsonValue;
}
