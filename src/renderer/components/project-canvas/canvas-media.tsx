import { useEffect, useRef, useState } from "react";
import type { CanvasTarget } from "../../../contracts/project-canvas/canvas-link";
import type { CanvasImage, CanvasRevision } from "../../../contracts/project-canvas/project-canvas";
import type { ProjectCanvasStore } from "../../stores/ProjectCanvasStore";
import { ArtifactIcon, CanvasIcon } from "../ui/icons";

export function CanvasMedia({
  store,
  target,
  revision,
  eager = false,
}: {
  store: ProjectCanvasStore;
  target: CanvasTarget;
  revision: CanvasRevision;
  eager?: boolean;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<CanvasImage | null>();
  const [failed, setFailed] = useState(false);
  const { projectChatId, cardId } = target;
  const { number, content } = revision;
  useEffect(() => {
    const element = node.current;
    if (content.kind === "decision" || !element) return;
    const controller = new AbortController();
    const load = () => {
      void store.preview({ projectChatId, cardId, revision: number }, controller.signal).then(
        (value) => {
          if (!controller.signal.aborted) setImage(value);
        },
        () => {
          if (!controller.signal.aborted) setFailed(true);
        },
      );
    };
    if (eager) {
      load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      load();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [store, projectChatId, cardId, number, eager, content.kind]);
  return (
    <div ref={node} className="size-full overflow-hidden bg-card text-card-foreground">
      {content.kind === "decision" ? (
        <div className="flex size-full flex-col gap-3 overflow-hidden p-5 text-left whitespace-normal">
          <span className="font-mono text-xs text-muted-foreground">Decision</span>
          <strong className="truncate text-base">{revision.title}</strong>
          <span className="line-clamp-6 text-sm leading-relaxed whitespace-pre-wrap">
            {content.text}
          </span>
        </div>
      ) : image ? (
        <img
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={revision.title}
          draggable={false}
          decoding="async"
          className="block size-full object-contain"
          onError={() => {
            setImage(null);
            setFailed(true);
          }}
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 bg-muted/50 px-4 text-center">
          {content.kind === "artifact" ? <ArtifactIcon /> : <CanvasIcon />}
          <span className="max-w-full truncate font-semibold">{revision.title}</span>
          <span className="text-xs text-muted-foreground">
            {failed
              ? "Preview unavailable"
              : content.kind === "artifact"
                ? "Cake artifact"
                : "Screenshot"}
          </span>
        </div>
      )}
    </div>
  );
}
