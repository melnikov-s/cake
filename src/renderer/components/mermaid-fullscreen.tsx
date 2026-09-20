import { FullscreenSurface } from "@/components/fullscreen-surface";

/** Keeps a rendered Mermaid diagram fullscreen independently of Streamdown's block lifecycle. */
export function MermaidFullscreen({ onClose, svg }: { onClose(): void; svg: string }) {
  return (
    <FullscreenSurface eyebrow="Diagram" mode="canvas" title="Mermaid" onClose={onClose}>
      <div
        className="flex size-full items-center justify-center overflow-auto p-6 [&_svg]:max-h-full [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </FullscreenSurface>
  );
}
