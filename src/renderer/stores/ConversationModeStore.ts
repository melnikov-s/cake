import { Store, createContext, untracked } from "r-state-tree";
import type { UiPart } from "../../ipc/session-contract";
import type { SpeechOutputSettings } from "../../domain/speech/speech-output-data";
import type { SpeechOutputCommands, Client } from "../client/Client";
import { encodePcm, type Microphone, type MicrophoneCapture } from "../dictation/microphone";
import type { SpeechPlayback } from "../speech/playback";
import { takeSpokenPhrases } from "../speech/spoken-text";

export interface ConversationModeTarget {
  readonly sessionId: string;
  parts(): readonly UiPart[];
  canEnter(): boolean;
  submitUtterance(text: string): Promise<boolean>;
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
}

/** Window-only owner: ephemeral audio, VAD, recognition, submission and spoken-prose cursors. */
export class ConversationModeStore extends Store<ConversationModeStoreProps> {
  phase: "off" | "preparing" | "active" | "error" = "off";
  sessionId: string | undefined;
  muted = false;
  listening = false;
  speaking = false;
  transcript = "";
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
    this.utterance = undefined;
    this.finalizing = [];
    this.preroll = [];
    this.onset = 0;
    this.listening = false;
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
    const speech = Math.sqrt(energy / Math.max(1, samples.length)) > 0.025;
    let run = this.utterance;
    if (!run) {
      this.preroll.push(samples);
      while (
        this.preroll.reduce((sum, chunk) => sum + chunk.length, 0) > 9600 &&
        this.preroll.length > 1
      )
        this.preroll.shift();
      this.onset = speech ? this.onset + samples.length : 0;
      if (this.onset < 6400) return;
      this.interrupt();
      run = {
        id: crypto.randomUUID(),
        chunks: this.preroll,
        samples: this.preroll.reduce((sum, chunk) => sum + chunk.length, 0),
        duration: 0,
        quiet: 0,
        finishing: false,
      };
      this.preroll = [];
      this.onset = 0;
      this.utterance = run;
      this.transcript = "";
    } else {
      run.chunks.push(samples);
      run.samples += samples.length;
    }
    run.duration += samples.length;
    run.quiet = speech ? 0 : run.quiet + samples.length;
    const backlog = run.samples + this.finalizing.reduce((sum, item) => sum + item.samples, 0);
    if (backlog > 128000) {
      this.fail(new Error("Recognition cannot keep up. Re-enter conversation mode to retry."));
      return;
    }
    if (run.quiet >= 14400 || run.duration >= 480000) {
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
      this.transcript = text;
      if (final) {
        this.finalizing.shift();
        if (text.trim() && this.target) {
          const accepted = await this.target.submitUtterance(text.trim());
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
