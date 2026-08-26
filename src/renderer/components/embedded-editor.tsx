import { useEffect, useRef } from "react";
import { observer } from "r-state-tree/react";
import type { EmbeddedEditorStore } from "../stores/EmbeddedEditorStore";
import { Button } from "./ui/button";
import { LoadingState } from "./ui/loading-state";

// Observer-wrapped: reads EmbeddedEditorStore status fields directly, so status
// transitions must re-render this card even if no parent render rescues it.
const StatusCard = observer(function StatusCard({ store }: { store: EmbeddedEditorStore }) {
  const managedDownloadAvailable = /Linux/.test(navigator.userAgent);
  return (
    <div className="embedded-editor-card" role="status">
      <strong>Full VS Code editing</strong>
      <p>
        Run a real VS Code server for this project inside Cake, with full language services, your
        extension workspace, and the command palette. On Mac, Cake needs code-server installed
        locally (Homebrew works well).
      </p>
      {store.statusMessage ? <p className="embedded-editor-status">{store.statusMessage}</p> : null}
      {store.error ? (
        <p className="embedded-editor-status" role="alert">
          {store.error}
        </p>
      ) : null}
      <div className="embedded-editor-actions">
        {store.status === "downloading" || store.status === "starting" ? null : (
          <Button size="sm" onClick={() => void store.askCakeToSetUp()}>
            Ask Cake to set this up
          </Button>
        )}
        {managedDownloadAvailable &&
        store.status !== "downloading" &&
        store.status !== "starting" ? (
          <Button variant="outline" size="sm" onClick={() => void store.install()}>
            Download openvscode-server
          </Button>
        ) : null}
      </div>
    </div>
  );
});

/**
 * Host surface for the embedded VS Code editor. Renders placeholder states while
 * the native WebContentsView is unavailable and reports its own rect so the main
 * process can position the view exactly over this container.
 */
export const EmbeddedEditorPane = observer(function EmbeddedEditorPane({
  store,
}: {
  store: EmbeddedEditorStore;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void store.refresh();
  }, [store]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const report = () => {
      const bounds = element.getBoundingClientRect();
      void store.reportBounds({
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      void store.reportBounds(null);
    };
  }, [store]);

  const showPlaceholder = store.status !== "ready" || Boolean(store.error);

  return (
    <div ref={containerRef} className="embedded-editor-pane h-full">
      {showPlaceholder ? (
        store.status === "missing" && !store.error ? (
          <StatusCard store={store} />
        ) : store.status === "downloading" ? (
          <div className="change-explorer-file-state">
            <LoadingState label="Installing VS Code" />
            <span>{store.statusMessage}</span>
          </div>
        ) : store.status === "starting" && !store.error ? (
          <div className="change-explorer-file-state">
            <LoadingState label="Starting VS Code" />
          </div>
        ) : (
          <StatusCard store={store} />
        )
      ) : null}
    </div>
  );
});
