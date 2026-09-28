import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { observer } from "r-state-tree/react";
import type { SourceLocation } from "../../ipc/source-location";
import type { DrawStore } from "../stores/DrawStore";
import type { DrawCanvas } from "./draw-canvas";
import { DrawCanvasErrorBoundary } from "./draw-canvas-error-boundary";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";

const EDITOR_LOAD_TIMEOUT_MS = 20_000;

/** Loads the Excalidraw bundle with a deadline so a stalled module request surfaces as an error. */
function lazyDrawCanvas() {
  return lazy(
    () =>
      new Promise<{ default: typeof DrawCanvas }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("The Cake Draw editor took too long to load.")),
          EDITOR_LOAD_TIMEOUT_MS,
        );
        import("./draw-canvas")
          .then((module) => resolve({ default: module.DrawCanvas }), reject)
          .finally(() => clearTimeout(timer));
      }),
  );
}

/**
 * The whiteboard area of Cake Draw. Every loading and failure state stays inside this region so
 * the project sidebar, chat, and navigation remain usable when the editor cannot open.
 */
export const DrawCanvasRegion = observer(function DrawCanvasRegion({
  store,
  onOpenSourceLocation,
}: {
  store: DrawStore;
  onOpenSourceLocation?(location: SourceLocation): void | Promise<void>;
}) {
  const [attempt, setAttempt] = useState(0);
  // A new lazy component per attempt lets Retry re-request a module load that failed or timed out.
  const Canvas = useMemo(() => lazyDrawCanvas(), [attempt]);

  useEffect(() => {
    void store.initialize();
  }, [store]);

  if (store.error && !store.documentLoaded && !store.loading)
    return (
      <div className="grid h-full place-items-center p-6">
        <Callout variant="error" className="max-w-md" role="alert">
          <strong className="text-sm">Cake Draw could not open this board</strong>
          <span className="text-muted-foreground">{store.error}</span>
          <div>
            <Button size="sm" variant="outline" onClick={() => void store.retry()}>
              Retry
            </Button>
          </div>
        </Callout>
      </div>
    );

  if (!store.activeBoardId || !store.documentLoaded || store.loading)
    return (
      <div className="grid h-full place-items-center">
        <LoadingState label="Loading board" />
      </div>
    );

  return (
    <DrawCanvasErrorBoundary key={attempt} onRetry={() => setAttempt((value) => value + 1)}>
      <Suspense
        fallback={
          <div className="grid h-full place-items-center">
            <LoadingState label="Loading Cake Draw editor" />
          </div>
        }
      >
        <Canvas
          key={store.activeBoardId}
          store={store}
          onOpenSourceLocation={onOpenSourceLocation}
        />
      </Suspense>
    </DrawCanvasErrorBoundary>
  );
});
