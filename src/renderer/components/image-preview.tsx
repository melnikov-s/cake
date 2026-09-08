import { useState } from "react";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import { Button } from "@/components/ui/button";

/** Renders an image that opens in Cake's shared fullscreen surface. */
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

  return (
    <>
      <Button
        variant="ghost"
        className="inline-block h-auto max-w-full cursor-zoom-in overflow-hidden rounded-lg p-0 leading-none hover:bg-transparent"
        aria-label={`View ${alt} enlarged`}
        title="View enlarged"
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} />
      </Button>
      {open ? (
        <FullscreenSurface
          eyebrow="Image preview"
          mode="canvas"
          title={alt}
          onClose={() => setOpen(false)}
        >
          <figure className="m-0 flex h-full w-full flex-col items-center justify-center gap-3 bg-black/75 p-6">
            <img
              src={src}
              alt={alt}
              draggable={false}
              className="max-h-[calc(100vh-120px)] max-w-full rounded-lg object-contain shadow-2xl"
            />
            {caption ? (
              <figcaption className="max-w-[600px] text-center text-xs text-white/85">
                {caption}
              </figcaption>
            ) : null}
          </figure>
        </FullscreenSurface>
      ) : null}
    </>
  );
}
