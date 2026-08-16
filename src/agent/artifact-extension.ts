import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../ipc/json-contract";
import {
  MAX_ARTIFACT_INPUT_BYTES,
  artifactPointerSchema,
  parseArtifactInput,
  validateArtifactResponse,
  type ArtifactRecord,
  type CakeArtifactV1
} from "../ipc/artifact-contract";
import { parseRequestInput } from "../ipc/request-contract";
import type { InlineWidgetGenerationRequest, InlineWidgetGenerationResult } from "./sidecar-runtime";

export interface ArtifactExtensionOptions {
  persistArtifact(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact(record: ArtifactRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  generateInlineWidget?(input: InlineWidgetGenerationRequest): Promise<InlineWidgetGenerationResult>;
}

export function createCakeArtifactExtension(options: ArtifactExtensionOptions): InlineExtension {
  return (pi) => {
    const widgetBriefSchema = z.object({
      id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
      title: z.string().min(1).max(512),
      brief: z.string().min(1).max(262_144),
      data: z.unknown().optional(),
      fallback: z.object({ markdown: z.string().min(1).max(MAX_ARTIFACT_INPUT_BYTES) })
    }).strict();
    const formField = Type.Object({
      id: Type.String(),
      label: Type.String(),
      type: Type.Union([Type.Literal("text"), Type.Literal("textarea"), Type.Literal("number"), Type.Literal("checkbox"), Type.Literal("select")]),
      required: Type.Optional(Type.Boolean()),
      placeholder: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.Object({ value: Type.String(), label: Type.String() })))
    });
    const parameters = Type.Object({ request: Type.Object({
      protocol: Type.Literal("cake.request/v1"),
      id: Type.String(),
      title: Type.String(),
      responseSchema: Type.Any(),
      view: Type.Union([
        Type.Object({ type: Type.Literal("form"), fields: Type.Array(formField), submitLabel: Type.Optional(Type.String()) }),
        Type.Object({ type: Type.Literal("widget"), language: Type.Union([Type.Literal("html"), Type.Literal("react")]), source: Type.String() })
      ]),
      fallback: Type.Object({ markdown: Type.String() })
    }) });
    const persist = async (input: unknown, sessionId: string) => {
      const artifact = parseArtifactInput(input);
      if (artifact.sessionId !== sessionId) throw new Error("Artifact sessionId does not match the active Pi session");
      return options.persistArtifact(artifact);
    };
    const appendPointer = (record: ArtifactRecord) => {
      pi.appendEntry("cake.artifact/v1", artifactPointerSchema.parse({
        protocol: "cake.artifact/v1",
        artifactId: record.artifact.id,
        sessionId: record.artifact.sessionId,
        revision: record.artifact.revision,
        kind: record.artifact.kind,
        digest: record.digest,
        fallback: record.artifact.fallback
      }));
    };
    pi.registerTool({
      name: "ui_request",
      label: "Request user input",
      description: "Display a cake.request/v1 form or sandboxed custom widget and wait for one schema-validated response or cancellation.",
      parameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const request = parseRequestInput(params.request);
        const record = await persist({
          protocol: "cake.artifact/v1",
          id: request.id,
          sessionId: ctx.sessionManager.getSessionId(),
          revision: 1,
          kind: "request",
          title: request.title,
          payload: { request },
          fallback: request.fallback,
          interaction: { mode: "request", responseSchema: request.responseSchema }
        }, ctx.sessionManager.getSessionId());
        appendPointer(record);
        const value = await options.requestArtifact(record, signal ?? new AbortController().signal);
        if (value === undefined) return { content: [{ type: "text", text: `The user cancelled request ${request.id}.` }], details: { artifactId: record.artifact.id, cancelled: true } };
        const validated = validateArtifactResponse(request.responseSchema, jsonValueSchema.parse(value));
        return { content: [{ type: "text", text: `The user submitted a validated response for request ${request.id}: ${formatUnknown(validated, 8_000)}` }], details: { artifactId: record.artifact.id, cancelled: false, value: validated } };
      }
    });
    if (options.generateInlineWidget) pi.registerTool({
      name: "ui_widget",
      label: "Create visual presentation",
      description: "Delegate a one-off inline React presentation from a self-contained brief. Cake stores the generated source outside the conversation context.",
      parameters: Type.Object({ widget: Type.Object({
        id: Type.String(),
        title: Type.String(),
        brief: Type.String(),
        data: Type.Optional(Type.Any()),
        fallback: Type.Object({ markdown: Type.String() })
      }) }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const widget = widgetBriefSchema.parse(params.widget);
        const serialized = JSON.stringify(widget);
        const maximumWidgetBriefBytes = 262_144;
        if (new TextEncoder().encode(serialized).byteLength > maximumWidgetBriefBytes) {
          throw new Error(`Widget brief exceeds the ${maximumWidgetBriefBytes}-byte limit`);
        }
        const generated = await options.generateInlineWidget!({
          brief: widget.brief,
          data: widget.data,
          fallback: widget.fallback.markdown,
          model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
          signal
        });
        const record = await persist({
          protocol: "cake.artifact/v1",
          id: widget.id,
          sessionId: ctx.sessionManager.getSessionId(),
          revision: 1,
          kind: "widget",
          title: widget.title,
          payload: {
            language: generated.language,
            source: generated.source,
            brief: serialized,
            generationSessionId: generated.generationSessionId
          },
          fallback: widget.fallback,
          interaction: { mode: "present" }
        }, ctx.sessionManager.getSessionId());
        appendPointer(record);
        return {
          content: [{ type: "text", text: `Displayed the delegated widget ${record.artifact.id}.` }],
          details: { artifactId: record.artifact.id }
        };
      }
    });
    pi.registerCommand("cake-artifacts", {
      description: "Exercise Cake's built-in artifact renderers and structured response path",
      async handler(_args, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const table = await persist({
          protocol: "cake.artifact/v1", id: "cake-s4-table", sessionId, revision: 1, kind: "table", title: "S4 table",
          payload: { columns: [{ id: "name", label: "Name", type: "text" }, { id: "score", label: "Score", type: "number" }], rows: [{ id: "row-a", name: "Alpha", score: 2 }, { id: "row-b", name: "Beta", score: 1 }], selectable: true },
          fallback: { markdown: "| Name | Score |\n| --- | ---: |\n| Alpha | 2 |\n| Beta | 1 |" }, interaction: { mode: "present" }
        }, sessionId);
        appendPointer(table);
        const diagram = await persist({
          protocol: "cake.artifact/v1", id: "cake-s4-diagram", sessionId, revision: 1, kind: "diagram", title: "S4 diagram",
          payload: { source: "flowchart LR\n  Agent --> Artifact\n  Artifact --> User" },
          fallback: { markdown: "Agent → Artifact → User" }, interaction: { mode: "present" }
        }, sessionId);
        appendPointer(diagram);
        const html = await persist({
          protocol: "cake.artifact/v1", id: "cake-s4-html", sessionId, revision: 1, kind: "html", title: "Sandboxed HTML",
          payload: { html: "<strong>Isolated HTML</strong><script>parent.document.body.textContent='compromised';fetch('https://example.com')</script>" },
          fallback: { markdown: "**Isolated HTML**" }, interaction: { mode: "present" }
        }, sessionId);
        appendPointer(html);
        const request = { protocol: "cake.request/v1" as const, id: "cake-s4-form", title: "S4 response", responseSchema: { type: "object" as const, required: ["answer"], properties: { answer: { type: "string" as const, minLength: 1 } } }, view: { type: "form" as const, fields: [{ id: "answer", label: "Answer", type: "text" as const, required: true }], submitLabel: "Send response" }, fallback: { markdown: "S4 response form: **Answer** (required)." } };
        const form = await persist({
          protocol: "cake.artifact/v1", id: request.id, sessionId, revision: 1, kind: "request", title: request.title,
          payload: { request }, fallback: request.fallback,
          interaction: { mode: "request", responseSchema: request.responseSchema }
        }, sessionId);
        appendPointer(form);
        const value = await options.requestArtifact(form, new AbortController().signal);
        const validated = value === undefined ? undefined : validateArtifactResponse(form.artifact.interaction?.responseSchema, jsonValueSchema.parse(value));
        if (validated !== undefined) {
          const completedForm = await persist({ ...form.artifact, revision: 2, interaction: { mode: "present" }, fallback: { markdown: `${form.artifact.fallback.markdown}\n\n_Response submitted._` } }, sessionId);
          appendPointer(completedForm);
        }
        ctx.ui.notify(value === undefined ? "Artifact request cancelled" : "Artifact response received", value === undefined ? "warning" : "info");
        pi.sendMessage({ customType: "cake.artifact.demo", content: value === undefined ? "Artifact request cancelled." : `Artifact response: ${formatUnknown(validated, 1_000)}`, display: true });
      }
    });
  };
}

function formatUnknown(value: unknown, limit = 48_000) {
  let formatted: string;
  if (typeof value === "string") formatted = value;
  else {
    try { formatted = JSON.stringify(value, null, 2); }
    catch { formatted = String(value); }
  }
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n…` : formatted;
}
