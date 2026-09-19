import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { memo, useCallback, useState } from "react";
import { Tldraw, createTLStore, inlineBase64AssetStore, type Editor } from "tldraw";
import type { DrawStore } from "../stores/DrawStore";
import { createDrawEditorAdapter } from "../draw/DrawEditorAdapter";

const assetUrls = getAssetUrlsByImport();
const acceptedImageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY;

/** A locally bundled tldraw canvas whose document persistence is owned by DrawStore. */
export const DrawCanvas = memo(function DrawCanvas({ store }: { store: DrawStore }) {
  const [tlStore] = useState(() => createTLStore({ assets: inlineBase64AssetStore }));

  const mounted = useCallback(
    (editor: Editor) => {
      const theme = document.documentElement.dataset.theme;
      if (theme === "light" || theme === "dark")
        editor.user.updateUserPreferences({ colorScheme: theme });
      const nextAdapter = createDrawEditorAdapter(editor);
      if (store.documentSnapshot) nextAdapter.loadDocument(store.documentSnapshot);
      store.attachEditor(nextAdapter);
      return () => store.detachEditor(nextAdapter);
    },
    [store],
  );

  return (
    <div className="h-full min-h-0 w-full bg-background" data-slot="draw-canvas">
      <Tldraw
        store={tlStore}
        assetUrls={assetUrls}
        licenseKey={licenseKey}
        acceptedImageMimeTypes={acceptedImageMimeTypes}
        acceptedVideoMimeTypes={[]}
        maxAssetSize={8 * 1024 * 1024}
        maxImageDimension={4_096}
        onMount={mounted}
      />
    </div>
  );
});
