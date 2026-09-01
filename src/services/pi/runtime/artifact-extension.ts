import { Schema } from "effect";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { jsonValueSchema, type JsonValue } from "../../../ipc/json-contract";
import {
  artifactPointerSchema,
  parseArtifactInput,
  validateArtifactResponse,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../../ipc/artifact-contract";
import type {
  InlineWidgetGenerationRequest,
  InlineWidgetGenerationResult,
} from "./sidecar-runtime";

export interface ArtifactExtensionOptions {
  persistArtifact(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact(record: ArtifactRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  generateInlineWidget?(
    input: InlineWidgetGenerationRequest,
  ): Promise<InlineWidgetGenerationResult>;
}

export function createCakeArtifactExtension(options: ArtifactExtensionOptions): InlineExtension {
  return (pi) => {
    const persist = async (input: unknown, sessionId: string) => {
      const artifact = parseArtifactInput(input);
      if (artifact.sessionId !== sessionId)
        throw new Error("Artifact sessionId does not match the active Pi session");
      return options.persistArtifact(artifact);
    };
    const appendPointer = (record: ArtifactRecord) => {
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
        }),
      );
    };
    pi.registerCommand("cake-artifacts", {
      description: "Exercise Cake's built-in artifact renderers and structured response path",
      async handler(_args, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const table = await persist(
          {
            protocol: "cake.artifact/v1",
            id: "cake-s4-table",
            sessionId,
            revision: 1,
            kind: "table",
            title: "S4 table",
            payload: {
              columns: [
                { id: "name", label: "Name", type: "text" },
                { id: "score", label: "Score", type: "number" },
              ],
              rows: [
                { id: "row-a", name: "Alpha", score: 2 },
                { id: "row-b", name: "Beta", score: 1 },
              ],
              selectable: true,
            },
            fallback: { markdown: "| Name | Score |\n| --- | ---: |\n| Alpha | 2 |\n| Beta | 1 |" },
            interaction: { mode: "present" },
          },
          sessionId,
        );
        appendPointer(table);
        const diagram = await persist(
          {
            protocol: "cake.artifact/v1",
            id: "cake-s4-diagram",
            sessionId,
            revision: 1,
            kind: "diagram",
            title: "S4 diagram",
            payload: { source: "flowchart LR\n  Agent --> Artifact\n  Artifact --> User" },
            fallback: { markdown: "Agent → Artifact → User" },
            interaction: { mode: "present" },
          },
          sessionId,
        );
        appendPointer(diagram);
        const html = await persist(
          {
            protocol: "cake.artifact/v1",
            id: "cake-s4-html",
            sessionId,
            revision: 1,
            kind: "html",
            title: "Sandboxed HTML",
            payload: {
              html: "<strong>Isolated HTML</strong><script>parent.document.body.textContent='compromised';fetch('https://example.com')</script>",
            },
            fallback: { markdown: "**Isolated HTML**" },
            interaction: { mode: "present" },
          },
          sessionId,
        );
        appendPointer(html);
        const widget = await persist(
          {
            protocol: "cake.artifact/v1",
            id: "cake-s4-widget",
            sessionId,
            revision: 1,
            kind: "widget",
            title: "S4 widget",
            payload: {
              language: "html",
              source: "<strong>Repairable widget</strong>",
              brief: "A compact repairable artifact demo widget",
              generationSessionId: "s4-widget-generation",
            },
            fallback: { markdown: "Repairable widget" },
            interaction: { mode: "present" },
          },
          sessionId,
        );
        appendPointer(widget);
        const request = {
          protocol: "cake.request/v1" as const,
          id: "cake-s4-form",
          title: "S4 response",
          responseSchema: {
            type: "object" as const,
            properties: { answer: { type: "string" as const } },
          },
          view: {
            type: "form" as const,
            fields: [
              {
                id: "answer",
                label: "Answer",
                type: "select" as const,
                options: [{ value: "standard", label: "Standard answer" }],
              },
            ],
          },
          fallback: { markdown: "S4 response form: **Answer**." },
        };
        const form = await persist(
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
        appendPointer(form);
        const value = await options.requestArtifact(form, new AbortController().signal);
        const validated =
          value === undefined
            ? undefined
            : validateArtifactResponse(
                form.artifact.interaction?.responseSchema,
                Schema.decodeUnknownSync(jsonValueSchema)(value),
              );
        if (validated !== undefined) {
          const completedForm = await persist(
            {
              ...form.artifact,
              revision: 2,
              interaction: { mode: "present" },
              fallback: { markdown: `${form.artifact.fallback.markdown}\n\n_Response submitted._` },
            },
            sessionId,
          );
          appendPointer(completedForm);
        }
        ctx.ui.notify(
          value === undefined ? "Artifact request cancelled" : "Artifact response received",
          value === undefined ? "warning" : "info",
        );
        pi.sendMessage({
          customType: "cake.artifact.demo",
          content:
            value === undefined
              ? "Artifact request cancelled."
              : `Artifact response: ${formatUnknown(validated, 1_000)}`,
          display: true,
        });
      },
    });
  };
}

function formatUnknown(value: unknown, limit = 48_000) {
  let formatted: string;
  if (typeof value === "string") formatted = value;
  else {
    try {
      formatted = JSON.stringify(value, null, 2);
    } catch {
      formatted = String(value);
    }
  }
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n…` : formatted;
}
