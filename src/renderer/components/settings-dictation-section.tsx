import { useEffect, useState } from "react";
import { observer } from "r-state-tree/react";
import type { DictationStore } from "../stores/DictationStore";
import { SettingsToggle } from "./settings/settings-toggle";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Select } from "./ui/select";
import { Callout } from "./ui/callout";
import { LoadingSpinner } from "./ui/loading-state";

export const SettingsDictationSection = observer(function SettingsDictationSection({
  store,
}: {
  store: DictationStore;
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
          Speak into focused Cake writing fields. Entirely local, with no saved recordings or ready
          sounds. VS Code, terminals, and embedded pages are excluded.
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
        description="Focus a writing field, wait for Listening, then speak. Enter finishes your last words and submits where supported. Mode starts off when Cake opens."
        checked={store.enabled}
        disabled={!state?.supported || !state.engineAvailable || !state.modelPath || installing}
        onChange={(enabled) => void store.setEnabled(enabled)}
      />
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
          placeholder="Enable dictation, focus here, wait for Listening, then speak…"
          value={testDraft}
          onChange={(event) => setTestDraft(event.target.value)}
          rows={3}
        />
      </div>
      {store.enabled && (
        <p role="status" className="text-xs text-muted-foreground">
          {store.label}
        </p>
      )}
      {(store.error || state?.status === "error") && (
        <Callout variant="error">{store.error ?? state?.message}</Callout>
      )}
    </section>
  );
});
