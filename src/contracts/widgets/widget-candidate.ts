import type { JsonValue } from "../serialization/json-contract";

/**
 * Private, operation-local staging area written by the widget side chat through
 * its file tools. Never a live artifact or transcript authority.
 *
 * `files` maps `widget/...` paths to source text; Cake assembles them into the
 * published widget source. `state` is the staged artifact JSON document.
 */
export interface WidgetCandidate {
  files: Record<string, string>;
  state: JsonValue;
}
