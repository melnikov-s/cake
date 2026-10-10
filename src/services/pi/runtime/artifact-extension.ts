import { Schema } from "effect";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  artifactPointerSchema,
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../../../ipc/artifact-contract";

export interface ArtifactExtensionOptions {
  persistArtifact(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
}

export function createCakeArtifactExtension(options: ArtifactExtensionOptions): InlineExtension {
  return (pi) => {
    pi.registerCommand("cake-artifacts", {
      description: "Exercise Cake's built-in reusable artifact renderers",
      async handler(_args, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const present = async (artifact: CakeArtifactV1) => {
          const record = await options.persistArtifact(parseArtifactInput(artifact));
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
            }),
          );
          return record;
        };
        const table = await present({
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
        });
        await present({ ...table.artifact, revision: 2 });
        await present({
          protocol: "cake.artifact/v1",
          id: "cake-s4-diagram",
          sessionId,
          revision: 1,
          kind: "diagram",
          title: "S4 diagram",
          payload: { source: "flowchart LR\n  Agent --> Artifact\n  Artifact --> User" },
          fallback: { markdown: "Agent → Artifact → User" },
          interaction: { mode: "present" },
        });
        await present({
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
        });
        await present({
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
        });
        ctx.ui.notify("Artifact examples presented", "info");
      },
    });
  };
}
