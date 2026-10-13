import workletUrl from "./pcm-worklet.js?url";

export interface MicrophoneCapture {
  /** Finish already-delivered audio before closing the device. */
  finish(): Promise<void>;
  stop(): void;
}
export interface MicrophoneSession extends MicrophoneCapture {
  /** Drain queued worklet messages before handing the device to a new insertion. */
  discardPending(): Promise<void>;
}
export interface Microphone {
  open(
    onAudio: (samples: Float32Array) => void,
    signal: AbortSignal,
    deviceId: string,
    onEnded: () => void,
  ): Promise<MicrophoneSession>;
  devices(): Promise<ReadonlyArray<{ id: string; label: string }>>;
}

export const microphone: Microphone = {
  async devices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      }));
  },
  async open(onAudio, signal, deviceId, onEnded) {
    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Microphone startup cancelled");
    }
    const context = new AudioContext({ sampleRate: 16000 });
    let stopped = false;
    const flushes: Array<() => void> = [];
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      for (const resolve of flushes) resolve();
      flushes.length = 0;
      signal.removeEventListener("abort", stop);
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      await context.audioWorklet.addModule(workletUrl);
      signal.throwIfAborted();
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, "cake-dictation-pcm");
      const silent = context.createGain();
      silent.gain.value = 0;
      const discardPending = () =>
        new Promise<void>((resolve) => {
          if (stopped) return resolve();
          flushes.push(resolve);
          processor.port.postMessage("flush");
        });
      processor.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "flushed") {
          flushes.shift()?.();
        } else if (!stopped && event.data instanceof Float32Array) onAudio(event.data);
      };
      for (const track of stream.getAudioTracks())
        track.addEventListener("ended", onEnded, { once: true });
      source.connect(processor).connect(silent).connect(context.destination);
      await context.resume();
      signal.throwIfAborted();
      return {
        stop,
        discardPending,
        async finish() {
          if (stopped) return;
          source.disconnect();
          await discardPending();
          stop();
        },
      };
    } catch (error) {
      stop();
      throw error;
    }
  },
};

export function encodePcm(chunks: readonly Float32Array[]): string {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length * 4);
  const view = new DataView(bytes.buffer);
  let index = 0;
  for (const chunk of chunks)
    for (const value of chunk) {
      // Browser audio processing can produce peaks outside [-1, 1]; keep the
      // native engine's bounded PCM contract without rejecting the recording.
      view.setFloat32(index, Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0, true);
      index += 4;
    }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
