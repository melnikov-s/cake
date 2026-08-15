import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function ExpandIcon() {
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" /></svg>;
}

function CloseIcon() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export function FullscreenButton({ className, disabled, label, onClick }: { className?: string; disabled?: boolean; label: string; onClick(): void }) {
  return <Button className={cn("fullscreen-trigger", className)} variant="ghost" disabled={disabled} aria-label={label} title="View fullscreen" onClick={onClick}><ExpandIcon /></Button>;
}

export function FullscreenSurface({ children, eyebrow, mode = "reader", onClose, title }: { children: ReactNode; eyebrow: string; mode?: "reader" | "canvas"; onClose(): void; title: string }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
    <div className={`fullscreen-surface fullscreen-surface-${mode}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={onClose}>
      <header onMouseDown={(event) => event.stopPropagation()}>
        <div>
          <span>{eyebrow}</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button ref={closeButton} className="fullscreen-surface-close" type="button" aria-label={`Exit fullscreen ${title}`} title="Exit fullscreen" onClick={onClose}><CloseIcon /></button>
      </header>
      <main>
        <article className="fullscreen-surface-content" onMouseDown={(event) => event.stopPropagation()}>{children}</article>
      </main>
    </div>,
    document.body
  );
}
