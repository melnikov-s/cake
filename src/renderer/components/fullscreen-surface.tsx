import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon, ExpandIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export function FullscreenButton({
  className,
  disabled,
  label,
  onClick,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <IconButton
      className={cn("fullscreen-trigger", className)}
      tooltip="View fullscreen"
      ariaLabel={label}
      disabled={disabled}
      onClick={onClick}
    >
      <ExpandIcon />
    </IconButton>
  );
}

export function FullscreenSurface({
  children,
  eyebrow,
  mode = "reader",
  onClose,
  title,
}: {
  children: ReactNode;
  eyebrow: string;
  mode?: "reader" | "canvas";
  onClose(): void;
  title: string;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const surfaceId = useRef(crypto.randomUUID()).current;
  const [registered, setRegistered] = useState(() => !window.cake);
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    let active = true;
    const bridge = window.cake;
    const unsubscribe = bridge?.subscribe((event) => {
      if (event.type === "fullscreen-surface-close-requested" && event.surfaceId === surfaceId)
        onCloseRef.current();
    });
    if (bridge)
      void bridge
        .request({
          type: "set-fullscreen-surface-open",
          requestId: crypto.randomUUID(),
          surfaceId,
          open: true,
        })
        .then(() => {
          if (active) setRegistered(true);
        })
        .catch(() => {
          if (active) setRegistered(true);
        });

    return () => {
      active = false;
      unsubscribe?.();
      if (bridge)
        void bridge
          .request({
            type: "set-fullscreen-surface-open",
            requestId: crypto.randomUUID(),
            surfaceId,
            open: false,
          })
          .catch(() => undefined);
    };
  }, [surfaceId]);

  useEffect(() => {
    if (!registered) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [registered]);

  if (!registered) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex flex-col bg-background text-foreground animate-in fade-in duration-150"
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
          <span className="block font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </span>
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
        className={cn("flex flex-1 justify-center overflow-auto p-6", mode === "canvas" && "p-0")}
      >
        <article
          className={cn("w-full max-w-4xl", mode === "canvas" && "h-full max-w-none")}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {children}
        </article>
      </main>
    </div>,
    document.body,
  );
}
