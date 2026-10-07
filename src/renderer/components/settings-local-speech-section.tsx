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
  const megabytes = Math.round((model?.totalBytes ?? 140_989_471) / 1_000_000);
  const downloaded = ((model?.downloadedBytes ?? 0) / 1_000_000).toFixed(1);
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Pocket TTS 8-bit · English · Alba voice. One-time {megabytes} MB model download from Hugging
        Face. The native engine is included with Cake; no Python or API key is needed.
      </p>
      <Callout>
        Microphone recognition and speech output stay on this Mac. After installation, local speech
        output needs no network connection or ElevenLabs credits. Your chat model still follows its
        own provider settings.
      </Callout>
      {!model?.supported && (
        <Callout>Local Pocket TTS requires Apple Silicon and macOS 14 or later.</Callout>
      )}
      {model?.supported && !model.engineAvailable && (
        <Callout variant="error">
          Cake's bundled local speech engine is missing. Rebuild, update or reinstall Cake.
        </Callout>
      )}
      {speech.installing ? (
        <div className="grid gap-2">
          <p role="status" className="text-xs tabular-nums text-muted-foreground">
            Downloading Pocket TTS… {downloaded} / {megabytes} MB
          </p>
          {speech.canCancelDownload && (
            <Button variant="outline" onClick={() => speech.cancelDownload()}>
              Cancel download
            </Button>
          )}
        </div>
      ) : model?.installed ? (
        <div className="flex items-center gap-3">
          <p role="status" className="text-xs text-muted-foreground">
            Pocket TTS is installed and ready for voice mode.
          </p>
          <Button
            variant="outline"
            disabled={speech.busy}
            onClick={() => void speech.removeLocalModel()}
          >
            Remove local model
          </Button>
        </div>
      ) : (
        <Button
          disabled={speech.busy || !model?.supported || !model.engineAvailable}
          onClick={() => void speech.downloadLocalModel()}
        >
          Download Pocket TTS · {megabytes} MB
        </Button>
      )}
      {model?.message && <Callout variant="error">{model.message}</Callout>}
      <p className="text-xs text-muted-foreground">
        Pocket TTS by Kyutai; MLX conversion by mlx-community; Alba voice by Alba MacKenna. Model
        and voice licensed CC BY 4.0. Local output currently uses normal speaking speed.
      </p>
    </div>
  );
});
