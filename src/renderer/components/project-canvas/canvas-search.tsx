import { useState } from "react";
import { searchCanvas } from "../../../utils/project-canvas-search";
import type { CanvasTarget } from "../../../contracts/project-canvas/canvas-link";
import type { CanvasCard } from "../../../contracts/project-canvas/project-canvas";
import { Button } from "../ui/button";
import { DialogBackdrop, DialogContent } from "../ui/dialog";
import { Input } from "../ui/input";

export function CanvasSearch({
  cards,
  projectChatId,
  portal,
  pick,
  close,
}: {
  cards: readonly CanvasCard[];
  projectChatId: string;
  portal: HTMLElement;
  pick(target: CanvasTarget): void;
  close(): void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const hits = searchCanvas(cards, query).slice(0, 8);
  const open = (hit: (typeof hits)[number] | undefined) => {
    if (hit) pick({ projectChatId, cardId: hit.card.id, revision: hit.revision.number });
  };
  return (
    <DialogBackdrop
      portalContainer={portal}
      aria-label="Search Canvas"
      onClose={close}
      className="absolute place-items-start justify-items-center bg-background/25 pt-[12vh] backdrop-blur-none"
    >
      <DialogContent className="max-w-lg space-y-2 rounded-2xl p-2">
        <Input
          autoFocus
          value={query}
          placeholder="Search Canvas"
          aria-label="Search cards"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSelected(
                Math.max(0, Math.min(hits.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1))),
              );
            }
            if (e.key === "Enter") open(hits[selected]);
          }}
        />
        {hits.length === 0 && (
          <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
            No matching cards.
          </p>
        )}
        {hits.map((hit, index) => (
          <Button
            key={hit.card.id}
            variant="ghost"
            aria-current={selected === index}
            onPointerMove={() => setSelected(index)}
            className="flex h-10 w-full justify-start gap-3 px-3 aria-current:bg-muted"
            onClick={() => open(hit)}
          >
            <span className="truncate text-foreground">{hit.revision.title}</span>
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {hit.card.group} · r{hit.revision.number}
            </span>
          </Button>
        ))}
      </DialogContent>
    </DialogBackdrop>
  );
}
