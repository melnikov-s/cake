import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeechPlayback } from "../../../src/renderer/speech/playback";
import type { SpeechOutputAudio } from "../../../src/domain/speech/speech-output-data";

function audio(samples: number[]): SpeechOutputAudio {
  const bytes = new Uint8Array(samples.length * 2),
    view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return { encoding: "pcm_s16le", sampleRate: 24000, pcm: btoa(String.fromCharCode(...bytes)) };
}
function webAudio() {
  const contexts: Context[] = [];
  class Node {
    buffer: { data: Float32Array } | undefined;
    onended: (() => void) | undefined;
    startAt = 0;
    stop = vi.fn();
    disconnect = vi.fn();
    connect = vi.fn();
    start(at: number) {
      this.startAt = at;
    }
    end() {
      this.onended?.();
    }
  }
  class Context {
    currentTime = 0;
    destination = {};
    nodes: Node[] = [];
    close = vi.fn(async () => {});
    resume = vi.fn(async () => {});
    constructor() {
      contexts.push(this);
    }
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      return { data, getChannelData: () => data };
    }
    createBufferSource() {
      const node = new Node();
      this.nodes.push(node);
      return node;
    }
  }
  vi.stubGlobal("AudioContext", Context);
  return contexts;
}
afterEach(() => vi.unstubAllGlobals());
describe("streaming speech playback", () => {
  it("schedules mono signed little-endian PCM in chunk order without waiting for the whole reply", async () => {
    const contexts = webAudio(),
      playback = createSpeechPlayback(),
      signal = new AbortController().signal;
    await playback.start(signal);
    await playback.enqueue(audio([-32768, 0, 32767]), signal);
    await playback.enqueue(audio([100]), signal);
    expect(contexts[0]!.nodes[0]!.buffer!.data).toEqual(new Float32Array([-1, 0, 32767 / 32768]));
    expect(contexts[0]!.nodes[1]!.startAt).toBe(3 / 24000);
    playback.stop();
  });
  it("backpressures enqueue to a bounded five-second scheduled-audio window", async () => {
    const contexts = webAudio(),
      playback = createSpeechPlayback(),
      signal = new AbortController().signal;
    await playback.start(signal);
    const chunk = audio(Array(24000).fill(0));
    for (let i = 0; i < 5; i++) await playback.enqueue(chunk, signal);
    const pending = playback.enqueue(chunk, signal);
    await Promise.resolve();
    expect(contexts[0]!.nodes).toHaveLength(5);
    contexts[0]!.currentTime = 1;
    contexts[0]!.nodes[0]!.end();
    await pending;
    expect(contexts[0]!.nodes[5]!.startAt).toBe(5);
    playback.stop();
  });
  it("stop immediately silences scheduled nodes and a fresh start cannot receive stale-generation audio", async () => {
    const contexts = webAudio(),
      playback = createSpeechPlayback(),
      controller = new AbortController();
    await playback.start(controller.signal);
    const chunk = audio(Array(24000).fill(0));
    for (let i = 0; i < 5; i++) await playback.enqueue(chunk, controller.signal);
    const stale = playback.enqueue(chunk, controller.signal);
    const rejection = expect(stale).rejects.toThrow("stopped");
    playback.stop();
    expect(contexts[0]!.nodes.every((node) => node.stop.mock.calls.length === 1)).toBe(true);
    await playback.start(new AbortController().signal);
    await rejection;
    expect(contexts[1]!.nodes).toHaveLength(0);
    playback.stop();
  });
  it("drain waits for the last audible sample, and abort/disposal release pending waits and the audio context", async () => {
    const contexts = webAudio(),
      playback = createSpeechPlayback(),
      controller = new AbortController();
    await playback.start(controller.signal);
    await playback.enqueue(audio([1]), controller.signal);
    let drained = false;
    const drain = playback.drain(controller.signal).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    contexts[0]!.nodes[0]!.end();
    await drain;
    expect(drained).toBe(true);
    await playback.enqueue(audio([1]), controller.signal);
    const cancelled = playback.drain(controller.signal);
    const rejection = expect(cancelled).rejects.toThrow();
    controller.abort();
    await rejection;
    expect(contexts[0]!.close).toHaveBeenCalledOnce();
  });
  it("rejects malformed base64, oversized or sample-misaligned PCM before playback", async () => {
    const contexts = webAudio(),
      playback = createSpeechPlayback(),
      signal = new AbortController().signal;
    await playback.start(signal);
    for (const pcm of ["!!==", "AA==", "A".repeat(87388), ""])
      await expect(
        playback.enqueue({ encoding: "pcm_s16le", sampleRate: 24000, pcm }, signal),
      ).rejects.toThrow("Invalid speech audio");
    expect(contexts[0]!.nodes).toHaveLength(0);
    playback.stop();
  });
});
