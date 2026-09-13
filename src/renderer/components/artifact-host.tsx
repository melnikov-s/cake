import { Option, Schema } from "effect";
import { useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { observer } from "r-state-tree/react";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";
import { cakeRequestV1Schema } from "../../ipc/request-contract";
import type { SourceLocation } from "../../ipc/source-location";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { ArtifactForm } from "./artifact-form";
import { RequestArtifact, WidgetArtifact } from "./artifact-widget";
import { DiagramArtifact } from "./diagram-artifact";
import { FileArtifact } from "./file-artifact";
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
  const title =
    Option.isSome(parsedRequest) && parsedRequest.value.title
      ? parsedRequest.value.title
      : (artifact.title ?? artifact.id);
  const canvas =
    artifact.kind === "widget" ||
    artifact.kind === "html" ||
    (Option.isSome(parsedRequest) && parsedRequest.value.view.type === "widget");

  const renderArtifact = (fill = false) => (
    <>
      {artifact.kind === "markdown" ? (
        <Markdown onOpenSourceLocation={onOpenSourceLocation}>{artifact.payload.markdown}</Markdown>
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
      {artifact.kind === "file" ? <FileArtifact artifact={artifact} /> : null}
      {artifact.kind === "widget" ? (
        <WidgetArtifact artifact={artifact} inlineWidgets={inlineWidgets} fill={fill} />
      ) : null}
      {artifact.kind === "request" ? (
        <RequestArtifact
          artifact={artifact}
          requested={requested}
          submittedAnswer={submittedAnswer}
          onSubmit={onSubmit}
          onSkip={onSkip}
          inlineWidgets={inlineWidgets}
          fill={fill}
        />
      ) : null}
    </>
  );

  return (
    <article
      className="relative min-w-0"
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
    >
      <FullscreenButton
        className="absolute top-0 right-0 z-10 bg-background/85"
        label={`View ${title} fullscreen`}
        onClick={() => setFullscreen(true)}
      />
      {renderArtifact()}
      {fullscreen && (
        <FullscreenSurface
          mode={canvas ? "canvas" : "reader"}
          eyebrow="Artifact"
          title={title}
          onClose={() => setFullscreen(false)}
        >
          {renderArtifact(true)}
        </FullscreenSurface>
      )}
    </article>
  );
});
