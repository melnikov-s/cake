import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

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
  const triggerButton = useRef<HTMLButtonElement>(null);
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

  const portalHost = triggerButton.current?.closest<HTMLElement>(".chat-layout") ?? document.body;
  const contained = portalHost !== document.body;

  return (
    <>
      <button
        ref={triggerButton}
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
            className={cn("image-preview-overlay", contained && "image-preview-overlay-contained")}
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <IconButton
              ref={closeButton}
              className="image-preview-close"
              tooltip="Close image"
              ariaLabel={`Close ${alt}`}
              onClick={() => setOpen(false)}
            >
              <CloseIcon />
            </IconButton>
            <figure className="image-preview-figure">
              <img src={src} alt={alt} draggable={false} onMouseDown={(e) => e.stopPropagation()} />
              {caption && <figcaption>{caption}</figcaption>}
            </figure>
          </div>,
          portalHost,
        )}
    </>
  );
}
