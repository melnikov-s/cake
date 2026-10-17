import { observer } from "r-state-tree/react";
import type { SpeechSettingsStore } from "../stores/SpeechSettingsStore";
import { SettingsLocalSpeechSection } from "./settings-local-speech-section";
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
    <section className="grid gap-1.5" aria-labelledby="speech-output-title">
      <h2 id="speech-output-title" className="px-0.5 text-xs font-semibold text-foreground">
        Speech output
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor="speech-enabled" className="text-xs font-medium text-foreground">
              Enable speech
            </label>
            <p id="speech-enabled-description" className="text-[11px] text-muted-foreground">
              Show the conversation-mode icon in chat.
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
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor="speech-provider" className="text-xs font-medium text-foreground">
              Speech provider
            </label>
            <small className="text-[11px] text-muted-foreground">
              {speech.localModel && !speech.localModel.supported
                ? "Local output requires Apple Silicon and macOS 14 or later."
                : speech.localSelected
                  ? "Pocket TTS · local Core ML · 24 kHz audio"
                  : "ElevenLabs Flash · streaming 24 kHz audio"}
            </small>
          </div>
          <Select
            id="speech-provider"
            className="h-8 w-48 rounded-sm text-xs"
            value={speech.settings?.provider ?? "elevenlabs"}
            disabled={speech.busy || speech.installing || !speech.settings}
            onChange={(event) => void speech.selectProvider(event.target.value)}
          >
            <option value="elevenlabs">ElevenLabs · cloud</option>
            <option value="pocket-tts" disabled={!speech.localModel?.supported}>
              Pocket TTS · local
            </option>
          </Select>
        </div>
        {speech.localSelected ? (
          <SettingsLocalSpeechSection speech={speech} />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <label htmlFor="speech-key" className="text-xs font-medium text-foreground">
                  ElevenLabs API key
                </label>
                <small className="text-[11px] text-muted-foreground">
                  {speech.settings?.keyConfigured ? "Key configured" : "No key configured"} · stored
                  encrypted on this desktop.
                </small>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Input
                  id="speech-key"
                  type="password"
                  autoComplete="off"
                  className="h-8 w-44 rounded-sm font-mono text-xs"
                  placeholder={speech.settings?.keyConfigured ? "••••••••••••••••" : undefined}
                  value={speech.apiKeyDraft}
                  disabled={speech.busy}
                  onChange={(event) => {
                    speech.apiKeyDraft = event.target.value;
                  }}
                />
                <Button
                  size="sm"
                  className="rounded-sm"
                  disabled={speech.busy || !speech.apiKeyDraft.trim()}
                  onClick={() => void speech.saveApiKey()}
                >
                  Save key
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-sm"
                  disabled={speech.busy || !speech.settings?.keyConfigured}
                  onClick={() => void speech.removeApiKey()}
                >
                  Remove key
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <label htmlFor="speech-voice" className="text-xs font-medium text-foreground">
                  Voice
                </label>
                <small className="text-[11px] text-muted-foreground">
                  ElevenLabs synthesis voice for assistant replies.
                </small>
              </div>
              <div className="flex items-center gap-1.5">
                <Select
                  id="speech-voice"
                  className="h-8 w-44 rounded-sm text-xs"
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
                  size="sm"
                  className="rounded-sm"
                  disabled={speech.refreshing || !speech.settings?.keyConfigured}
                  onClick={() => void speech.refreshVoices()}
                >
                  {speech.refreshing ? "Refreshing voices…" : "Refresh voices"}
                </Button>
              </div>
            </div>
          </>
        )}
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor="speech-speed" className="text-xs font-medium text-foreground">
              Speaking speed
            </label>
            <small className="text-[11px] text-muted-foreground">
              {speech.localSelected
                ? "Pocket TTS speed (up to 2×)."
                : "ElevenLabs speed (up to 1.2×)."}
            </small>
          </div>
          <div className="grid w-48 shrink-0 gap-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>1×</span>
              <span className="tabular-nums font-medium text-foreground">
                {speech.speed.toFixed(2)}×
              </span>
            </div>
            <Slider
              id="speech-speed"
              min={1}
              max={speech.localSelected ? 2 : 1.2}
              step={0.01}
              value={speech.speed}
              disabled={speech.busy}
              aria-valuetext={`${speech.speed.toFixed(2)} times normal speed`}
              onValueChange={(speed) => {
                speech.speedDraft = speed;
              }}
              onValueCommit={() => void speech.saveSpeed()}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">Voice diagnostics</strong>
            <small className="text-[11px] text-muted-foreground">
              Copy recent reply detection, synthesis timing, and playback state.
            </small>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="rounded-sm"
            disabled={speech.diagnosticsCopyStatus === "copying"}
            onClick={() => void speech.copyDiagnostics()}
          >
            {speech.diagnosticsCopyStatus === "copied"
              ? "Voice diagnostics copied"
              : speech.diagnosticsCopyStatus === "failed"
                ? "Copy failed — try again"
                : "Copy voice diagnostics"}
          </Button>
        </div>
      </div>
      {speech.error && <Callout variant="error">{speech.error}</Callout>}
    </section>
  );
});
