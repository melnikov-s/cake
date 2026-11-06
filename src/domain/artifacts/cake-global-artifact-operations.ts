import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { globalArtifactOperationContracts } from "../../contracts/artifacts/global-artifact-control";
import { Schema } from "effect";
import { jsonValueSchema, type JsonValue } from "../../contracts/serialization/json-contract";

/** Semantic artifact commands stay behind Cake discovery, never injected Pi tools. */
export function createGlobalArtifactOperations(
  invoke: (command: string, input: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
): readonly CakeOperationDefinition[] {
  return globalArtifactOperationContracts.map((operation) => ({
    ...operation,
    topic: "artifacts",
    examples: [{}],
    result: "Schema-validated artifact metadata, execution state, or semantic handler result.",
    guidance: [
      "Discover artifacts.globals and artifacts.viewing, then artifacts.tools for the selected identity. Do not infer the active artifact from its creator or a historical screenshot.",
      "Artifact tools validate declared input and output schemas and remain available with the view closed. Private data belongs to the artifact, not a shared agent API.",
      "Pause stops logic and pauses schedules until explicit resume. Start/open do not resume background schedules. Deletion removes only Cake-owned data, never arbitrary outside files.",
    ],
    execute: (input, context) =>
      invoke(operation.command, Schema.decodeUnknownSync(jsonValueSchema)(input), context.signal),
  }));
}
