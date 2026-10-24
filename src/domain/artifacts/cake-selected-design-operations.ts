import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import type { CakeArtifactOperationOptions } from "../../contracts/artifacts/artifact-agent-control";
import {
  PrototypeChoice,
  SelectedDesignCaptureInput,
  SelectedDesignReference,
  SelectedDesignSourceInput,
  SelectedDesignSourceOutput,
} from "../../contracts/widgets/prototype-source";
import {
  readPrototypeSource,
  selectedPrototypeModules,
} from "../../services/widgets/prototype-source";

export function createSelectedDesignOperations(
  options: Pick<CakeArtifactOperationOptions, "resolveArtifact" | "readArtifactState">,
): CakeOperationDefinition[] {
  const inspect = async (reference: string, expectedVersion: number) => {
    if (!options.resolveArtifact || !options.readArtifactState)
      throw new Error("Selected design source access is unavailable");
    // Resolution enforces the caller's effective artifact link. No global read bypass.
    const resolved = await options.resolveArtifact(reference);
    const { record, metadata } = resolved;
    const artifact = record.artifact;
    if (
      metadata.exactRef !== reference ||
      metadata.digest !== record.digest ||
      reference !== `cake://artifact/${artifact.id}@r${artifact.revision}`
    )
      throw new Error("Mismatched selected design revision/digest");
    if (metadata.latestRevision !== artifact.revision)
      throw new Error("Selected design revision is stale; explicitly recapture the selection");
    if (
      artifact.kind !== "widget" ||
      artifact.payload.language !== "react" ||
      !artifact.payload.source
    )
      throw new Error("Selected design has no available React source");
    const bundle = readPrototypeSource(artifact.payload.source);
    if (!bundle)
      throw new Error(
        "Widget has no prototype source manifest; revise it explicitly before handoff",
      );
    const state = await options.readArtifactState(artifact.id);
    if (state.lineageId !== artifact.id || state.version !== expectedVersion)
      throw new Error("Selected design state version is stale or mismatched; reread and recapture");
    const choice = Schema.decodeUnknownSync(PrototypeChoice)(state.value);
    const modules = selectedPrototypeModules(bundle, choice.selectedOptionId);
    const selection = Schema.decodeUnknownSync(SelectedDesignReference)({
      schema: "cake.selected-design/v1",
      exactRef: reference,
      digest: record.digest,
      optionId: choice.selectedOptionId,
      state: { version: state.version, value: choice },
    });
    return { selection, modules };
  };
  return [
    {
      command: "artifacts.selection.capture",
      topic: "artifacts",
      summary: "Capture a bounded selected-design reference, without source or images.",
      inputSchema: SelectedDesignCaptureInput,
      outputSchema: SelectedDesignReference,
      examples: [
        { input: { reference: "cake://artifact/prototypes@r1", expectedStateVersion: 1 } },
      ],
      result: "Exact revision/digest, stable option ID, and observed saved selection/version only.",
      guidance: [
        "Read artifacts.state.read first. Supply the exact current @rN and observed nonzero state version. Null/unsaved choices and legacy widgets without a validated module manifest fail explicitly.",
        "Forward this small JSON reference in an ordinary user/session message (or Workboard for family members). It grants no read access and attaches no source, screenshots, other options, or generation history. The receiver explicitly links exactRef with artifacts.link, then requests artifacts.source.",
        "Saved selection is not the current visible view or visual verification. Screenshots are optional, separate visual evidence; never attach them automatically for a source handoff.",
      ],
      async execute(input) {
        const parsed = Schema.decodeUnknownSync(SelectedDesignCaptureInput)(input);
        return (await inspect(parsed.reference, parsed.expectedStateVersion)).selection;
      },
    },
    {
      command: "artifacts.source",
      topic: "artifacts",
      summary:
        "Lazily read only a captured selected option and its required shared source modules.",
      inputSchema: SelectedDesignSourceInput,
      outputSchema: SelectedDesignSourceOutput,
      examples: [
        {
          description:
            "Pass the JSON from artifacts.selection.capture as selection; omit moduleId to inspect the selected closure.",
        },
      ],
      result:
        "Selected module/dependency metadata; optionally one requested module's paged source.",
      guidance: [
        "Pass a captured cake.selected-design/v1 reference. Omit moduleId to discover just the chosen option's dependency closure; request each module by ID with character offset/limit (maximum 48000). External package imports are listed, not copied.",
        "Link exactRef first. Unknown options, unauthorized modules, missing manifests/dependencies/source, mismatched digests, changed revisions and changed saved state fail explicitly. Never substitute latest, all five options, chooser source, a screenshot, or private generation history.",
        "Source is implementation material, not evidence of the visible design. Request a screenshot separately only when visual checks are needed; confirm its artifact revision and selected state.",
      ],
      async execute(input) {
        const parsed = Schema.decodeUnknownSync(SelectedDesignSourceInput)(input);
        if (
          parsed.moduleId === undefined &&
          (parsed.offset !== undefined || parsed.limit !== undefined)
        )
          throw new Error("Source paging requires a moduleId");
        const inspected = await inspect(parsed.selection.exactRef, parsed.selection.state.version);
        if (
          inspected.selection.digest !== parsed.selection.digest ||
          inspected.selection.optionId !== parsed.selection.optionId
        )
          throw new Error(
            "Selected design reference does not match saved selection/revision evidence",
          );
        const module =
          parsed.moduleId === undefined
            ? undefined
            : inspected.modules.find((candidate) => candidate.id === parsed.moduleId);
        if (parsed.moduleId !== undefined && !module)
          throw new Error(
            `Source module is not authorized by the selected option: ${parsed.moduleId}`,
          );
        const offset = parsed.offset ?? 0;
        const limit = parsed.limit ?? 48_000;
        if (module && offset > module.source.length)
          throw new Error("Source offset is out of range");
        const result = {
          selection: inspected.selection,
          modules: inspected.modules.map(({ id, dependencies }) => ({ id, dependencies })),
        };
        if (!module) return result;
        return {
          ...result,
          module: {
            id: module.id,
            source: module.source.slice(offset, offset + limit),
            offset,
            totalCharacters: module.source.length,
            nextOffset: offset + limit < module.source.length ? offset + limit : null,
          },
        };
      },
    },
  ];
}
