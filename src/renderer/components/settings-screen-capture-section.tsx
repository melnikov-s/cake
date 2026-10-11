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
    <section className="grid gap-6 py-5" aria-labelledby="screen-capture-title">
      <div>
        <h2 id="screen-capture-title" className="text-[15px] font-semibold">
          Screen capture attachments
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Capture any app into the active chat draft, or the last active chat when you're elsewhere
          in Cake. Screenshots are never sent automatically.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Global shortcut</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Works while another app is active. Clear to disable.
          </p>
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
      <div className="grid gap-2">
        <label htmlFor="capture-max-dimension" className="text-xs font-medium">
          Maximum image dimension
        </label>
        <Select
          id="capture-max-dimension"
          value={String(capture.maxDimension)}
          onChange={(event) => capture.setMaxDimension(Number(event.target.value))}
        >
          {[1024, 1536, 2048, 3072, 4096, 8192].map((size) => (
            <option key={size} value={size}>
              {size}px{size === 2048 ? " (recommended)" : ""}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">
          The longest edge is capped; smaller images aren't enlarged. Enter captures the display
          containing your pointer.
        </p>
      </div>
      <div className="grid gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Drag a rectangle and release to attach it. Switch to Annotate to add arrows and labels,
          then return to Crop or press Enter for the full annotated display. Move the toolbar with
          its drag grip. Escape discards the unfinished arrow or gesture; press it again to close
          capture.
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          On macOS, allow Cake in Privacy & Security → Screen & System Audio Recording.
          Command–Shift–6 may conflict with Touch Bar screenshots; choose another shortcut if
          needed.
        </p>
      </div>
      {capture.error && <Callout variant="error">{capture.error}</Callout>}
      <div>
        <Button variant="outline" disabled={capture.busy} onClick={() => void capture.capture()}>
          Capture screenshot
        </Button>
      </div>
    </section>
  );
});
