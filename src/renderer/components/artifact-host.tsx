import { useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { observer } from "r-state-tree/react";
import type { ArtifactRecord } from "../../contracts/artifacts/artifact-contract";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { WidgetArtifact } from "./widget-artifact";
import { DiagramArtifact } from "./diagram-artifact";
import { FileArtifact } from "./file-artifact";
import { HtmlArtifact } from "./html-artifact";
import { MediaArtifact } from "./media-artifact";
import { TableArtifact } from "./table-artifact";

interface ArtifactHostProps {
  record: ArtifactRecord;
  presentation?: "workspace" | "inline";
  inlineWidgets?: InlineWidgetStore;
  onOpenSourceLocation?(location: SourceLocation): void;
}

export const ArtifactHost = observer(function ArtifactHost({
  record,
  presentation = "workspace",
  inlineWidgets,
  onOpenSourceLocation,
}: ArtifactHostProps) {
  const artifact = record.artifact;
  const [fullscreen, setFullscreen] = useState(false);
  const title = artifact.title ?? artifact.id;
  const canvas = artifact.kind === "widget" || artifact.kind === "html";

  const renderArtifact = (fill = false) => (
    <>
      {artifact.kind === "markdown" ? (
        <Markdown onOpenSourceLocation={onOpenSourceLocation}>{artifact.payload.markdown}</Markdown>
      ) : null}
      {artifact.kind === "table" ? <TableArtifact artifact={artifact} /> : null}
      {artifact.kind === "diagram" ? <DiagramArtifact artifact={artifact} /> : null}
      {artifact.kind === "media" ? <MediaArtifact artifact={artifact} /> : null}
      {artifact.kind === "diff" ? (
        <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed">
          {artifact.payload.diff}
        </pre>
      ) : null}
      {artifact.kind === "html" ? <HtmlArtifact artifact={artifact} /> : null}
      {artifact.kind === "file" ? <FileArtifact artifact={artifact} /> : null}
      {artifact.kind === "widget" ? (
        <WidgetArtifact
          artifact={artifact}
          inlineWidgets={inlineWidgets}
          fill={fill}
          presentation={fill ? "workspace" : presentation}
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
