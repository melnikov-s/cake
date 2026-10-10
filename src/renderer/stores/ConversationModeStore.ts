import { Store, createContext, untracked } from "r-state-tree";
import type { UiPart } from "../../ipc/session-contract";
import type { TextProcessingMode } from "../../domain/dictation/dictation-data";
import { punctuationPreview } from "../../utils/punctuation-text";
import type { SpeechOutputSettings } from "../../domain/speech/speech-output-data";
import type { SpeechOutputCommands, Client } from "../client/Client";
import { encodePcm, type Microphone, type MicrophoneCapture } from "../dictation/microphone";
import { openSpeechCapture } from "../dictation/speech-capture";
import type { ProvisionalTextSpan } from "../dictation/provisional-text";
import type { SpeechPlayback } from "../speech/playback";
import { takeSpokenPhrases } from "../speech/spoken-text";
import { recordVoiceDiagnostic, voiceDiagnosticReport } from "../speech/diagnostics";
import { isSpeechInterruption } from "../speech/interruption";
import type { SpeechInputSettingsStore } from "./SpeechInputSettingsStore";
import {
  defaultSpeechInputPreferences,
  speechRecognitionSettings,
} from "../../utils/speech-input-settings";

export interface ConversationModeTarget {
  readonly sessionId: string;
  parts(): readonly UiPart[];
  canEnter(): boolean;
  draft(): string;
  setDraft(text: string): void;
  submitUtterance(): Promise<boolean>;
}
export interface ConversationModeStoreProps {
  preferences: SpeechInputSettingsStore;
  speech: SpeechOutputCommands;
  recognition: Pick<Client["dictation"], "prepare" | "release" | "transcribe" | "detectSpeech">;
  microphone: Microphone;
  postProcess: Client["workspaces"]["postProcessDictation"];
  textProcessingMode(): TextProcessingMode;
  punctuate: Client["dictation"]["punctuate"];
  playback: SpeechPlayback;
  settings(): SpeechOutputSettings | undefined;
  enabled(): boolean;
  onError(message: string, details?: string): void;
  activeSessionId(): string | undefined;
  deviceId(): string;
  suspendDictation(): Promise<void>;
}
export const ConversationModeContext = createContext<ConversationModeStore | undefined>();
// Microphone PCM is 16 kHz. Preferences are captured once per voice-mode entry.
// Three 256 ms detector frames keep progressive recognition close to its existing 800 ms cadence.
const RECOGNITION_BATCH_SAMPLES = 12_288;
interface Utterance {
  id: string;
  chunks: Float32Array[];
  samples: number;
  duration: number;
  quiet: number;
  finishing: boolean;
  autoSend: boolean;
  draftText: string;
  draftInvalid: boolean;
  interruption?: {
    state: "pending" | "confirmed" | "rejected";
    deadline: number;
    timer?: ReturnType<typeof setTimeout>;
  };
}

/** Window-only owner: ephemeral audio, VAD, recognition, submission and spoken-prose cursors.
 * Interruption candidates/timers belong to this capture generation, never persistence;
 * recognition remains serial and rejected candidates are finalized without submitting. */
export class ConversationModeStore extends Store<ConversationModeStoreProps> {
  phase: "off" | "preparing" | "active" | "error" = "off";
  sessionId: string | undefined;
  muted = false;
  listening = false;
  speaking = false;
  transcript = "";
  private provisionalText: ProvisionalTextSpan | undefined;
  get provisionalInput(): ProvisionalTextSpan | undefined {
    return this.props.textProcessingMode() !== "raw" &&
      this.provisionalText?.value === this.target?.draft()
      ? this.provisionalText
      : undefined;
  }
  sendProgress: number | undefined;
  private target: ConversationModeTarget | undefined;
  private preferences = { ...defaultSpeechInputPreferences };
  private revision = 0;
  private controller: AbortController | undefined;
  private captureController: AbortController | undefined;
  private capture: MicrophoneCapture | undefined;
  private outputController: AbortController | undefined;
  private outputRevision = 0;
  private outputRunning = false;
  // Ephemeral output-generation wakeup: lets synthesis continue while audio drains.
  private outputWake: (() => void) | undefined;
  private phrases: string[] = [];
  private cursors = new Map<string, number>();
  private users = new Set<string>();
  private liveReplies = new Set<string>();
  private outputEligible = false;
  private utterance: Utterance | undefined;
  private recognitionRunning = false;
  private finalizing: Utterance[] = [];
  private preroll: Float32Array[] = [];
  private onset = 0;
  private cleanup: Promise<void> = Promise.resolve();

