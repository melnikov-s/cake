import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

/**
 * Renders an image inside a button that opens the same image enlarged in a
 * fullscreen overlay. The overlay closes via Escape, the close control, or a
 * click on the backdrop — clicking the image itself never closes it.
 */
export function ImagePreview({
  src,
  alt,
  caption,
}: {
  src: string;
  alt: string;
  caption?: string;
}) {
  const [open, setOpen] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(() => setOpen(false));
  closeRef.current = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="image-preview-trigger"
        aria-label={`View ${alt} enlarged`}
        title="View enlarged"
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} />
      </button>
      {open &&
        createPortal(
          <div
            className="image-preview-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <button
              ref={closeButton}
              type="button"
              className="image-preview-close"
              aria-label={`Close ${alt}`}
              onClick={() => setOpen(false)}
            >
              <CloseIcon />
            </button>
            <figure className="image-preview-figure">
              <img src={src} alt={alt} draggable={false} onMouseDown={(e) => e.stopPropagation()} />
              {caption && <figcaption>{caption}</figcaption>}
            </figure>
          </div>,
          document.body,
        )}
    </>
  );
}
