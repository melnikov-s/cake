import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { SourceLocation } from "../../ipc/source-location";
import { isCakeDrawSourceUrl, parseDrawSourceLink } from "../../domain/draw/draw-source-link";
import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import { observer } from "r-state-tree/react";
import type { DrawStore } from "../stores/DrawStore";
import {
  createDrawEditorAdapter,
  restoreDrawDocument,
  type DrawEditorAdapter,
} from "../draw/DrawEditorAdapter";
import { useResolvedColorTheme } from "../lib/resolved-color-theme";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

/** A locally bundled Excalidraw canvas whose document persistence is owned by DrawStore. */
export const DrawCanvas = observer(function DrawCanvas({
  store,
  onOpenSourceLocation,
}: {
  store: DrawStore;
  onOpenSourceLocation?(location: SourceLocation): void | Promise<void>;
}) {
  const adapterRef = useRef<DrawEditorAdapter>(null);
  const mounted = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      const adapter = createDrawEditorAdapter(api);
      adapterRef.current = adapter;
      store.attachEditor(adapter);
    },
    [store],
  );

  useEffect(
    () => () => {
      const adapter = adapterRef.current;
      if (adapter) store.detachEditor(adapter);
      adapterRef.current = null;
    },
    [store],
  );

  const openLink = useCallback(
    (
      element: { link: string | null },
      event: CustomEvent<{ nativeEvent: MouseEvent | PointerEvent<HTMLCanvasElement> }>,
    ) => {
      if (!element.link || !isCakeDrawSourceUrl(element.link)) return;
      event.preventDefault();
      const location = parseDrawSourceLink(element.link);
      if (location) void onOpenSourceLocation?.(location);
    },
    [onOpenSourceLocation],
  );

  const theme = useResolvedColorTheme();
  // Excalidraw restores initialData after publishing its imperative API. Loading through
  // the API callback races that initialization and can be reset to an empty scene.
  const initialData = store.documentSnapshot ? restoreDrawDocument(store.documentSnapshot) : null;
  return (
    <div className="relative h-full min-h-0 w-full bg-background" data-slot="draw-canvas">
      <div className={cn("h-full", store.agentDrawing && "pointer-events-none")}>
        {/* MainMenu is intentionally not mounted: Cake owns the three-format export surface in its toolbar. */}
        <Excalidraw
          excalidrawAPI={mounted}
          initialData={initialData}
          theme={theme}
          autoFocus
          viewModeEnabled={store.agentDrawing}
          onLinkOpen={openLink}
          UIOptions={{
            canvasActions: { loadScene: false, saveToActiveFile: false },
          }}
        />
      </div>
      {store.agentDrawing ? (
        <div className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2">
          <Badge variant="secondary">Agent drawing…</Badge>
        </div>
      ) : null}
    </div>
  );
});
