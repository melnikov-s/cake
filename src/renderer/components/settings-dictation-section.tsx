import { useEffect, useState } from "react";
import { observer } from "r-state-tree/react";
import type { DictationStore } from "../stores/DictationStore";
import type { CakePromptSettingsStore } from "../stores/CakePromptSettingsStore";
import { defaultCakePrompts } from "../../contracts/application/cake-prompt-defaults";
import { SettingsPromptField } from "./settings/settings-prompt-field";
import { SettingsToggle } from "./settings/settings-toggle";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Select } from "./ui/select";
import { Callout } from "./ui/callout";
import { LoadingSpinner } from "./ui/loading-state";

export const SettingsDictationSection = observer(function SettingsDictationSection({
  store,
  prompts,
}: {
  store: DictationStore;
  prompts: CakePromptSettingsStore;
}) {
  const state = store.state;
  const [testDraft, setTestDraft] = useState("");
  useEffect(() => {
    void store.refreshDevices();
  }, [store]);
  const installing = store.busy || state?.status === "installing";
  return (
    <section className="grid gap-1.5" aria-labelledby="dictation-title">
      <h2 id="dictation-title" className="px-0.5 text-xs font-semibold text-foreground">
        Voice input
      </h2>
      {state && !state.supported && (
        <Callout variant="warning">Parakeet requires Apple Silicon and macOS 14 or later.</Callout>
      )}
      {state?.supported && !state.engineAvailable && (
        <Callout variant="error">
          Cake's bundled speech engine is missing. Reinstall or update Cake.
        </Callout>
      )}
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <SettingsToggle
          label="Dictation mode"
          description="Speak into focused writing fields. Enter finishes and submits where supported."
          checked={store.enabled}
          disabled={
            installing ||
            (!store.enabled && (!state?.supported || !state.engineAvailable || !state.modelPath))
          }
          onChange={(enabled) => void store.setEnabled(enabled)}
        />
        <div
          id="setting-text-processing"
          className="flex items-center justify-between gap-4 px-3.5 py-2.5"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor="text-processing-mode" className="text-xs font-medium text-foreground">
              Text processing
            </label>
            <small className="text-[11px] text-muted-foreground">
              Shared by dictation and voice mode. Utility mode cleans up pauses and fillers.
            </small>
          </div>
          <Select
            id="text-processing-mode"
            className="h-8 w-64 rounded-sm text-xs"
            value={store.textProcessingMode}
            onChange={(event) => {
              const mode = event.target.value;
              if (mode === "raw" || mode === "utility") store.setTextProcessingMode(mode);
            }}
          >
            <option value="raw">Recognition · local live revisions</option>
            <option value="utility">Utility model · customizable cleanup</option>
          </Select>
        </div>
        {store.textProcessingMode === "utility" && prompts.prompts && (
          <SettingsPromptField
            id="setting-prompt-dictation-cleanup"
            label="Utility cleanup prompt"
            description="Shared by dictation and voice mode. Reset restores default meaning-preserving cleanup."
            value={prompts.prompts.dictationCleanup ?? ""}
            defaultValue={defaultCakePrompts().dictationCleanup}
            onApply={(value) => void prompts.update("dictationCleanup", value)}
          />
        )}
        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor="dictation-microphone" className="text-xs font-medium text-foreground">
              Microphone
            </label>
            <small className="text-[11px] text-muted-foreground">
              Audio input device for dictation and voice mode.
            </small>
          </div>
          <div className="flex items-center gap-1.5">
            <Select
              id="dictation-microphone"
              className="h-8 w-48 rounded-sm text-xs"
              value={store.deviceId}
              onChange={(event) => store.setDevice(event.target.value)}
            >
              <option value="">System default</option>
              {store.devices
                .filter((device) => device.id && device.id !== "default")
                .map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.label}
                  </option>
                ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              onClick={() => void store.refreshDevices()}
            >
              Refresh microphones
            </Button>
          </div>
        </div>
        <div className="grid gap-1.5 px-3.5 py-2.5">
          <Textarea
            dictation
            aria-label="Try dictation"
            className="min-h-16 rounded-sm text-xs"
            placeholder="Enable dictation, focus here, wait for the voice bars, then speak…"
            value={testDraft}
            onChange={(event) => setTestDraft(event.target.value)}
            rows={2}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-xs font-medium text-foreground">
              Parakeet TDT 0.6B v2 · Core ML
            </strong>
            <small className="truncate text-[11px] text-muted-foreground">
              {state?.modelPath ? `Installed: ${state.modelPath}` : "464 MB local English model"}
            </small>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              className="rounded-sm"
              disabled={
                !state?.supported ||
                !state.engineAvailable ||
                installing ||
                (state.modelPath === state.managedModelPath && state.status !== "error")
              }
              onClick={() => void store.install()}
            >
              Download Parakeet model
            </Button>
            {store.installing && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-sm"
                onClick={() => store.cancelInstall()}
              >
                Cancel download
              </Button>
            )}
            {state?.modelPath && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-sm"
                disabled={installing}
                onClick={() => void store.remove()}
              >
                Remove Cake model data
              </Button>
            )}
          </div>
        </div>
        {state?.status === "installing" && (
          <div className="flex items-center gap-2 px-3.5 py-2 text-xs" role="status">
            <LoadingSpinner label="Installing dictation" />
            {state.message}
            {state.totalBytes > 0 &&
              ` ${Math.min(100, Math.floor((state.downloadedBytes / state.totalBytes) * 100))}%`}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor="dictation-model-path" className="text-xs font-medium text-foreground">
              Use an existing Core ML Parakeet model folder
            </label>
            <small className="text-[11px] text-muted-foreground">
              Directory containing v2 .mlmodelc bundles and parakeet_vocab.json.
            </small>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              id="dictation-model-path"
              className="h-8 w-52 rounded-sm font-mono text-xs"
              placeholder="/absolute/path/to/model"
              value={store.modelPathDraft}
              onChange={(event) => {
                store.modelPathDraft = event.target.value;
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              disabled={!state?.supported || installing || !store.modelPathDraft.trim()}
              onClick={() => void store.useModelPath(store.modelPathDraft)}
            >
              Use model folder
            </Button>
          </div>
        </div>
      </div>
      {prompts.error && <Callout variant="error">{prompts.error}</Callout>}
      {(store.error || state?.status === "error") && (
        <Callout variant="error">{store.error ?? state?.message}</Callout>
      )}
    </section>
  );
});
