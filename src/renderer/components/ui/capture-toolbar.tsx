import type { ReactNode } from "react";
import { FloatingToolbar } from "./floating-toolbar";
import { IconButton } from "./icon-button";
import { CaptureArrowIcon, CaptureDisplayIcon, CloseIcon, CropIcon, UndoIcon } from "./icons";

/** Compact movable capture controls, outside the exported canvas. */
export function CaptureToolbar({
  mode,
  busy,
  canUndo,
  destinationPicker,
  onMode,
  onUndo,
  onCapture,
  onCancel,
}: {
  mode: "crop" | "annotate";
  busy: boolean;
  canUndo: boolean;
  destinationPicker: ReactNode;
  onMode(mode: "crop" | "annotate"): void;
  onUndo(): void;
  onCapture(): void;
  onCancel(): void;
}) {
  return (
    <FloatingToolbar role="toolbar" aria-label="Screen capture tools" aria-busy={busy}>
      {destinationPicker}
      <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
      <IconButton
        tooltip="Crop · drag to attach"
        ariaLabel="Crop"
        aria-pressed={mode === "crop"}
        disabled={busy}
        onClick={() => onMode("crop")}
      >
        <CropIcon />
      </IconButton>
      <IconButton
        tooltip="Annotate · draw an arrow"
        ariaLabel="Annotate"
        aria-pressed={mode === "annotate"}
        disabled={busy}
        onClick={() => onMode("annotate")}
      >
        <CaptureArrowIcon />
      </IconButton>
      <IconButton tooltip="Undo arrow" disabled={busy || !canUndo} onClick={onUndo}>
        <UndoIcon />
      </IconButton>
      <IconButton
        tooltip={busy ? "Attaching screenshot…" : "Attach full display · Enter"}
        ariaLabel="Attach full display"
        disabled={busy}
        onClick={onCapture}
      >
        <CaptureDisplayIcon />
      </IconButton>
      <IconButton tooltip="Cancel · Escape" ariaLabel="Cancel" onClick={onCancel}>
        <CloseIcon />
      </IconButton>
    </FloatingToolbar>
  );
}
