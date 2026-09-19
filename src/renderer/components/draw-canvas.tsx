import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef } from "react";
import { observer } from "r-state-tree/react";
import type { DrawStore } from "../stores/DrawStore";
import {
  createDrawEditorAdapter,
  restoreDrawDocument,
  type DrawEditorAdapter,
} from "../draw/DrawEditorAdapter";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

/** A locally bundled Excalidraw canvas whose document persistence is owned by DrawStore. */
export const DrawCanvas = observer(function DrawCanvas({ store }: { store: DrawStore }) {
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

  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
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
