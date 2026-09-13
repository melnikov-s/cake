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
}

interface PiOperationHost {
  appendEntry(type: string, data: JsonValue): void;
}

interface PiToolRuntimeContext {
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
  };
  model?: { provider: string; id: string };
}

const widgetSchema = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  data: Schema.optionalKey(Schema.Unknown),
  fallback: Schema.Struct({
    markdown: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_ARTIFACT_INPUT_BYTES),
    ),
  }),
});

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

  const operations: CakeOperationDefinition[] = [
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
