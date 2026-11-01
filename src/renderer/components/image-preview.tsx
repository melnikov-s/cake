import { useState } from "react";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import { Button } from "@/components/ui/button";
import { AttachmentTile } from "@/components/ui/attachment-tile";
import { cn } from "@/lib/utils";
import { useImageCopy } from "@/lib/use-image-copy";
import { ContextMenu } from "@/components/ui/context-menu";
import { CopyButton } from "@/components/ui/copy-button";
import { Callout } from "@/components/ui/callout";

/** Renders an image that opens in Cake's shared fullscreen surface. */
export function ImagePreview({
  src,
  alt,
  caption,
  className,
  imageClassName,
  presentation = "image",
  onRemove,
}: {
  src: string;
  alt: string;
  caption?: string;
  className?: string;
  imageClassName?: string;
  presentation?: "image" | "attachment";
  onRemove?(): void;
}) {
  const [open, setOpen] = useState(false);
  const { copy, error } = useImageCopy(src);
  const items = [{ label: "Copy image", onSelect: () => void copy().catch(() => undefined) }];

  return (
    <>
      <ContextMenu
        label="Image actions"
        items={items}
        className={cn("inline-block max-w-full", className)}
      >
        {presentation === "attachment" ? (
          <AttachmentTile
            name={alt}
            imageSrc={src}
            ariaLabel={`View ${alt} enlarged`}
            onClick={() => setOpen(true)}
            onRemove={onRemove}
          />
        ) : (
          <Button
            variant="ghost"
            className={cn(
              "inline-block h-auto max-w-full cursor-zoom-in overflow-hidden rounded-lg p-0 leading-none hover:bg-transparent",
              className,
            )}
            aria-label={`View ${alt} enlarged`}
            title="View enlarged"
            onClick={() => setOpen(true)}
          >
            <img src={src} alt={alt} className={imageClassName} />
          </Button>
        )}
      </ContextMenu>
      {error && !open && <Callout variant="error">{error}</Callout>}
      {open ? (
        <FullscreenSurface
          eyebrow="Image preview"
          mode="canvas"
          title={alt}
          toolbar={<CopyButton label="image" copy={copy} />}
          onClose={() => setOpen(false)}
        >
          <figure className="m-0 flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/35 p-8">
            <ContextMenu label="Image actions" items={items} className="contents">
              <img
                src={src}
                alt={alt}
                draggable={false}
                className="max-h-[calc(100vh-112px)] max-w-full rounded-lg border border-border/65 bg-card object-contain shadow-xl"
              />
            </ContextMenu>
            {error && <Callout variant="error">{error}</Callout>}
            {caption ? (
              <figcaption className="max-w-[600px] text-center text-xs text-muted-foreground">
                {caption}
              </figcaption>
            ) : null}
          </figure>
        </FullscreenSurface>
      ) : null}
    </>
  );
}
