import { useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { ResizableSurface } from "@/components/ui/resizable-surface";
import { observer } from "r-state-tree/react";
import type { ArtifactRecord } from "../../contracts/artifacts/artifact-contract";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { WidgetArtifact } from "./widget-artifact";
import { WidgetInitialPreview } from "./widget-initial-preview";
import { DiagramArtifact } from "./diagram-artifact";
import { FileArtifact } from "./file-artifact";
import { HtmlArtifact } from "./html-artifact";
import { MediaArtifact } from "./media-artifact";
import { TableArtifact } from "./table-artifact";
import { MessageBoardArtifact } from "./message-board-artifact";
import type { MessageBoardStore } from "../stores/MessageBoardStore";

interface ArtifactHostProps {
  record: ArtifactRecord;
  presentation?: "workspace" | "inline";
  inlineWidgets?: InlineWidgetStore;
  stateSessionId?: string;
  messageBoard?: MessageBoardStore;
  onOpenSourceLocation?(location: SourceLocation): void;
}

export const ArtifactHost = observer(function ArtifactHost({
  record,
  presentation = "workspace",
  inlineWidgets,
  stateSessionId,
  messageBoard,
  onOpenSourceLocation,
}: ArtifactHostProps) {
  const artifact = record.artifact;
  const [fullscreen, setFullscreen] = useState(false);
  const title = artifact.title ?? artifact.id;
  const canvas = artifact.kind === "widget" || artifact.kind === "html";

  const renderArtifact = () => (
    <>
      {artifact.kind === "message-board" ? (
        messageBoard ? (
          <MessageBoardArtifact store={messageBoard} />
        ) : (
          <Markdown>{artifact.fallback.markdown}</Markdown>
        )
      ) : null}
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
      {artifact.kind === "widget" ? (
        <ResizableSurface
          label={title}
          renderExpanded={
            fullscreen
              ? (targetRef) => (
                  <FullscreenSurface
                    mode="canvas"
                    eyebrow="Artifact"
                    title={title}
                    onClose={() => setFullscreen(false)}
                  >
                    <div ref={targetRef} className="h-full min-h-0 w-full" />
                  </FullscreenSurface>
                )
              : undefined
          }
        >
          <WidgetArtifact
            artifact={artifact}
            stateSessionId={stateSessionId}
            inlineWidgets={inlineWidgets}
            fill
            presentation={fullscreen ? "workspace" : presentation}
          />
        </ResizableSurface>
      ) : (
        renderArtifact()
      )}
      {artifact.kind === "widget" && <WidgetInitialPreview artifact={artifact} />}
      {fullscreen && artifact.kind !== "widget" && (
        <FullscreenSurface
          mode={canvas ? "canvas" : "reader"}
          eyebrow="Artifact"
          title={title}
          onClose={() => setFullscreen(false)}
        >
          {renderArtifact()}
        </FullscreenSurface>
      )}
    </article>
  );
});
