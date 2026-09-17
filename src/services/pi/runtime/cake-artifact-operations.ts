import { Schema } from "effect";
import { jsonValueSchema, type JsonValue } from "../../../ipc/json-contract";
import {
  MAX_ARTIFACT_INPUT_BYTES,
  artifactPointerSchema,
  parseArtifactInput,
  validateArtifactResponse,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../../ipc/artifact-contract";
import { cakeRequestV1Schema, parseRequestInput } from "../../../ipc/request-contract";
import type {
  InlineWidgetGenerationRequest,
  InlineWidgetGenerationResult,
  InlineWidgetRevisionRequest,
} from "./sidecar-runtime";
import type { ArtifactProjectionMetadata } from "../../artifacts/ArtifactProjection";
import type {
  CakeOperationDefinition,
  CakeOperationExecutionContext,
} from "./cake-operation-registry";

interface ArtifactFileImportInput {
  path: string;
  id: string;
  revision: number;
  title?: string;
}

export interface ResolvedAgentArtifact {
  readonly record: ArtifactRecord;
  readonly metadata: ArtifactProjectionMetadata;
}

export interface CakeArtifactOperationOptions {
  persistArtifact(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact(record: ArtifactRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  generateInlineWidget?(
    input: InlineWidgetGenerationRequest,
  ): Promise<InlineWidgetGenerationResult>;
  reviseInlineWidget?(input: InlineWidgetRevisionRequest): Promise<InlineWidgetGenerationResult>;
  resolveArtifact?(reference: string): Promise<ResolvedAgentArtifact>;
  listArtifactMetadata?(): Promise<ReadonlyArray<ArtifactProjectionMetadata>>;
  historyArtifact?(reference: string): Promise<ReadonlyArray<ArtifactProjectionMetadata>>;
  restoreArtifact?(input: {
    lineageId: string;
    sourceRevision: number;
    expectedRevision: number;
  }): Promise<ResolvedAgentArtifact>;
  linkArtifact?(reference: string): Promise<ArtifactProjectionMetadata>;
  unlinkArtifact?(lineageId: string): Promise<void>;
  importArtifactFile?(input: ArtifactFileImportInput): Promise<CakeArtifactV1>;
}

interface ArtifactContextInjection {
  readonly message: {
    readonly customType: "cake.artifact-context/v1";
    readonly display: false;
    readonly content: string;
  };
}

type ArtifactContextHandlerResult = void | ArtifactContextInjection;

export interface PiArtifactOperationHost {
  appendEntry(type: string, data: JsonValue): void;
  on?(
    event: "before_agent_start",
    handler: () => ArtifactContextHandlerResult | Promise<ArtifactContextHandlerResult>,
  ): void;
}

interface PiToolRuntimeContext {
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
  };
  model?: { provider: string; id: string };
}

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
const artifactUpdateSchema = Schema.Union([
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
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50)),
  ),
});
const artifactHistorySchema = Schema.Struct({
  lineageId: artifactIdSchema,
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
});

function runtimeContext(context: CakeOperationExecutionContext) {
  // SAFETY: createCakeGatewayExtension supplies Pi's validated tool execution context.
  return context.runtime as PiToolRuntimeContext;
}

const stableReference = (value: string) =>
  value.startsWith("cake://artifact/") ? value : `cake://artifact/${value}`;

export function formatArtifactContextManifest(
  artifacts: ReadonlyArray<ArtifactProjectionMetadata>,
  options: { readonly maxCount?: number; readonly maxBytes?: number } = {},
) {
  const maxCount = options.maxCount ?? 32;
  const maxBytes = options.maxBytes ?? 16_384;
  const heading =
    "Linked artifact metadata (content is not injected; inspect exactPath with read/rg/shell):\n";
  let result = heading;
  let count = 0;
  for (const artifact of artifacts.slice(0, maxCount)) {
    const line = `${JSON.stringify({
      lineageId: artifact.lineageId,
      ...(artifact.title === undefined ? null : { title: artifact.title }),
      kind: artifact.kind,
      selectedRevision: artifact.selectedRevision,
      latestRevision: artifact.latestRevision,
      digest: artifact.digest,
      linkMode: artifact.linkMode,
      stableRef: artifact.stableRef,
      exactRef: artifact.exactRef,
      exactPath: artifact.exactPath,
    })}\n`;
    if (new TextEncoder().encode(result + line).byteLength > maxBytes) break;
    result += line;
    count += 1;
  }
  if (count < artifacts.length) {
    const suffix = `… ${artifacts.length - count} additional linked artifacts omitted by bounds.\n`;
    if (new TextEncoder().encode(result + suffix).byteLength <= maxBytes) result += suffix;
  }
  return result;
}

