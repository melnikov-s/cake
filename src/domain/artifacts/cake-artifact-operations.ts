import type { CakeArtifactOperationOptions } from "../../contracts/artifacts/artifact-agent-control";
import type { CakeOperationHost } from "../../contracts/agent/cake-operation-context";
import { editText } from "../../services/pi/edit-text";
import { createCakeArtifactStateOperations } from "./cake-artifact-state-operations";
import { Schema } from "effect";
import { retainedWidgetPreviewEvidence } from "../../contracts/widgets/widget-view-evidence";
import { jsonValueSchema } from "../../contracts/serialization/json-contract";
import {
  AgentListInput,
  agentListLabel,
  agentListPage,
} from "../../contracts/agent/agent-list-data";

import {
  MAX_ARTIFACT_INPUT_BYTES,
  artifactPointerSchema,
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../contracts/artifacts/artifact-contract";

import { widgetConversationFromOperation } from "../widgets/widgetOperationContext";
import { ArtifactProjectionMetadata } from "../../contracts/artifacts/artifact-projection-data";
import {
  cakeOperationImageResult,
  type CakeOperationDefinition,
  type CakeOperationExecutionContext,
} from "../../contracts/agent/cake-operation";

type ArtifactFileImportInput = Parameters<
  NonNullable<CakeArtifactOperationOptions["importArtifactFile"]>
>[0];

const artifactIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const titleSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const markdownSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ARTIFACT_INPUT_BYTES),
);

const widgetSchema = Schema.Struct({
  id: artifactIdSchema,
  title: titleSchema,
  brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  data: Schema.optionalKey(Schema.Unknown),
  initialState: Schema.optionalKey(jsonValueSchema),
  fallback: Schema.Struct({
    markdown: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_ARTIFACT_INPUT_BYTES),
    ),
  }),
});

const markdownCreateSchema = Schema.Struct({
  id: artifactIdSchema,
  title: Schema.optionalKey(titleSchema),
  kind: Schema.Literal("markdown"),
  markdown: markdownSchema,
});
const fileCreateSchema = Schema.Struct({
  id: artifactIdSchema,
  title: Schema.optionalKey(titleSchema),
  kind: Schema.Literal("file"),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
const artifactCreateSchema = Schema.Struct({
  artifact: Schema.Union([markdownCreateSchema, fileCreateSchema]),
});
const artifactReferenceSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?:cake:\/\/artifact\/)?[A-Za-z0-9][A-Za-z0-9._:-]*(?:@r[1-9][0-9]*)?$/),
);
const artifactResolveSchema = Schema.Struct({ reference: artifactReferenceSchema });
const expectedRevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
const artifactUpdateSchema = Schema.Struct({
  lineageId: artifactIdSchema,
  expectedRevision: expectedRevisionSchema,
  title: Schema.optionalKey(titleSchema),
  edits: Schema.Array(
    Schema.Struct({
      oldText: markdownSchema,
      newText: Schema.String.check(Schema.isMaxLength(MAX_ARTIFACT_INPUT_BYTES)),
    }),
  ).check(Schema.isMinLength(1)),
});
const artifactReplaceSchema = Schema.Union([
  Schema.Struct({
    lineageId: artifactIdSchema,
    expectedRevision: expectedRevisionSchema,
    title: Schema.optionalKey(titleSchema),
    markdown: markdownSchema,
  }),
  Schema.Struct({
    lineageId: artifactIdSchema,
    expectedRevision: expectedRevisionSchema,
    title: Schema.optionalKey(titleSchema),
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    lineageId: artifactIdSchema,
    expectedRevision: expectedRevisionSchema,
    title: Schema.optionalKey(titleSchema),
    instructions: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  }),
]);
const artifactRestoreSchema = Schema.Struct({
  lineageId: artifactIdSchema,
  sourceRevision: expectedRevisionSchema,
  expectedRevision: expectedRevisionSchema,
});
const artifactLinkSchema = Schema.Struct({ reference: artifactReferenceSchema });
const artifactUnlinkSchema = Schema.Struct({ lineageId: artifactIdSchema });
const artifactSearchSchema = Schema.Struct({
  ...AgentListInput.fields,
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
const artifactSummarySchema = Schema.Struct({
  exactRef: ArtifactProjectionMetadata.fields.exactRef,
  kind: ArtifactProjectionMetadata.fields.kind,
  title: Schema.String.check(Schema.isMaxLength(256)),
});
const artifactListOutputSchema = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nextOffset: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  artifacts: Schema.Array(artifactSummarySchema).check(Schema.isMaxLength(50)),
});
const artifactHistorySchema = Schema.Struct({
  ...AgentListInput.fields,
  lineageId: artifactIdSchema,
});

