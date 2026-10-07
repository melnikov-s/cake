import { Button } from "./button";
import { SegmentedControlButton, SegmentedControlGroup } from "./segmented-control";

/** Floating capture instructions and mode controls, outside the exported canvas. */
export function CaptureToolbar({
  mode,
  busy,
  canUndo,
  onMode,
  onUndo,
  onCapture,
  onCancel,
}: {
  mode: "crop" | "annotate";
  busy: boolean;
  canUndo: boolean;
  onMode(mode: "crop" | "annotate"): void;
  onUndo(): void;
  onCapture(): void;
  onCancel(): void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Screen capture tools"
      className="flex max-w-full flex-wrap items-center justify-center gap-3 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
    >
      <SegmentedControlGroup aria-label="Capture mode">
        <SegmentedControlButton
          active={mode === "crop"}
          disabled={busy}
          onClick={() => onMode("crop")}
        >
          Crop
        </SegmentedControlButton>
        <SegmentedControlButton
          active={mode === "annotate"}
          disabled={busy}
          onClick={() => onMode("annotate")}
        >
          Annotate
        </SegmentedControlButton>
      </SegmentedControlGroup>
      <span className="text-xs">
        {busy
          ? "Attaching screenshot…"
          : mode === "crop"
            ? "Drag a rectangle to attach"
            : "Drag arrows, then type labels"}
        <span className="ml-2 text-muted-foreground">Enter: full display · Escape: cancel</span>
      </span>
      <Button variant="ghost" size="sm" disabled={busy || !canUndo} onClick={onUndo}>
        Undo arrow
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={onCapture}>
        Attach full display
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
