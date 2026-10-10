import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { SpeechInputSettingsStore } from "../stores/SpeechInputSettingsStore";
import { speechInputControls, formatSpeechInputSetting } from "../../utils/speech-input-settings";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { SettingSlider } from "./ui/setting-slider";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";

export const SettingsSpeechInputSection = observer(function SettingsSpeechInputSection({
  store,
}: {
  store: SpeechInputSettingsStore;
}) {
  const [open, setOpen] = useState(false);
  const values = store.values;
  const sensitivity = speechInputControls[0];
  return (
    <section
      className="grid gap-4 border-t border-border py-5"
      aria-labelledby="speech-input-settings-title"
    >
      <h2 id="speech-input-settings-title" className="text-sm font-semibold">
        Speech input
      </h2>
      <p className="text-xs text-muted-foreground">
        Detection settings apply to both dictation and voice mode. Automatic-send and interruption
        settings apply only to voice mode. Settings are remembered for this window and apply on the
        next capture: refocus your writing field for dictation, or exit and re-enter voice mode.
      </p>
      <SettingSlider
        id={`voice-${sensitivity.key}`}
        label={sensitivity.label}
        description={sensitivity.description}
        scopeLabel={sensitivity.scope}
        min={sensitivity.min}
        max={sensitivity.max}
        step={sensitivity.step}
        value={values.speechStartThreshold}
        valueText={formatSpeechInputSetting(sensitivity.key, values.speechStartThreshold)}
        minLabel="More sensitive"
        maxLabel="Reject more noise"
        onValueChange={(value) => store.setNumber(sensitivity.key, value)}
      />
      <DisclosureTrigger
        id="advanced-voice-title"
        title="Advanced speech input"
        open={open}
        aria-controls="advanced-voice-settings"
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div id="advanced-voice-settings" className="grid gap-5">
          <Callout>
            Stricter detection can reduce background noise, but cannot reliably distinguish an
            invented “yeah” from a real one.
          </Callout>
          {(["Detection", "Automatic send", "Interruptions"] as const).map((group) => (
            <div key={group} className="grid gap-4">
              <h3 className="text-sm font-semibold">
                {group} — {group === "Detection" ? "Dictation + voice mode" : "Voice mode only"}
              </h3>
              <div className="grid gap-5 md:grid-cols-2">
                {speechInputControls
                  .filter((control) => control.group === group && control.key !== sensitivity.key)
                  .map((control) => {
                    const max =
                      control.key === "speechContinueThreshold"
                        ? values.speechStartThreshold
                        : control.key === "countdownDelaySeconds"
                          ? Math.min(control.max, values.sendPauseSeconds - 0.25)
                          : control.max;
                    return (
                      <SettingSlider
                        key={control.key}
                        id={`voice-${control.key}`}
                        label={control.label}
                        description={control.description}
                        scopeLabel={control.scope}
                        min={control.min}
                        max={max}
                        step={control.step}
                        value={values[control.key]}
                        valueText={formatSpeechInputSetting(control.key, values[control.key])}
                        onValueChange={(value) => store.setNumber(control.key, value)}
                      />
                    );
                  })}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3">
            <div className="grid gap-1">
              <label htmlFor="voice-short-commands" className="text-xs font-medium">
                Allow short interruption commands
              </label>
              <p id="voice-short-commands-description" className="text-xs text-muted-foreground">
                Voice mode only. Let “stop,” “wait,” “please stop” and “please wait” interrupt
                without reaching the word count.
              </p>
            </div>
            <Switch
              id="voice-short-commands"
              aria-label="Allow short interruption commands"
              aria-describedby="voice-short-commands-description"
              checked={values.shortCommands}
              onCheckedChange={(enabled) => store.setShortCommands(enabled)}
            />
          </div>
          <Button className="w-fit" variant="outline" onClick={() => store.reset()}>
            Reset speech input settings
          </Button>
        </div>
      )}
    </section>
  );
});