export function createCakeArtifactOperations(
  pi: PiArtifactOperationHost,
  options: CakeArtifactOperationOptions,
): CakeOperationDefinition[] {
  const persist = async (input: unknown, sessionId: string) => {
    const artifact = parseArtifactInput(input);
    if (artifact.sessionId !== sessionId)
      throw new Error("Artifact sessionId does not match the active Pi session");
    return options.persistArtifact(artifact);
  };
  const appendPointer = (
    record: ArtifactRecord,
    origin: { assistantEntryId: string; toolCallId: string },
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
      }),
    );
  };
  const pointerOrigin = (context: CakeOperationExecutionContext) => {
    const runtime = runtimeContext(context);
    const assistantEntryId = runtime.sessionManager.getLeafId();
    if (!assistantEntryId)
      throw new Error("Artifact creation requires an originating assistant message");
    return { assistantEntryId, toolCallId: context.toolCallId };
  };
  const resolveArtifact = async (reference: string) => {
    if (!options.resolveArtifact) throw new Error("Artifact resolution is unavailable");
    return options.resolveArtifact(stableReference(reference));
  };

  if (pi.on && options.listArtifactMetadata)
    pi.on("before_agent_start", async () => {
      const manifest = formatArtifactContextManifest(await options.listArtifactMetadata!());
      if (manifest.endsWith(":\n")) return;
      return {
        message: {
          customType: "cake.artifact-context/v1",
          display: false,
          content: manifest,
        },
      };
    });

  const operations: CakeOperationDefinition[] = [
    {
      command: "artifacts.list",
      topic: "artifacts",
      summary: "List bounded metadata for artifacts effectively linked to this session.",
      guidance: [
        "Artifact payloads are never injected into context or returned by Cake operations. Inspect canonical exact-revision files with ordinary read, rg, or shell tools.",
        "Stable cake://artifact/<id> references follow latest; exact @rN references are reproducible.",
      ],
      inputSchema: Schema.Struct({}),
      examples: [{}],
      result: "Up to 100 linked artifact metadata records and exact read-only paths.",
      async execute() {
        if (!options.listArtifactMetadata) throw new Error("Artifact listing is unavailable");
        const all = await options.listArtifactMetadata();
        return { total: all.length, truncated: all.length > 100, artifacts: all.slice(0, 100) };
      },
    },
    {
      command: "artifacts.search",
      topic: "artifacts",
      summary: "Search linked artifact titles, kinds, IDs, and references.",
      inputSchema: artifactSearchSchema,
      examples: [{ input: { query: "design", limit: 20 } }],
      result: "Bounded matching artifact metadata; payload content is not searched or returned.",
      async execute(input) {
        if (!options.listArtifactMetadata) throw new Error("Artifact search is unavailable");
        // SAFETY: CakeOperationRegistry parsed input with artifactSearchSchema.
        const parsed = input as typeof artifactSearchSchema.Type;
        const query = parsed.query.toLocaleLowerCase();
        const all = (await options.listArtifactMetadata()).filter((artifact) =>
          [
            artifact.lineageId,
            artifact.title ?? "",
            artifact.kind,
            artifact.stableRef,
            artifact.exactRef,
          ]
            .join("\n")
            .toLocaleLowerCase()
            .includes(query),
        );
        const limit = parsed.limit ?? 20;
        return { total: all.length, truncated: all.length > limit, artifacts: all.slice(0, limit) };
      },
    },
    {
      command: "artifacts.history",
      topic: "artifacts",
      summary: "List bounded immutable revision metadata for one linked lineage.",
      inputSchema: artifactHistorySchema,
      examples: [{ input: { lineageId: "design-plan", limit: 50 } }],
      result: "Bounded exact revision metadata and read-only paths, newest first.",
      async execute(input) {
        if (!options.historyArtifact) throw new Error("Artifact history is unavailable");
        // SAFETY: CakeOperationRegistry parsed input with artifactHistorySchema.
        const parsed = input as typeof artifactHistorySchema.Type;
        const all = [
          ...(await options.historyArtifact(stableReference(parsed.lineageId))),
        ].reverse();
        const limit = parsed.limit ?? 50;
        return { total: all.length, truncated: all.length > limit, revisions: all.slice(0, limit) };
      },
    },
    {
      command: "artifacts.resolve-reference",
      topic: "artifacts",
      summary: "Resolve a linked stable or exact artifact reference to an exact read-only path.",
      guidance: [
        "An unlinked pasted URI is not readable. Explicitly link it first; temporary read leases are deferred until Cake has a durable lease owner.",
      ],
      inputSchema: artifactResolveSchema,
      examples: [{ input: { reference: "cake://artifact/design-plan@r1" } }],
      result: "Bounded metadata and canonical files for the selected exact revision.",
      async execute(input) {
        // SAFETY: CakeOperationRegistry parsed input with artifactResolveSchema.
        const parsed = input as typeof artifactResolveSchema.Type;
        return (await resolveArtifact(parsed.reference)).metadata;
      },
    },
    {
      command: "artifacts.create",
      topic: "artifacts",
      summary:
        "Create a durable Markdown document or imported file artifact in the current session.",
      guidance: [
        "Use a Markdown artifact for substantial reusable documents. Markdown is the readable content itself and does not need a separate fallback argument.",
        "Import a workspace file when the file itself is the reusable deliverable. Cake snapshots it; later workspace changes do not mutate the artifact.",
        "Choose a stable descriptive ID. Use artifacts.update, rather than creating a second ID, when revising the same deliverable.",
      ],
      inputSchema: artifactCreateSchema,
      examples: [
        {
          input: {
            artifact: {
              id: "design-plan",
              title: "Design plan",
              kind: "markdown",
              markdown: "# Design plan\n\nImplementation details.",
            },
          },
        },
      ],
      result: "Bounded exact-revision metadata and the read-only projection path.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with artifactCreateSchema.
        const draft = (input as typeof artifactCreateSchema.Type).artifact;
        const sessionId = runtimeContext(context).sessionManager.getSessionId();
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
      summary: "Durably edit, fix, revise, or repair an existing artifact.",
      guidance: [
        "Use this operation when the user asks to edit, fix, revise, or repair an artifact. Cake preserves its stable ID and publishes the next immutable revision.",
        "Markdown updates replace the complete document. File updates snapshot a replacement workspace-relative path. Widget updates accept revision instructions and run isolated generation, rendering, and visual review before publication.",
      ],
      inputSchema: artifactUpdateSchema,
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
        // SAFETY: CakeOperationRegistry parsed input with artifactUpdateSchema.
        const update = input as typeof artifactUpdateSchema.Type;
        const current = (await resolveArtifact(update.lineageId)).record;
        if (current.artifact.revision !== update.expectedRevision)
          throw new Error(
            `Artifact ${update.lineageId} is at revision ${current.artifact.revision}; expected ${update.expectedRevision}`,
          );
        const runtime = runtimeContext(context);
        const sessionId = runtime.sessionManager.getSessionId();
        const revision = update.expectedRevision + 1;
        let artifact: CakeArtifactV1;
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
          const generated = await options.reviseInlineWidget({
            sessionId,
            source: current.artifact.payload.source,
            brief: current.artifact.payload.brief,
            fallback: current.artifact.fallback.markdown,
            instructions: update.instructions,
            model: runtime.model,
            signal: context.signal,
          });
          if (context.signal.aborted) throw new Error("Widget revision was cancelled");
          artifact = {
            ...current.artifact,
            revision,
            payload: {
              ...current.artifact.payload,
              source: generated.source,
              generationSessionId: generated.generationSessionId,
            },
          };
          if (update.title) artifact = { ...artifact, title: update.title };
        }
        // The publishing session is revision provenance; the global lineage identity stays stable.
        artifact = { ...artifact, sessionId };
        const record = await persist(artifact, sessionId);
        appendPointer(record, pointerOrigin(context));
        return (await resolveArtifact(`cake://artifact/${record.artifact.id}@r${revision}`))
          .metadata;
      },
    },
    {
      command: "artifacts.restore",
      topic: "artifacts",
      summary: "Publish a historical snapshot as the next immutable revision.",
      inputSchema: artifactRestoreSchema,
      examples: [{ input: { lineageId: "design-plan", sourceRevision: 1, expectedRevision: 3 } }],
      result: "The newly published exact revision metadata and read-only path.",
      async execute(input, context) {
        if (!options.restoreArtifact) throw new Error("Artifact restore is unavailable");
        // SAFETY: CakeOperationRegistry parsed input with artifactRestoreSchema.
        const parsed = input as typeof artifactRestoreSchema.Type;
        const restored = await options.restoreArtifact(parsed);
        appendPointer(restored.record, pointerOrigin(context));
        return restored.metadata;
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
    {
      command: "interview.open",
      topic: "interview",
      summary:
        "Open one schema-validated interview form or sandboxed request widget and wait for submission or cancellation.",
      guidance: [
        "When requirements gathering involves multiple questions or design decisions, use an interview. Present recommended defaults first. Collect independent answers in one structured form.",
        "Ask one question at a time only when later questions depend on earlier answers or the user wants to discuss each decision. Use chat for follow-up questions that depend on submitted answers.",
        "Form fields are optional, so response schemas must accept an empty object. Selects accept listed choices or freeform text. Put the recommended select option first; Cake auto-selects it and always adds the freeform option, so do not list an Other option.",
      ],
      inputSchema: Schema.Struct({ request: cakeRequestV1Schema }),
      examples: [
        {
          input: {
            request: {
              protocol: "cake.request/v1",
              id: "deployment-settings",
              title: "Deployment settings",
              responseSchema: { type: "object", properties: { region: { type: "string" } } },
              view: {
                type: "form",
                fields: [
                  {
                    id: "region",
                    label: "Region",
                    type: "select",
                    options: [{ value: "us-east-1", label: "US East" }],
                  },
                ],
              },
              fallback: { markdown: "Choose a deployment region." },
            },
          },
        },
      ],
      result: "The validated response and artifact ID, or an explicit cancelled result.",
      limitations: [
        "Request widgets have no network, filesystem, Node, Electron, parent, or Cake API access.",
      ],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with the definition's input schema.
        const request = parseRequestInput((input as { request: unknown }).request);
        const sessionId = runtimeContext(context).sessionManager.getSessionId();
        const record = await persist(
          {
            protocol: "cake.artifact/v1",
            id: request.id,
            sessionId,
            revision: 1,
            kind: "request",
            title: request.title,
            payload: { request },
            fallback: request.fallback,
            interaction: { mode: "request", responseSchema: request.responseSchema },
          },
          sessionId,
        );
        appendPointer(record, pointerOrigin(context));
        const value = await options.requestArtifact(record, context.signal);
        if (value === undefined && context.signal.aborted)
          throw context.signal.reason instanceof Error
            ? context.signal.reason
            : new Error("The request ended because its turn was interrupted");
        if (value === undefined)
          return Schema.decodeUnknownSync(jsonValueSchema)({
            artifactId: record.artifact.id,
            cancelled: true,
          });
        return Schema.decodeUnknownSync(jsonValueSchema)({
          artifactId: record.artifact.id,
          cancelled: false,
          value: Schema.decodeUnknownSync(jsonValueSchema)(
            validateArtifactResponse(
              request.responseSchema,
              Schema.decodeUnknownSync(jsonValueSchema)(value),
            ),
          ),
        });
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
        "The specialist can combine React Flow diagrams, optional ELK layout, ordinary React explanations, D3/SVG, filters and details inside one widget. Describe the intended relationships and useful interactions, not pixel coordinates or a mandatory graph DSL.",
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
        "The persisted widget artifact ID after generation, rendered screenshot review, and acceptance complete.",
      limitations: [
        "Generated widgets have no filesystem, Node, Electron, parent-DOM or Cake API access. CSP blocks fetch/XHR/WebSocket; generic widgets permit passive HTTPS/data images and media. Supply local data and request self-contained output.",
        "Every successfully rendered candidate is reviewed from an actual Cake Electron screenshot. Review screenshots are retained in private Pi widget-session transcripts under Cake's existing session retention policy.",
      ],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with the definition's input schema.
        const widget = (input as { widget: typeof widgetSchema.Type }).widget;
        const serialized = JSON.stringify(widget);
        if (new TextEncoder().encode(serialized).byteLength > 262_144)
          throw new Error("Widget brief exceeds the 262144-byte limit");
        const runtime = runtimeContext(context);
        const sessionId = runtime.sessionManager.getSessionId();
        const generated = await options.generateInlineWidget!({
          sessionId,
          brief: widget.brief,
          data: widget.data,
          fallback: widget.fallback.markdown,
          model: runtime.model
            ? { provider: runtime.model.provider, id: runtime.model.id }
            : undefined,
          signal: context.signal,
        });
        if (context.signal.aborted) throw new Error("Widget generation was cancelled");
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
            },
            fallback: widget.fallback,
            interaction: { mode: "present" },
          },
          sessionId,
        );
        appendPointer(record, pointerOrigin(context));
        return { artifactId: record.artifact.id };
      },
    });

  return operations;
}