function artifactPage(metadata: readonly ArtifactProjectionMetadata[], input: AgentListInput) {
  const all = Schema.decodeUnknownSync(Schema.Array(ArtifactProjectionMetadata), {
    onExcessProperty: "error",
  })(metadata);
  const query = input.query?.toLowerCase();
  const selected = all.filter(
    (artifact) =>
      !query ||
      [
        artifact.lineageId,
        artifact.title ?? "",
        artifact.kind,
        artifact.exactRef,
        artifact.stableRef,
      ]
        .join("\n")
        .toLowerCase()
        .includes(query),
  );
  const { items, ...page } = agentListPage(selected, input);
  return {
    ...page,
    artifacts: items.map((artifact) => ({
      exactRef: artifact.exactRef,
      kind: artifact.kind,
      title: agentListLabel(artifact.title ?? artifact.lineageId),
    })),
  };
}

function runtimeContext(context: CakeOperationExecutionContext) {
  const sessionId = context.runtime.sessionId;
  if (!sessionId) throw new Error("The Cake session is not ready");
  return { ...context.runtime, sessionId };
}

const stableReference = (value: string) =>
  value.startsWith("cake://artifact/") ? value : `cake://artifact/${value}`;

const linkedArtifactSystemGuidance =
  "This session has linked artifacts. Use artifacts.list to inspect them when relevant.";

