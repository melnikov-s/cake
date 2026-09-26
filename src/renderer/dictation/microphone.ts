import workletUrl from "./pcm-worklet.js?url";

export interface MicrophoneCapture {
  /** Finish already-delivered audio before closing the device. */
  finish(): Promise<void>;
  stop(): void;
}
export interface Microphone {
  open(
    onAudio: (samples: Float32Array) => void,
    signal: AbortSignal,
    deviceId: string,
    onEnded: () => void,
  ): Promise<MicrophoneCapture>;
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
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
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
      let flushed: (() => void) | undefined;
      processor.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "flushed") flushed?.();
        else if (!stopped && event.data instanceof Float32Array) onAudio(event.data);
      };
      for (const track of stream.getAudioTracks())
        track.addEventListener("ended", onEnded, { once: true });
      source.connect(processor).connect(silent).connect(context.destination);
      await context.resume();
      signal.throwIfAborted();
      return {
        stop,
        async finish() {
          if (stopped) return;
          source.disconnect();
          await new Promise<void>((resolve) => {
            flushed = resolve;
            // Aborting focus also releases a pending flush.
            signal.addEventListener("abort", () => resolve(), { once: true });
            processor.port.postMessage("flush");
          });
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
      view.setFloat32(index, value, true);
      index += 4;
    }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
