import { useState } from "react";
import type { CakeArtifactV1 } from "../../contracts/artifacts/artifact-contract";
import { INITIAL_WIDGET_PREVIEW_LABEL } from "../../contracts/widgets/widget-view-evidence";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { ImagePreview } from "./image-preview";

/** Immutable publication evidence, intentionally separate from the live sandbox above it. */
export function WidgetInitialPreview({
  artifact,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "widget" }>;
}) {
  const [open, setOpen] = useState(false);
  if (!artifact.payload.preview) return null;
  return (
    <section
      aria-label="Retained initial-state preview"
      className="mt-2 border-t border-border/60 pt-2"
    >
      <DisclosureTrigger
        title={INITIAL_WIDGET_PREVIEW_LABEL}
        subtitle={`Retained · r${artifact.revision}`}
        open={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <figure className="mt-2">
          <ImagePreview
            src={`data:image/png;base64,${artifact.payload.preview.data}`}
            alt={INITIAL_WIDGET_PREVIEW_LABEL}
            caption={`cake://artifact/${artifact.id}@r${artifact.revision} · retained-initial-state`}
            imageClassName="max-h-96 max-w-full object-contain"
          />
          <figcaption className="mt-1 text-xs text-muted-foreground">
            cake://artifact/{artifact.id}@r{artifact.revision} · retained-initial-state. Does not
            track interactive selections.
          </figcaption>
        </figure>
      )}
    </section>
  );
}
