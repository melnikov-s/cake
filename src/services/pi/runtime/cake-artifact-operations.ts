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
import type {
  CakeOperationDefinition,
  CakeOperationExecutionContext,
} from "./cake-operation-registry";

export interface CakeArtifactOperationOptions {
  persistArtifact(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact(record: ArtifactRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  generateInlineWidget?(
    input: InlineWidgetGenerationRequest,
  ): Promise<InlineWidgetGenerationResult>;
  reviseInlineWidget?(input: InlineWidgetRevisionRequest): Promise<InlineWidgetGenerationResult>;
  getArtifact?(artifactId: string): Promise<ArtifactRecord | undefined>;
  listArtifacts?(): Promise<ReadonlyArray<ArtifactRecord>>;
}

interface PiOperationHost {
  appendEntry(type: string, data: JsonValue): void;
}

interface ArtifactReadBase {
  id: string;
  title?: string;
  kind: CakeArtifactV1["kind"];
  revision: number;
  createdAt: string;
  updatedAt: string;
  fallback: { readonly markdown: string };
}

interface ArtifactSummary {
  id: string;
  title?: string;
  kind: CakeArtifactV1["kind"];
  revision: number;
  updatedAt: string;
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
const artifactCreateSchema = Schema.Struct({ artifact: markdownCreateSchema });
const artifactReadSchema = Schema.Struct({ id: artifactIdSchema });
const artifactUpdateSchema = Schema.Union([
  Schema.Struct({
    id: artifactIdSchema,
    title: Schema.optionalKey(titleSchema),
    markdown: markdownSchema,
  }),
  Schema.Struct({
    id: artifactIdSchema,
    title: Schema.optionalKey(titleSchema),
    instructions: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  }),
]);

function runtimeContext(context: CakeOperationExecutionContext) {
  // SAFETY: createCakeGatewayExtension supplies Pi's validated tool execution context.
  return context.runtime as PiToolRuntimeContext;
}

export function createCakeArtifactOperations(
  pi: PiOperationHost,
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
        artifactId: record.artifact.id,
        sessionId: record.artifact.sessionId,
        revision: record.artifact.revision,
        kind: record.artifact.kind,
        digest: record.digest,
        fallback: record.artifact.fallback,
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
  const requireArtifact = async (id: string) => {
    const record = await options.getArtifact?.(id);
    if (!record) throw new Error(`Artifact ${id} was not found in the current session`);
    return record;
  };
  const readableRecord = (record: ArtifactRecord): JsonValue => {
    const { artifact } = record;
    const common: ArtifactReadBase = {
      id: artifact.id,
      kind: artifact.kind,
      revision: artifact.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      fallback: artifact.fallback,
    };
    if (artifact.title) common.title = artifact.title;
    if (artifact.kind === "widget")
      return {
        ...common,
        payload: {
          language: artifact.payload.language,
          brief: artifact.payload.brief,
          generationSessionId: artifact.payload.generationSessionId,
        },
      };
    // SAFETY: artifact payloads have passed cake.artifact/v1 parsing; request payloads are
    // validated again by their dedicated request boundary before they reach this operation.
    return { ...common, payload: artifact.payload } as JsonValue;
  };

  const operations: CakeOperationDefinition[] = [
    {
      command: "artifacts.list",
      topic: "artifacts",
      summary: "List the current session's durable artifacts and their latest revisions.",
      guidance: [
        "Use artifacts.list when the user refers to an artifact ambiguously or before choosing one to inspect or revise.",
        "Artifacts are scoped to the current Cake session. Updates publish immutable revisions under the same artifact ID.",
      ],
      inputSchema: Schema.Struct({}),
      examples: [{}],
      result: "The artifact count and bounded summaries for the current Cake session.",
      async execute() {
        if (!options.listArtifacts) throw new Error("Artifact listing is unavailable");
        const records = (await options.listArtifacts()).filter(
          (record) => record.artifact.kind !== "request",
        );
        return {
          count: records.length,
          artifacts: records.map((record) => {
            const summary: ArtifactSummary = {
              id: record.artifact.id,
              kind: record.artifact.kind,
              revision: record.artifact.revision,
              updatedAt: record.updatedAt,
            };
            if (record.artifact.title) summary.title = record.artifact.title;
            return Schema.decodeUnknownSync(jsonValueSchema)(summary);
          }),
        };
      },
    },
    {
      command: "artifacts.read",
      topic: "artifacts",
      summary: "Read the latest durable revision of one artifact in the current session.",
      guidance: [
        "Read an artifact before revising it. Widget implementation source stays isolated; reads return its brief and readable fallback instead.",
      ],
      inputSchema: artifactReadSchema,
      examples: [{ input: { id: "design-plan" } }],
      result: "The current revision and editable artifact content or safe widget metadata.",
      async execute(input) {
        // SAFETY: CakeOperationRegistry parsed input with artifactReadSchema.
        const parsed = input as typeof artifactReadSchema.Type;
        return readableRecord(await requireArtifact(parsed.id));
      },
    },
    {
      command: "artifacts.create",
      topic: "artifacts",
      summary: "Create a durable Markdown document artifact in the current session.",
      guidance: [
        "Use a Markdown artifact for substantial reusable documents. Markdown is the readable content itself and does not need a separate fallback argument.",
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
      result: "The persisted artifact ID, kind, and revision.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with artifactCreateSchema.
        const draft = (input as typeof artifactCreateSchema.Type).artifact;
        if (options.getArtifact && (await options.getArtifact(draft.id)))
          throw new Error(`Artifact ${draft.id} already exists; use artifacts.update`);
        const sessionId = runtimeContext(context).sessionManager.getSessionId();
        let artifact: CakeArtifactV1 = {
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
        const record = await persist(artifact, sessionId);
        appendPointer(record, pointerOrigin(context));
        return { artifactId: record.artifact.id, kind: record.artifact.kind, revision: 1 };
      },
    },
    {
      command: "artifacts.update",
      topic: "artifacts",
      summary: "Durably edit, fix, revise, or repair an existing artifact.",
      guidance: [
        "Use this operation when the user asks to edit, fix, revise, or repair an artifact. Cake preserves its stable ID and publishes the next immutable revision.",
        "Markdown updates replace the complete document. Widget updates accept revision instructions and run isolated generation, rendering, and visual review before publication.",
      ],
      inputSchema: artifactUpdateSchema,
      examples: [{ input: { id: "design-plan", markdown: "# Revised design plan\n\nUpdated." } }],
      result: "The artifact ID, kind, and newly published revision.",
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed input with artifactUpdateSchema.
        const update = input as typeof artifactUpdateSchema.Type;
        const current = await requireArtifact(update.id);
        const runtime = runtimeContext(context);
        const revision = current.artifact.revision + 1;
        let artifact: CakeArtifactV1;
        if ("markdown" in update) {
          if (current.artifact.kind !== "markdown")
            throw new Error(`Artifact ${update.id} is ${current.artifact.kind}, not markdown`);
          artifact = {
            ...current.artifact,
            revision,
            payload: { markdown: update.markdown },
            fallback: { markdown: update.markdown },
          };
          if (update.title) artifact = { ...artifact, title: update.title };
        } else {
          if (current.artifact.kind !== "widget")
            throw new Error(
              `Artifact ${update.id} is ${current.artifact.kind}; revision instructions are only valid for widgets`,
            );
          if (!options.reviseInlineWidget)
            throw new Error("Durable widget revision is unavailable");
          const generated = await options.reviseInlineWidget({
            sessionId: current.artifact.sessionId,
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
        const record = await persist(artifact, runtime.sessionManager.getSessionId());
        appendPointer(record, pointerOrigin(context));
        return { artifactId: record.artifact.id, kind: record.artifact.kind, revision };
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
