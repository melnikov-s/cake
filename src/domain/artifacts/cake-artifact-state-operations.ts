import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import type { CakeArtifactOperationOptions } from "../../contracts/artifacts/artifact-agent-control";
import {
  ArtifactState,
  ArtifactStateReplacement,
  ArtifactStateUpdate,
} from "../../contracts/artifacts/artifact-state";
import { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";

export function createCakeArtifactStateOperations(
  options: CakeArtifactOperationOptions,
): CakeOperationDefinition[] {
  return [
    {
      command: "artifacts.state.read",
      topic: "artifacts",
      summary: "Read the current mutable JSON state of a linked widget artifact.",
      inputSchema: Schema.Struct({ lineageId: ArtifactLineageId }),
      outputSchema: ArtifactState,
      examples: [{ input: { lineageId: "editable-diagram" } }],
      result: "Current JSON value and stale-write version (not artifact revision/history).",
      guidance: [
        "State belongs to the artifact lineage, not a session or revision. Every linked view observes the same current value. State writes do not append transcript pointers or artifact revisions.",
      ],
      async execute(input) {
        if (!options.readArtifactState) throw new Error("Artifact state is unavailable");
        const parsed = Schema.decodeUnknownSync(Schema.Struct({ lineageId: ArtifactLineageId }))(
          input,
        );
        return options.readArtifactState(parsed.lineageId);
      },
    },
    {
      command: "artifacts.state.replace",
      topic: "artifacts",
      summary: "Replace linked widget JSON state without adding history.",
      inputSchema: ArtifactStateReplacement,
      outputSchema: ArtifactState,
      examples: [
        { input: { lineageId: "editable-diagram", expectedVersion: 0, value: { nodes: [] } } },
      ],
      result: "The saved current value/version. A stale version fails without mutation.",
      async execute(input) {
        if (!options.replaceArtifactState) throw new Error("Artifact state is unavailable");
        return options.replaceArtifactState(
          Schema.decodeUnknownSync(ArtifactStateReplacement)(input),
        );
      },
    },
    {
      command: "artifacts.state.update",
      topic: "artifacts",
      summary: "Surgically set/remove JSON-pointer paths in linked widget state.",
      inputSchema: ArtifactStateUpdate,
      outputSchema: ArtifactState,
      examples: [
        {
          input: {
            lineageId: "editable-diagram",
            expectedVersion: 1,
            edits: [{ op: "set", path: "/title", value: "Updated" }],
          },
        },
      ],
      result: "One saved current value/version. All edits succeed together or nothing changes.",
      guidance: [
        "Read first and supply expectedVersion. Paths use JSON pointer escaping (~0 for ~, ~1 for /). Set replaces a field/index or appends with /-; remove deletes a field or array item. Parents must exist. Edits run in order. Empty path sets the root.",
      ],
      async execute(input) {
        if (!options.updateArtifactState) throw new Error("Artifact state is unavailable");
        return options.updateArtifactState(Schema.decodeUnknownSync(ArtifactStateUpdate)(input));
      },
    },
  ];
}
