import { snapshot, Store, untracked } from "r-state-tree";
import type {
  DictationState,
  TextProcessingMode,
  SpeechRecognitionSettings,
} from "../../contracts/dictation/dictation-data";
import type { SpeechInputSettingsStore } from "./SpeechInputSettingsStore";
import { speechRecognitionSettings } from "../../utils/speech-input-settings";
import type { Client } from "../client/Client";
import { encodePcm, type Microphone, type MicrophoneCapture } from "../dictation/microphone";
import { openSpeechCapture } from "../dictation/speech-capture";
import type { ProvisionalTextSpan } from "../dictation/provisional-text";

export interface DictationTarget {
  readonly id: string;
  begin(): void;
  replace(text: string): ProvisionalTextSpan | void;
}
interface Utterance {
  settings: SpeechRecognitionSettings;
  id: string;
  target: DictationTarget;
  controller: AbortController;
  capture?: MicrophoneCapture;
  chunks: Float32Array[];
  samples: number;
  meterEnergy: number;
  meterSamples: number;
  pending?: Promise<void>;
  finishing: boolean;
  rawText: string;
  cleanedRaw?: string;
  cleanedText?: string;
  cleanupController: AbortController;
  quietSamples: number;
  heardSpeech: boolean;
  cleanupDue: boolean;
  cleanupPending?: Promise<void>;
}
export type DictationPhase = "off" | "paused" | "preparing" | "listening" | "finishing" | "error";
const CLEANUP_SILENCE_SAMPLES = 3 * 16_000;

/** Window-owned voice-input workflow. Focus is take-latest; drafts retain their existing owners.
 * Main owns installation. This window persists enablement, microphone and cleanup choice (last
 * local edit wins); capture, maintenance pauses, audio and focus are ephemeral.
 */
