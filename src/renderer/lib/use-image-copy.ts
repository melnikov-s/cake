import { useState } from "react";
import { useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { imageClipboardData } from "./image-clipboard";

/** Clipboard feedback is local to the preview, never persisted with the attachment. */
export function useImageCopy(src: string) {
  const root = useStore(RootStore);
  const [error, setError] = useState<string>();
  const copy = async () => {
    setError(undefined);
    try {
      await root.copyImage(await imageClipboardData(src));
    } catch (cause) {
      setError(`Could not copy image: ${cause instanceof Error ? cause.message : String(cause)}`);
      throw cause;
    }
  };
  return { copy, error };
}
