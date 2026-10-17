import { observer } from "r-state-tree/react";
import type { ScreenCaptureAttachmentStore } from "../stores/ScreenCaptureAttachmentStore";
import { DEFAULT_CAPTURE_SHORTCUT } from "../../contracts/desktop/screen-capture-data";
import { HotkeyRecorder } from "./ui/hotkey-recorder";
import { Select } from "./ui/select";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";

export const SettingsScreenCaptureSection = observer(function SettingsScreenCaptureSection({
  capture,
}: {
  capture: ScreenCaptureAttachmentStore;
}) {
  return (
    <section className="grid gap-1.5" aria-labelledby="screen-capture-title">
      <header className="flex items-center justify-between gap-3 px-0.5">
        <h2 id="screen-capture-title" className="text-xs font-semibold text-foreground">
          Screen capture attachments
        </h2>
        <Button
          variant="outline"
          size="sm"
          className="rounded-sm"
          disabled={capture.busy}
          onClick={() => void capture.capture()}
        >
          Capture screenshot
        </Button>
      </header>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <div className="flex flex-wrap items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Global shortcut</strong>
            <small className="text-[11px] text-muted-foreground">
              Capture any app into the active chat draft. Works while another app is active.
            </small>
          </div>
          <HotkeyRecorder
            label="Screen capture"
            value={capture.shortcut}
            defaultValue={DEFAULT_CAPTURE_SHORTCUT}
            onRecordingChange={(recording) => capture.setRecordingShortcut(recording)}
            onChange={(value) => capture.setShortcut(value)}
            onClear={() => capture.setShortcut("")}
            onReset={() => capture.setShortcut(DEFAULT_CAPTURE_SHORTCUT)}
          />
        </div>
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor="capture-max-dimension" className="text-xs font-medium text-foreground">
              Maximum image dimension
            </label>
            <small className="text-[11px] text-muted-foreground">
              Caps the longest edge; smaller images are not enlarged.
            </small>
          </div>
          <Select
            id="capture-max-dimension"
            className="h-8 w-44 rounded-sm text-xs"
            value={String(capture.maxDimension)}
            onChange={(event) => capture.setMaxDimension(Number(event.target.value))}
          >
            {[1024, 1536, 2048, 3072, 4096, 8192].map((size) => (
              <option key={size} value={size}>
                {size}px{size === 2048 ? " (recommended)" : ""}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {capture.error && <Callout variant="error">{capture.error}</Callout>}
    </section>
  );
});
