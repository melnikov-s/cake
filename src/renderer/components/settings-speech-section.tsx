import { observer } from "r-state-tree/react";
import type { SpeechSettingsStore } from "../stores/SpeechSettingsStore";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Switch } from "./ui/switch";
import { Slider } from "./ui/slider";

export const SettingsSpeechSection = observer(function SettingsSpeechSection({
  speech,
}: {
  speech: SpeechSettingsStore;
}) {
  const selected = speech.settings?.voiceId ?? "";
  return (
    <section className="grid gap-5 py-5" aria-labelledby="speech-output-title">
      <header>
        <h2 id="speech-output-title" className="text-[15px] font-semibold">
          Speech output
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          ElevenLabs Flash · eleven_flash_v2_5 · streaming 24 kHz audio
        </p>
      </header>
      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-1">
          <label htmlFor="speech-enabled" className="text-xs font-medium">
            Enable speech
          </label>
          <p id="speech-enabled-description" className="text-xs text-muted-foreground">
            Show the conversation-mode icon in chat. Turning this off stops speech input and output.
          </p>
        </div>
        <Switch
          id="speech-enabled"
          aria-label="Enable speech"
          aria-describedby="speech-enabled-description"
          checked={speech.enabled}
          onCheckedChange={(enabled) => speech.setEnabled(enabled)}
        />
      </div>
      <Callout>
        Conversation mode uses local Parakeet input. Only selected assistant prose is sent to
        ElevenLabs, not microphone audio, reasoning or tool output. Provider retention depends on
        your plan. Your own account quota and billing apply; free-tier access is neither unlimited
        nor a commercial license.
      </Callout>
      <div className="grid gap-2">
        <label htmlFor="speech-key" className="text-xs font-medium">
          ElevenLabs API key
        </label>
        <Input
          id="speech-key"
          type="password"
          autoComplete="off"
          value={speech.apiKeyDraft}
          disabled={speech.busy}
          onChange={(event) => {
            speech.apiKeyDraft = event.target.value;
          }}
        />
        <p className="text-xs text-muted-foreground">
          {speech.settings?.keyConfigured ? "Key configured" : "No key configured"}. Stored
          encrypted on this desktop; never returned to the renderer.
        </p>
        <div className="flex gap-2">
          <Button
            disabled={speech.busy || !speech.apiKeyDraft.trim()}
            onClick={() => void speech.saveApiKey()}
          >
            Save key
          </Button>
          <Button
            variant="outline"
            disabled={speech.busy || !speech.settings?.keyConfigured}
            onClick={() => void speech.removeApiKey()}
          >
            Remove key
          </Button>
        </div>
      </div>
      <div className="grid gap-2">
        <label htmlFor="speech-voice" className="text-xs font-medium">
          Voice
        </label>
        <Select
          id="speech-voice"
          value={selected}
          disabled={speech.busy}
          onChange={(event) => void speech.selectVoice(event.target.value)}
        >
          <option value="">Choose a voice…</option>
          {selected && !speech.voices.some((voice) => voice.id === selected) && (
            <option value={selected}>{selected}</option>
          )}
          {speech.voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </Select>
        <Button
          variant="outline"
          disabled={speech.refreshing || !speech.settings?.keyConfigured}
          onClick={() => void speech.refreshVoices()}
        >
          {speech.refreshing ? "Refreshing voices…" : "Refresh voices"}
        </Button>
      </div>
      <div className="grid max-w-64 gap-2">
        <div className="flex items-center justify-between text-xs">
          <label htmlFor="speech-speed" className="font-medium">
            Speaking speed
          </label>
          <span className="tabular-nums">{speech.speed.toFixed(2)}×</span>
        </div>
        <Slider
          id="speech-speed"
          min={1}
          max={1.2}
          step={0.01}
          value={speech.speed}
          disabled={speech.busy}
          aria-valuetext={`${speech.speed.toFixed(2)} times normal speed`}
          onValueChange={(speed) => {
            speech.speedDraft = speed;
          }}
          onValueCommit={() => void speech.saveSpeed()}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Normal · 1×</span>
          <span>Faster · 1.2×</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        No generated preview, automatic billed retry or fallback. Exit voice mode to use ordinary
        text chat. Speech capture and output stop on window blur.
      </p>
      {speech.error && <Callout variant="error">{speech.error}</Callout>}
    </section>
  );
});
