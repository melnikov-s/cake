import { useEffect, type CSSProperties } from "react";
import { observer } from "r-state-tree/react";
import type { ScreenCaptureOverlayStore } from "../stores/ScreenCaptureOverlayStore";
import { CaptureCanvas } from "./ui/capture-canvas";
import { CaptureToolbar } from "./ui/capture-toolbar";
import { CaptureDestinationPicker } from "./ui/capture-destination-picker";
import { Input } from "./ui/input";
import { Callout } from "./ui/callout";

export const ScreenCaptureOverlay = observer(function ScreenCaptureOverlay({
  store,
}: {
  store: ScreenCaptureOverlayStore;
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      if (event.key === "Escape") {
        event.preventDefault();
        void store.cancel();
      } else if (
        event.key === "Enter" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLSelectElement)
      ) {
        event.preventDefault();
        void store.capture();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [store]);
  const snapshot = store.snapshot;
  const labelPoint = store.labelPoint;
  const labelPosition: CSSProperties | undefined =
    snapshot && labelPoint
      ? {
          left: `${Math.min(75, (labelPoint.x / snapshot.width) * 100)}%`,
          top: `${Math.min(85, (labelPoint.y / snapshot.height) * 100)}%`,
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
          arrows={store.visibleArrows}
          selection={store.selection}
          mode={store.mode}
          disabled={store.busy || store.cancelled}
          onBegin={(point) => store.begin(point)}
          onMove={(point) => store.move(point)}
          onEnd={(point) => store.end(point)}
          onAbandon={() => store.abandonDrag()}
          onPalette={(palette) => {
            store.palette = palette;
          }}
          onError={(error) => {
            store.error = error instanceof Error ? error.message : String(error);
          }}
        />
      )}
      {labelPoint && (
        <div className="absolute z-10 ml-3 mt-3 w-60" style={labelPosition}>
          <Input
            autoFocus
            aria-label="Arrow label"
            placeholder="Label this arrow…"
            maxLength={240}
            value={store.label}
            onChange={(event) => {
              store.label = event.target.value;
            }}
            onBlur={() => store.commitLabel()}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                store.commitLabel();
              }
            }}
          />
        </div>
      )}
      <div className="absolute inset-x-4 top-4 z-20 flex flex-col items-center gap-2">
        <CaptureToolbar
          mode={store.mode}
          busy={store.busy || !snapshot}
          canUndo={store.arrows.length > 0}
          destinationPicker={
            snapshot &&
            store.destination && (
              <CaptureDestinationPicker
                routing={snapshot.routing}
                destination={store.destination}
                newSessionProjectPath={store.newSessionProjectPath}
                disabled={store.busy || store.cancelled}
                onChange={(destination) => store.selectDestination(destination)}
              />
            )
          }
          onMode={(mode) => store.setMode(mode)}
          onUndo={() => store.undo()}
          onCapture={() => void store.capture()}
          onCancel={() => void store.cancel()}
        />
        {store.error && <Callout variant="error">{store.error}</Callout>}
      </div>
    </div>
  );
});
