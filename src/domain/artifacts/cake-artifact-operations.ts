import type { WidgetTemplate } from "../../contracts/widgets/widget-template";
import type { CakeArtifactOperationOptions } from "../../contracts/artifacts/artifact-agent-control";
import type { CakeOperationHost } from "../../contracts/agent/cake-operation-context";
import { editText } from "../../services/pi/edit-text";
import { createCakeArtifactStateOperations } from "./cake-artifact-state-operations";
import { createSelectedDesignOperations } from "./cake-selected-design-operations";
import { readPrototypeSource } from "../../services/widgets/prototype-source";
import { Schema } from "effect";
import { inlineWidgetLanguageSchema } from "../../contracts/widgets/inline-widget-contract";
import type { WidgetGenerationProgress } from "../../contracts/widgets/widget-generation";
import { retainedWidgetPreviewEvidence } from "../../contracts/widgets/widget-view-evidence";
import { jsonValueSchema } from "../../contracts/serialization/json-contract";
import {
  AgentListInput,
  agentListLabel,
  agentListPage,
} from "../../contracts/agent/agent-list-data";

import {
  MAX_ARTIFACT_INPUT_BYTES,
  htmlArtifactHeightSchema,
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
const descriptionSchema = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096)));
const markdownSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ARTIFACT_INPUT_BYTES),
);

