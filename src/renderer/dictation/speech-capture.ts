import type { Client } from "../client/Client";
import { encodePcm, type Microphone, type MicrophoneCapture } from "./microphone";

const FRAME_SAMPLES = 4096;
const MAX_PENDING_SAMPLES = 128_000;

/** Capture adapter: ordered native detection with bounded, capture-local PCM buffering.
 * Stores still own utterances, send policy and interruption decisions. No audio is persisted.
 */
export async function openSpeechCapture(
  microphone: Microphone,
  detect: Client["dictation"]["detectSpeech"],
  onAudio: (samples: Float32Array, speech: boolean) => void,
  onError: (error: unknown) => void,
  signal: AbortSignal,
  deviceId: string,
  onEnded: () => void,
  onSamples?: (samples: Float32Array) => void,
): Promise<MicrophoneCapture> {
  const captureId = crypto.randomUUID();
  let buffered = new Float32Array(0);
  const queue: Float32Array[] = [];
  let queuedSamples = 0;
  let pending: Promise<void> | undefined;
  let stopped = false;
  let capture: MicrophoneCapture | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    buffered = new Float32Array(0);
    queue.length = 0;
    queuedSamples = 0;
    capture?.stop();
    signal.removeEventListener("abort", stop);
  };
  const pump = () => {
    if (pending || stopped || signal.aborted) return;
    pending = (async () => {
      while (queue.length && !stopped && !signal.aborted) {
        const samples = queue.shift();
        if (!samples) return;
        const speech = await detect({ captureId, pcm: encodePcm([samples]) }, { signal });
        if (!stopped && !signal.aborted) {
          queuedSamples -= samples.length;
          onAudio(samples, speech);
        }
      }
    })()
      .catch((error) => {
        if (!stopped && !signal.aborted) {
          stop();
          onError(error);
        }
      })
      .finally(() => {
        pending = undefined;
        if (queue.length) pump();
      });
  };
  const enqueue = (samples: Float32Array) => {
    queue.push(samples);
    queuedSamples += samples.length;
    if (queuedSamples > MAX_PENDING_SAMPLES) {
      stop();
      onError(new Error("Speech detection cannot keep up. Re-enter conversation mode to retry."));
      return;
    }
    pump();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    capture = await microphone.open(
      (samples) => {
        if (stopped || signal.aborted) return;
        onSamples?.(samples);
        if (stopped || signal.aborted) return;
        const joined = new Float32Array(buffered.length + samples.length);
        joined.set(buffered);
        joined.set(samples, buffered.length);
        let offset = 0;
        while (joined.length - offset >= FRAME_SAMPLES && !stopped) {
          enqueue(joined.slice(offset, offset + FRAME_SAMPLES));
          offset += FRAME_SAMPLES;
        }
        if (!stopped) buffered = joined.slice(offset);
      },
      signal,
      deviceId,
      onEnded,
    );
    if (signal.aborted || stopped) {
      if (stopped) capture.stop();
      else stop();
      signal.throwIfAborted();
      throw new Error("Speech capture stopped during startup");
    }
    return {
      stop,
      async finish() {
        await capture?.finish();
        if (!stopped && buffered.length) {
          enqueue(buffered);
          buffered = new Float32Array(0);
        }
        while (pending) await pending;
        stop();
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
