import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../ipc/json-contract";
import {
  MAX_ARTIFACT_INPUT_BYTES,
  artifactPointerSchema,
  parseArtifactInput,
  validateArtifactResponse,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../ipc/artifact-contract";
import { cakeRequestV1Schema, parseRequestInput } from "../ipc/request-contract";
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
  sessionManager: { getSessionId(): string };
  model?: { provider: string; id: string };
}

const widgetSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    title: z.string().min(1).max(512),
    brief: z.string().min(1).max(262_144),
    data: z.unknown().optional(),
    fallback: z.object({ markdown: z.string().min(1).max(MAX_ARTIFACT_INPUT_BYTES) }),
  })
  .strict();

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
  const appendPointer = (record: ArtifactRecord) => {
    pi.appendEntry(
      "cake.artifact/v1",
      artifactPointerSchema.parse({
        protocol: "cake.artifact/v1",
        artifactId: record.artifact.id,
        sessionId: record.artifact.sessionId,
        revision: record.artifact.revision,
        kind: record.artifact.kind,
        digest: record.digest,
        fallback: record.artifact.fallback,
      }),
    );
  };

  const operations: CakeOperationDefinition[] = [
    {
      command: "requests.open",
      topic: "requests",
      summary:
        "Open one schema-validated form or sandboxed request widget and wait for submission or cancellation.",
      guidance: [
        "Prefer forms for interviews, questionnaires, multiple decisions, and structured configuration; use normal conversation for simple one-off questions.",
        "Form fields are optional, so response schemas must accept an empty object. Selects accept listed choices or freeform text.",
      ],
      inputSchema: z.object({ request: cakeRequestV1Schema }).strict(),
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
        appendPointer(record);
        const value = await options.requestArtifact(record, context.signal);
        if (value === undefined && context.signal.aborted)
          throw context.signal.reason instanceof Error
            ? context.signal.reason
            : new Error("The request ended because its turn was interrupted");
        if (value === undefined)
          return jsonValueSchema.parse({ artifactId: record.artifact.id, cancelled: true });
        return jsonValueSchema.parse({
          artifactId: record.artifact.id,
          cancelled: false,
          value: jsonValueSchema.parse(
            validateArtifactResponse(request.responseSchema, jsonValueSchema.parse(value)),
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
        "Use widgets when interactivity or visual presentation materially helps, especially when requested; prefer Markdown, tables, code, or Mermaid for simple textual explanations.",
        "Supply a complete presentation brief, bounded data, and a readable Markdown fallback. Do not write the generated React source yourself.",
      ],
      inputSchema: z.object({ widget: widgetSchema }).strict(),
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
      result: "The persisted widget artifact ID after generation and compilation complete.",
      limitations: [
        "Generated widgets have no network, filesystem, Node, Electron, parent, or Cake API access.",
      ],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with the definition's input schema.
        const widget = widgetSchema.parse((input as { widget: unknown }).widget);
        const serialized = JSON.stringify(widget);
        if (new TextEncoder().encode(serialized).byteLength > 262_144)
          throw new Error("Widget brief exceeds the 262144-byte limit");
        const runtime = runtimeContext(context);
        const generated = await options.generateInlineWidget!({
          brief: widget.brief,
          data: widget.data,
          fallback: widget.fallback.markdown,
          model: runtime.model
            ? { provider: runtime.model.provider, id: runtime.model.id }
            : undefined,
          signal: context.signal,
        });
        const sessionId = runtime.sessionManager.getSessionId();
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
        appendPointer(record);
        return { artifactId: record.artifact.id };
      },
    });

  return operations;
}
