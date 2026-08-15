import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

function CloseIcon() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export function AssistantMessageFullscreen({ children, onClose }: { children: ReactNode; onClose(): void }) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="assistant-message-fullscreen" role="dialog" aria-modal="true" aria-labelledby="assistant-message-fullscreen-title" onMouseDown={onClose}>
      <header onMouseDown={(event) => event.stopPropagation()}>
        <div>
          <span>Full response</span>
          <h2 id="assistant-message-fullscreen-title">Cake</h2>
        </div>
        <button ref={closeButton} type="button" aria-label="Exit fullscreen response" title="Exit fullscreen" onClick={onClose}><CloseIcon /></button>
      </header>
      <main>
        <article className="assistant-message-fullscreen-content" onMouseDown={(event) => event.stopPropagation()}>{children}</article>
      </main>
    </div>,
    document.body
  );
}
