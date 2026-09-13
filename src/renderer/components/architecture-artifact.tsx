import { useState } from "react";
import { FullscreenSurface } from "@/components/fullscreen-surface";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type { SourceLocation } from "../../ipc/source-location";
import { ArchitectureCanvas } from "./architecture-canvas";

export function ArchitectureArtifact({
  artifact,
  onOpenSourceLocation,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "architecture" }>;
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const title = artifact.title ?? "Architecture diagram";
  const openFullscreenSourceLocation = (location: SourceLocation) => {
    setFullscreen(false);
    onOpenSourceLocation?.(location);
  };
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex justify-end">
        <FullscreenButton label={`View ${title} fullscreen`} onClick={() => setFullscreen(true)} />
      </div>
      <ArchitectureCanvas artifact={artifact} onOpenSourceLocation={onOpenSourceLocation} />
      {fullscreen && (
        <FullscreenSurface
          mode="canvas"
          eyebrow="Architecture diagram"
          title={title}
          onClose={() => setFullscreen(false)}
        >
          <div className="h-full p-4">
            <ArchitectureCanvas
              artifact={artifact}
              onOpenSourceLocation={openFullscreenSourceLocation}
            />
          </div>
        </FullscreenSurface>
      )}
    </section>
  );
}
