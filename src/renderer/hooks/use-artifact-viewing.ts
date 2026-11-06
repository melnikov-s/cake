import { useCallback, useEffect, useId, useRef } from "react";
import { useOptionalStore } from "r-state-tree/react";
import type { ArtifactViewReference } from "../../contracts/artifacts/artifact-viewing";
import { RootStore } from "../stores/RootStore";

/** Observe actual viewport presence, not every historical artifact mounted in a transcript. */
export function useArtifactViewing(entry: ArtifactViewReference) {
  const root = useOptionalStore(RootStore);
  const store = root?.artifactViewingStore;
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const { lineageId, revision, surface } = entry;
  useEffect(() => {
    if (!store || !ref.current) return;
    const value = { lineageId, revision, surface };
    if (!window.IntersectionObserver) {
      store.show(id, value);
      return () => store.hide(id);
    }
    const observer = new IntersectionObserver(([observation]) => {
      if (observation?.isIntersecting) store.show(id, value);
      else store.hide(id);
    });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      store.hide(id);
    };
  }, [id, store, lineageId, revision, surface]);
  const activate = useCallback(() => store?.activate(id), [store, id]);
  return { ref, onPointerDownCapture: activate, onFocusCapture: activate };
}
