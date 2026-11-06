import { child, createStore, snapshot, Store, untracked } from "r-state-tree";
import type {
  DictationState,
  DictationTrace,
  DictationTraceStep,
  TextProcessingMode,
  SpeechRecognitionSettings,
} from "../../contracts/dictation/dictation-data";
import type { SpeechInputSettingsStore } from "./SpeechInputSettingsStore";
import { speechRecognitionSettings } from "../../utils/speech-input-settings";
import { ClientError, type Client } from "../client/Client";
import { encodePcm, type Microphone, type MicrophoneCapture } from "../dictation/microphone";
import { openSpeechCapture, SpeechCaptureBacklogError } from "../dictation/speech-capture";
import { recordVoiceDiagnostic } from "../speech/diagnostics";
import { createReusableMicrophone } from "../dictation/reusable-microphone";
import { DictationVocabularyStore } from "./DictationVocabularyStore";
import type { ProvisionalTextSpan } from "../dictation/provisional-text";

export interface DictationTarget {
  readonly id: string;
  submissionOwner?(): string | undefined;
  submitted?(): void;
  begin(): void;
  replace(text: string): ProvisionalTextSpan | void;
  readonly submit?: () => void | Promise<void>;
}
export interface DictationSubmission {
  readonly target: DictationTarget;
  ready: boolean;
}
interface Utterance {
  /** Short desktop-log correlation ID for this startup attempt; never content. */
  attempt: string;
  startedAt: number;
  settings: SpeechRecognitionSettings;
  sendPhrase?: string;
  isolated: boolean;
  voiceCommand: boolean;
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
  completion?: Promise<boolean>;
  rawText: string;
  cleanedRaw?: string;
  cleanedText?: string;
  cleanupController: AbortController;
  quietSamples: number;
  heardSpeech: boolean;
  cleanupDue: boolean;
  cleanupPending?: Promise<void>;
  listeningSince: number;
}
export type DictationPhase = "off" | "paused" | "preparing" | "listening" | "finishing" | "error";
/** What asked for capture, recorded with each startup attempt in the desktop log. */
type StartReason =
  | "focus"
  | "enable"
  | "unmute"
  | "retry"
  | "recovery"
  | "edit"
  | "resume"
  | "device";
const attemptId = () => crypto.randomUUID().slice(0, 8);
const CLEANUP_SILENCE_SAMPLES = 3 * 16_000;
const MICROPHONE_HANDOFF_MS = 500;
const RECOVERY_DELAYS_MS = [500, 1500, 4000] as const;
const HEALTHY_LISTENING_MS = 30_000;

type FailureStage = "startup" | "detection" | "transcription" | "microphone" | "observation";
const recoveryCode = (error: unknown): string => {
  if (error instanceof SpeechCaptureBacklogError) return "audio-backlog";
  if (error instanceof ClientError) return error.dictationFailure?.code ?? error.kind;
  if (error instanceof DOMException) {
    if (
      [
        "NotAllowedError",
        "NotFoundError",
        "NotReadableError",
        "SecurityError",
        "OverconstrainedError",
      ].includes(error.name)
    )
      return error.name;
  }
  return "unknown";
};
const recoverable = new Set([
  "engine-timeout",
  "engine-exit",
  "engine-not-ready",
  "audio-backlog",
  "microphone-ended",
  "NotReadableError",
  "transport",
  "observation",
]);

/** Exact words only: ignore case, outer whitespace and recognizer punctuation at the edges. */
function commandText(text: string) {
  return text
    .trim()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "")
    .trim()
    .toLowerCase();
}

