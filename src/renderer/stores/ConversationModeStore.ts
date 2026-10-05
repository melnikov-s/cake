import { Store, createContext, untracked } from "r-state-tree";
import type { UiPart } from "../../ipc/session-contract";
import type { SpeechOutputSettings } from "../../domain/speech/speech-output-data";
import type { SpeechOutputCommands, Client } from "../client/Client";
import { encodePcm, type Microphone, type MicrophoneCapture } from "../dictation/microphone";
import type { SpeechPlayback } from "../speech/playback";
import { takeSpokenPhrases } from "../speech/spoken-text";
import { INTERRUPTION_WINDOW_MS, isSpeechInterruption } from "../speech/interruption";

export interface ConversationModeTarget {
  readonly sessionId: string;
  parts(): readonly UiPart[];
  canEnter(): boolean;
  draft(): string;
  setDraft(text: string): void;
  submitUtterance(): Promise<boolean>;
}
export interface ConversationModeStoreProps {
  speech: SpeechOutputCommands;
  recognition: Pick<Client["dictation"], "prepare" | "release" | "transcribe">;
  microphone: Microphone;
  playback: SpeechPlayback;
  settings(): SpeechOutputSettings | undefined;
  enabled(): boolean;
  onError(message: string, details?: string): void;
  activeSessionId(): string | undefined;
  deviceId(): string;
  suspendDictation(): Promise<void>;
}
export const ConversationModeContext = createContext<ConversationModeStore | undefined>();
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
  sendProgress: number | undefined;
  private target: ConversationModeTarget | undefined;
  private revision = 0;
  private controller: AbortController | undefined;
  private captureController: AbortController | undefined;
  private capture: MicrophoneCapture | undefined;
  private outputController: AbortController | undefined;
  private outputRevision = 0;
  private outputRunning = false;
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
      if (!this.props.settings()?.keyConfigured || !this.props.settings()?.voiceId)
        throw new Error("Configure an ElevenLabs key and voice in Settings → Speech output.");
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
  private updateDraft(run: Utterance, text: string): void {
    if (!this.target || run.draftInvalid) return;
    const draft = this.target.draft();
    if (run.draftText && !draft.endsWith(run.draftText)) {
      // Manual editing or submission seals this insertion; never replace the user's edits.
      run.draftInvalid = true;
      run.autoSend = false;
      this.sendProgress = undefined;
      return;
    }
    const prefix = run.draftText ? draft.slice(0, -run.draftText.length) : draft;
    run.draftText = `${prefix && !/\s$/.test(prefix) ? " " : ""}${text.trim()}`;
    this.target.setDraft(prefix + run.draftText);
  }
  private stopOutput() {
    this.outputRevision++;
    this.outputController?.abort();
    this.outputController = undefined;
    this.props.playback.stop();
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
    void this.exit();
    this.phase = "error";
    this.props.onError(
      message,
      this.transcript ? `Unaccepted speech: ${this.transcript}` : undefined,
    );
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
      const capture = await this.props.microphone.open(
        (samples) => {
          if (!signal.aborted && revision === this.revision && !this.muted) this.audio(samples);
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
  private audio(samples: Float32Array) {
    let energy = 0;
    for (const value of samples) energy += value * value;
    // Background-noise rejection for barge-in must not make ordinary listening less sensitive.
    const speech =
      Math.sqrt(energy / Math.max(1, samples.length)) >
      (this.speaking && !this.utterance ? 0.025 : 0.015);
    let run = this.utterance;
    if (!run) {
      this.preroll.push(samples);
      while (
        this.preroll.reduce((sum, chunk) => sum + chunk.length, 0) > 9600 &&
        this.preroll.length > 1
      )
        this.preroll.shift();
      this.onset = speech ? this.onset + samples.length : 0;
      // Recognition now decides barge-in; a short spoken "stop" must reach it too.
      if (this.onset < 3200) return;
      const tentative = this.speaking;
      if (!tentative) this.interrupt();
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
          ? { state: "pending", deadline: performance.now() + INTERRUPTION_WINDOW_MS }
          : undefined,
      };
      if (run.interruption) {
        const candidate = run;
        run.interruption.timer = setTimeout(
          () => this.rejectInterruption(candidate),
          INTERRUPTION_WINDOW_MS,
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
      this.sendProgress = undefined;
    } else {
      run.quiet += samples.length;
      this.sendProgress =
        run.autoSend &&
        run.interruption?.state !== "pending" &&
        run.interruption?.state !== "rejected"
          ? Math.min(1, run.quiet / 32000)
          : undefined;
    }
    const backlog = run.samples + this.finalizing.reduce((sum, item) => sum + item.samples, 0);
    if (backlog > 128000) {
      this.fail(new Error("Recognition cannot keep up. Re-enter conversation mode to retry."));
      return;
    }
    if (run.quiet >= 32000 || run.duration >= 480000) {
      run.autoSend = run.autoSend && run.quiet >= 32000;
      run.finishing = true;
      this.finalizing.push(run);
      this.utterance = undefined;
    }
    void this.pumpRecognition();
  }
  private async pumpRecognition() {
    if (this.recognitionRunning) return;
    const run = this.finalizing[0] ?? this.utterance;
    if (!run || (!run.finishing && run.samples < 12800) || !this.controller) return;
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
      const text = await this.props.recognition.transcribe(
        { utteranceId: run.id, pcm: encodePcm(chunks), final },
        { signal },
      );
      if (signal.aborted || revision !== this.revision) return;
      if (run.interruption?.state === "pending") {
        if (performance.now() >= run.interruption.deadline) this.rejectInterruption(run);
        else if (isSpeechInterruption(text)) {
          this.clearInterruptionTimer(run);
          run.interruption.state = "confirmed";
          this.interrupt();
        } else if (final) this.rejectInterruption(run);
      }
      const rejected = run.interruption?.state === "rejected";
      this.transcript = rejected ? "" : text;
      if (!rejected && run.interruption?.state !== "pending" && text.trim())
        this.updateDraft(run, text);
      if (final) {
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
      // A settled-only snapshot is history/reconnection data, not a new live reply to replay.
      if (part.status === "streaming" && this.phase === "active" && this.outputEligible)
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
      while (this.phrases.length && !signal.aborted && revision === this.outputRevision) {
        const text = this.phrases.shift();
        if (!text) break;
        await this.props.speech.synthesize(
          { text },
          async (audio) => {
            if (!signal.aborted && revision === this.outputRevision)
              await this.props.playback.enqueue(audio, signal);
          },
          { signal },
        );
        await this.props.playback.drain(signal);
      }
    } catch (error) {
      if (!signal.aborted && revision === this.outputRevision) this.fail(error);
    } finally {
      this.outputRunning = false;
      if (revision === this.outputRevision) this.speaking = false;
      if (this.phase === "active" && this.phrases.length) void this.pumpOutput();
    }
  }
}
