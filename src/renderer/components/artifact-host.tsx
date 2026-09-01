import { Option, Schema } from "effect";
import { useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { FullscreenButton } from "@/components/fullscreen-surface";
import { observer } from "r-state-tree/react";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type { SourceLocation } from "../../ipc/source-location";

import { cakeRequestV1Schema } from "../../ipc/request-contract";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { ArtifactForm } from "./artifact-form";
import { RequestArtifact, WidgetArtifact } from "./artifact-widget";
import { DiagramArtifact } from "./diagram-artifact";
import { HtmlArtifact } from "./html-artifact";
import { MediaArtifact } from "./media-artifact";
import { TableArtifact } from "./table-artifact";

interface ArtifactHostProps {
  record: ArtifactRecord;
  requested?: boolean;
  submittedAnswer?: JsonValue;
  onSubmit?(value: JsonValue): void;
  onSkip?(): void;
  inlineWidgets?: InlineWidgetStore;
  onOpenSourceLocation?(location: SourceLocation): void;
}

export const ArtifactHost = observer(function ArtifactHost({
  record,
  requested = false,
  submittedAnswer,
  onSubmit,
  onSkip,
  inlineWidgets,
  onOpenSourceLocation,
}: ArtifactHostProps) {
  const artifact = record.artifact;
  const [fullscreen, setFullscreen] = useState(false);
  const parsedRequest =
    artifact.kind === "request"
      ? Schema.decodeUnknownOption(cakeRequestV1Schema)(artifact.payload.request)
      : Option.none<typeof cakeRequestV1Schema.Type>();
  const widget =
    artifact.kind === "widget"
      ? {
          id: `${artifact.sessionId}:widget:${artifact.id}:${artifact.revision}`,
          title: artifact.title ?? "Widget",
        }
      : Option.isSome(parsedRequest) && parsedRequest.value.view.type === "widget"
        ? {
            id: `${artifact.sessionId}:request:${artifact.id}:${artifact.revision}`,
            title: parsedRequest.value.title,
          }
        : undefined;
  const widgetReady = Boolean(widget && inlineWidgets?.state(widget.id)?.compiled);
  return (
    <article
      className="relative overflow-hidden rounded-[14px] border border-border bg-card shadow-[0_10px_30px_-15px_hsl(var(--shadow)/0.3)]"
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
    >
      <header className="flex items-center justify-between gap-2.5 border-b border-border bg-card/85 px-3.5 py-2.5">
        <strong className="text-[13px] font-semibold text-foreground">
          {artifact.title ?? artifact.id}
        </strong>
        {widget && (
          <FullscreenButton
            className="ml-auto"
            disabled={!widgetReady}
            label={`View ${widget.title} fullscreen`}
            onClick={() => setFullscreen(true)}
          />
        )}
      </header>
      <div className="p-3.5">
        {artifact.kind === "markdown" ? (
          <Markdown onOpenSourceLocation={onOpenSourceLocation}>
            {artifact.payload.markdown}
          </Markdown>
        ) : null}
        {artifact.kind === "table" ? <TableArtifact artifact={artifact} /> : null}
        {artifact.kind === "diagram" ? <DiagramArtifact artifact={artifact} /> : null}
        {artifact.kind === "form" ? (
          <ArtifactForm
            fields={artifact.payload.fields}
            requested={requested}
            submittedAnswer={submittedAnswer}
            onSubmit={onSubmit}
            onSkip={onSkip}
          />
        ) : null}
        {artifact.kind === "media" ? <MediaArtifact artifact={artifact} /> : null}
        {artifact.kind === "diff" ? (
          <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed">
            {artifact.payload.diff}
          </pre>
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
            submittedAnswer={submittedAnswer}
            onSubmit={onSubmit}
            onSkip={onSkip}
            inlineWidgets={inlineWidgets}
            fullscreen={fullscreen}
            onCloseFullscreen={() => setFullscreen(false)}
          />
        ) : null}
      </div>
      <details className="border-t border-border px-3.5 py-2 text-[11px]">
        <summary className="cursor-pointer text-muted-foreground select-none">
          Readable fallback
        </summary>
        <div className="mt-2">
          <Markdown onOpenSourceLocation={onOpenSourceLocation}>
            {artifact.fallback.markdown}
          </Markdown>
        </div>
      </details>
    </article>
  );
});
