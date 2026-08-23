import { useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { FullscreenButton } from "@/components/fullscreen-surface";
import { observer } from "r-state-tree/react";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";

import { cakeRequestV1Schema } from "../../ipc/request-contract";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { RequestArtifact, WidgetArtifact } from "./artifact-widget";
import { DiagramArtifact } from "./diagram-artifact";
import { FormArtifact } from "./form-artifact";
import { HtmlArtifact } from "./html-artifact";
import { MediaArtifact } from "./media-artifact";
import { TableArtifact } from "./table-artifact";
export { downloadArtifactMarkdown } from "./table-artifact";

interface ArtifactHostProps {
  record: ArtifactRecord;
  requested?: boolean;
  onSubmit?(value: JsonValue): void;
  onSkip?(): void;
  inlineWidgets?: InlineWidgetStore;
}

export const ArtifactHost = observer(function ArtifactHost({
  record,
  requested = false,
  onSubmit,
  onSkip,
  inlineWidgets,
}: ArtifactHostProps) {
  const artifact = record.artifact;
  const [fullscreen, setFullscreen] = useState(false);
  const parsedRequest =
    artifact.kind === "request"
      ? cakeRequestV1Schema.safeParse(artifact.payload.request)
      : undefined;
  const widget =
    artifact.kind === "widget"
      ? {
          id: `${artifact.sessionId}:widget:${artifact.id}:${artifact.revision}`,
          title: artifact.title ?? "Widget",
        }
      : parsedRequest?.success && parsedRequest.data.view.type === "widget"
        ? {
            id: `${artifact.sessionId}:request:${artifact.id}:${artifact.revision}`,
            title: parsedRequest.data.title,
          }
        : undefined;
  const widgetReady = Boolean(widget && inlineWidgets?.state(widget.id)?.compiled);
  return (
    <article className="artifact" data-artifact-id={artifact.id} data-artifact-kind={artifact.kind}>
      <header>
        <div>
          <strong>{artifact.title ?? artifact.id}</strong>
          <span>
            {artifact.kind} · r{artifact.revision}
          </span>
        </div>
        {widget && (
          <FullscreenButton
            className="artifact-fullscreen-button"
            disabled={!widgetReady}
            label={`View ${widget.title} fullscreen`}
            onClick={() => setFullscreen(true)}
          />
        )}
      </header>
      <div className="artifact-body">
        {artifact.kind === "markdown" ? <Markdown>{artifact.payload.markdown}</Markdown> : null}
        {artifact.kind === "table" ? <TableArtifact artifact={artifact} /> : null}
        {artifact.kind === "diagram" ? <DiagramArtifact artifact={artifact} /> : null}
        {artifact.kind === "form" ? (
          <FormArtifact
            artifact={artifact}
            requested={requested}
            onSubmit={onSubmit}
            onSkip={onSkip}
          />
        ) : null}
        {artifact.kind === "media" ? <MediaArtifact artifact={artifact} /> : null}
        {artifact.kind === "diff" ? (
          <pre className="artifact-diff">{artifact.payload.diff}</pre>
        ) : null}
        {artifact.kind === "html" ? <HtmlArtifact artifact={artifact} /> : null}
        {artifact.kind === "widget" ? (
          <WidgetArtifact
            artifact={artifact}
            inlineWidgets={inlineWidgets}
            fullscreen={fullscreen}
            onCloseFullscreen={() => setFullscreen(false)}
          />
        ) : null}
        {artifact.kind === "request" ? (
          <RequestArtifact
            artifact={artifact}
            requested={requested}
            onSubmit={onSubmit}
            onSkip={onSkip}
            inlineWidgets={inlineWidgets}
            fullscreen={fullscreen}
            onCloseFullscreen={() => setFullscreen(false)}
          />
        ) : null}
      </div>
      <details className="artifact-fallback">
        <summary>Readable fallback</summary>
        <Markdown>{artifact.fallback.markdown}</Markdown>
      </details>
    </article>
  );
});
