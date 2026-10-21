import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { ImagePreview } from "@/components/image-preview";

type MarkdownImageProps = Omit<ComponentProps<"img">, "src"> & {
  src?: string;
  artifactReference?: string;
  resourcePath?: string;
  caption?: string;
  loadImage?(
    path: string,
    signal: AbortSignal,
  ): Promise<{ readonly data: string; readonly mimeType: string }>;
  renderArtifactReference?(reference: string, label?: ReactNode): ReactNode;
};

export function MarkdownImage({
  alt = "Image",
  artifactReference,
  loadImage,
  renderArtifactReference,
  src,
  resourcePath,
  caption,
}: MarkdownImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setResolvedSrc(undefined);
    setError(undefined);
    if (!resourcePath) return;
    if (!loadImage) {
      setError("No image source is available");
      return;
    }
    const controller = new AbortController();
    void loadImage(resourcePath, controller.signal).then(
      ({ data, mimeType }) => {
        if (!controller.signal.aborted) setResolvedSrc(`data:${mimeType};base64,${data}`);
      },
      (cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => controller.abort();
  }, [loadImage, resourcePath]);

  if (artifactReference && renderArtifactReference)
    return renderArtifactReference(artifactReference, alt);
  if (error)
    return (
      <span
        title={error}
        className="inline-flex rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      >
        Image not available: {alt}
      </span>
    );
  const displaySrc = resourcePath ? resolvedSrc : src;
  if (!displaySrc)
    return (
      <span className="inline-flex rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Loading image…
      </span>
    );
  return <ImagePreview src={displaySrc} alt={alt} caption={caption} />;
}
