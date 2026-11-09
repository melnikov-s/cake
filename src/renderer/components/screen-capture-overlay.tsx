import { useCallback, useEffect, useLayoutEffect } from "react";
import { StoreProvider, observer } from "r-state-tree/react";
import type { ScreenCaptureOverlayStore } from "../stores/ScreenCaptureOverlayStore";
import { CaptureCanvas } from "./ui/capture-canvas";
import { CaptureBounds } from "./ui/capture-bounds";
import { CaptureDestinationPicker } from "./capture-destination-picker";
import { CaptureToolbar } from "./ui/capture-toolbar";
import { AnnotationDraftPopover } from "./annotation-draft-popover";
import { AnnotationItemPopover } from "./annotation-item-popover";
import { Callout } from "./ui/callout";
import { applyDocumentTheme } from "../lib/resolved-color-theme";

export const ScreenCaptureOverlay = observer(function ScreenCaptureOverlay({
  store,
}: {
  store: ScreenCaptureOverlayStore;
}) {
  const closeLabel = useCallback(() => store.commitLabel(), [store]);
  const cancelLabel = useCallback(() => store.cancelLabel(), [store]);
  const deleteLabel = useCallback(() => store.deleteLabel(), [store]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        store.escape();
      } else if (
        event.key === "Enter" &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')
        ) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLSelectElement) &&
        (!(event.target instanceof HTMLButtonElement) || event.target.hasAttribute("aria-pressed"))
      ) {
        event.preventDefault();
        store.beginCapturePreview();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !store.capturePreview) return;
      event.preventDefault();
      void store.releaseCapturePreview();
    };
    const blur = () => store.cancelCapturePreview();
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    };
  }, [store]);
  const snapshot = store.snapshot;
  const labelPoint = store.labelPoint;
  const theme = snapshot?.routing.appearance.theme;
  const importedTheme = snapshot?.routing.appearance.importedTheme;
  useLayoutEffect(() => {
    if (!theme) return;
    applyDocumentTheme(theme, importedTheme);
    return () => applyDocumentTheme("system");
  }, [theme, importedTheme]);
  const labelAnchor =
    snapshot && labelPoint
      ? {
          left: (labelPoint.x / snapshot.width) * window.innerWidth,
          right: (labelPoint.x / snapshot.width) * window.innerWidth,
          top: (labelPoint.y / snapshot.height) * window.innerHeight,
          bottom: (labelPoint.y / snapshot.height) * window.innerHeight,
        }
      : undefined;
  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-background text-foreground"
      aria-label="Screen capture"
    >
      {snapshot && (
        <CaptureCanvas
          image={snapshot.image}
          drawings={store.visibleDrawings}
          selection={store.capturePreview ? undefined : store.selection}
          mode={store.mode}
          disabled={store.busy || store.cancelled || Boolean(store.capturePreview)}
          onEdit={(index) => store.editLabel(index)}
          onBegin={(point) => store.begin(point)}
          onMove={(point) => store.move(point)}
          onEnd={(point) => store.end(point)}
          onAbandon={() => store.abandonDrag()}
          color={store.annotationColor}
          onError={(error) => {
            store.error = error instanceof Error ? error.message : String(error);
          }}
        />
      )}
      {snapshot && store.capturePreview && (
        <CaptureBounds
          rect={store.capturePreview}
          width={snapshot.width}
          height={snapshot.height}
          topInset={snapshot.automaticTopInset ?? 0}
          onChange={(rect) => store.updateCapturePreview(rect)}
        />
      )}
      {labelAnchor && (
        <StoreProvider store={store.dictationStore}>
          {store.editingNew ? (
            <AnnotationDraftPopover
              key={store.editingIndex}
              anchor={labelAnchor}
              draft={{
                value: store.label,
                onChange: (value) => {
                  store.label = value;
                },
              }}
              onSave={closeLabel}
              onClose={closeLabel}
              onCancel={cancelLabel}
            />
          ) : (
            <AnnotationItemPopover
              key={store.editingIndex}
              anchor={labelAnchor}
              annotation={{
                comment: store.label,
                selectedText: `Annotation ${store.editingIndex! + 1}`,
              }}
              onSave={(comment) => {
                store.label = comment;
                store.commitLabel();
              }}
              onClose={cancelLabel}
              onRemove={deleteLabel}
            />
          )}
        </StoreProvider>
      )}
      {!store.capturePreview && (
        <CaptureToolbar
          destination={
            store.destinationPicker && (
              <StoreProvider store={store.destinationPicker}>
                <CaptureDestinationPicker disabled={store.busy || store.cancelled} />
              </StoreProvider>
            )
          }
          canAttach={Boolean(store.destinationPicker?.destination)}
          mode={store.mode}
          color={store.annotationColor}
          onColor={(color) => store.selectColor(color)}
          busy={store.busy || !snapshot}
          canUndo={store.drawings.length > 0}
          copied={store.copied}
          onCopy={() => void store.capture(undefined, true)}
          onMode={(mode) => store.setMode(mode)}
          onUndo={() => store.undo()}
          onCapture={() => void store.capture()}
          onCancel={() => void store.cancel()}
        />
      )}
      {store.error && (
        <div className="absolute bottom-4 left-1/2 z-20 max-w-[calc(100vw-32px)] -translate-x-1/2">
          <Callout variant="error">{store.error}</Callout>
        </div>
      )}
    </div>
  );
});
