import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { SpeechInputSettingsStore } from "../stores/SpeechInputSettingsStore";
import { speechInputControls, formatSpeechInputSetting } from "../../utils/speech-input-settings";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { SettingSlider } from "./ui/setting-slider";
import { Switch } from "./ui/switch";
import { Button } from "./ui/button";

export const SettingsSpeechInputSection = observer(function SettingsSpeechInputSection({
  store,
}: {
  store: SpeechInputSettingsStore;
}) {
  const [open, setOpen] = useState(false);
  const values = store.values;
  const sensitivity = speechInputControls[0];
  return (
    <section className="grid gap-1.5" aria-labelledby="speech-input-settings-title">
      <div className="flex items-center justify-between gap-3 px-0.5">
        <h2 id="speech-input-settings-title" className="text-xs font-semibold text-foreground">
          Speech input
        </h2>
        <DisclosureTrigger
          id="advanced-voice-title"
          title="Advanced speech input"
          open={open}
          aria-controls="advanced-voice-settings"
          onClick={() => setOpen(!open)}
        />
      </div>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
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
      </div>
      {open && (
        <div id="advanced-voice-settings" className="mt-2 grid gap-3">
          {(["Detection", "Automatic send", "Interruptions"] as const).map((group) => (
            <div key={group} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2 px-0.5">
                <h3 className="text-xs font-semibold text-foreground">
                  {group} · {group === "Detection" ? "Dictation + voice mode" : "Voice mode only"}
                </h3>
                {group === "Interruptions" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-sm"
                    onClick={() => store.reset()}
                  >
                    Reset speech input settings
                  </Button>
                )}
              </div>
              <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
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
                {group === "Interruptions" && (
                  <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <label
                        htmlFor="voice-short-commands"
                        className="text-xs font-medium text-foreground"
                      >
                        Allow short interruption commands
                      </label>
                      <p
                        id="voice-short-commands-description"
                        className="text-[11px] text-muted-foreground"
                      >
                        Let “stop,” “wait,” “please stop” and “please wait” interrupt immediately.
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
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
});
