import { observer } from "r-state-tree/react";
import type { SpeechSettingsStore } from "../stores/SpeechSettingsStore";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";

export const SettingsLocalSpeechSection = observer(function SettingsLocalSpeechSection({
  speech,
}: {
  speech: SpeechSettingsStore;
}) {
  const model = speech.localModel;
  const size = model ? `${Math.round(model.totalBytes / 1_000_000)} MB` : "model data";
  const downloaded = ((model?.downloadedBytes ?? 0) / 1_000_000).toFixed(1);
  return (
    <div className="grid gap-2 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-xs font-medium text-foreground">
            Pocket TTS Core ML · English · Alba voice
          </strong>
          <small className="text-[11px] text-muted-foreground">
            {size} local model; no Python or API key is needed. Speaking speed is adjusted locally
            without changing pitch.
          </small>
        </div>
        {speech.installing ? (
          <div className="flex items-center gap-2">
            <p role="status" className="text-xs tabular-nums text-muted-foreground">
              Downloading Pocket TTS… {downloaded} / {size}
            </p>
            {speech.canCancelDownload && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-sm"
                onClick={() => speech.cancelDownload()}
              >
                Cancel download
              </Button>
            )}
          </div>
        ) : model?.installed ? (
          <div className="flex items-center gap-2">
            <p role="status" className="text-xs text-muted-foreground">
              Pocket TTS is installed and ready for voice mode.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              disabled={speech.busy}
              onClick={() => void speech.removeLocalModel()}
            >
              Remove local model
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="rounded-sm"
            disabled={speech.busy || !model?.supported || !model.engineAvailable}
            onClick={() => void speech.downloadLocalModel()}
          >
            Download Pocket TTS · {size}
          </Button>
        )}
      </div>
      {!model?.supported && (
        <Callout>Local Pocket TTS requires Apple Silicon and macOS 14 or later.</Callout>
      )}
      {model?.supported && !model.engineAvailable && (
        <Callout variant="error">
          Cake's bundled local speech engine is missing. Rebuild, update or reinstall Cake.
        </Callout>
      )}
      {model?.message && <Callout variant="error">{model.message}</Callout>}
    </div>
  );
});
