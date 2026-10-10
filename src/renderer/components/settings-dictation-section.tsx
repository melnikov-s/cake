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
    <section className="grid gap-5 py-5" aria-labelledby="dictation-title">
      <header>
        <h2 id="dictation-title" className="text-[15px] font-semibold">
          Voice input
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Speak into focused Cake writing fields. Speech recognition is local, with no saved
          recordings or ready sounds. VS Code, terminals, and embedded pages are excluded.
        </p>
      </header>
      {state && !state.supported && (
        <Callout variant="warning">Parakeet requires Apple Silicon and macOS 14 or later.</Callout>
      )}
      {state?.supported && !state.engineAvailable && (
        <Callout variant="error">
          Cake's bundled speech engine is missing. Reinstall or update Cake.
        </Callout>
      )}
      <SettingsToggle
        label="Dictation mode"
        description="Focus a writing field, wait for the voice bars, then speak. Enter finishes your last words and submits where supported. Your choice is remembered when Cake opens; temporary pauses do not turn it off."
        checked={store.enabled}
        disabled={
          installing ||
          (!store.enabled && (!state?.supported || !state.engineAvailable || !state.modelPath))
        }
        onChange={(enabled) => void store.setEnabled(enabled)}
      />
      <div id="setting-text-processing" className="grid gap-2">
        <label htmlFor="text-processing-mode" className="text-xs font-medium">
          Text processing
        </label>
        <Select
          id="text-processing-mode"
          value={store.textProcessingMode}
          onChange={(event) => {
            const mode = event.target.value;
            if (mode === "raw" || mode === "local" || mode === "utility")
              store.setTextProcessingMode(mode);
          }}
        >
          <option value="raw">Raw · no additional processing</option>
          <option
            value="local"
            disabled={
              !["installed", "ready", "loading"].includes(state?.punctuation.status ?? "missing")
            }
          >
            Local punctuation · CPU, offline
          </option>
          <option value="utility">Utility model · customizable cleanup</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          Shared by dictation and voice mode. Raw keeps recognition unchanged. Local revises
          punctuation and capitalization across pauses without removing words; its recent gray tail
          stays provisional until more context or finalization. Utility cleanup runs after three
          seconds of silence or on submission and can remove fillers or follow your custom prompt.
          Only utility mode sends dictated text to your configured utility provider and may incur
          costs. The modes do not run together; failures keep raw recognition.
        </p>
      </div>
      {store.textProcessingMode === "utility" && prompts.prompts && (
        <SettingsPromptField
          id="setting-prompt-dictation-cleanup"
          label="Utility cleanup prompt"
          description="Shared by dictation and voice mode. Customize cleanup or ask for concise wording. Reset restores meaning-preserving cleanup. Only the dictated passage is supplied; Cake handles the JSON response format."
          value={prompts.prompts.dictationCleanup ?? ""}
          defaultValue={defaultCakePrompts().dictationCleanup}
          onApply={(value) => void prompts.update("dictationCleanup", value)}
        />
      )}
      {prompts.error && <Callout variant="error">{prompts.error}</Callout>}
      {store.processingError && (
        <Callout variant="warning">{store.processingError} Raw recognition is retained.</Callout>
      )}
      <div className="grid gap-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium">Local punctuation · English · CPU</h3>
        <p className="text-xs text-muted-foreground">
          Optional one-time 210 MB download from Hugging Face. English punctuation and
          capitalization by 1-800-BAD-CODE, Apache-2.0. Runs offline on the CPU; no chat model,
          audio upload, filler removal, or summarization. A smaller quantized version was not
          selected because it reduced question-boundary accuracy in evaluation.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={store.installingPunctuation}
            onClick={() => void store.installPunctuation()}
          >
            Download punctuation model
          </Button>
          {store.installingPunctuation && (
            <Button variant="outline" onClick={() => store.cancelPunctuationInstall()}>
              Cancel punctuation download
            </Button>
          )}
          {state?.punctuation.status !== "missing" && state?.punctuation.status !== undefined && (
            <Button
              variant="outline"
              disabled={store.installingPunctuation}
              onClick={() => void store.removePunctuation()}
            >
              Remove punctuation model
            </Button>
          )}
        </div>
        {state?.punctuation.status === "installing" && (
          <div className="flex items-center gap-2 text-xs" role="status">
            <LoadingSpinner label="Installing punctuation" />
            {state.punctuation.message}
            {state.punctuation.totalBytes > 0 &&
              ` ${Math.min(100, Math.floor((state.punctuation.downloadedBytes / state.punctuation.totalBytes) * 100))}%`}
          </div>
        )}
        {state?.punctuation.status === "error" && (
          <Callout variant="warning">
            {state.punctuation.message} Raw recognition is retained.
          </Callout>
        )}
      </div>
      <div className="grid gap-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium">Parakeet TDT 0.6B v2 · English · Core ML</h3>
        <p className="text-xs text-muted-foreground">
          NVIDIA Parakeet · Core ML conversion by FluidInference · CC BY 4.0
        </p>
        <p className="text-xs text-muted-foreground">
          One-time model download: 464 MB from Hugging Face. The native speech engine is included
          with Cake, and Core ML comes with macOS. No separate runtime or developer tools to
          install.
        </p>
        {state?.modelPath && (
          <p className="break-all font-mono text-xs text-muted-foreground">
            Model: {state.modelPath}
          </p>
        )}
        {state?.managedModelPath && (
          <p className="break-all text-xs text-muted-foreground">
            Cake storage: {state.managedModelPath}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
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
            <Button variant="outline" onClick={() => store.cancelInstall()}>
              Cancel download
            </Button>
          )}
          {state?.modelPath && (
            <Button variant="outline" disabled={installing} onClick={() => void store.remove()}>
              Remove Cake model data
            </Button>
          )}
        </div>
        {state?.status === "installing" && (
          <div className="flex items-center gap-2 text-xs" role="status">
            <LoadingSpinner label="Installing dictation" />
            {state.message}
            {state.totalBytes > 0 &&
              ` ${Math.min(100, Math.floor((state.downloadedBytes / state.totalBytes) * 100))}%`}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Removal clears the selection and Cake's downloaded weights. External model folders and the
          bundled speech engine are left alone.
        </p>
      </div>
      <div className="grid gap-2">
        <label htmlFor="dictation-model-path" className="text-xs font-medium">
          Use an existing Core ML Parakeet model folder
        </label>
        <Input
          id="dictation-model-path"
          placeholder="/absolute/path/to/model"
          value={store.modelPathDraft}
          onChange={(event) => {
            store.modelPathDraft = event.target.value;
          }}
        />
        <p className="text-xs text-muted-foreground">
          Must contain the v2 Preprocessor, Encoder, Decoder, and JointDecision .mlmodelc bundles
          plus parakeet_vocab.json. MLX, Whisper, and ONNX weights aren’t compatible.
        </p>
        <Button
          className="justify-self-start"
          variant="outline"
          disabled={!state?.supported || installing || !store.modelPathDraft.trim()}
          onClick={() => void store.useModelPath(store.modelPathDraft)}
        >
          Use model folder
        </Button>
      </div>
      <div className="grid gap-2">
        <label htmlFor="dictation-microphone" className="text-xs font-medium">
          Microphone
        </label>
        <Select
          id="dictation-microphone"
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
          className="justify-self-start"
          variant="outline"
          onClick={() => void store.refreshDevices()}
        >
          Refresh microphones
        </Button>
        <p className="text-xs text-muted-foreground">
          macOS will request microphone access when you first focus a dictation field. If denied,
          allow Cake in System Settings → Privacy & Security → Microphone.
        </p>
        <Textarea
          dictation
          aria-label="Try dictation"
          placeholder="Enable dictation, focus here, wait for the voice bars, then speak…"
          value={testDraft}
          onChange={(event) => setTestDraft(event.target.value)}
          rows={3}
        />
      </div>
      {(store.error || state?.status === "error") && (
        <Callout variant="error">{store.error ?? state?.message}</Callout>
      )}
    </section>
  );
});
