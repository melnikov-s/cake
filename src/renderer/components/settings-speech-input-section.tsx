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
    <section
      className="grid min-w-0 max-w-3xl gap-1.5"
      aria-labelledby="speech-input-settings-title"
    >
      <h2 id="speech-input-settings-title" className="px-0.5 text-xs font-semibold text-foreground">
        Speech input
      </h2>
      <div className="min-w-0 divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
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
          className="px-3.5 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-controls="advanced-voice-settings"
          onClick={() => setOpen(!open)}
        />
        {open && (
          <div
            id="advanced-voice-settings"
            role="region"
            aria-labelledby="advanced-voice-title"
            className="min-w-0 divide-y divide-border/60"
          >
            {(["Detection", "Automatic send", "Interruptions"] as const).map((group) => (
              <div key={group} className="min-w-0">
                <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3.5 pt-3 pb-1 text-xs font-semibold text-foreground">
                  {group}
                  <span className="text-xs font-normal text-muted-foreground">
                    {group === "Detection" ? "Dictation + voice mode" : "Voice mode only"}
                  </span>
                </h3>
                <div className="divide-y divide-border/60">
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
                    <div className="flex items-center justify-between gap-6 px-3.5 py-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <label
                          htmlFor="voice-short-commands"
                          className="text-xs font-medium text-foreground"
                        >
                          Allow short interruption commands
                        </label>
                        <p
                          id="voice-short-commands-description"
                          className="max-w-prose text-xs leading-relaxed text-muted-foreground"
                        >
                          <span className="sr-only">Voice mode only. </span>
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
            <div className="px-3.5 py-3">
              <Button
                variant="outline"
                size="sm"
                className="h-auto min-h-8 whitespace-normal py-1.5 text-left"
                onClick={() => store.reset()}
              >
                Reset speech input settings
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
});