export class DictationStore extends Store<{
  preferences: SpeechInputSettingsStore;
  client: Client["dictation"];
  microphone: Microphone;
  postProcess: Client["workspaces"]["postProcessDictation"];
  beforeCapture?(): Promise<void>;
  canReleaseRecognition?(): boolean;
}> {
  state: DictationState | undefined;
  @snapshot enabled = false;
  /** Window preference shared with voice mode; text/results remain insertion-local and ephemeral. */
  @snapshot textProcessingMode: TextProcessingMode = "raw";
  /** Window-local input mute; survives field changes, never persisted. */
  muted = false;
  phase: DictationPhase = "off";
  /** Ephemeral level of the current capture; never persisted or shared across focus generations. */
  audioLevel = 0;
  /** Exact DOM insertion awaiting optional cleanup; never persisted. */
  provisionalText: ProvisionalTextSpan | undefined;
  error: string | undefined;
  modelPathDraft = "";
  @snapshot deviceId = "";
  devices: ReadonlyArray<{ id: string; label: string }> = [];
  busy = false;
  private target: DictationTarget | undefined;
  private utterance: Utterance | undefined;
  private installation: AbortController | undefined;
  private modeRevision = 0;

  constructor(props: DictationStore["props"]) {
    super(props);
    this.effect(() => {
      // Hydration restores intent, not a recording or an in-flight preparation.
      untracked(() => {
        this.phase = this.enabled ? "paused" : "off";
      });
      return () => {
        this.endUtterance();
        this.installation?.abort();
      };
    });
  }

  get activeTargetId() {
    return this.target?.id;
  }
  /** Muting seals visible speech and drops pending results; unmuting starts at the current caret. */
  setMuted(id: string, muted: boolean) {
    if (!this.enabled || this.target?.id !== id || this.muted === muted) return;
    this.muted = muted;
    if (muted) {
      this.endUtterance();
      this.phase = "paused";
    } else {
      this.error = undefined;
      void this.start(this.target);
    }
  }
  get label() {
    if (this.muted) return "Dictation muted";
    if (this.phase === "preparing") return "Preparing dictation… Wait to speak";
    if (this.phase === "listening") return "Listening";
    if (this.phase === "finishing") return "Finishing…";
    if (this.phase === "error") return this.error ?? "Dictation unavailable";
    return "Dictation paused";
  }
  applyState(state: DictationState) {
    this.state = state;
  }
  reportError(error: unknown) {
    this.endUtterance();
    this.error = error instanceof Error ? error.message : String(error);
    this.phase = "error";
  }
  private endUtterance() {
    const run = this.utterance;
    this.utterance = undefined;
    this.provisionalText = undefined;
    this.audioLevel = 0;
    run?.cleanupController.abort();
    run?.controller.abort();
    run?.capture?.stop();
    if (run) {
      run.chunks = [];
      run.samples = 0;
    }
  }
  /** Pause the current field without changing the user's dictation preference. */
  pauseCapture(): void {
    this.endUtterance();
    this.target = undefined;
    if (this.enabled) this.phase = "paused";
  }
  async setEnabled(enabled: boolean) {
    const revision = ++this.modeRevision;
    this.enabled = enabled;
    this.muted = false;
    this.error = undefined;
    this.endUtterance();
    this.phase = enabled ? "preparing" : "off";
    try {
      if (!enabled) {
        if (this.props.canReleaseRecognition?.() ?? true)
          await this.props.client.release({ signal: this.signal });
        return;
      }
      if (revision !== this.modeRevision || this.signal.aborted) return;
      await this.props.client.prepare({ signal: this.signal });
      if (revision !== this.modeRevision || this.signal.aborted) return;
      this.phase = "paused";
      if (this.target && !this.muted) await this.start(this.target);
    } catch (error) {
      if (revision === this.modeRevision && !this.signal.aborted) this.reportError(error);
    }
  }
  focus(target: DictationTarget) {
    if (this.target === target) return;
    this.endUtterance();
    this.target = target;
    if (!this.enabled || this.muted || this.busy) return;
    if (this.state?.status === "error")
      this.reportError(new Error(this.state.message ?? "Dictation unavailable"));
    else if (this.phase !== "preparing" || this.utterance) void this.start(target);
  }
  blur(id: string) {
    if (this.target?.id !== id) return;
    this.endUtterance();
    this.target = undefined;
    if (this.enabled) this.phase = "paused";
  }
  /** Manual editing/cursor movement seals visible speech and starts a new insertion. */
  restart(id: string) {
    if (this.target?.id !== id || !this.enabled || this.muted) return;
    if (this.phase === "finishing") {
      this.endUtterance();
      this.phase = "paused";
      void this.start(this.target);
      return;
    }
    const run = this.utterance;
    this.provisionalText = undefined;
    if (run && this.phase === "listening") {
      // Editing starts a new decoding generation, not a new microphone acquisition.
      run.quietSamples = 0;
      run.heardSpeech = false;
      run.cleanupDue = false;
      run.cleanupController.abort();
      run.cleanupController = new AbortController();
      run.cleanupPending = undefined;
      run.rawText = "";
      run.cleanedRaw = undefined;
      run.cleanedText = undefined;
      run.id = crypto.randomUUID();
      run.chunks = [];
      run.samples = 0;
      run.target.begin();
    } else if (this.state?.status === "ready") void this.start(this.target);
  }
  private async start(target: DictationTarget) {
    if (!this.enabled || this.muted || this.busy || this.signal.aborted) return;
    this.endUtterance();
    const run: Utterance = {
      settings: speechRecognitionSettings(this.props.preferences.values),
      id: crypto.randomUUID(),
      target,
      controller: new AbortController(),
      chunks: [],
      samples: 0,
      meterEnergy: 0,
      meterSamples: 0,
      finishing: false,
      rawText: "",
      cleanupController: new AbortController(),
      quietSamples: 0,
      heardSpeech: false,
      cleanupDue: false,
    };
    this.utterance = run;
    this.phase = "preparing";
    target.begin();
    try {
      await this.props.beforeCapture?.();
      if (this.utterance !== run) return;
      // Voice mode can have released the shared recognizer. Preparation is warm/idempotent.
      await this.props.client.prepare({ signal: this.signal });
      if (this.utterance !== run) return;
      const capture = await openSpeechCapture(
        this.props.microphone,
        // Focus cancellation drops capture-local results, not the shared warm worker.
        (audio) =>
          this.props.client.detectSpeech(
            { ...audio, thresholds: run.settings.thresholds },
            { signal: this.signal },
          ),
        (samples, speech) => {
          if (this.utterance !== run || run.finishing) return;
          if (speech) {
            run.heardSpeech = true;
            run.quietSamples = 0;
            run.cleanupDue = false;
          } else if (run.heardSpeech) {
            const previous = run.quietSamples;
            run.quietSamples += samples.length;
            if (previous < CLEANUP_SILENCE_SAMPLES && run.quietSamples >= CLEANUP_SILENCE_SAMPLES) {
              run.cleanupDue = true;
              this.scheduleCleanup(run);
            }
          }
        },
        (error) => {
          if (this.utterance === run) this.reportError(error);
        },
        run.controller.signal,
        this.deviceId,
        () => {
          if (this.utterance === run)
            this.reportError(
              new Error("Microphone disconnected. Choose a microphone and enable dictation again."),
            );
        },
        (samples) => {
          if (this.utterance !== run) return;
          if (!run.finishing) {
            for (const sample of samples) {
              const bounded = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
              run.meterEnergy += bounded * bounded;
            }
            run.meterSamples += samples.length;
            // PCM arrives every ~8ms; publish at ~20Hz rather than rendering each worklet block.
            if (run.meterSamples >= 800) {
              const level = Math.min(1, Math.sqrt(run.meterEnergy / run.meterSamples) * 8);
              this.audioLevel = Math.max(level, this.audioLevel * 0.65);
              run.meterEnergy = 0;
              run.meterSamples = 0;
            }
          }
          run.chunks.push(samples);
          run.samples += samples.length;
          if (run.samples > 128_000) {
            this.reportError(new Error("Dictation cannot keep up. Re-enable dictation to retry."));
            return;
          }
          if (run.samples >= 12_800 && !run.pending && !run.finishing) this.pump(run);
        },
      );
      if (this.utterance !== run) {
        capture.stop();
        return;
      }
      run.capture = capture;
      this.phase = "listening";
    } catch (error) {
      if (this.utterance === run) this.reportError(error);
    }
  }
  private async transcribe(run: Utterance, final: boolean) {
    const utteranceId = run.id;
    const chunks = run.chunks;
    run.chunks = [];
    run.samples = 0;
    const text = await this.props.client.transcribe(
      { utteranceId, pcm: encodePcm(chunks), final, settings: run.settings },
      { signal: this.signal },
    );
    if (this.utterance === run && run.id === utteranceId) {
      run.rawText = text;
      const cleaned = this.textProcessingMode !== "raw" && run.cleanedRaw === text;
      const span = run.target.replace(cleaned ? (run.cleanedText ?? text) : text);
      this.provisionalText =
        this.textProcessingMode !== "raw" && !cleaned && span ? span : undefined;
    }
  }
  setTextProcessingMode(mode: TextProcessingMode): void {
    this.textProcessingMode = mode;
    this.provisionalText = undefined;
    const run = this.utterance;
    if (!run) return;
    run.cleanupDue = false;
    run.cleanupController.abort();
    run.cleanupController = new AbortController();
    run.cleanupPending = undefined;
    run.cleanedRaw = undefined;
    run.cleanedText = undefined;
  }
  private scheduleCleanup(run: Utterance) {
    if (
      !run.cleanupDue ||
      run.pending ||
      this.textProcessingMode !== "utility" ||
      run.finishing ||
      run.cleanupPending
    )
      return;
    run.cleanupDue = false;
    const pending = this.clean(run).finally(() => {
      if (run.cleanupPending !== pending) return;
      run.cleanupPending = undefined;
      if (this.utterance === run) this.scheduleCleanup(run);
    });
    run.cleanupPending = pending;
  }
  private async clean(run: Utterance) {
    if (this.textProcessingMode === "raw" || !run.rawText.trim() || run.cleanedRaw === run.rawText)
      return;
    const raw = run.rawText;
    const id = run.id;
    const signal = AbortSignal.any([
      this.signal,
      run.controller.signal,
      run.cleanupController.signal,
    ]);
    let text = raw;
    try {
      text = await this.props.postProcess(raw, { signal });
    } catch {
      // Optional cleanup must not lose speech or prevent submission.
    }
    if (
      signal.aborted ||
      this.utterance !== run ||
      run.id !== id ||
      this.textProcessingMode !== "utility"
    )
      return;
    run.cleanedRaw = raw;
    run.cleanedText = text;
    if (run.rawText === raw) {
      run.target.replace(text);
      this.provisionalText = undefined;
    }
  }
  private pump(run: Utterance) {
    run.pending = this.transcribe(run, false)
      .catch((error) => {
        if (this.utterance === run) this.reportError(error);
      })
      .finally(() => {
        run.pending = undefined;
        if (this.utterance === run && !run.finishing) {
          if (run.samples >= 12_800) this.pump(run);
          else this.scheduleCleanup(run);
        }
      });
  }
  /** Detected speech may still be waiting for its first transcription. Silence is not a draft. */
  hasSpeechToFinish(id: string): boolean {
    const run = this.utterance;
    return !!run && run.target.id === id && (run.heardSpeech || !!run.rawText.trim());
  }
  /** Returns false if focus changed or recognition failed: never submit a truncated draft. */
  async finish(id: string): Promise<boolean> {
    const run = this.utterance;
    if (!this.enabled) return true;
    if (!run || run.target.id !== id || run.finishing || this.phase !== "listening") return false;
    run.finishing = true;
    this.phase = "finishing";
    this.audioLevel = 0;
    try {
      await run.capture?.finish();
      await run.pending;
      if (this.utterance !== run) return false;
      await this.transcribe(run, true);
      if (this.utterance !== run) return false;
      await run.cleanupPending;
      if (this.utterance !== run) return false;
      await this.clean(run);
      if (this.utterance !== run) return false;
      this.endUtterance();
      this.phase = "paused";
      return true;
    } catch (error) {
      if (this.utterance === run) this.reportError(error);
      return false;
    }
  }
  resume(id: string) {
    if (this.target?.id === id && this.enabled && !this.muted && this.phase === "paused")
      void this.start(this.target);
  }
  async refreshDevices() {
    try {
      this.devices = await this.props.microphone.devices();
    } catch (error) {
      this.reportError(error);
    }
  }
  setDevice(id: string) {
    this.deviceId = id;
    if (this.target && this.enabled && !this.muted && this.state?.status === "ready")
      void this.start(this.target);
  }
  get installing() {
    return this.installation !== undefined;
  }
  /** Model maintenance suspends runtime capture without writing the user's preference. */
  private async pauseForModelChange() {
    ++this.modeRevision;
    this.pauseCapture();
    try {
      if (this.props.canReleaseRecognition?.() ?? true)
        await this.props.client.release({ signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }
  async install() {
    if (this.busy) return;
    this.busy = true;
    await this.pauseForModelChange();
    this.error = undefined;
    const controller = new AbortController();
    this.installation = controller;
    try {
      await this.props.client.install({ signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) this.reportError(error);
    } finally {
      this.busy = false;
      this.installation = undefined;
    }
  }
  cancelInstall() {
    this.installation?.abort();
  }
  async useModelPath(path: string) {
    if (this.busy || !path.trim()) return;
    this.busy = true;
    await this.pauseForModelChange();
    try {
      await this.props.client.setModelPath(path.trim(), { signal: this.signal });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.busy = false;
    }
  }
  async remove() {
    if (this.busy) return;
    this.busy = true;
    await this.pauseForModelChange();
    try {
      await this.props.client.remove({ signal: this.signal });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.busy = false;
    }
  }
}
