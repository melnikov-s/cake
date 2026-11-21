import type { CanvasTarget } from "../../../contracts/project-canvas/canvas-link";
import { canvasLink } from "../../../contracts/project-canvas/canvas-link";
import type { ProjectCanvasStore } from "../../stores/ProjectCanvasStore";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { LinkIcon } from "../ui/icons";
import { CanvasMedia } from "./canvas-media";
import type { Tile } from "./layout";

export function CanvasTile({
  tile,
  store,
  projectChatId,
  open,
  copy,
}: {
  tile: Tile;
  store: ProjectCanvasStore;
  projectChatId: string;
  open(target: CanvasTarget, source: DOMRect): void;
  copy(link: string): void;
}) {
  const { card, revision, x, y, w, h } = tile;
  const target = { projectChatId, cardId: card.id, revision: revision.number };
  return (
    <div
      className="group absolute"
      style={{ left: x, top: y, width: w, height: h }}
      data-canvas-card={card.id}
    >
      {card.revisions.length > 1 && (
        <div className="absolute inset-0 -translate-y-2 scale-[0.96] rounded-lg bg-card ring-1 ring-border/70 shadow-sm" />
      )}
      <Button
        variant="ghost"
        aria-label={`Review ${revision.title}`}
        onClick={(event) => open(target, event.currentTarget.getBoundingClientRect())}
        className="relative block size-full overflow-hidden rounded-lg p-0 ring-1 ring-foreground/10 shadow-[0_1px_2px_-1px_var(--color-foreground),0_12px_24px_-16px_var(--color-foreground)] transition-[transform,box-shadow] hover:-translate-y-1 hover:shadow-xl motion-reduce:transition-none"
      >
        <CanvasMedia key={revision.number} target={target} revision={revision} store={store} />
      </Button>
      <IconButton
        tooltip="Copy link"
        className="absolute right-2 bottom-2 rounded-full bg-card/95 opacity-0 shadow-sm group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={() => copy(canvasLink(target))}
      >
        <LinkIcon />
      </IconButton>
      {revision.pins.length > 0 && (
        <span className="pointer-events-none absolute -top-2 -right-2 grid size-7 place-items-center rounded-full bg-card font-mono text-xs text-accent shadow-md">
          {revision.pins.length}
        </span>
      )}
    </div>
  );
}
