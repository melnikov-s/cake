import type { JsonObject } from "../serialization/json-contract";

/** Curated operation declarations exposed by an authoritative Cake control gateway. */
export interface GlobalControlTool {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  parameters: JsonObject;
  examples?: readonly { input?: JsonObject; description?: string }[];
  result?: string;
  limitations?: readonly string[];
}