export function createCakeArtifactOperations(
  pi: CakeOperationHost,
  options: CakeArtifactOperationOptions,
): CakeOperationDefinition[] {
  const persist = async (
    input: CakeArtifactV1,
    sessionId: string,
    stagedState?: Parameters<CakeArtifactOperationOptions["persistArtifact"]>[1],
  ) => {
    const artifact = parseArtifactInput(input);
    if (artifact.sessionId !== sessionId)
      throw new Error("Artifact sessionId does not match the active Pi session");
    return stagedState === undefined
      ? options.persistArtifact(artifact)
      : options.persistArtifact(artifact, stagedState);
  };
  const appendPointer = (
    record: ArtifactRecord,
    origin: { assistantEntryId: string; toolCallId: string },
    presentation?: "selected-revision",
  ) => {
    pi.appendEntry(
      "cake.artifact/v1",
      Schema.decodeUnknownSync(artifactPointerSchema)({
        protocol: "cake.artifact/v1",
        lineageId: record.artifact.id,
        revision: record.artifact.revision,
        kind: record.artifact.kind,
        digest: record.digest,
        ...(record.artifact.title === undefined ? null : { title: record.artifact.title }),
        stableRef: `cake://artifact/${record.artifact.id}`,
        exactRef: `cake://artifact/${record.artifact.id}@r${record.artifact.revision}`,
        origin,
        ...(presentation === undefined ? null : { presentation }),
      }),
    );
  };
  const pointerOrigin = (context: CakeOperationExecutionContext) => {
    const runtime = runtimeContext(context);
    const assistantEntryId = runtime.entryId;
    if (!assistantEntryId)
      throw new Error("Artifact creation requires an originating assistant message");
    return { assistantEntryId, toolCallId: context.toolCallId };
  };
  const resolveArtifact = async (reference: string) => {
    if (!options.resolveArtifact) throw new Error("Artifact resolution is unavailable");
    return options.resolveArtifact(stableReference(reference));
  };

  if (pi.on && options.hasLinkedArtifacts)
    pi.on("before_agent_start", async (event) => {
      if (!(await options.hasLinkedArtifacts!())) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${linkedArtifactSystemGuidance}` };
    });

  const operations: CakeOperationDefinition[] = [
    ...createCakeArtifactStateOperations(options),
    {
      command: "artifacts.list",
      topic: "artifacts",
      summary: "List bounded metadata for artifacts effectively linked to this session.",
      guidance: [
        "Lists return metadata, not payloads. Resolve exact-revision files and read only what you need. Widget publication and artifacts.preview supply a native image to the agent; the user's live inline rendering alone is not model-visible evidence.",
        "Stable cake://artifact/<id> references follow latest; exact @rN references are reproducible.",
      ],
      inputSchema: AgentListInput,
      examples: [{}],
      result:
        "Exact references, titles and kinds, total and nextOffset; resolve one reference for read-only files and full metadata.",
      outputSchema: artifactListOutputSchema,
      async execute(input) {
        if (!options.listArtifactMetadata) throw new Error("Artifact listing is unavailable");
        return artifactPage(
          await options.listArtifactMetadata(),
          Schema.decodeUnknownSync(AgentListInput)(input),
        );
      },
    },
    {
      command: "artifacts.search",
      topic: "artifacts",
      summary: "Search linked artifact titles, kinds, IDs, and references.",
      inputSchema: artifactSearchSchema,
      outputSchema: artifactListOutputSchema,
      examples: [{ input: { query: "design", limit: 20 } }],
      result: "Bounded matching artifact metadata; payload content is not searched or returned.",
      async execute(input) {
        if (!options.listArtifactMetadata) throw new Error("Artifact search is unavailable");
        return artifactPage(
          await options.listArtifactMetadata(),
          Schema.decodeUnknownSync(artifactSearchSchema)(input),
        );
      },
    },
    {
      command: "artifacts.history",
      topic: "artifacts",
      summary: "List bounded immutable revision metadata for one linked lineage.",
      inputSchema: artifactHistorySchema,
      examples: [{ input: { lineageId: "design-plan", limit: 50 } }],
      result:
        "Exact revision references, titles and kinds, newest first; nextOffset continues, resolve-reference supplies files.",
      async execute(input) {
        if (!options.historyArtifact) throw new Error("Artifact history is unavailable");
        const parsed = Schema.decodeUnknownSync(artifactHistorySchema)(input);
        const all = [
          ...(await options.historyArtifact(stableReference(parsed.lineageId))),
        ].reverse();
        const { artifacts, ...page } = artifactPage(all, parsed);
        return { ...page, revisions: artifacts };
      },
    },
    {
      command: "artifacts.resolve-reference",
      topic: "artifacts",
      summary: "Resolve a linked stable or exact artifact reference to an exact read-only path.",
      guidance: [
        "An unlinked pasted URI is not readable. Explicitly link it first; temporary read leases are deferred until Cake has a durable lease owner.",
        "For approved initial-state widget designs, read preview.png or call artifacts.preview with the approved exact @rN reference before implementation. For user-selected variants, ask for Attach current view pixels and exact revision metadata; an initial-state preview at the same revision is not matching evidence. The brief describes intent, not the approved rendering. Read source.tsx.txt/source.html.txt selectively for ambiguous layout or behavior; do not import private generation history. Compare a real implementation screenshot against that same approved revision.",
      ],
      inputSchema: artifactResolveSchema,
      outputSchema: ArtifactProjectionMetadata,
      examples: [{ input: { reference: "cake://artifact/design-plan@r1" } }],
      result: "Bounded metadata and canonical files for the selected exact revision.",
      async execute(input) {
        // SAFETY: CakeOperationRegistry parsed input with artifactResolveSchema.
        const parsed = input as typeof artifactResolveSchema.Type;
        return (await resolveArtifact(parsed.reference)).metadata;
      },
    },
    {
      command: "artifacts.present",
      topic: "artifacts",
      summary: "Show an existing linked artifact again inline at this tool call.",
      guidance: [
        "Use this when the user wants to see an existing artifact again, including after state-only edits. Do not regenerate it with widgets.present, replace it, or repeat a Markdown embed.",
        "Stable references resolve the current source; exact @rN references select that immutable source revision. Widgets hydrate current lineage state in either case.",
        "Each successful call adds a new inline surface, even if the same revision was already published or presented. No artifact revision, link, or mutable state is changed. All artifact kinds use their existing renderer and sandbox.",
        "This presents to the user, not a new model-visible screenshot. Use artifacts.preview for the retained initial-state image—not the current interactive view. Ask the user to Attach current view for live pixels.",
      ],
      inputSchema: artifactResolveSchema,
      outputSchema: ArtifactProjectionMetadata,
      examples: [{ input: { reference: "cake://artifact/architecture-map" } }],
      result: "Selected exact-revision metadata; the artifact renders inline in the conversation.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with artifactResolveSchema.
        const { reference } = input as typeof artifactResolveSchema.Type;
        const origin = pointerOrigin(context);
        const resolved = await resolveArtifact(reference);
        if (context.signal.aborted) throw new Error("Artifact presentation was cancelled");
        appendPointer(resolved.record, origin, "selected-revision");
        return resolved.metadata;
      },
    },
    {
      command: "artifacts.preview",
      topic: "artifacts",
      summary:
        "Inspect an exact widget revision’s initial-state preview—not its current interactive view.",
      guidance: [
        "Use the user-approved exact @rN reference, never latest. Link an unlinked reference first. This returns the accepted review capture, not a new render or the private generation conversation.",
        "Initial state—not current interactive view. This immutable preview does not track the user’s selected variant, even at the same revision. For an approved interactive selection, ask the user to use Attach current view on that widget and send the pixels + evidence metadata. Inspect pixels matching both revision and selected state before implementation; source alone is never visual verification.",
      ],
      inputSchema: Schema.Struct({
        reference: artifactReferenceSchema.check(Schema.isPattern(/@r[1-9][0-9]*$/)),
      }),
      examples: [{ input: { reference: "cake://artifact/architecture-map@r1" } }],
      result:
        "Exact revision metadata plus a native PNG image supplied to the agent. No source or generation history.",
      limitations: [
        "Historical revisions without a retained preview report an error; Cake never substitutes latest or regenerates an approved snapshot.",
        "Native image results require a direct cake tool call, not a structured codemode call. Alternatively read the resolved preview.png file with an image-capable read tool.",
      ],
      async execute(input) {
        // SAFETY: the operation schema validates the exact reference.
        const { reference } = input as { reference: string };
        const resolved = await resolveArtifact(reference);
        const artifact = resolved.record.artifact;
        if (artifact.kind !== "widget")
          throw new Error("Rendered previews are only available for widgets");
        if (!artifact.payload.preview)
          throw new Error(`No retained rendered preview for ${resolved.metadata.exactRef}`);
        return cakeOperationImageResult(
          {
            ...resolved.metadata,
            previewEvidence: retainedWidgetPreviewEvidence(resolved.metadata.exactRef),
          },
          [{ type: "image", ...artifact.payload.preview }],
        );
      },
    },
    {
      command: "artifacts.create",
      topic: "artifacts",
      summary:
        "Create a durable Markdown document or imported file artifact in the current session.",
      guidance: [
        "Keep investigations, explanations, ordinary implementation details, progress, and reports in chat by default. Create text/Markdown artifacts only when the user explicitly requests them, except for a spec serving as a shared, durable reference that this session can read after compaction or child sessions can read for coordinated implementation. Shared-reference usefulness, not length or formatting, is the purpose; merely being an investigation does not qualify.",
        "Markdown is the readable content itself and does not need a separate fallback argument. This text/Markdown policy does not restrict non-text visual artifacts or explicitly requested file deliverables.",
        "Import a workspace file when the file itself is the reusable deliverable. Cake snapshots it; later workspace changes do not mutate the artifact.",
        "Choose a stable descriptive ID. Use artifacts.update for targeted Markdown edits or artifacts.replace for full replacements, file snapshots, and widget revision instructions, rather than creating a second ID.",
      ],
      inputSchema: artifactCreateSchema,
      examples: [
        {
          input: {
            artifact: {
              id: "design-plan",
              title: "Design plan",
              kind: "markdown",
              markdown: "# Design plan\n\nShared implementation spec for child sessions.",
            },
          },
        },
      ],
      result: "Bounded exact-revision metadata and the read-only projection path.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with artifactCreateSchema.
        const draft = (input as typeof artifactCreateSchema.Type).artifact;
        const sessionId = runtimeContext(context).sessionId;
        let artifact: CakeArtifactV1;
        if (draft.kind === "file") {
          if (!options.importArtifactFile)
            throw new Error("Workspace file artifact import is unavailable");
          const fileInput: ArtifactFileImportInput = {
            id: draft.id,
            path: draft.path,
            revision: 1,
          };
          if (draft.title !== undefined) fileInput.title = draft.title;
          artifact = await options.importArtifactFile(fileInput);
        } else {
          artifact = {
            protocol: "cake.artifact/v1",
            id: draft.id,
            sessionId,
            revision: 1,
            kind: "markdown",
            payload: { markdown: draft.markdown },
            fallback: { markdown: draft.markdown },
            interaction: { mode: "present" },
          };
          if (draft.title) artifact = { ...artifact, title: draft.title };
        }
        const record = await persist(artifact, sessionId);
        appendPointer(record, pointerOrigin(context));
        return (await resolveArtifact(`cake://artifact/${record.artifact.id}@r1`)).metadata;
      },
    },
    {
      command: "artifacts.update",
      topic: "artifacts",
      summary: "Apply targeted text replacements to an existing Markdown artifact.",
      guidance: [
        "Read the current exact revision before editing. Send only changed blocks, not the complete document.",
        "Uses Pi's edit tool with artifact-backed in-memory read/write operations: the same matching, uniqueness, overlap, BOM/line-ending preservation, limited whitespace/typography normalization, and no-op rejection as file edits. All edits are matched against the original revision, not incrementally. Supply exact oldText with enough context to be unique; merge overlapping or nested edits.",
        "Use an empty newText to delete a block. Keep oldText as small as possible while still unique. Cake publishes one new immutable revision and preserves the stable ID.",
        "Use artifacts.replace for full Markdown rewrites, replacement file snapshots, or widget revision instructions. Never edit read-only artifact projection files directly.",
      ],
      inputSchema: artifactUpdateSchema,
      examples: [
        {
          input: {
            lineageId: "design-plan",
            expectedRevision: 1,
            edits: [{ oldText: "Original sentence.", newText: "Revised sentence." }],
          },
        },
      ],
      result: "Bounded newly published revision metadata and its read-only projection path.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with artifactUpdateSchema.
        const update = input as typeof artifactUpdateSchema.Type;
        const resolved = await resolveArtifact(update.lineageId);
        const current = resolved.record;
        if (current.artifact.revision !== update.expectedRevision)
          throw new Error(
            `Artifact ${update.lineageId} is at revision ${current.artifact.revision}; expected ${update.expectedRevision}`,
          );
        if (current.artifact.kind !== "markdown")
          throw new Error(`Artifact ${update.lineageId} is ${current.artifact.kind}, not markdown`);
        // Pi edits staged bytes only; Cake still owns immutable revision publication.
        const markdown = await editText({
          workingDirectory: current.workspacePath,
          path: resolved.metadata.exactPath,
          text: current.artifact.payload.markdown,
          edits: update.edits,
          toolCallId: context.toolCallId,
          signal: context.signal,
        });
        if (context.signal.aborted) throw new Error("Artifact update was cancelled");
        const sessionId = runtimeContext(context).sessionId;
        let artifact: CakeArtifactV1 = {
          ...current.artifact,
          sessionId,
          revision: update.expectedRevision + 1,
          payload: { markdown },
          fallback: { markdown },
        };
        if (update.title !== undefined) artifact = { ...artifact, title: update.title };
        const record = await persist(artifact, sessionId);
        appendPointer(record, pointerOrigin(context));
        return (
          await resolveArtifact(`cake://artifact/${record.artifact.id}@r${artifact.revision}`)
        ).metadata;
      },
    },
    {
      command: "artifacts.replace",
      topic: "artifacts",
      summary: "Replace an existing artifact or revise a widget from instructions.",
      guidance: [
        "Use this operation when the user asks to edit, fix, revise, or repair an artifact. Cake preserves its stable ID and publishes the next immutable revision.",
        "Markdown replacements require the complete document; prefer artifacts.update for targeted text edits. File replacements snapshot a replacement workspace-relative path. Widget replacements accept revision instructions and run isolated generation, rendering, and visual review before publication, returning the new revision's accepted PNG as a native image.",
      ],
      inputSchema: artifactReplaceSchema,
      examples: [
        {
          input: {
            lineageId: "design-plan",
            expectedRevision: 1,
            markdown: "# Revised design plan\n\nUpdated.",
          },
        },
      ],
      result: "Bounded newly published revision metadata and its read-only projection path.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with artifactReplaceSchema.
        const update = input as typeof artifactReplaceSchema.Type;
        const current = (await resolveArtifact(update.lineageId)).record;
        if (current.artifact.revision !== update.expectedRevision)
          throw new Error(
            `Artifact ${update.lineageId} is at revision ${current.artifact.revision}; expected ${update.expectedRevision}`,
          );
        const runtime = runtimeContext(context);
        const sessionId = runtime.sessionId;
        const revision = update.expectedRevision + 1;
        let artifact: CakeArtifactV1;
        let stagedState: Parameters<CakeArtifactOperationOptions["persistArtifact"]>[1];
        if ("markdown" in update) {
          if (current.artifact.kind !== "markdown")
            throw new Error(
              `Artifact ${update.lineageId} is ${current.artifact.kind}, not markdown`,
            );
          artifact = {
            ...current.artifact,
            revision,
            payload: { markdown: update.markdown },
            fallback: { markdown: update.markdown },
          };
          if (update.title) artifact = { ...artifact, title: update.title };
        } else if ("path" in update) {
          if (current.artifact.kind !== "file")
            throw new Error(`Artifact ${update.lineageId} is ${current.artifact.kind}, not a file`);
          if (!options.importArtifactFile)
            throw new Error("Workspace file artifact import is unavailable");
          const fileInput: ArtifactFileImportInput = {
            id: current.artifact.id,
            path: update.path,
            revision,
          };
          const title = update.title ?? current.artifact.title;
          if (title !== undefined) fileInput.title = title;
          artifact = await options.importArtifactFile(fileInput);
        } else {
          if (current.artifact.kind !== "widget")
            throw new Error(
              `Artifact ${update.lineageId} is ${current.artifact.kind}; revision instructions are only valid for widgets`,
            );
          if (!options.reviseInlineWidget)
            throw new Error("Durable widget revision is unavailable");
          if (!options.readArtifactState) throw new Error("Artifact state access is unavailable");
          const latestState = await options.readArtifactState(update.lineageId);
          const generated = await options.reviseInlineWidget({
            sessionId,
            generationSessionId: current.artifact.payload.generationSessionId,
            source: current.artifact.payload.source,
            brief: current.artifact.payload.brief,
            fallback: current.artifact.fallback.markdown,
            instructions: update.instructions,
            initialState: latestState.value,
            initialStateVersion: latestState.version,
            model: runtime.model,
            signal: context.signal,
          });
          if (context.signal.aborted) throw new Error("Widget revision was cancelled");
          if (!generated.browser)
            throw new Error("Accepted widget revision has no retained browser output");
          if (generated.state !== undefined)
            stagedState = {
              expectedVersion: latestState.version,
              value: generated.state,
            };
          artifact = {
            ...current.artifact,
            revision,
            payload: {
              ...current.artifact.payload,
              source: generated.source,
              generationSessionId: generated.generationSessionId,
              preview: generated.preview,
              browser: generated.browser,
            },
          };
          if (update.title) artifact = { ...artifact, title: update.title };
        }
        // The publishing session is revision provenance; the global lineage identity stays stable.
        artifact = { ...artifact, sessionId };
        const record = await persist(artifact, sessionId, stagedState);
        appendPointer(record, pointerOrigin(context));
        const resolved = await resolveArtifact(
          `cake://artifact/${record.artifact.id}@r${revision}`,
        );
        return record.artifact.kind === "widget" && record.artifact.payload.preview
          ? cakeOperationImageResult(
              {
                ...resolved.metadata,
                previewEvidence: retainedWidgetPreviewEvidence(resolved.metadata.exactRef),
              },
              [{ type: "image", ...record.artifact.payload.preview }],
            )
          : resolved.metadata;
      },
    },
    {
      command: "artifacts.restore",
      topic: "artifacts",
      summary: "Publish a historical snapshot as the next immutable revision.",
      inputSchema: artifactRestoreSchema,
      examples: [{ input: { lineageId: "design-plan", sourceRevision: 1, expectedRevision: 3 } }],
      result:
        "The newly published exact revision metadata and read-only path, plus a native image for widgets with a retained preview.",
      async execute(input, context) {
        if (!options.restoreArtifact) throw new Error("Artifact restore is unavailable");
        // SAFETY: CakeOperationRegistry parsed input with artifactRestoreSchema.
        const parsed = input as typeof artifactRestoreSchema.Type;
        const restored = await options.restoreArtifact(parsed);
        appendPointer(restored.record, pointerOrigin(context));
        return restored.record.artifact.kind === "widget" &&
          restored.record.artifact.payload.preview
          ? cakeOperationImageResult(
              {
                ...restored.metadata,
                previewEvidence: retainedWidgetPreviewEvidence(restored.metadata.exactRef),
              },
              [{ type: "image", ...restored.record.artifact.payload.preview }],
            )
          : restored.metadata;
      },
    },
    {
      command: "artifacts.link",
      topic: "artifacts",
      summary: "Explicitly link a global stable or exact artifact reference to this session scope.",
      inputSchema: artifactLinkSchema,
      examples: [{ input: { reference: "cake://artifact/design-plan" } }],
      result: "The selected linked revision metadata. Linking appends no Pi pointer.",
      async execute(input) {
        if (!options.linkArtifact) throw new Error("Artifact linking is unavailable");
        // SAFETY: CakeOperationRegistry parsed input with artifactLinkSchema.
        const parsed = input as typeof artifactLinkSchema.Type;
        return options.linkArtifact(stableReference(parsed.reference));
      },
    },
    {
      command: "artifacts.unlink",
      topic: "artifacts",
      summary: "Remove this session's effective direct or family artifact link.",
      inputSchema: artifactUnlinkSchema,
      examples: [{ input: { lineageId: "design-plan" } }],
      result: "Confirmation only. Unlinking appends no Pi pointer and does not delete history.",
      async execute(input) {
        if (!options.unlinkArtifact) throw new Error("Artifact unlinking is unavailable");
        // SAFETY: CakeOperationRegistry parsed input with artifactUnlinkSchema.
        const parsed = input as typeof artifactUnlinkSchema.Type;
        await options.unlinkArtifact(parsed.lineageId);
        return { lineageId: parsed.lineageId, unlinked: true };
      },
    },
  ];

  if (options.generateInlineWidget)
    operations.push({
      command: "widgets.present",
      topic: "widgets",
      summary: "Delegate and present one self-contained interactive or highly visual React widget.",
      guidance: [
        "Prefer ordinary inline Markdown—including Mermaid and small tables—whenever it communicates the result clearly. Create a widget only for a substantial, reusable, or genuinely interactive/visual deliverable, especially when requested.",
        "Supply the explanation goal, audience, verified facts/source references, bounded data, and a readable Markdown fallback. Do not write the generated React source yourself.",
        "Publication supplies the accepted rendered preview to the agent as a native image, with an immutable exact reference. The user sees a live interactive widget. The retained PNG is Initial state—not current interactive view. Revision alone does not identify a selected variant. Before implementing an approved design, inspect matching revision AND state pixels: use the exact preview for the initial state, or ask the user to Attach current view for their interactive selection. Never claim visual verification from source or textual image descriptions. Read projected source selectively when needed and compare the implementation's real screenshot against the approved revision.",
        "The specialist can read domain skills and combine React, installed widget libraries, editable canvases, filters and details. Supply initialState for artifact-scoped JSON data; the widget owns its format and save timing. Describe intended relationships and useful interactions, not pixel coordinates or a mandatory graph DSL.",
        "The published visualization is shown inline, expanded by default with a collapse control. Do not add a redundant embed or Open artifact link after publication. To show an existing artifact again on demand, use artifacts.present with its stable or exact reference, not widgets.present regeneration or duplicate Markdown embeds. Ordinary [Title](cake://artifact/<id>) links stay compact. Use exact revisions for historical explanations.",
      ],
      inputSchema: Schema.Struct({ widget: widgetSchema }),
      examples: [
        {
          input: {
            widget: {
              id: "architecture-map",
              title: "Architecture map",
              brief: "An interactive dependency map with selectable nodes and a detail panel.",
              fallback: { markdown: "Architecture dependency map." },
            },
          },
        },
      ],
      result:
        "The persisted widget ID, revision, digest and exact reference plus its accepted review PNG as a native model-visible image; no generated source or private branch history.",
      limitations: [
        "The immutable snapshot, including accepted PNG bytes, must fit the existing 1 MiB serialized artifact limit. Oversized publication fails rather than silently omitting the preview.",
        "Generated widgets have no filesystem, Node, Electron, parent-DOM or unrestricted Cake API access. @cake/artifact-sdk grants only artifact-scoped JSON state. CSP blocks fetch/XHR/WebSocket. Required libraries must already be installed; ask for dependency authorization outside the private generation branch.",
        "Generation inherits the caller's ancestor context at creation time, excluding sibling branches and unfinished tool calls. Revisions follow the artifact's generation branch, not later parent messages.",
        "Every successfully rendered candidate is reviewed from an actual Cake Electron screenshot. Private review history stays private; only the accepted capture is retained in the immutable artifact snapshot and supplied to the caller. The capture covers one bounded initial state, not every interaction, theme, or viewport.",
      ],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with the definition's input schema.
        const widget = (input as { widget: typeof widgetSchema.Type }).widget;
        const serialized = JSON.stringify(widget);
        if (new TextEncoder().encode(serialized).byteLength > 262_144)
          throw new Error("Widget brief exceeds the 262144-byte limit");
        const runtime = runtimeContext(context);
        const sessionId = runtime.sessionId;
        const generated = await options.generateInlineWidget!({
          sessionId,
          parentConversation: widgetConversationFromOperation(runtime),
          brief: widget.brief,
          data: widget.data,
          initialState: widget.initialState,
          fallback: widget.fallback.markdown,
          model: runtime.model
            ? { provider: runtime.model.provider, id: runtime.model.id }
            : undefined,
          signal: context.signal,
        });
        if (context.signal.aborted) throw new Error("Widget generation was cancelled");
        if (!generated.browser) throw new Error("Accepted widget has no retained browser output");
        const record = await persist(
          {
            protocol: "cake.artifact/v1",
            id: widget.id,
            sessionId,
            revision: 1,
            kind: "widget",
            title: widget.title,
            payload: {
              language: generated.language,
              source: generated.source,
              brief: serialized,
              generationSessionId: generated.generationSessionId,
              preview: generated.preview,
              browser: generated.browser,
            },
            fallback: widget.fallback,
            interaction: { mode: "present" },
          },
          sessionId,
          generated.state !== undefined || widget.initialState !== undefined
            ? {
                expectedVersion: 0,
                value:
                  generated.state !== undefined ? generated.state : (widget.initialState ?? null),
              }
            : undefined,
        );
        appendPointer(record, pointerOrigin(context));
        if (record.artifact.kind !== "widget" || !record.artifact.payload.preview)
          throw new Error("Published widget is missing its accepted preview");
        return cakeOperationImageResult(
          {
            artifactId: record.artifact.id,
            artifactRevision: record.artifact.revision,
            exactRef: `cake://artifact/${record.artifact.id}@r${record.artifact.revision}`,
            digest: record.digest,
            previewEvidence: retainedWidgetPreviewEvidence(
              `cake://artifact/${record.artifact.id}@r${record.artifact.revision}`,
            ),
          },
          [{ type: "image", ...record.artifact.payload.preview }],
        );
      },
    });

  return operations;
}
