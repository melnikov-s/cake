import type { CaptureMode } from "../../../contracts/desktop/screen-capture-data";
import type { CaptureAnnotationColor } from "../../../utils/capture-annotation-colors";
import { AnnotationColorPicker } from "./annotation-color-picker";
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
  color,
  onColor,
  busy,
  canUndo,
  copied,
  onCopy,
  onMode,
  onUndo,
  onCapture,
  onCancel,
}: {
  mode: CaptureMode;
  color: CaptureAnnotationColor;
  onColor(color: CaptureAnnotationColor): void;
  busy: boolean;
  canUndo: boolean;
  copied: boolean;
  onCopy(): void;
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
      <AnnotationColorPicker value={color} onChange={onColor} disabled={busy} />
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