  constructor(props: ConversationModeStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.activeSessionId(),
      () => {
        void this.exit();
      },
    );
    this.reaction(
      () => this.enabled,
      (enabled) => {
        if (!enabled) void this.exit();
      },
    );
    this.effect(() => {
      const parts = this.target?.parts();
      // Read the actual changing projection fields, not just array length or an ID fingerprint.
      const copy = parts?.map((part) => ({ ...part }));
      untracked(() => {
        if (copy && this.phase === "active") this.consumeParts(copy);
      });
    });
    this.effect(() => () => {
      void this.exit();
    });
  }
  get enabled(): boolean {
    return this.props.enabled();
  }
  async enter(target: ConversationModeTarget): Promise<boolean> {
    if (!this.enabled) return false;
    if (
      (this.phase === "active" || this.phase === "preparing") &&
      this.sessionId === target.sessionId
    )
      return this.phase === "active";
    await this.exit();
    if (this.signal.aborted || !this.enabled) return false;
    const revision = ++this.revision;
    this.phase = "preparing";
    this.sessionId = target.sessionId;
    this.target = target;
    this.preferences = this.props.preferences.values;
    this.transcript = "";
    this.muted = false;
    this.outputEligible = false;
    this.users.clear();
    this.cursors.clear();
    this.liveReplies.clear();
    this.consumeParts(target.parts());
    const controller = new AbortController();
    this.controller = controller;
    const signal = AbortSignal.any([controller.signal, this.signal]);
    try {
      if (!target.canEnter() || this.props.activeSessionId() !== target.sessionId)
        throw new Error("Select an existing writable Project Session to enter conversation mode.");
      const settings = this.props.settings();
      recordVoiceDiagnostic("enter", {
        provider: settings?.provider,
        phase: this.phase,
        preferences: { ...this.preferences },
      });
      if (settings?.provider === "pocket-tts") {
        if (!settings.localModel.supported)
          throw new Error("Local Pocket TTS requires Apple Silicon and macOS 14 or later.");
        if (
          !settings.localModel.engineAvailable ||
          !settings.localModel.installed ||
          settings.localModel.installing
        )
          throw new Error(
            "Download Pocket TTS in Settings → Voice & Dictation before entering voice mode.",
          );
      } else if (!settings?.keyConfigured || !settings.voiceId) {
        throw new Error("Configure an ElevenLabs key and voice in Settings → Voice & Dictation.");
      }
      await this.props.suspendDictation();
      signal.throwIfAborted();
      await this.cleanup;
      signal.throwIfAborted();
      await this.props.recognition.prepare({ signal });
      signal.throwIfAborted();
      await this.props.playback.start(signal);
      signal.throwIfAborted();
      await this.startCapture(revision);
      signal.throwIfAborted();
      if (revision !== this.revision) return false;
      this.phase = "active";
      this.listening = true;
      recordVoiceDiagnostic("active");
      return true;
    } catch (error) {
      if (revision === this.revision && !signal.aborted) this.fail(error);
      return false;
    }
  }
  async exit(): Promise<void> {
    if (this.phase === "off" && !this.controller && !this.target) {
      await this.cleanup;
      return;
    }
    recordVoiceDiagnostic("exit", { phase: this.phase });
    this.revision++;
    this.controller?.abort();
    this.controller = undefined;
    this.stopInput();
    this.stopOutput();
    this.target = undefined;
    this.sessionId = undefined;
    this.phase = "off";
    this.muted = false;
    this.cursors.clear();
    this.users.clear();
    this.liveReplies.clear();
    this.outputEligible = false;
    // Do not use the disposed Store signal: release is resource cleanup, not agent cancellation.
    this.cleanup = this.cleanup
      .catch(() => {})
      .then(() => this.props.recognition.release())
      .catch(() => {});
    await this.cleanup;
  }
  private stopInput() {
    this.provisionalText = undefined;
    this.captureController?.abort();
    this.captureController = undefined;
    this.capture?.stop();
    this.capture = undefined;
    const runs = [...this.finalizing, ...(this.utterance ? [this.utterance] : [])];
    for (const run of runs) {
      this.clearInterruptionTimer(run);
      if (run.interruption && run.interruption.state !== "confirmed") this.transcript = "";
    }
    this.utterance = undefined;
    this.finalizing = [];
    this.preroll = [];
    this.onset = 0;
    this.listening = false;
    this.sendProgress = undefined;
  }
  cancelPendingSend(): void {
    for (const run of [...this.finalizing, ...(this.utterance ? [this.utterance] : [])])
      run.autoSend = false;
    this.sendProgress = undefined;
  }
  private updateDraft(run: Utterance, text: string, provisional: boolean, pendingStart = 0): void {
    if (!this.target || run.draftInvalid) return;
    const draft = this.target.draft();
    if (run.draftText && !draft.endsWith(run.draftText)) {
      // Manual editing or submission seals this insertion; never replace the user's edits.
      run.draftInvalid = true;
      this.provisionalText = undefined;
      run.autoSend = false;
      this.sendProgress = undefined;
      return;
    }
    const prefix = run.draftText ? draft.slice(0, -run.draftText.length) : draft;
    run.draftText = text.trim() ? `${prefix && !/\s$/.test(prefix) ? " " : ""}${text.trim()}` : "";
    const value = prefix + run.draftText;
    this.provisionalText =
      provisional &&
      this.props.textProcessingMode() !== "raw" &&
      run.draftText &&
      pendingStart < text.length
        ? {
            value,
            start: prefix.length + (run.draftText.length - text.trim().length) + pendingStart,
            end: value.length,
          }
        : undefined;
    this.target.setDraft(value);
    this.updateSendProgress(run);
  }
  private updateSendProgress(run: Utterance): void {
    // This utterance must contribute recognized text; an existing typed draft
    // is not evidence that a detected noise was speech. Async recognition can
    // arrive mid-pause, so refresh here as well as at the audio boundary.
    if (run !== (this.utterance ?? this.finalizing.at(-1))) return;
    this.sendProgress =
      run.autoSend &&
      !run.draftInvalid &&
      run.draftText.trim().length > 0 &&
      run.quiet > 0 &&
      run.quiet >= this.preferences.countdownDelaySeconds * 16000 &&
      run.interruption?.state !== "pending" &&
      run.interruption?.state !== "rejected"
        ? Math.min(
            1,
            (run.quiet - this.preferences.countdownDelaySeconds * 16000) /
              ((this.preferences.sendPauseSeconds - this.preferences.countdownDelaySeconds) *
                16000),
          )
        : undefined;
  }
  private stopOutput() {
    this.outputRevision++;
    this.outputController?.abort();
    this.outputController = undefined;
    this.props.playback.stop();
    this.outputWake?.();
    this.outputWake = undefined;
    this.phrases = [];
    this.speaking = false;
  }
  async setMuted(muted: boolean): Promise<void> {
    if (this.phase !== "active" || this.muted === muted) return;
    this.muted = muted;
    this.stopInput();
    if (!muted) {
      try {
        await this.startCapture(this.revision, true);
      } catch (error) {
        if (this.phase === "active" && !this.muted) this.fail(error);
      }
    }
  }
  interrupt(): void {
    recordVoiceDiagnostic("interrupt", { state: this.speaking ? "speaking" : "idle" });
    this.stopOutput();
    this.outputEligible = false;
    // Advance raw cursors now; the interrupted reply never gets replayed.
    if (this.target) this.consumeParts(this.target.parts());
  }
  private clearInterruptionTimer(run: Utterance) {
    if (!run.interruption) return;
    clearTimeout(run.interruption.timer);
    run.interruption.timer = undefined;
  }
  private rejectInterruption(run: Utterance) {
    if (run.interruption?.state !== "pending") return;
    this.clearInterruptionTimer(run);
    run.interruption.state = "rejected";
    run.chunks = [];
    run.samples = 0;
    this.transcript = "";
    // Do not cancel native inference: finish this ID at the quiet boundary so
    // rejection neither invalidates the warm recognizer nor re-triggers on the same speech.
  }
  private fail(error: unknown) {
    const message =
      error instanceof Error ? error.message : "Conversation mode failed. Re-enter to retry.";
    recordVoiceDiagnostic("error", { phase: this.phase });
    const details = [
      message,
      this.transcript ? `Unaccepted speech: ${this.transcript}` : undefined,
      "Voice diagnostics (metadata only):",
      voiceDiagnosticReport(),
    ]
      .filter(Boolean)
      .join("\n\n");
    void this.exit();
    this.phase = "error";
    this.props.onError(message, details);
  }
  private async startCapture(revision: number, prepare = false) {
    const controller = new AbortController();
    this.captureController = controller;
    const signal = AbortSignal.any([
      controller.signal,
      this.controller?.signal ?? this.signal,
      this.signal,
    ]);
    try {
      // Native cancellation can invalidate a warm recognizer. Re-prepare under the
      // same capture generation before accepting input after mute.
      if (prepare) await this.props.recognition.prepare({ signal });
      if (signal.aborted || revision !== this.revision) return;
      const capture = await openSpeechCapture(
        this.props.microphone,
        (audio, options) =>
          this.props.recognition.detectSpeech(
            {
              ...audio,
              thresholds: {
                start: this.preferences.speechStartThreshold,
                continuation: this.preferences.speechContinueThreshold,
              },
            },
            options,
          ),
        (samples, speech) => {
          if (!signal.aborted && revision === this.revision && !this.muted)
            this.audio(samples, speech);
        },
        (error) => {
          if (!signal.aborted && revision === this.revision) this.fail(error);
        },
        signal,
        this.props.deviceId(),
        () => {
          if (!signal.aborted && revision === this.revision)
            this.fail(new Error("Microphone disconnected. Re-enter conversation mode to retry."));
        },
      );
      if (signal.aborted || revision !== this.revision) {
        capture.stop();
        return;
      }
      this.capture = capture;
      this.listening = true;
    } catch (error) {
      if (!signal.aborted && revision === this.revision) throw error;
    }
  }
  private audio(samples: Float32Array, speech: boolean) {
    let run = this.utterance;
    if (!run) {
      this.preroll.push(samples);
      while (
        this.preroll.reduce((sum, chunk) => sum + chunk.length, 0) >
          Math.max(
            this.preferences.prerollMs * 16,
            Math.ceil((this.preferences.minimumSpeechMs * 16) / 4096) * 4096,
          ) &&
        this.preroll.length > 1
      )
        this.preroll.shift();
      this.onset = speech ? this.onset + samples.length : 0;
      // Recognition now decides barge-in; a short spoken "stop" must reach it too.
      if (this.onset < this.preferences.minimumSpeechMs * 16) return;
      // Quiet input is not an interruption. Cancelling here would suppress an
      // upcoming reply (or its next sentence) even if recognition returns empty.
      // Only the transcript-confirmed barge-in path below suppresses output.
      const tentative = this.speaking;
      run = {
        id: crypto.randomUUID(),
        chunks: this.preroll,
        samples: this.preroll.reduce((sum, chunk) => sum + chunk.length, 0),
        duration: 0,
        quiet: 0,
        finishing: false,
        autoSend: true,
        draftText: "",
        draftInvalid: false,
        interruption: tentative
          ? {
              state: "pending",
              deadline: performance.now() + this.preferences.interruptionWindowMs,
            }
          : undefined,
      };
      if (run.interruption) {
        const candidate = run;
        run.interruption.timer = setTimeout(
          () => this.rejectInterruption(candidate),
          this.preferences.interruptionWindowMs,
        );
      }
      this.preroll = [];
      this.onset = 0;
      this.utterance = run;
      this.transcript = "";
    } else if (run.interruption?.state !== "rejected") {
      run.chunks.push(samples);
      run.samples += samples.length;
    }
    run.duration += samples.length;
    if (speech) {
      if (run.quiet > 0 && !run.draftInvalid) run.autoSend = true;
      run.quiet = 0;
    } else run.quiet += samples.length;
    this.updateSendProgress(run);
    const backlog = run.samples + this.finalizing.reduce((sum, item) => sum + item.samples, 0);
    if (backlog > 128000) {
      this.fail(new Error("Recognition cannot keep up. Re-enter conversation mode to retry."));
      return;
    }
    if (
      run.quiet >= this.preferences.sendPauseSeconds * 16000 ||
      run.duration >= this.preferences.maximumUtteranceSeconds * 16000
    ) {
      run.autoSend = run.autoSend && run.quiet >= this.preferences.sendPauseSeconds * 16000;
      run.finishing = true;
      this.finalizing.push(run);
      this.utterance = undefined;
    }
    void this.pumpRecognition();
  }
  private async pumpRecognition() {
    if (this.recognitionRunning) return;
    const run = this.finalizing[0] ?? this.utterance;
    if (!run || (!run.finishing && run.samples < RECOGNITION_BATCH_SAMPLES) || !this.controller)
      return;
    const revision = this.revision;
    const inputSignal = this.captureController?.signal;
    const signal = AbortSignal.any([
      this.controller.signal,
      inputSignal ?? this.signal,
      this.signal,
    ]);
    const chunks = run.chunks;
    run.chunks = [];
    run.samples = 0;
    const final = run.finishing;
    this.recognitionRunning = true;
    try {
      let text = await this.props.recognition.transcribe(
        {
          utteranceId: run.id,
          pcm: encodePcm(chunks),
          final,
          settings: speechRecognitionSettings(this.preferences),
        },
        { signal },
      );
      if (signal.aborted || revision !== this.revision) return;
      if (run.interruption?.state === "pending") {
        if (performance.now() >= run.interruption.deadline) this.rejectInterruption(run);
        else if (isSpeechInterruption(text, this.preferences)) {
          this.clearInterruptionTimer(run);
          run.interruption.state = "confirmed";
          this.interrupt();
        } else if (final) this.rejectInterruption(run);
      }
      const rejected = run.interruption?.state === "rejected";
      this.transcript = rejected ? "" : text;
      // Cumulative recognition may withdraw a provisional word. Remove only
      // this run's insertion and disarm the countdown, preserving typed text.
      if (!rejected && run.interruption?.state !== "pending" && !text.trim() && run.draftText)
        this.updateDraft(run, "", false);
      if (!rejected && run.interruption?.state !== "pending" && text.trim()) {
        const raw = text;
        const local = this.props.textProcessingMode() === "local";
        this.updateDraft(run, local ? punctuationPreview(raw) : raw, true);
        if (local && !run.draftInvalid) {
          try {
            const result = await this.props.punctuate(
              { utteranceId: run.id, text: raw, final },
              { signal },
            );
            if (signal.aborted || revision !== this.revision) return;
            if (this.props.textProcessingMode() === "local") {
              text = result.text;
              this.updateDraft(run, text, !final, result.pendingStart);
              this.transcript = text;
            } else this.updateDraft(run, raw, false);
          } catch {
            if (signal.aborted || revision !== this.revision) return;
            this.updateDraft(run, raw, false);
          }
        }
      }
      if (final) {
        if (
          !rejected &&
          run.interruption?.state !== "pending" &&
          !run.draftInvalid &&
          text.trim() &&
          this.props.textProcessingMode() === "utility"
        ) {
          const raw = text;
          try {
            text = await this.props.postProcess(raw, { signal });
          } catch {
            text = raw;
          }
          if (signal.aborted || revision !== this.revision) return;
          if (this.props.textProcessingMode() !== "utility") text = raw;
          this.updateDraft(run, text, false);
          this.transcript = text;
        }
        this.clearInterruptionTimer(run);
        this.finalizing.shift();
        if (!this.utterance) this.sendProgress = undefined;
        if (
          !rejected &&
          !run.draftInvalid &&
          run.autoSend &&
          text.trim() &&
          this.target &&
          !this.utterance &&
          !this.finalizing.length
        ) {
          const accepted = await this.target.submitUtterance();
          if (revision !== this.revision || signal.aborted) return;
          if (!accepted) {
            this.fail(
              new Error("Speech was not accepted. Copy the recognized text to retry manually."),
            );
            return;
          }
          this.transcript = "";
        }
      }
    } catch (error) {
      if (!signal.aborted && revision === this.revision) this.fail(error);
    } finally {
      this.recognitionRunning = false;
      if (this.phase === "active") void this.pumpRecognition();
    }
  }
  private consumeParts(parts: readonly UiPart[]) {
    for (const part of parts) {
      if (
        part.kind === "skill" ||
        (part.kind === "text" && part.role === "user" && !part.deliveryState && !part.draft)
      ) {
        // A saved snapshot replaces live IDs; it must not count as another input
        // and re-enable speech from a reply the user already interrupted.
        const key = part.renderKey ?? part.entryId ?? part.id;
        if (!this.users.has(key)) {
          this.users.add(key);
          if (this.phase === "active") this.outputEligible = true;
        }
      }
      if (part.kind !== "text" || part.role !== "assistant") continue;
      const key = part.renderKey ?? part.id;
      const offset = this.cursors.get(key) ?? 0;
      if (this.phase === "active" && !this.cursors.has(key))
        recordVoiceDiagnostic("reply", {
          status: part.status,
          characters: part.text.length,
          state: this.outputEligible ? "eligible" : "ineligible",
        });
      // Live completed messages have no durable entryId. A fast reply can reach
      // us only as complete after projection coalescing; it is still a new reply.
      // Durable history/reconnection snapshots and parts present at entry stay sealed.
      if (
        this.phase === "active" &&
        this.outputEligible &&
        (part.status === "streaming" ||
          (part.status === "complete" && !part.entryId && !this.cursors.has(key)))
      )
        this.liveReplies.add(key);
      if (part.status === "complete" && !this.liveReplies.has(key)) {
        this.cursors.set(key, part.text.length);
        continue;
      }
      if (!this.outputEligible || this.phase !== "active" || part.status === "error") {
        this.cursors.set(key, part.text.length);
        continue;
      }
      const result = takeSpokenPhrases(part.text, offset, part.status === "complete");
      this.cursors.set(key, result.consumedCharacters);
      this.phrases.push(...result.phrases);
    }
    if (this.phrases.length > 64) {
      this.fail(
        new Error("Speech output cannot keep up. Read the answer in chat and re-enter to retry."),
      );
      return;
    }
    if (this.phrases.length) this.outputWake?.();
    if (this.phase === "active") void this.pumpOutput();
  }
  private async pumpOutput() {
    if (this.outputRunning || !this.phrases.length || !this.controller) return;
    this.outputRunning = true;
    const revision = this.outputRevision;
    const controller = new AbortController();
    this.outputController = controller;
    const signal = AbortSignal.any([controller.signal, this.controller.signal, this.signal]);
    this.speaking = true;
    try {
      await this.props.playback.start(signal);
      while (!signal.aborted && revision === this.outputRevision) {
        const text = this.phrases.shift();
        if (!text) {
          // Race arrival of the next sentence with actual playback completion.
          // Do not insert a drain barrier between synthesis requests, including
          // sentences that arrive while the previous audio is still playing.
          let wake: (() => void) | undefined;
          const ready = new Promise<void>((resolve) => {
            wake = resolve;
          });
          this.outputWake = wake;
          try {
            const drained = await Promise.race([
              this.props.playback.drain(signal).then(() => true),
              ready.then(() => false),
            ]);
            if (drained && !this.phrases.length) break;
          } finally {
            if (this.outputWake === wake) this.outputWake = undefined;
          }
          continue;
        }
        const started = performance.now();
        let chunks = 0;
        recordVoiceDiagnostic("synthesis-start", {
          provider: this.props.settings()?.provider,
          characters: text.length,
          phrases: this.phrases.length,
        });
        await this.props.speech.synthesize(
          { text },
          async (audio) => {
            if (!signal.aborted && revision === this.outputRevision) {
              if (++chunks === 1)
                recordVoiceDiagnostic("first-audio", {
                  elapsedMillis: Math.round(performance.now() - started),
                });
              await this.props.playback.enqueue(audio, signal);
            }
          },
          { signal },
        );
        if (signal.aborted || revision !== this.outputRevision) break;
        recordVoiceDiagnostic("synthesis-complete", {
          chunks,
          elapsedMillis: Math.round(performance.now() - started),
        });
        if (!chunks)
          throw new Error("The speech provider returned no audio. Re-enter voice mode to retry.");
      }
    } catch (error) {
      if (!signal.aborted && revision === this.outputRevision) this.fail(error);
    } finally {
      this.outputRunning = false;
      if (revision === this.outputRevision) {
        this.speaking = false;
        recordVoiceDiagnostic("output-complete", {
          state: signal.aborted ? "cancelled" : "finished",
        });
      }
      if (this.phase === "active" && this.phrases.length) void this.pumpOutput();
    }
  }
}