const widgetSchema = Schema.Struct({
  description: descriptionSchema,
  language: Schema.optionalKey(inlineWidgetLanguageSchema),
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

const htmlPresentSchema = Schema.Struct({
  description: descriptionSchema,
  id: artifactIdSchema,
  title: titleSchema,
  html: markdownSchema,
  height: Schema.optionalKey(htmlArtifactHeightSchema),
});

const markdownCreateSchema = Schema.Struct({
  description: descriptionSchema,
  id: artifactIdSchema,
  title: Schema.optionalKey(titleSchema),
  kind: Schema.Literal("markdown"),
  markdown: markdownSchema,
});
const fileCreateSchema = Schema.Struct({
  description: descriptionSchema,
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
const widgetInstanceFields = {
  description: descriptionSchema,
  id: artifactIdSchema,
  title: titleSchema,
  initialState: jsonValueSchema,
  fallback: Schema.Struct({ markdown: markdownSchema }),
};
const widgetInstantiateSchema = Schema.Union([
  Schema.Struct({
    ...widgetInstanceFields,
    reference: artifactReferenceSchema.check(Schema.isPattern(/@r[1-9][0-9]*$/)),
  }),
  Schema.Struct({
    ...widgetInstanceFields,
    template: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
]);
const expectedRevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
const artifactUpdateSchema = Schema.Struct({
  description: descriptionSchema,
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
    description: descriptionSchema,
    markdown: markdownSchema,
  }),
  Schema.Struct({
    lineageId: artifactIdSchema,
    expectedRevision: expectedRevisionSchema,
    title: Schema.optionalKey(titleSchema),
    description: descriptionSchema,
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    lineageId: artifactIdSchema,
    expectedRevision: expectedRevisionSchema,
    title: Schema.optionalKey(titleSchema),
    description: descriptionSchema,
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
  description: descriptionSchema,
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
      ...(artifact.description === undefined ? null : { description: artifact.description }),
    })),
  };
}

/** Streams widget side-chat progress into the calling tool's live result. */
function widgetProgressReporter(context: CakeOperationExecutionContext) {
  return (progress: WidgetGenerationProgress) =>
    context.onUpdate?.({
      widgetGeneration: {
        phase: progress.phase,
        files: progress.files,
        characters: progress.characters,
      },
    });
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
  // Regular Pi persists custom pointers; Durable persists the successful tool result itself.
  pi: CakeOperationHost | undefined,
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
    if (!pi) throw new Error("Artifact publication requires a transcript host");
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

  if (pi?.on && options.hasLinkedArtifacts)
    pi.on("before_agent_start", async (event) => {
      if (!(await options.hasLinkedArtifacts!())) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${linkedArtifactSystemGuidance}` };
    });

  const operations: CakeOperationDefinition[] = [
    ...createCakeArtifactStateOperations(options),
    ...createSelectedDesignOperations(options),
    {
      command: "html.present",
      topic: "html",
      summary: "Show static HTML/CSS inline",
      guidance: [
        "For simple mockups, headers, layouts, and static visual explanations, author HTML/CSS directly here. No React, specialist or workspace file is needed.",
        "Self-contained HTML/CSS; supply colors/fonts, no host styles. Scripts/network/forms/parent access disabled. Use widgets.present for interaction/state and live theme.",
        "Use readable viewport/scrolling, not tiny screens. height: 120–1600px (default 240).",
        "Already shown inline; artifacts.present shows it again. Inspect every alternative's rendered pixels before visual claims. Static HTML has no retained preview; disclose missing checks as published, visually unverified.",
      ],
      inputSchema: htmlPresentSchema,
      outputSchema: ArtifactProjectionMetadata,
      examples: [
        {
          input: {
            id: "header-options",
            title: "Three header styles",
            height: 360,
            html: "<style>header{padding:24px;margin:8px;border:1px solid #888}</style><header>Minimal Studio</header><header>Editorial</header><header>Modern Dark</header>",
          },
        },
      ],
      result:
        "Persisted exact-revision metadata; the static HTML renders inline in this conversation.",
      async execute(input, context) {
        const draft = Schema.decodeUnknownSync(htmlPresentSchema)(input);
        const sessionId = runtimeContext(context).sessionId;
        const origin = pi ? pointerOrigin(context) : undefined;
        if (context.signal.aborted) throw new Error("HTML presentation was cancelled");
        const record = await persist(
          {
            protocol: "cake.artifact/v1",
            id: draft.id,
            sessionId,
            revision: 1,
            kind: "html",
            title: draft.title,
            ...(draft.description === undefined ? null : { description: draft.description }),
            payload: {
              html: draft.html,
              ...(draft.height === undefined ? null : { height: draft.height }),
            },
            fallback: { markdown: draft.title },
            interaction: { mode: "present" },
          },
          sessionId,
        );
        const resolved = await resolveArtifact(
          `cake://artifact/${record.artifact.id}@r${record.artifact.revision}`,
        );
        if (origin) appendPointer(record, origin);
        return resolved.metadata;
      },
    },
    {
      command: "artifacts.list",
      topic: "artifacts",
      summary: "List linked artifacts",
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
      summary: "Search linked metadata",
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
      summary: "List immutable revisions",
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
      summary: "Resolve exact read-only files",
      guidance: [
        "An unlinked pasted URI is not readable. Explicitly link it first; temporary read leases are deferred until Cake has a durable lease owner.",
        "Inspect approved exact @rN preview pixels; selected variants need a screenshot with revision/state confirmed. Read projected source only as needed, not private history. Compare implementation pixels to that evidence.",
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
      summary: "Show existing artifact",
      guidance: [
        "Show existing content without regeneration/replacement. Independent documents use widgets.instantiate.",
        "Stable references resolve the current source; exact @rN references select that immutable source revision. Widgets hydrate current lineage state in either case.",
        "Adds inline surface only; no revision/ownership/state change. Existing sandbox/renderer applies.",
        "Permanent chats link accessible refs during presentation. Project Sessions must artifacts.link first. Missing/inaccessible fails.",
        "User display is not agent inspection. preview is initial state; live pixels need screenshot with revision/state.",
      ],
      inputSchema: artifactResolveSchema,
      outputSchema: ArtifactProjectionMetadata,
      examples: [{ input: { reference: "cake://artifact/architecture-map" } }],
      result: "Selected exact-revision metadata; the artifact renders inline in the conversation.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with artifactResolveSchema.
        const { reference } = input as typeof artifactResolveSchema.Type;
        const origin = pi ? pointerOrigin(context) : undefined;
        const resolved = options.resolveArtifactForPresentation
          ? await options.resolveArtifactForPresentation(stableReference(reference))
          : await resolveArtifact(reference);
        if (context.signal.aborted) throw new Error("Artifact presentation was cancelled");
        if (origin) appendPointer(resolved.record, origin, "selected-revision");
        return resolved.metadata;
      },
    },
    {
      command: "artifacts.preview",
      topic: "artifacts",
      summary: "Inspect initial-state preview",
      guidance: [
        "Use the user-approved exact @rN reference, never latest. Link an unlinked reference first. This returns the accepted review capture, not a new render or the private generation conversation.",
        "Initial state—not current interactive view. For selected variants, inspect screenshot matching revision AND state. Source is not visual proof.",
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
      summary: "Create Markdown/file artifact",
      guidance: [
        "Keep ordinary work/reports in chat. Text artifacts need a user request or shared durable spec; length/format alone does not qualify.",
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
        if (draft.description !== undefined)
          artifact = { ...artifact, description: draft.description };
        const record = await persist(artifact, sessionId);
        appendPointer(record, pointerOrigin(context));
        return (await resolveArtifact(`cake://artifact/${record.artifact.id}@r1`)).metadata;
      },
    },
    {
      command: "artifacts.update",
      topic: "artifacts",
      summary: "Edit Markdown text",
      guidance: [
        "Read the current exact revision before editing. Send only changed blocks, not the complete document.",
        "Pi edit semantics: unique non-overlapping oldText against original revision, not incremental. Merge overlapping edits; no-op edits fail.",
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
        if (update.description !== undefined)
          artifact = { ...artifact, description: update.description };
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
      summary: "Replace content or revise widget source",
      guidance: [
        "Use for source/behavior changes, publishing a new revision. Live data: state.read/update; display: present; independent copy: widgets.instantiate.",
        "Markdown: complete replacement, or update for targeted edits. File: workspace-relative snapshot. Widget: revision instructions; rendered/reviewed before publication, returns PNG. Language stays fixed.",
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
          const generationSessionId = current.artifact.payload.generationSessionId;
          if (generationSessionId ? !options.reviseInlineWidget : !options.generateInlineWidget)
            throw new Error("Durable widget revision is unavailable");
          if (!options.readArtifactState) throw new Error("Artifact state access is unavailable");
          const latestState = await options.readArtifactState(update.lineageId);
          const revisionInput = {
            sessionId,
            language: current.artifact.payload.language,
            source: current.artifact.payload.source,
            brief: current.artifact.payload.brief,
            fallback: current.artifact.fallback.markdown,
            instructions: update.instructions,
            initialState: latestState.value,
            initialStateVersion: latestState.version,
            model: runtime.model,
            signal: context.signal,
            onProgress: widgetProgressReporter(context),
          };
          const generated = generationSessionId
            ? await options.reviseInlineWidget!({ ...revisionInput, generationSessionId })
            : await options.generateInlineWidget!({
                ...revisionInput,
                parentConversation: widgetConversationFromOperation(runtime),
                brief: `${revisionInput.brief}\n\nRequested renderer change: ${update.instructions}`,
                data: { source: revisionInput.source },
              });
          if (context.signal.aborted) throw new Error("Widget revision was cancelled");
          if (!generated.browser)
            throw new Error("Accepted widget revision has no retained browser output");
          if (generated.language !== current.artifact.payload.language)
            throw new Error("Widget revisions must preserve the source language");
          const previousPrototype =
            current.artifact.payload.language === "react"
              ? readPrototypeSource(current.artifact.payload.source)
              : undefined;
          if (previousPrototype) {
            const nextPrototype = readPrototypeSource(generated.source);
            if (
              !nextPrototype ||
              previousPrototype.options.some(
                (option) => !nextPrototype.options.some((next) => next.id === option.id),
              )
            )
              throw new Error(
                "Prototype revisions must preserve the manifest and all five stable option IDs",
              );
          }
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
        artifact = {
          ...artifact,
          sessionId,
          ...(update.description === undefined ? null : { description: update.description }),
        };
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
      summary: "Publish historical snapshot",
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
      summary: "Link artifact reference",
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
      summary: "Remove effective artifact link",
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

  const captureWidgetInstance = options.captureWidgetInstance;
  if (captureWidgetInstance)
    operations.push({
      command: "widgets.instantiate",
      topic: "widgets",
      summary: "Instantiate prepared widget",
      inputSchema: widgetInstantiateSchema,
      guidance: [
        "Supply template (loaded skill) or exact linked reference, new ID and matching initialState. Prepared templates need no generation, compilation or discovery.",
        "Use the loaded skill's complete call directly; no further reads, discovery or generation.",
        "Template mutable state and hardcoded seed data are not copied as authoritative data. Supply the complete independent document in initialState. Read the template source/state contract first if needed.",
        "For existing data/content use artifacts.state.read then artifacts.state.update. To show the same document again use artifacts.present. Only source/behavior changes or old hardcoded content need artifacts.replace.",
        "A fresh rendered initial-state capture is returned, not the template's preview. This is not a new model review and does not verify every interaction. Publication is inline; do not add a redundant embed.",
      ],
      examples: [
        {
          input: {
            id: "new-document",
            title: "New document",
            template: "editable-board",
            initialState: { elements: [] },
            fallback: { markdown: "Independent editable document." },
          },
        },
        {
          input: {
            id: "second-diagram",
            title: "Second diagram",
            reference: "cake://artifact/editable-diagram@r1",
            initialState: { nodes: [], edges: [] },
            fallback: { markdown: "Second independent diagram." },
          },
        },
      ],
      result:
        "New revision-one widget reference and fresh initial-state PNG, with explicit reuse execution facts. No request-time generation, compilation or model review; skill templates are prepared at session startup.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with widgetInstantiateSchema.
        const instance = input as typeof widgetInstantiateSchema.Type;
        const runtime = runtimeContext(context);
        const origin = pointerOrigin(context);
        if (context.signal.aborted) throw new Error("Widget instantiation was cancelled");
        const reference =
          "reference" in instance
            ? stableReference(instance.reference)
            : `skill:${instance.template}`;
        let implementation: WidgetTemplate;
        if ("reference" in instance) {
          const template = (await resolveArtifact(reference)).record.artifact;
          if (template.kind !== "widget")
            throw new Error("Widget instantiation requires a linked widget template");
          if (template.id === instance.id)
            throw new Error("Widget instantiation requires a new lineage ID");
          implementation = template.payload;
        } else {
          if (!options.resolveWidgetTemplate)
            throw new Error("Skill widget templates are unavailable in this session");
          implementation = options.resolveWidgetTemplate(instance.template);
        }
        const preview = await captureWidgetInstance({
          sessionId: runtime.sessionId,
          browser: implementation.browser,
          initialState: instance.initialState,
          signal: context.signal,
        });
        if (context.signal.aborted) throw new Error("Widget instantiation was cancelled");
        let payload: Extract<CakeArtifactV1, { kind: "widget" }>["payload"] = {
          language: implementation.language,
          source: implementation.source,
          browser: implementation.browser,
          brief: `Reused implementation from ${reference}. The caller supplied independent initialState; artifact-scoped mutable state is authoritative for this document.`,
          preview,
        };
        if (implementation.generationSessionId)
          payload = { ...payload, generationSessionId: implementation.generationSessionId };
        const record = await persist(
          {
            protocol: "cake.artifact/v1",
            id: instance.id,
            sessionId: runtime.sessionId,
            revision: 1,
            kind: "widget",
            title: instance.title,
            ...(instance.description === undefined ? null : { description: instance.description }),
            payload,
            fallback: instance.fallback,
            interaction: { mode: "present" },
          },
          runtime.sessionId,
          { expectedVersion: 0, value: instance.initialState },
        );
        appendPointer(record, origin);
        const exactRef = `cake://artifact/${record.artifact.id}@r1`;
        return cakeOperationImageResult(
          {
            artifactId: record.artifact.id,
            artifactRevision: 1,
            exactRef,
            digest: record.digest,
            previewEvidence: retainedWidgetPreviewEvidence(exactRef),
            execution: {
              reusedFrom: reference,
              retainedBrowserOutput: true,
              generated: false,
              compiled: false,
              modelReviewed: false,
            },
          },
          [{ type: "image", ...preview }],
        );
      },
    });

  if (options.generateInlineWidget)
    operations.push({
      command: "widgets.present",
      topic: "widgets",
      summary: "Generate interactive widget",
      guidance: [
        "Prefer ordinary inline Markdown—including Mermaid and small tables—whenever it communicates the result clearly. Create a widget only for a substantial, reusable, or genuinely interactive/visual deliverable, especially when requested.",
        "Static HTML: html.present. Interactive generation: supply goal, audience, verified facts, bounded data and Markdown fallback; specialist writes source.",
        "Data: state.read/update. Show: artifacts.present. Independent copy: widgets.instantiate exact reference. Source/behavior: artifacts.replace.",
        "Accepted PNG is initial state, not live selection. Before implementation inspect matching revision AND selected-state pixels; request a screenshot for live state. Compare real implementation pixels; source/descriptions are not visual proof.",
        "language: html for inline CSS/JS without packages/JSX; react (default) for components/libraries/prototype manifests. Repairs preserve language.",
        "HTML: cakeArtifact read/getSnapshot/subscribe/replace(value,expectedVersion). React: @cake/artifact-sdk. Await hydration; JSON only; handle conflicts.",
        "Speech: globalThis.cakeSpeech (HTML) or useSpeech (React); speak/pause/resume/stop, sentence progress. Request in brief. One speaker; closes stop it.",
        "Specialist uses domain skills/installed libraries. initialState is artifact JSON. Describe relationships/interactions, not pixel coordinates.",
        "Already shown inline. Show again with artifacts.present, not regeneration/duplicate embeds. Exact refs preserve historical content.",
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
        "Generated widgets have no filesystem, Node, Electron, parent-DOM or unrestricted Cake API access. @cake/artifact-sdk (React) and globalThis.cakeArtifact (HTML) grant only artifact-scoped JSON state; cakeSpeech/useSpeech add read-aloud only (no microphone, voice choice or audio files). Speech fails with a readable error until speech output is configured in Settings. CSP blocks fetch/XHR/WebSocket. HTML has no external scripts/dependencies; React libraries must already be installed; ask for dependency authorization outside the private generation branch.",
        pi
          ? "Generation inherits the caller's ancestor context at creation time, excluding sibling branches and unfinished tool calls. Revisions follow the artifact's generation branch, not later parent messages."
          : "Permanent chats generate in a private conversation from the supplied brief/data, without inheriting chat history. Include all verified context needed by the specialist.",
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
          // Durable owns permanent-chat history; never open it as a regular Pi transcript.
          parentConversation: pi ? widgetConversationFromOperation(runtime) : undefined,
          brief: widget.brief,
          language: widget.language ?? "react",
          data: widget.data,
          initialState: widget.initialState,
          fallback: widget.fallback.markdown,
          model: runtime.model
            ? { provider: runtime.model.provider, id: runtime.model.id }
            : undefined,
          signal: context.signal,
          onProgress: widgetProgressReporter(context),
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
            ...(widget.description === undefined ? null : { description: widget.description }),
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
        // Durable presents the successful tool result; regular Pi needs its custom pointer.
        if (pi) appendPointer(record, pointerOrigin(context));
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
