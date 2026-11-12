import { useState, type ReactNode } from "react";
import { Markdown, fencedCode } from "@/components/ai-elements/markdown";
import { ArtifactPresentationSurface } from "./artifact-presentation-surface";
import { ArtifactAttachmentMenu } from "./artifact-attachment-menu";
import { SidePanel } from "./ui/side-panel";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { ResizableSurface } from "@/components/ui/resizable-surface";
import { observer } from "r-state-tree/react";
import type { ArtifactRecord } from "../../contracts/artifacts/artifact-contract";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { WidgetArtifact } from "./widget-artifact";
import { WidgetInitialPreview } from "./widget-initial-preview";
import { FileArtifact } from "./file-artifact";
import { HtmlArtifact } from "./html-artifact";
import { MediaArtifact } from "./media-artifact";
import { TableArtifact } from "./table-artifact";
import { MessageBoardArtifact } from "./message-board-artifact";
import type { MessageBoardStore } from "../stores/MessageBoardStore";
import { useArtifactViewing } from "../hooks/use-artifact-viewing";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
} from "../../contracts/artifacts/artifact-lineage";

interface ArtifactHostProps {
  record: ArtifactRecord;
  presentation?: "workspace" | "inline" | "fullscreen" | "side-panel";
  viewingSurface?: "library";
  onClose?(): void;
  wrapContent?(content: ReactNode): ReactNode;
  inlineWidgets?: InlineWidgetStore;
  stateSessionId?: string;
  messageBoard?: MessageBoardStore;
  onOpenSourceLocation?(location: SourceLocation): void;
}

export const ArtifactHost = observer(function ArtifactHost({
  record,
  presentation = "workspace",
  viewingSurface,
  onClose,
  wrapContent,
  inlineWidgets,
  stateSessionId,
  messageBoard,
  onOpenSourceLocation,
}: ArtifactHostProps) {
  const artifact = record.artifact;
  const [fullscreen, setFullscreen] = useState(false);
  const viewing = useArtifactViewing({
    lineageId: decodeArtifactLineageId(artifact.id),
    revision: decodeArtifactRevisionNumber(artifact.revision),
    surface:
      viewingSurface ??
      (presentation === "workspace" || presentation === "side-panel" ? "pane" : presentation),
  });
  const closeFullscreen = () => {
    setFullscreen(false);
    if (presentation !== "side-panel") onClose?.();
  };
  const title = artifact.title ?? artifact.id;

  const renderArtifact = (fill = false) => (
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
      {artifact.kind === "diagram" ? (
        <Markdown onOpenSourceLocation={onOpenSourceLocation}>
          {fencedCode(artifact.payload.source, "mermaid")}
        </Markdown>
      ) : null}
      {artifact.kind === "media" ? <MediaArtifact artifact={artifact} /> : null}
      {artifact.kind === "diff" ? (
        <pre className="overflow-x-auto font-mono text-xs leading-relaxed">
          {artifact.payload.diff}
        </pre>
      ) : null}
      {artifact.kind === "html" ? <HtmlArtifact artifact={artifact} fill={fill} /> : null}
      {artifact.kind === "file" ? <FileArtifact artifact={artifact} /> : null}
    </>
  );

  if (presentation === "side-panel") {
    const canvas = artifact.kind === "widget" || artifact.kind === "html";
    const content =
      artifact.kind === "widget" ? (
        <WidgetArtifact
          artifact={artifact}
          stateSessionId={stateSessionId}
          inlineWidgets={inlineWidgets}
          onInteraction={viewing.onPointerDownCapture}
          fill
        />
      ) : (
        renderArtifact(true)
      );
    return (
      <SidePanel
        title={title}
        onClose={() => onClose?.()}
        headerActions={
          <>
            <ArtifactAttachmentMenu
              artifact={artifact}
              sessionId={stateSessionId ?? artifact.sessionId}
            />
            <FullscreenButton
              label={`View ${title} fullscreen`}
              onClick={() => setFullscreen(true)}
            />
          </>
        }
      >
        <ResizableSurface
          label={title}
          fill
          renderExpanded={
            fullscreen
              ? (targetRef) => (
                  <ArtifactPresentationSurface
                    record={record}
                    sessionId={stateSessionId}
                    onClose={closeFullscreen}
                  >
                    <div ref={targetRef} className="h-full min-h-0 w-full" />
                  </ArtifactPresentationSurface>
                )
              : undefined
          }
        >
          <article
            {...viewing}
            className={
              canvas ? "h-full min-h-0 overflow-hidden" : "h-full min-h-0 overflow-auto p-4"
            }
            data-artifact-id={artifact.id}
            data-artifact-kind={artifact.kind}
          >
            {wrapContent ? wrapContent(content) : content}
          </article>
        </ResizableSurface>
      </SidePanel>
    );
  }

  if (presentation === "fullscreen") {
    const content =
      artifact.kind === "widget" ? (
        <WidgetArtifact
          artifact={artifact}
          stateSessionId={stateSessionId}
          inlineWidgets={inlineWidgets}
          onInteraction={viewing.onPointerDownCapture}
          fill
          presentation="workspace"
        />
      ) : (
        renderArtifact(true)
      );
    return (
      <ArtifactPresentationSurface
        record={record}
        sessionId={stateSessionId}
        onClose={closeFullscreen}
      >
        <article
          {...viewing}
          className="h-full min-h-0 w-full"
          data-artifact-id={artifact.id}
          data-artifact-kind={artifact.kind}
        >
          {wrapContent ? wrapContent(content) : content}
        </article>
      </ArtifactPresentationSurface>
    );
  }

  return (
    <article
      {...viewing}
      className="relative min-w-0"
      data-artifact-id={artifact.id}
      data-artifact-kind={artifact.kind}
    >
      {artifact.kind !== "diagram" && artifact.kind !== "message-board" && (
        <FullscreenButton
          className="absolute top-0 right-0 z-10 bg-background/85"
          label={`View ${title} fullscreen`}
          onClick={() => setFullscreen(true)}
        />
      )}
      {artifact.kind === "widget" ? (
        <ResizableSurface
          label={title}
          renderExpanded={
            fullscreen
              ? (targetRef) => (
                  <ArtifactPresentationSurface
                    record={record}
                    sessionId={stateSessionId}
                    onClose={closeFullscreen}
                  >
                    <div ref={targetRef} className="h-full min-h-0 w-full" />
                  </ArtifactPresentationSurface>
                )
              : undefined
          }
        >
          <WidgetArtifact
            artifact={artifact}
            stateSessionId={stateSessionId}
            inlineWidgets={inlineWidgets}
            onInteraction={viewing.onPointerDownCapture}
            fill
            presentation={fullscreen ? "workspace" : presentation}
          />
        </ResizableSurface>
      ) : (
        renderArtifact()
      )}
      {artifact.kind === "widget" && <WidgetInitialPreview artifact={artifact} />}
      {fullscreen && artifact.kind !== "widget" && (
        <ArtifactPresentationSurface
          record={record}
          sessionId={stateSessionId}
          onClose={closeFullscreen}
        >
          {renderArtifact(true)}
        </ArtifactPresentationSurface>
      )}
    </article>
  );
});
