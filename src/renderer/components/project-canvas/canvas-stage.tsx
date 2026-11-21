import { useLayoutEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { canvasLink, type CanvasTarget } from "../../../contracts/project-canvas/canvas-link";
import type { CanvasCard, CanvasRevision } from "../../../contracts/project-canvas/project-canvas";
import { cn } from "../../lib/utils";
import type { ProjectCanvasStore } from "../../stores/ProjectCanvasStore";
import { Button } from "../ui/button";
import { DialogBackdrop } from "../ui/dialog";
import { IconButton } from "../ui/icon-button";
import { CloseIcon, LinkIcon } from "../ui/icons";
import { Textarea } from "../ui/textarea";
import { CanvasMedia } from "./canvas-media";

export const CanvasStage = observer(function CanvasStage({
  card,
  revision,
  target,
  store,
  source,
  portal,
  openArtifact,
  handoff,
  copy,
  close,
}: {
  card: CanvasCard;
  revision: CanvasRevision;
  target: CanvasTarget;
  store: ProjectCanvasStore;
  source?: DOMRect;
  portal: HTMLElement;
  openArtifact(reference: string): void;
  handoff(sessionId: string, text: string): Promise<boolean>;
  copy(link: string): void;
  close(): void;
}) {
  const [compare, setCompare] = useState<number>();
  const [placing, setPlacing] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const [text, setText] = useState("");
  const [activePin, setActivePin] = useState<string>();
  const [handoffFailed, setHandoffFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const focus = useRef<HTMLDivElement>(null);
  const lastRevision = card.revisions.find((item) => item.number === compare);
  const exact = { ...target, revision: revision.number };
  const selectedPin = revision.pins.find((pin) => pin.id === activePin);
  useLayoutEffect(() => {
    const prior = document.activeElement;
    focus.current?.focus({ preventScroll: true });
    const node = box.current;
    const rect = node?.getBoundingClientRect();
    const animation =
      source && rect?.width && node && !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? node.animate(
            [
              {
                transform: `translate(${source.left - rect.left}px,${source.top - rect.top}px) scale(${source.width / rect.width},${source.height / rect.height})`,
              },
              { transform: "none" },
            ],
            { duration: 480, easing: "cubic-bezier(0.3, 0.7, 0.1, 1)" },
          )
        : undefined;
    return () => {
      animation?.cancel();
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus({ preventScroll: true });
    };
  }, [source]);
  const save = async () => {
    if (!point || !text.trim()) return;
    if (await store.addPin(exact, { ...point, text: text.trim() })) {
      setText("");
      setPoint(undefined);
      setPlacing(false);
    }
  };
  const go = (number: number) => {
    if (!card.revisions.some((item) => item.number === number)) return;
    store.reveal({ ...target, revision: number });
  };
  const older = lastRevision && lastRevision.number < revision.number;
  const current = (
    <div
      className="relative min-h-0 max-h-[60vh] overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10 shadow-2xl"
      style={{ aspectRatio: revision.aspect }}
    >
      <CanvasMedia target={exact} revision={revision} store={store} eager />
      {revision.pins.map((pin, index) => (
        <IconButton
          key={pin.id}
          tooltip={`Feedback pin ${index + 1}`}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-card text-accent shadow-lg"
          style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
          aria-pressed={activePin === pin.id}
          onClick={() => {
            setActivePin(pin.id);
            setHandoffFailed(false);
          }}
        >
          <span className="font-mono text-xs">{index + 1}</span>
        </IconButton>
      ))}
      {placing && (
        <Button
          aria-label="Place feedback on this revision"
          variant="ghost"
          className="absolute inset-0 size-full cursor-crosshair rounded-none hover:bg-transparent"
          onClick={(e) => {
            const bounds = e.currentTarget.getBoundingClientRect();
            setPoint(
              e.detail === 0
                ? { x: 0.5, y: 0.5 }
                : {
                    x: (e.clientX - bounds.left) / bounds.width,
                    y: (e.clientY - bounds.top) / bounds.height,
                  },
            );
          }}
        />
      )}
      {point && (
        <span
          className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-card"
          style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
        />
      )}
    </div>
  );
  return (
    <DialogBackdrop
      portalContainer={portal}
      onClose={close}
      aria-label={`Review ${revision.title}`}
      className="absolute grid place-items-center overflow-y-auto bg-background/55 p-5 backdrop-blur-sm"
    >
      <div
        ref={focus}
        tabIndex={-1}
        className="relative flex w-full min-w-0 flex-col items-center gap-4 outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape" && placing) {
            event.stopPropagation();
            setPoint(undefined);
            setPlacing(false);
          }
          if (event.target instanceof HTMLTextAreaElement) return;
          if (event.key === "ArrowLeft") go(revision.number - 1);
          if (event.key === "ArrowRight") go(revision.number + 1);
        }}
      >
        <div
          ref={box}
          className={cn(
            "grid w-full origin-top-left items-end gap-5",
            lastRevision ? "max-w-[76rem] grid-cols-2" : "max-w-[52rem]",
          )}
        >
          <div className={cn("min-w-0", lastRevision && !older && "order-first")}>
            {lastRevision && (
              <p className="mb-2 text-center font-mono text-xs text-muted-foreground">
                {older ? "After" : "Before"} · r{revision.number}
              </p>
            )}
            {current}
          </div>
          {lastRevision && (
            <div className={cn("min-w-0", older && "order-first")}>
              <p className="mb-2 text-center font-mono text-xs text-muted-foreground">
                {older ? "Before" : "After"} · r{lastRevision.number}
              </p>
              <div
                className="max-h-[60vh] overflow-hidden rounded-lg ring-1 ring-foreground/10 shadow-2xl"
                style={{ aspectRatio: lastRevision.aspect }}
              >
                <CanvasMedia
                  key={lastRevision.number}
                  target={{ ...target, revision: lastRevision.number }}
                  revision={lastRevision}
                  store={store}
                  eager
                />
              </div>
            </div>
          )}
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border border-border/75 bg-popover/95 px-2 py-1 shadow-xl backdrop-blur-xl">
          <span className="max-w-60 truncate px-2 text-sm font-medium">{revision.title}</span>
          <div
            className="flex max-w-52 items-center gap-1 overflow-x-auto"
            aria-label="Revision rail"
          >
            {card.revisions.map((item) => (
              <Button
                key={item.number}
                size="sm"
                variant="ghost"
                aria-pressed={item.number === revision.number}
                className="rounded-full aria-pressed:bg-muted aria-pressed:text-foreground"
                onClick={() => go(item.number)}
              >
                r{item.number}
              </Button>
            ))}
          </div>
          {card.revisions.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              onClick={() =>
                setCompare(lastRevision ? undefined : revision.number > 1 ? revision.number - 1 : 2)
              }
            >
              {lastRevision ? "End compare" : "Compare"}
            </Button>
          )}
          {lastRevision && card.revisions.length > 2 && (
            <div className="flex max-w-52 overflow-x-auto" aria-label="Compare with revision">
              {card.revisions
                .filter((item) => item.number !== revision.number)
                .map((item) => (
                  <Button
                    key={item.number}
                    variant="ghost"
                    size="sm"
                    aria-label={`Compare with r${item.number}`}
                    aria-pressed={compare === item.number}
                    className="rounded-full aria-pressed:bg-muted"
                    onClick={() => setCompare(item.number)}
                  >
                    r{item.number}
                  </Button>
                ))}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            aria-pressed={placing}
            onClick={() => {
              setPlacing(!placing);
              setPoint(undefined);
              setActivePin(undefined);
            }}
          >
            Pin feedback
          </Button>
          {revision.content.kind === "artifact" && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => {
                if (revision.content.kind === "artifact") openArtifact(revision.content.reference);
              }}
            >
              Open artifact
            </Button>
          )}
          <IconButton tooltip="Copy link" onClick={() => copy(canvasLink(exact))}>
            <LinkIcon />
          </IconButton>
          <IconButton tooltip="Close review" onClick={close}>
            <CloseIcon />
          </IconButton>
        </div>
        {placing && !point && (
          <p role="status" className="text-xs text-muted-foreground">
            Choose a point on this revision.
          </p>
        )}
        {point && (
          <form
            className="w-full max-w-sm space-y-2 rounded-lg border border-border bg-popover p-3 shadow-lg"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Textarea
              aria-label="Pinned feedback"
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              autoFocus
            />
            <Button type="submit" disabled={!text.trim() || store.saving}>
              Save pin
            </Button>
            {store.pinError && (
              <p role="alert" className="text-sm text-destructive">
                {store.pinError}
              </p>
            )}
          </form>
        )}
        {selectedPin && (
          <div className="w-full max-w-sm space-y-2 rounded-lg border border-border bg-popover p-3 shadow-lg">
            <p className="max-h-36 overflow-y-auto text-sm whitespace-pre-wrap">
              {selectedPin.text}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                setHandoffFailed(
                  !(await handoff(
                    revision.publisher,
                    `Feedback on ${canvasLink(exact)} (pin ${revision.pins.indexOf(selectedPin) + 1}):\n\n${selectedPin.text}`,
                  )),
                );
              }}
            >
              Draft reply to publisher
            </Button>
            {handoffFailed && (
              <p role="alert" className="text-sm text-destructive">
                Could not open the publishing conversation.
              </p>
            )}
          </div>
        )}
      </div>
    </DialogBackdrop>
  );
});
