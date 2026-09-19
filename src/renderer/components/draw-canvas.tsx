import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { memo, useCallback, useEffect, useRef } from "react";
import type { DrawStore } from "../stores/DrawStore";
import { createDrawEditorAdapter, type DrawEditorAdapter } from "../draw/DrawEditorAdapter";

/** A locally bundled Excalidraw canvas whose document persistence is owned by DrawStore. */
export const DrawCanvas = memo(function DrawCanvas({ store }: { store: DrawStore }) {
  const adapterRef = useRef<DrawEditorAdapter>(null);
  const mounted = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      const adapter = createDrawEditorAdapter(api);
      if (store.documentSnapshot) adapter.loadDocument(store.documentSnapshot);
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
  return (
    <div className="h-full min-h-0 w-full bg-background" data-slot="draw-canvas">
      <Excalidraw
        excalidrawAPI={mounted}
        theme={theme}
        autoFocus
        UIOptions={{
          canvasActions: { loadScene: false, saveToActiveFile: false },
        }}
      />
    </div>
  );
});
