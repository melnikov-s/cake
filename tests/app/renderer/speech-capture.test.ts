import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import type { Microphone } from "../../../src/renderer/dictation/microphone";
import { openSpeechCapture } from "../../../src/renderer/dictation/speech-capture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function microphone() {
  let callback: (samples: Float32Array) => void = () => {};
  const stop = vi.fn();
  const finish = vi.fn(async () => {});
  const device: Microphone = {
    open: async (onAudio) => {
      callback = onAudio;
      return { stop, finish };
    },
    devices: async () => [],
  };
  return { device, stop, finish, push: (samples: Float32Array) => callback(samples) };
}

describe("native speech capture adapter", () => {
  it("serializes detector calls, preserves audio order and flushes a final partial frame", async () => {
    const mic = microphone();
    const first = deferred<boolean>();
    const detect = vi
      .fn<Client["dictation"]["detectSpeech"]>()
      .mockImplementationOnce(async () => first.promise)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const audio = vi.fn();
    const error = vi.fn();
    const capture = await openSpeechCapture(
      mic.device,
      detect,
      audio,
      error,
      new AbortController().signal,
      "usb",
      () => {},
    );
    mic.push(new Float32Array(4096).fill(0.1));
    mic.push(new Float32Array(4096).fill(0.2));
    mic.push(new Float32Array(37).fill(0.3));
    expect(detect).toHaveBeenCalledTimes(1);
    const finish = capture.finish();
    first.resolve(true);
    await finish;
    expect(detect).toHaveBeenCalledTimes(3);
    expect(new Set(detect.mock.calls.map(([request]) => request.captureId)).size).toBe(1);
    expect(
      audio.mock.calls.map(([samples, speech]) => [samples.length, samples[0], speech]),
    ).toEqual([
      [4096, Math.fround(0.1), true],
      [4096, Math.fround(0.2), false],
      [37, Math.fround(0.3), true],
    ]);
    expect(error).not.toHaveBeenCalled();
    expect(mic.finish).toHaveBeenCalledTimes(1);
    expect(mic.stop).toHaveBeenCalledTimes(1);
  });
  it("drops late detection and buffered frames on capture cancellation", async () => {
    const mic = microphone();
    const result = deferred<boolean>();
    const detect = vi.fn<Client["dictation"]["detectSpeech"]>(async () => result.promise);
    const audio = vi.fn(),
      error = vi.fn();
    const controller = new AbortController();
    const capture = await openSpeechCapture(
      mic.device,
      detect,
      audio,
      error,
      controller.signal,
      "",
      () => {},
    );
    mic.push(new Float32Array(8192));
    controller.abort();
    result.resolve(true);
    await capture.finish();
    capture.stop();
    expect(audio).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(mic.stop).toHaveBeenCalledTimes(1);
  });
  it("fails visibly instead of accumulating an unbounded detection backlog", async () => {
    const mic = microphone();
    const result = deferred<boolean>();
    const detect = vi.fn<Client["dictation"]["detectSpeech"]>(async () => result.promise);
    const audio = vi.fn(),
      error = vi.fn();
    const capture = await openSpeechCapture(
      mic.device,
      detect,
      audio,
      error,
      new AbortController().signal,
      "",
      () => {},
    );
    mic.push(new Float32Array(33 * 4096));
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("cannot keep up") }),
    );
    expect(mic.stop).toHaveBeenCalledTimes(1);
    result.resolve(true);
    await capture.finish();
    expect(audio).not.toHaveBeenCalled();
    expect(detect).toHaveBeenCalledTimes(1);
  });
});
