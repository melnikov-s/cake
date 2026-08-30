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

  const portalHost =
    triggerButton.current?.closest<HTMLElement>(".chat-layout") ?? globalThis.document?.body;
  const contained = Boolean(
    portalHost && globalThis.document && portalHost !== globalThis.document.body,
  );

  return (
    <>
      <button
        ref={triggerButton}
        type="button"
        className="inline-block max-w-full cursor-zoom-in overflow-hidden rounded-lg leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`View ${alt} enlarged`}
        title="View enlarged"
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} />
      </button>
      {open &&
        portalHost &&
        createPortal(
          <div
            className={cn(
              "fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm",
              contained && "absolute",
            )}
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <IconButton
              ref={closeButton}
              className="absolute top-4 right-4 border border-white/20 bg-white/10 text-white hover:bg-white/20"
              tooltip="Close image"
              ariaLabel={`Close ${alt}`}
              onClick={() => setOpen(false)}
            >
              <CloseIcon />
            </IconButton>
            <figure className="m-0 flex max-h-full max-w-full flex-col items-center gap-3">
              <img
                src={src}
                alt={alt}
                draggable={false}
                className="max-h-[calc(100vh-120px)] max-w-full rounded-lg object-contain shadow-2xl"
                onMouseDown={(e) => e.stopPropagation()}
              />
              {caption && (
                <figcaption className="max-w-[600px] text-center text-xs text-white/85">
                  {caption}
                </figcaption>
              )}
            </figure>
          </div>,
          portalHost,
        )}
    </>
  );
}
