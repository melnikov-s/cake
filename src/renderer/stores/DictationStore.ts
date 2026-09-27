import { Store } from "r-state-tree";
import type { DictationState } from "../../domain/dictation/dictation-data";
import type { Client } from "../client/Client";
import { encodePcm, type Microphone, type MicrophoneCapture } from "../dictation/microphone";

export interface DictationTarget {
  readonly id: string;
  begin(): void;
  replace(text: string): void;
}
interface Utterance {
  id: string;
  target: DictationTarget;
  controller: AbortController;
  capture?: MicrophoneCapture;
  chunks: Float32Array[];
  samples: number;
  pending?: Promise<void>;
  finishing: boolean;
}
export type DictationPhase = "off" | "paused" | "preparing" | "listening" | "finishing" | "error";

/** Window-owned voice-input workflow. Focus is take-latest; drafts retain their existing owners.
 * Installation is a projection of main; enabled mode/audio/focus are ephemeral, never persisted.
 */
export class DictationStore extends Store<{ client: Client["dictation"]; microphone: Microphone }> {
  state: DictationState | undefined;
  enabled = false;
  phase: DictationPhase = "off";
  error: string | undefined;
  modelPathDraft = "";
  deviceId = "";
  devices: ReadonlyArray<{ id: string; label: string }> = [];
  busy = false;
  private target: DictationTarget | undefined;
  private dismissedTargetId: string | undefined;
  private utterance: Utterance | undefined;
  private installation: AbortController | undefined;
  private modeRevision = 0;

  constructor(props: DictationStore["props"]) {
    super(props);
    this.effect(() => () => {
      this.endUtterance();
      this.installation?.abort();
    });
  }

  get activeTargetId() {
    return this.target?.id;
  }
  isDismissed(id: string) {
    return this.dismissedTargetId === id;
  }
  /** Stop only this focus's capture; blur makes the field eligible again. */
  dismiss(id: string) {
    if (!this.enabled || this.target?.id !== id || this.dismissedTargetId === id) return;
    this.dismissedTargetId = id;
    this.endUtterance();
    this.phase = "paused";
  }
  get label() {
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
    run?.controller.abort();
    run?.capture?.stop();
    if (run) {
      run.chunks = [];
      run.samples = 0;
    }
  }
  async setEnabled(enabled: boolean) {
    const revision = ++this.modeRevision;
    this.enabled = enabled;
    this.dismissedTargetId = undefined;
    this.error = undefined;
    this.endUtterance();
    this.phase = enabled ? "preparing" : "off";
    try {
      if (!enabled) {
        await this.props.client.release({ signal: this.signal });
        return;
      }
      await this.props.client.prepare({ signal: this.signal });
      if (revision !== this.modeRevision || this.signal.aborted) return;
      this.phase = "paused";
      if (this.target) await this.start(this.target);
    } catch (error) {
      if (revision === this.modeRevision && !this.signal.aborted) this.reportError(error);
    }
  }
  focus(target: DictationTarget) {
    if (this.target === target) return;
    this.endUtterance();
    this.dismissedTargetId = undefined;
    this.target = target;
    if (!this.enabled) return;
    if (this.state?.status === "ready") void this.start(target);
    else if (this.state?.status === "error")
      this.reportError(new Error(this.state.message ?? "Dictation unavailable"));
    else this.phase = "preparing";
  }
  blur(id: string) {
    if (this.target?.id !== id) return;
    this.endUtterance();
    this.dismissedTargetId = undefined;
    this.target = undefined;
    if (this.enabled) this.phase = "paused";
  }
  /** Manual editing/cursor movement seals visible speech and starts a new insertion. */
  restart(id: string) {
    if (
      this.target?.id !== id ||
      !this.enabled ||
      this.isDismissed(id) ||
      this.phase === "finishing"
    )
      return;
    const run = this.utterance;
    if (run && this.phase === "listening") {
      // Editing starts a new decoding generation, not a new microphone acquisition.
      run.id = crypto.randomUUID();
      run.chunks = [];
      run.samples = 0;
      run.target.begin();
    } else if (this.state?.status === "ready") void this.start(this.target);
  }
  private async start(target: DictationTarget) {
    this.endUtterance();
    const run: Utterance = {
      id: crypto.randomUUID(),
      target,
      controller: new AbortController(),
      chunks: [],
      samples: 0,
      finishing: false,
    };
    this.utterance = run;
    this.phase = "preparing";
    target.begin();
    try {
      const capture = await this.props.microphone.open(
        (samples) => {
          if (this.utterance !== run) return;
          run.chunks.push(samples);
          run.samples += samples.length;
          if (run.samples > 128_000) {
            this.reportError(new Error("Dictation cannot keep up. Re-enable dictation to retry."));
            return;
          }
          if (run.samples >= 12_800 && !run.pending && !run.finishing) this.pump(run);
        },
        run.controller.signal,
        this.deviceId,
        () => {
          if (this.utterance === run)
            this.reportError(
              new Error("Microphone disconnected. Choose a microphone and enable dictation again."),
            );
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
      { utteranceId, pcm: encodePcm(chunks), final },
      { signal: this.signal },
    );
    if (this.utterance === run && run.id === utteranceId) run.target.replace(text);
  }
  private pump(run: Utterance) {
    run.pending = this.transcribe(run, false)
      .catch((error) => {
        if (this.utterance === run) this.reportError(error);
      })
      .finally(() => {
        run.pending = undefined;
        if (this.utterance === run && !run.finishing && run.samples >= 12_800) this.pump(run);
      });
  }
  /** Returns false if focus changed or recognition failed: never submit a truncated draft. */
  async finish(id: string): Promise<boolean> {
    const run = this.utterance;
    if (!this.enabled) return true;
    if (!run || run.target.id !== id || run.finishing || this.phase !== "listening") return false;
    run.finishing = true;
    this.phase = "finishing";
    try {
      await run.capture?.finish();
      await run.pending;
      if (this.utterance !== run) return false;
      await this.transcribe(run, true);
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
    if (this.target?.id === id && this.enabled && !this.isDismissed(id) && this.phase === "paused")
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
    if (
      this.target &&
      this.enabled &&
      !this.isDismissed(this.target.id) &&
      this.state?.status === "ready"
    )
      void this.start(this.target);
  }
  get installing() {
    return this.installation !== undefined;
  }
  async install() {
    if (this.busy) return;
    this.busy = true;
    await this.setEnabled(false);
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
    await this.setEnabled(false);
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
    await this.setEnabled(false);
    try {
      await this.props.client.remove({ signal: this.signal });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.busy = false;
    }
  }
}
