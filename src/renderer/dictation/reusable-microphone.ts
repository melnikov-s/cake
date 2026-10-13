import type { Microphone, MicrophoneSession } from "./microphone";

/** Dictation owns the idle lifetime; this adapter owns only the device and its current listener.
 * Detached audio is dropped. A worklet fence drains old messages before a new listener can hear it.
 */
export function createReusableMicrophone(device: Microphone): Microphone & { release(): void } {
  interface Listener {
    audio(samples: Float32Array): void;
    ended(): void;
    ready: boolean;
    detach(): void;
  }
  interface Session {
    deviceId: string;
    controller: AbortController;
    capture?: MicrophoneSession;
    finishing?: boolean;
    listener?: Listener;
  }
  let session: Session | undefined;
  const release = () => {
    const previous = session;
    session = undefined;
    previous?.listener?.detach();
    previous?.controller.abort();
    previous?.capture?.stop();
  };
  return {
    devices: () => device.devices(),
    release,
    async open(onAudio, signal, deviceId, onEnded) {
      signal.throwIfAborted();
      if (session && (session.deviceId !== deviceId || !session.capture || session.finishing))
        release();
      const reused = session !== undefined;
      const current = (session ??= { deviceId, controller: new AbortController() });
      current.listener?.detach();
      const listener: Listener = {
        audio: onAudio,
        ended: onEnded,
        ready: false,
        detach() {
          signal.removeEventListener("abort", listener.detach);
          if (current.listener !== listener) return;
          current.listener = undefined;
          // Pending startup and finalization cannot be reused; cancellation closes them now.
          if ((!current.capture || current.finishing) && session === current) release();
        },
      };
      current.listener = listener;
      signal.addEventListener("abort", listener.detach, { once: true });
      try {
        if (!reused) {
          current.capture = await device.open(
            (samples) => {
              if (current.listener?.ready) current.listener.audio(samples);
            },
            current.controller.signal,
            deviceId,
            () => {
              const ended = current.listener?.ended;
              if (session === current) release();
              ended?.();
            },
          );
        } else {
          await current.capture!.discardPending();
        }
        signal.throwIfAborted();
        if (session !== current || current.listener !== listener)
          throw new Error("Microphone startup cancelled");
        listener.ready = true;
        return {
          stop: listener.detach,
          discardPending: () => current.capture!.discardPending(),
          async finish() {
            if (current.listener !== listener) return;
            current.finishing = true;
            await current.capture!.finish();
            if (session === current) release();
          },
        };
      } catch (error) {
        listener.detach();
        if (session === current && !current.listener) release();
        else if (session !== current) current.capture?.stop();
        throw error;
      }
    },
  };
}
