import { useEffect, useRef } from "react";
import { observer } from "r-state-tree/react";
import type { EmbeddedEditorStore } from "../stores/EmbeddedEditorStore";
import { Button } from "./ui/button";
import { LoadingState } from "./ui/loading-state";

function StatusCard({ store }: { store: EmbeddedEditorStore }) {
  return (
    <div className="embedded-editor-card" role="status">
      <strong>Full VS Code editing</strong>
      <p>
        Run a real VS Code server for this project inside Cake, with full language services, your
        extension workspace, and the command palette. Cake downloads it once and reuses it across
        projects.
      </p>
      {store.statusMessage ? <p className="embedded-editor-status">{store.statusMessage}</p> : null}
      {store.error ? (
        <p className="embedded-editor-status" role="alert">
          {store.error}
        </p>
      ) : null}
      <div className="embedded-editor-actions">
        {store.status === "downloading" || store.status === "starting" ? null : (
          <Button size="sm" onClick={() => void store.install()}>
            {store.status === "failed" ? "Retry installation" : "Install VS Code editor"}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => store.setMode("builtin")}>
          Use the built-in reader
        </Button>
      </div>
    </div>
  );
}

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
  const vscodeMode = store.mode === "vscode";

  useEffect(() => {
    void store.refresh();
  }, [store]);

  useEffect(() => {
    if (vscodeMode) void store.open();
  }, [vscodeMode, store]);

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
    <div ref={containerRef} className="embedded-editor-pane">
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
