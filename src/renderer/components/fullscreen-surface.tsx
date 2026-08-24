import { useEffect, useId, useRef, type ReactNode } from "react";
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
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
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
  }, []);

  return createPortal(
    <div
      className={`fullscreen-surface fullscreen-surface-${mode}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={onClose}
    >
      <header onMouseDown={(event) => event.stopPropagation()}>
        <div>
          <span>{eyebrow}</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <IconButton
          ref={closeButton}
          className="fullscreen-surface-close"
          tooltip="Exit fullscreen"
          ariaLabel={`Exit fullscreen ${title}`}
          onClick={onClose}
        >
          <CloseIcon />
        </IconButton>
      </header>
      <main>
        <article
          className="fullscreen-surface-content"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {children}
        </article>
      </main>
    </div>,
    document.body,
  );
}