/** Window-owned voice-input workflow. Focus is take-latest; drafts retain their existing owners.
 * Main owns installation. This window persists enablement, microphone, cleanup and refocus policy
 * (last local edit wins); capture, maintenance pauses, audio and focus are ephemeral.
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
  @snapshot preventAutomaticRefocus = true;
  /** Window preference shared with voice mode; text/results remain insertion-local and ephemeral. */
  @snapshot textProcessingMode: TextProcessingMode = "raw";
  /** Mirror of the main-process mute shared by every window; survives field changes, never
   * persisted. */
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
  private targetFocused = false;
  /** Keyboard focus moved from the field into its own indicator; keeps that control mounted. */
  private indicatorFocused = false;
  /** Set once capture is requested for the target. From then on capture follows the target, not
   * DOM or window focus, until an explicit end: Escape, mute, disable, Send, another dictation
   * field, unmount, voice mode or a model change. */
  private engaged = false;
  private submission: DictationSubmission | undefined;
  private stoppedTargetId: string | undefined;
  private utterance: Utterance | undefined;
  private installation: AbortController | undefined;
  /** The model load in flight for this mode; a capture starting meanwhile awaits it. */
  private modelLoad: Promise<void> | undefined;
  /** A background preload failed with no capture waiting; the next field focus shows it. */
  private preloadFailure: unknown;
  private modeRevision = 0;
  private recoveryAttempt = 0;
  private recoveryRevision = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly microphone: ReturnType<typeof createReusableMicrophone>;
  /** This window's identity for the single cross-window capture. */
  private readonly captureOwner = crypto.randomUUID().slice(0, 8);
  /** This window's latest claim; Infinity while one is in flight so older claims never pause it. */
  private captureClaim = -1;
  private microphoneReleaseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: DictationStore["props"]) {
    super(props);
    this.microphone = createReusableMicrophone(props.microphone);
    this.effect(() => {
      const preferences = this.props.preferences.values;
      const phrase = preferences.dictationVoiceSend
        ? commandText(preferences.dictationSendPhrase) || undefined
        : undefined;
      const listening = this.phase === "listening";
      untracked(() => {
        const run = this.utterance;
        if (!listening || !run?.target.submit || run.sendPhrase === phrase || run.finishing) return;
        // Seal pending speech through ordinary finalization, never as a command. Restart
        // with the latest policy; changing Settings must not leave a stale capture active.
        void this.finish(run.target.id).then((finished) => {
          if (finished) this.resume(run.target.id);
        });
      });
    });
    this.effect(() => {
      // Hydration restores intent, not a recording or an in-flight preparation.
      untracked(() => {
        this.phase = this.enabled ? "paused" : "off";
      });
      return () => {
        this.endUtterance(false, "disposed");
        this.installation?.abort();
      };
    });
  }

  @child get vocabulary() {
    return createStore(DictationVocabularyStore, {
      client: this.props.client,
      revision: this.state?.vocabularyRevision,
    });
  }

  /** Live focus policy; capture phase and lifetime are deliberately irrelevant. */
  get suppressAutomaticRefocus() {
    return this.preventAutomaticRefocus && this.enabled && !this.muted;
  }
  setPreventAutomaticRefocus(prevent: boolean) {
    this.preventAutomaticRefocus = prevent;
  }
  get activeTargetId() {
    return this.target?.id;
  }
  /** Shown for live capture, plus the focused field's unmute/retry control; never while paused. */
  indicatorVisible(id: string) {
    if (!this.enabled || this.target?.id !== id) return false;
    if (this.indicatorFocused) return true;
    if (this.muted || this.phase === "error") return this.targetFocused;
    return (
      (this.targetFocused || this.engaged) &&
      (this.phase === "preparing" || this.phase === "listening" || this.phase === "finishing")
    );
  }
  get capturing() {
    return (
      this.utterance !== undefined || this.submission !== undefined || this.phase === "preparing"
    );
  }
  /** Muting seals visible speech and drops pending results; unmuting starts at the current caret. */
  setMuted(id: string | undefined, muted: boolean) {
    if (!this.enabled || this.target?.id !== id || this.muted === muted) return;
    this.applyMuted(muted, true);
    void Promise.resolve()
      .then(() => this.props.client.setMuted({ muted }))
      .catch(() => undefined);
  }
  /** Another window's unmute restarts only a field the user is in; the clicked window always does. */
  private applyMuted(muted: boolean, local: boolean) {
    this.muted = muted;
    if (!this.enabled) return;
    if (muted) {
      this.engaged = false;
      this.endUtterance(false, "muted");
      this.phase = "paused";
    } else {
      this.error = undefined;
      if (this.target && !this.submission && (local || this.targetFocused))
        void this.start(this.target, "unmute");
    }
  }
  /** Records this window as the capture owner; other windows pause when they observe it. */
  private claimCapture() {
    const previous = this.captureClaim;
    this.captureClaim = Number.POSITIVE_INFINITY;
    void Promise.resolve()
      .then(() => this.props.client.claim({ owner: this.captureOwner }))
      .then(
        ({ claim }) => {
          this.captureClaim = claim;
          // A newer claim may have been observed while this one was in flight.
          if (this.state) this.yieldCapture(this.state);
        },
        () => {
          this.captureClaim = previous;
        },
      );
  }
  private yieldCapture(state: DictationState) {
    if (
      state.captureOwner !== undefined &&
      state.captureOwner !== this.captureOwner &&
      state.captureClaim > this.captureClaim &&
      this.capturing
    )
      this.pauseCapture("other-window");
  }
  get label() {
    if (this.muted) return "Dictation muted";
    if (this.phase === "preparing")
      return this.recoveryAttempt
        ? `Reconnecting dictation… (${this.recoveryAttempt}/${RECOVERY_DELAYS_MS.length})`
        : "Preparing dictation… Wait to speak";
    if (this.phase === "listening") return "Listening";
    if (this.phase === "finishing") return "Finishing…";
    if (this.phase === "error")
      return this.recoveryAttempt >= RECOVERY_DELAYS_MS.length
        ? `Automatic recovery stopped. ${this.error ?? "Dictation unavailable"}`
        : (this.error ?? "Dictation unavailable");
    return "Dictation paused";
  }
  applyState(state: DictationState) {
    const run = this.utterance;
    // Only the engine becoming ready while an attempt still waits explains a stall.
    if (state.status === "ready" && this.state?.status !== "ready" && run && !run.capture)
      this.trace("engine-ready", { attempt: run.attempt });
    this.state = state;
    if (state.muted !== this.muted) this.applyMuted(state.muted, false);
    this.yieldCapture(state);
  }
  /** One concise, metadata-only desktop-log line. Logging never affects dictation. */
  private trace(step: DictationTraceStep, fields: Partial<Omit<DictationTrace, "step">> = {}) {
    // Absent details serialize away; the schema bounds every value to short metadata.
    const entry: DictationTrace = {
      ...fields,
      attempt: fields.attempt ?? this.utterance?.attempt ?? "-",
      step,
    };
    void Promise.resolve()
      .then(() => this.props.client.trace(entry))
      .catch(() => undefined);
  }
  reportError(error: unknown) {
    this.endUtterance(false, "failed");
    this.error = error instanceof Error ? error.message : String(error);
    this.phase = "error";
  }
  /** Observation reconnects itself; capture recovery still belongs to the current owner. */
  reportObservationError() {
    if (!this.utterance && !this.recoveryTimer) return;
    this.captureFailed(
      new Error("Dictation connection interrupted."),
      "observation",
      "observation",
    );
  }
  private captureFailed(
    error: unknown,
    stage: FailureStage,
    code = recoveryCode(error),
    attempt = this.utterance?.attempt,
  ) {
    const finishing = this.utterance?.finishing;
    const queuedSeconds =
      error instanceof SpeechCaptureBacklogError
        ? error.queuedSeconds
        : (this.utterance?.samples ?? 0) / 16_000;
    const target = this.target;
    this.reportError(error);
    this.trace("failed", { attempt, stage, code });
    const delay = RECOVERY_DELAYS_MS[this.recoveryAttempt];
    const retry =
      !finishing &&
      recoverable.has(code) &&
      delay !== undefined &&
      target &&
      this.enabled &&
      !this.muted &&
      !this.busy &&
      !this.signal.aborted;
    recordVoiceDiagnostic("dictation-error", {
      stage,
      code,
      queuedSeconds,
      attempt: this.recoveryAttempt,
      decision: retry ? "retry" : recoverable.has(code) ? "stopped-or-exhausted" : "manual",
    });
    if (!retry) return;
    this.recoveryAttempt++;
    this.trace("retry-scheduled", { attempt, retry: this.recoveryAttempt, elapsedMs: delay });
    this.phase = "preparing";
    const revision = this.recoveryRevision;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (
        revision !== this.recoveryRevision ||
        this.target !== target ||
        !this.enabled ||
        this.muted ||
        this.busy ||
        this.signal.aborted
      )
        return;
      recordVoiceDiagnostic("dictation-retry", { stage, code, attempt: this.recoveryAttempt });
      void this.start(target, "recovery", true);
    }, delay);
  }
  /** The error microphone is a direct manual retry, not a mute/unmute dance. */
  retry(id: string) {
    if (this.target?.id === id && this.phase === "error") void this.start(this.target, "retry");
  }
  /** `reason` names what cancelled an attempt that had not reached Listening. */
  private endUtterance(retainMicrophone = false, reason = "replaced") {
    ++this.recoveryRevision;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    clearTimeout(this.microphoneReleaseTimer);
    this.microphoneReleaseTimer = undefined;
    const run = this.utterance;
    if (run) recordVoiceDiagnostic("dictation-stop", { phase: this.phase });
    if (run && !run.capture && reason !== "failed")
      this.trace("cancelled", {
        attempt: run.attempt,
        reason,
        elapsedMs: Math.round(performance.now() - run.startedAt),
      });
    this.utterance = undefined;
    this.provisionalText = undefined;
    this.audioLevel = 0;
    run?.cleanupController.abort();
    run?.controller.abort();
    run?.capture?.stop();
    if (!retainMicrophone) this.microphone.release();
    if (run) {
      run.chunks = [];
      run.samples = 0;
    }
  }
  /** Pause the current field without changing the user's dictation preference. */
  pauseCapture(reason = "paused"): void {
    this.submission = undefined;
    this.endUtterance(false, reason);
    this.target = undefined;
    this.targetFocused = false;
    this.indicatorFocused = false;
    this.engaged = false;
    if (this.enabled) this.phase = "paused";
  }
  async setEnabled(enabled: boolean) {
    const revision = ++this.modeRevision;
    this.enabled = enabled;
    this.recoveryAttempt = 0;
    this.submission = undefined;
    this.engaged = false;
    this.error = undefined;
    this.endUtterance(false, "mode-changed");
    this.modelLoad = undefined;
    this.preloadFailure = undefined;
    this.phase = enabled ? "paused" : "off";
    if (enabled) {
      const loading = this.preload("enable");
      if (this.target && this.targetFocused) await this.start(this.target, "enable");
      await loading;
      return;
    }
    try {
      if (this.props.canReleaseRecognition?.() ?? true)
        await this.props.client.release({ signal: this.signal });
    } catch (error) {
      if (revision === this.modeRevision && !this.signal.aborted) this.reportError(error);
    }
  }
  /** Launch warms the model in the background, but only for a window whose user enabled dictation. */
  preloadOnLaunch() {
    if (this.enabled && !this.busy) void this.preload("launch");
  }
  /** Loads the model before any field asks for it, so the first focus need not wait for it.
   * A failure stays silent until the next field focus, which shows it with Retry. */
  private async preload(reason: "launch" | "enable") {
    const revision = this.modeRevision;
    const attempt = attemptId();
    this.trace("model-load-requested", { attempt, reason });
    const loading = performance.now();
    try {
      await this.loadModel();
      this.trace("model-load-finished", {
        attempt,
        elapsedMs: Math.round(performance.now() - loading),
      });
    } catch (error) {
      if (revision !== this.modeRevision || this.signal.aborted) return;
      this.trace("failed", { attempt, stage: "preload", code: recoveryCode(error) });
      // A capture that joined this load reports the failure itself.
      if (!this.utterance && this.phase !== "error") this.preloadFailure = error;
    }
  }
  /** At most one load in flight: a capture started during a preload joins it, never restarts it. */
  private loadModel(): Promise<void> {
    if (this.modelLoad) return this.modelLoad;
    const load = this.props.client.prepare({ signal: this.signal }).finally(() => {
      if (this.modelLoad === load) this.modelLoad = undefined;
    });
    this.modelLoad = load;
    return load;
  }
  focus(target: DictationTarget, intentional = true) {
    if (!intentional && this.stoppedTargetId === target.id) return;
    this.stoppedTargetId = undefined;
    this.indicatorFocused = false;
    if (this.target === target && this.targetFocused) {
      // A re-click while the spinner shows: record whether an attempt is still alive.
      if (this.phase === "preparing")
        this.trace("focus-ignored", {
          field: target.id,
          reason: this.utterance ? "already-preparing" : "no-active-attempt",
        });
      return;
    }
    // Returning to the field that kept dictating while unfocused continues the same capture.
    if (this.target === target && this.engaged && this.capturing) {
      this.targetFocused = true;
      return;
    }
    this.endUtterance(true, "focus-changed");
    this.submission = undefined;
    this.target = target;
    this.targetFocused = true;
    this.engaged = false;
    if (!this.enabled) return;
    if (this.muted || this.busy) {
      this.trace("focus-ignored", { field: target.id, reason: this.muted ? "muted" : "busy" });
      return;
    }
    const failure = this.preloadFailure;
    this.preloadFailure = undefined;
    // Another window may have loaded the model since; otherwise offer Retry, not a silent reload.
    if (failure !== undefined && this.state?.status !== "ready") {
      this.trace("focus-ignored", { field: target.id, reason: "preload-failed" });
      this.reportError(failure);
      return;
    }
    // prepare() can rebuild a failed worker; an observed backend error is not a focus veto.
    void this.start(target, "focus");
  }
  /** DOM blur never ends an engaged capture; it only stops an idle (muted or busy) field. */
  blur(id: string, toIndicator = false) {
    if (this.target?.id !== id) return;
    this.targetFocused = false;
    this.indicatorFocused = toIndicator;
    if (!this.enabled) {
      this.releaseTarget(id);
      return;
    }
    if (this.engaged) return;
    this.endUtterance(true, "blur");
    this.releaseMicrophoneSoon();
    this.phase = "paused";
  }
  leaveIndicator(id: string) {
    if (this.target?.id === id) this.indicatorFocused = false;
  }
  private releaseMicrophoneSoon() {
    // Brief field/chat transitions reuse the device; paused capture retains no audio.
    this.microphoneReleaseTimer = setTimeout(() => {
      this.microphoneReleaseTimer = undefined;
      this.microphone.release();
    }, MICROPHONE_HANDOFF_MS);
  }
  /** Release an unmounted or ineligible field regardless of its speech latch. */
  releaseTarget(id: string) {
    if (this.target?.id !== id) return;
    this.submission = undefined;
    this.endUtterance(true, "field-released");
    this.releaseMicrophoneSoon();
    this.target = undefined;
    this.targetFocused = false;
    this.indicatorFocused = false;
    this.engaged = false;
    if (this.enabled) this.phase = "paused";
  }
  /** Explicit stop keeps the visible draft, but no focus/restart callback can re-arm it. */
  stop(id: string) {
    if (this.target?.id !== id) return;
    this.stoppedTargetId = id;
    this.pauseCapture("stopped");
  }
  async prepareSubmission(owner: string): Promise<DictationSubmission | undefined> {
    const target = this.target;
    if (!target || target.submissionOwner?.() !== owner) return;
    const ticket: DictationSubmission = { target, ready: true };
    this.submission = ticket;
    if (this.phase === "listening") ticket.ready = await this.finish(target.id);
    else if (this.phase === "finishing") ticket.ready = (await this.utterance?.completion) ?? false;
    else if (this.phase === "preparing") {
      this.endUtterance(true, "submitted");
      this.phase = "paused";
    }
    if (this.submission !== ticket) ticket.ready = false;
    return ticket;
  }
  completeSubmission(ticket: DictationSubmission | undefined, submitted: boolean) {
    if (!ticket || this.submission !== ticket) return;
    this.submission = undefined;
    if (submitted) {
      this.stop(ticket.target.id);
      ticket.target.submitted?.();
    } else this.resume(ticket.target.id);
  }
  /** Manual editing/cursor movement seals visible speech and starts a new insertion. */
  restart(id: string) {
    if (
      this.target?.id !== id ||
      !this.enabled ||
      this.muted ||
      (this.submission !== undefined && this.phase !== "finishing") ||
      (!this.targetFocused && !this.engaged)
    )
      return;
    // Typing/selection changes must not bypass recovery backoff or retry a permanent error.
    if (this.phase === "error" || this.recoveryTimer) return;
    // The start is still opening the microphone and has inserted nothing: move its anchor to
    // the new caret instead of discarding the in-flight open (a click fires focus, then select).
    if (this.phase === "preparing" && this.utterance && !this.utterance.capture) {
      this.utterance.target.begin();
      return;
    }
    if (this.phase === "finishing") {
      this.submission = undefined;
      this.endUtterance();
      this.phase = "paused";
      void this.start(this.target, "edit");
      return;
    }
    const run = this.utterance;
    this.provisionalText = undefined;
    if (run && this.phase === "listening") {
      // Editing starts a new decoding generation, not a new microphone acquisition.
      run.quietSamples = 0;
      run.heardSpeech = false;
      run.isolated = false;
      run.voiceCommand = false;
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
    } else if (this.state?.status === "ready") void this.start(this.target, "edit");
  }
  private async start(target: DictationTarget, reason: StartReason, recovering = false) {
    if (this.target !== target || !this.enabled || this.muted || this.busy || this.signal.aborted)
      return;
    this.endUtterance(true, "restarted");
    this.preloadFailure = undefined;
    if (!recovering) this.recoveryAttempt = 0;
    this.error = undefined;
    recordVoiceDiagnostic("dictation-start", { attempt: this.recoveryAttempt });
    const run: Utterance = {
      attempt: attemptId(),
      startedAt: performance.now(),
      settings: speechRecognitionSettings(this.props.preferences.values),
      sendPhrase:
        this.props.preferences.values.dictationVoiceSend && target.submit
          ? commandText(this.props.preferences.values.dictationSendPhrase) || undefined
          : undefined,
      isolated: false,
      voiceCommand: false,
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
      listeningSince: 0,
    };
    this.utterance = run;
    this.engaged = true;
    this.phase = "preparing";
    this.claimCapture();
    target.begin();
    this.trace("start-requested", {
      field: target.id,
      reason,
      retry: this.recoveryAttempt || undefined,
    });
    const since = (from: number) => Math.round(performance.now() - from);
    try {
      await this.props.beforeCapture?.();
      if (this.utterance !== run) return;
      // Voice mode can have released the shared recognizer. Preparation is warm/idempotent.
      this.trace("model-load-requested", this.modelLoad ? { reason: "joined" } : {});
      const loading = performance.now();
      await this.loadModel();
      // Logged even when superseded: a finished load with no later step pinpoints the stall.
      this.trace("model-load-finished", { attempt: run.attempt, elapsedMs: since(loading) });
      if (this.utterance !== run) return;
      this.trace("mic-open-requested");
      const opening = performance.now();
      const capture = await openSpeechCapture(
        this.microphone,
        // Focus cancellation drops capture-local results, not the shared warm worker.
        (audio) =>
          this.props.client.detectSpeech(
            { ...audio, thresholds: run.settings.thresholds },
            { signal: this.signal },
          ),
        (samples, speech) => {
          if (this.utterance !== run) return;
          if (run.sendPhrase) return this.voiceAudio(run, samples, speech);
          if (run.finishing) return;
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
          if (this.utterance === run) this.captureFailed(error, "detection");
        },
        run.controller.signal,
        this.deviceId,
        () => {
          if (this.utterance === run)
            this.captureFailed(
              new Error("Microphone disconnected. Check the selected microphone."),
              "microphone",
              "microphone-ended",
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
          // Voice-send capture consumes only ordered, classified frames, never raw packets.
          if (run.sendPhrase) return;
          run.chunks.push(samples);
          run.samples += samples.length;
          if (run.samples > 128_000) {
            this.captureFailed(
              new SpeechCaptureBacklogError(run.samples / 16_000),
              "transcription",
            );
            return;
          }
          if (run.samples >= 12_800 && !run.pending && !run.finishing) this.pump(run);
        },
      );
      this.trace("mic-opened", { attempt: run.attempt, elapsedMs: since(opening) });
      if (this.utterance !== run) {
        capture.stop();
        return;
      }
      run.capture = capture;
      this.phase = "listening";
      run.listeningSince = performance.now();
      this.trace("listening", { elapsedMs: since(run.startedAt) });
      recordVoiceDiagnostic("dictation-ready", { attempt: this.recoveryAttempt });
    } catch (error) {
      if (this.utterance === run) this.captureFailed(error, "startup");
    }
  }
  private async transcribe(run: Utterance, final: boolean, commandBoundary = false) {
    const utteranceId = run.id;
    const chunks = run.chunks;
    run.chunks = [];
    run.samples = 0;
    const text = await this.props.client.transcribe(
      { utteranceId, pcm: encodePcm(chunks), final, settings: run.settings },
      { signal: this.signal },
    );
    if (this.utterance === run && run.id === utteranceId) {
      // A warm microphone alone is not proof of recovery. Reset only after sustained
      // listening AND a successful decode, including a successful silent decode.
      if (this.recoveryAttempt && performance.now() - run.listeningSince >= HEALTHY_LISTENING_MS) {
        recordVoiceDiagnostic("dictation-recovered", { attempt: this.recoveryAttempt });
        this.recoveryAttempt = 0;
      }
      // Empty/no-change recognition is not an edit: preserve the user's selection until
      // words arrive, even when background noise triggers the speech detector.
      const preferences = this.props.preferences.values;
      run.voiceCommand = !!(
        commandBoundary &&
        run.sendPhrase &&
        preferences.dictationVoiceSend &&
        commandText(preferences.dictationSendPhrase) === run.sendPhrase &&
        commandText(text) === run.sendPhrase &&
        run.target.submit
      );
      if (run.voiceCommand) {
        run.rawText = "";
        run.target.replace("");
        this.provisionalText = undefined;
        return;
      }
      if (text.trim() === run.rawText.trim()) return;
      run.rawText = text;
      const cleaned = this.textProcessingMode !== "raw" && run.cleanedRaw === text;
      const span = run.target.replace(cleaned ? (run.cleanedText ?? text) : text);
      this.provisionalText =
        this.textProcessingMode !== "raw" && !cleaned && span ? span : undefined;
    }
  }
  /** Three seconds of classified quiet bound a whole recognition generation. Native ASR
   * endpoints/capacity commits and transport fragments are never command boundaries.
   * Awaited by openSpeechCapture so later audio cannot leak into the final flush. */
  private async voiceAudio(run: Utterance, samples: Float32Array, speech: boolean) {
    const id = run.id;
    run.chunks.push(samples);
    run.samples += samples.length;
    if (speech) {
      run.heardSpeech = true;
      run.quietSamples = 0;
    } else run.quietSamples += samples.length;
    if (run.finishing) return;
    if (run.quietSamples >= CLEANUP_SILENCE_SAMPLES) {
      if (run.heardSpeech) {
        await this.transcribe(run, true, run.isolated);
        if (this.utterance !== run || run.id !== id) return;
        if (run.voiceCommand && !run.finishing) {
          const target = run.target;
          // Invalidate before calling the ordinary Send owner, including synchronous draft reset.
          this.endUtterance();
          this.phase = "paused";
          await target.submit?.();
          this.resume(target.id);
          return;
        }
        await this.clean(run);
        if (this.utterance !== run || run.id !== id) return;
        run.target.begin();
        run.id = crypto.randomUUID();
        run.rawText = "";
        run.voiceCommand = false;
        run.cleanedRaw = undefined;
        run.cleanedText = undefined;
        this.provisionalText = undefined;
      }
      run.heardSpeech = false;
      run.isolated = true;
      // No audio crosses this acoustic boundary, even during a long quiet period.
      run.chunks = [];
      run.samples = 0;
    } else if (run.samples >= 12_800) await this.transcribe(run, false);
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
    const id = run.id;
    run.pending = this.transcribe(run, false)
      .catch((error) => {
        if (this.utterance === run && run.id === id) this.captureFailed(error, "transcription");
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
  finish(id: string): Promise<boolean> {
    const run = this.utterance;
    if (!this.enabled) return Promise.resolve(true);
    if (!run || run.target.id !== id || run.finishing || this.phase !== "listening")
      return Promise.resolve(false);
    run.completion = this.finishRun(run);
    return run.completion;
  }
  private async finishRun(run: Utterance): Promise<boolean> {
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
      if (this.utterance === run) {
        recordVoiceDiagnostic("dictation-error", {
          stage: "finish",
          code: recoveryCode(error),
          decision: "manual",
        });
        this.reportError(error);
      }
      return false;
    }
  }
  resume(id: string) {
    if (
      this.target?.id === id &&
      !this.submission &&
      (this.targetFocused || this.engaged) &&
      this.enabled &&
      !this.muted &&
      this.phase === "paused"
    )
      void this.start(this.target, "resume");
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
      !this.submission &&
      (this.targetFocused || this.engaged) &&
      this.enabled &&
      !this.muted &&
      this.state?.status === "ready"
    )
      void this.start(this.target, "device");
  }
  get installing() {
    return this.installation !== undefined;
  }
  /** Model maintenance suspends runtime capture without writing the user's preference. */
  private async pauseForModelChange() {
    ++this.modeRevision;
    this.pauseCapture("model-change");
    this.modelLoad = undefined;
    this.preloadFailure = undefined;
    try {
      if (this.props.canReleaseRecognition?.() ?? true)
        await this.props.client.release({ signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }
  async install(vocabulary = false) {
    if (this.busy) return;
    this.busy = true;
    await this.pauseForModelChange();
    this.error = undefined;
    const controller = new AbortController();
    this.installation = controller;
    try {
      if (vocabulary) await this.props.client.installVocabulary({ signal: controller.signal });
      else await this.props.client.install({ signal: controller.signal });
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
