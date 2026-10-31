import type { ReactNode } from "react";
import type { CaptureMode } from "../../../contracts/desktop/screen-capture-data";
import { FloatingToolbar } from "./floating-toolbar";
import { IconButton } from "./icon-button";
import {
  CaptureArrowIcon,
  CaptureDisplayIcon,
  CloseIcon,
  CopyIcon,
  CheckIcon,
  EditIcon,
  CropIcon,
  UndoIcon,
} from "./icons";

/** Compact movable capture controls, outside the exported canvas. */
export function CaptureToolbar({
  mode,
  busy,
  canUndo,
  copied,
  onCopy,
  destinationPicker,
  onMode,
  onUndo,
  onCapture,
  onCancel,
}: {
  mode: CaptureMode;
  busy: boolean;
  canUndo: boolean;
  copied: boolean;
  onCopy(): void;
  destinationPicker: ReactNode;
  onMode(mode: CaptureMode): void;
  onUndo(): void;
  onCapture(): void;
  onCancel(): void;
}) {
  return (
    <FloatingToolbar
      role="toolbar"
      aria-label="Screen capture tools"
      aria-busy={busy}
      // The native overlay covers the full display, including the MacBook notch/menu bar.
      // Lower only the initial strip by 40 CSS pixels; dragged geometry stays with the primitive.
      className="top-14"
    >
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
      <IconButton
        tooltip="Freehand"
        ariaLabel="Freehand"
        aria-pressed={mode === "freehand"}
        disabled={busy}
        onClick={() => onMode("freehand")}
      >
        <EditIcon />
      </IconButton>
      <IconButton tooltip="Undo drawing" disabled={busy || !canUndo} onClick={onUndo}>
        <UndoIcon />
      </IconButton>
      <IconButton
        tooltip={copied ? "Copied image and text" : "Copy image and text"}
        ariaLabel="Copy image and text"
        disabled={busy}
        onClick={onCopy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
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
