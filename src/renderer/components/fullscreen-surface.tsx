import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { FullscreenSurfaceStore } from "../stores/FullscreenSurfaceStore";

export function FullscreenSurface({
  children,
  eyebrow,
  mode = "reader",
  onClose,
  title,
}: {
  children: ReactNode;
  eyebrow: string;
  mode?: "reader" | "canvas" | "dialog";
  onClose(): void;
  title: string;
}) {
  const fullscreenSurfaces = useStore(FullscreenSurfaceStore);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const surfaceId = useRef(crypto.randomUUID()).current;
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(
    () => fullscreenSurfaces.open(surfaceId, () => onCloseRef.current()),
    [fullscreenSurfaces, surfaceId],
  );

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!surfaceRef.current?.contains(document.activeElement)) closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Fullscreen surfaces sit directly below the shared overlay band, so
      // nested layers (diagram/table fullscreen, image preview, dialogs) stack
      // above and handle Escape themselves. Only dismiss when this surface owns
      // the viewport center, i.e. nothing is stacked above. Environments without
      // layout (unit tests) are treated as topmost.
      const topmost = document.elementFromPoint?.(window.innerWidth / 2, window.innerHeight / 2);
      if (topmost && surfaceRef.current && !surfaceRef.current.contains(topmost)) return;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return createPortal(
    // z-45 keeps the surface above all workbench content while staying below
    // the shared z-50 overlay band, so overlays opened from within this surface
    // (e.g. a Mermaid diagram's own fullscreen view) stack on top of it.
    <div
      ref={surfaceRef}
      className="fixed inset-0 z-45 flex flex-col bg-background text-foreground animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onClose}
    >
      <header
        className="flex items-center justify-between border-b border-border bg-card px-5 py-3"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div>
          <span className="block text-xs font-medium text-muted-foreground">{eyebrow}</span>
          <h2 id={titleId} className="text-sm font-semibold text-foreground">
            {title}
          </h2>
        </div>
        <IconButton
          ref={closeButton}
          tooltip="Exit fullscreen"
          ariaLabel={`Exit fullscreen ${title}`}
          onClick={onClose}
        >
          <CloseIcon />
        </IconButton>
      </header>
      <main
        className={cn(
          "flex flex-1 justify-center overflow-auto p-6",
          mode === "canvas" && "p-0",
          mode === "dialog" && "items-center",
        )}
      >
        <article
          className={cn(
            "w-full max-w-4xl",
            mode === "canvas" && "h-full max-w-none",
            mode === "dialog" && "max-w-[34rem]",
          )}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {children}
        </article>
      </main>
    </div>,
    document.body,
  );
}
