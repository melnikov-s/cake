import type { SpeechOutputAudio } from "../../domain/speech/speech-output-data";
import { recordVoiceDiagnostic } from "./diagnostics";

const RESUME_TIMEOUT_MS = 5000;

export interface SpeechPlayback {
  start(signal: AbortSignal): Promise<void>;
  enqueue(audio: SpeechOutputAudio, signal: AbortSignal): Promise<void>;
  drain(signal: AbortSignal): Promise<void>;
  stop(): void;
}

/** PCM is scheduled as it arrives. Node completion supplies demand, not a polling/retry loop. */
export function createSpeechPlayback(): SpeechPlayback {
  let context: AudioContext | undefined;
  let generation = 0;
  let tail = 0;
  let loggedChunk = false;
  const nodes = new Set<AudioBufferSourceNode>();
  const waiters = new Set<() => void>();
  let detach: (() => void) | undefined;
  const wake = () => {
    for (const resolve of waiters) resolve();
  };
  const stop = () => {
    generation++;
    detach?.();
    detach = undefined;
    for (const node of nodes) {
      node.disconnect();
      node.stop();
    }
    nodes.clear();
    const old = context;
    context = undefined;
    tail = 0;
    wake();
    if (old) {
      old.onstatechange = null;
      recordVoiceDiagnostic("playback-stop", { state: old.state });
      void old.close().catch(() => {});
    }
  };
  const wait = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  const current = (revision: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (revision !== generation || !context) throw new Error("Speech playback stopped");
    if (context.state !== "running")
      throw new Error(
        `Speech audio is ${context.state}. Check your audio output device and re-enter voice mode.`,
      );
    return context;
  };
  return {
    stop,
    async start(signal) {
      signal.throwIfAborted();
      // Keep the context opened on entry instead of closing/recreating it for
      // every output batch. Rebind cancellation to the current output owner.
      detach?.();
      const revision = generation;
      const audio = context ?? new AudioContext({ sampleRate: 24000 });
      context = audio;
      signal.addEventListener("abort", stop, { once: true });
      detach = () => signal.removeEventListener("abort", stop);
      audio.onstatechange = () => {
        recordVoiceDiagnostic("playback-state", { state: audio.state });
        wake();
      };
      loggedChunk = false;
      recordVoiceDiagnostic("playback-start", { state: audio.state });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cancelled: (() => void) | undefined;
      try {
        await Promise.race([
          audio.resume(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Speech audio did not start. Check your audio output device and re-enter voice mode.",
                  ),
                ),
              RESUME_TIMEOUT_MS,
            );
            cancelled = () => reject(signal.reason);
            signal.addEventListener("abort", cancelled, { once: true });
            if (signal.aborted) cancelled();
          }),
        ]);
        current(revision, signal);
        recordVoiceDiagnostic("playback-ready", { state: audio.state });
      } catch (error) {
        if (revision === generation) stop();
        throw error;
      } finally {
        clearTimeout(timeout);
        if (cancelled) signal.removeEventListener("abort", cancelled);
      }
    },
    async enqueue(audio, signal) {
      const revision = generation;
      current(revision, signal);
      if (
        audio.encoding !== "pcm_s16le" ||
        audio.sampleRate !== 24000 ||
        audio.pcm.length > 87384 ||
        audio.pcm.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.pcm)
      )
        throw new Error("Invalid speech audio");
      const binary = atob(audio.pcm);
      if (!binary.length || binary.length > 65536 || binary.length % 2 !== 0)
        throw new Error("Invalid speech audio");
      const duration = binary.length / 2 / 24000;
      let ctx = current(revision, signal);
      while (Math.max(tail, ctx.currentTime) + duration - ctx.currentTime > 5) {
        await wait(signal);
        ctx = current(revision, signal);
      }
      const buffer = ctx.createBuffer(1, binary.length / 2, 24000);
      const data = buffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const value = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
        data[i] = (value >= 32768 ? value - 65536 : value) / 32768;
        peak = Math.max(peak, Math.abs(data[i]!));
      }
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      nodes.add(node);
      node.onended = () => {
        nodes.delete(node);
        node.disconnect();
        wake();
      };
      const start = Math.max(tail, ctx.currentTime);
      tail = start + duration;
      node.start(start);
      // First chunk of a batch is enough to establish amplitude/device state;
      // avoid filling the console/report with every 80 ms native frame.
      if (!loggedChunk) {
        loggedChunk = true;
        recordVoiceDiagnostic("playback-chunk", {
          state: ctx.state,
          samples: data.length,
          peak,
          queuedSeconds: tail - ctx.currentTime,
        });
      }
    },
    async drain(signal) {
      const revision = generation;
      current(revision, signal);
      while (nodes.size) {
        await wait(signal);
        current(revision, signal);
      }
    },
  };
}
