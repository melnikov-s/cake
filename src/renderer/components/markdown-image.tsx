import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { ImagePreview } from "@/components/image-preview";

type MarkdownImageProps = Omit<ComponentProps<"img">, "src"> & {
  src?: string;
  artifactReference?: string;
  workspacePath?: string;
  loadWorkspaceImage?(
    path: string,
    signal: AbortSignal,
  ): Promise<{ readonly data: string; readonly mimeType: string }>;
  renderArtifactReference?(reference: string): ReactNode;
};

export function MarkdownImage({
  alt = "Image",
  artifactReference,
  loadWorkspaceImage,
  renderArtifactReference,
  src,
  workspacePath,
}: MarkdownImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!workspacePath || !loadWorkspaceImage) return;
    const controller = new AbortController();
    void loadWorkspaceImage(workspacePath, controller.signal).then(
      ({ data, mimeType }) => {
        if (!controller.signal.aborted) setResolvedSrc(`data:${mimeType};base64,${data}`);
      },
      () => {
        if (!controller.signal.aborted) setUnavailable(true);
      },
    );
    return () => controller.abort();
  }, [loadWorkspaceImage, workspacePath]);

  if (artifactReference && renderArtifactReference)
    return renderArtifactReference(artifactReference);
  if (unavailable)
    return (
      <span className="inline-flex rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Image not available: {alt}
      </span>
    );
  const displaySrc = workspacePath ? resolvedSrc : src;
  if (!displaySrc)
    return (
      <span className="inline-flex rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Loading image…
      </span>
    );
  return <ImagePreview src={displaySrc} alt={alt} caption={workspacePath} />;
}
