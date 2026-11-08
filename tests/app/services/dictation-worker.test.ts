import type { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ParakeetWorker } from "../../../src/services/dictation/local-parakeet";

interface FakeProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}
const native = vi.hoisted(() => ({ processes: [] as FakeProcess[] }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    spawn: () => {
      const process = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      native.processes.push(process);
      return process;
    },
  };
});
beforeEach(() => {
  vi.useFakeTimers();
  native.processes.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});
const worker = () => new ParakeetWorker("/helper", "/model", "/vocabulary");
const readyWorker = async () => {
  const active = worker();
  native.processes[0]!.stdout.write('{"ready":true}\n');
  await active.ready;
  return active;
};

it("classifies unexpected connection loss during both startup and warm inference as recoverable", async () => {
  const active = await readyWorker();
  const result = active.transcribe({ utteranceId: "field", pcm: "", final: false });
  native.processes[0]!.emit("exit", 1, null);
  await expect(result).rejects.toMatchObject({ code: "engine-exit" });
  const startup = worker();
  native.processes[1]!.stderr.write("Model configuration invalid");
  native.processes[1]!.emit("exit", 1, null);
  await expect(startup.ready).rejects.toMatchObject({ code: "engine-exit" });
});

it("does not mistake a resolved startup promise for a healthy retained worker after idle disconnect", async () => {
  const active = await readyWorker();
  await active.prepare();
  native.processes[0]!.emit("exit", 1, null);
  await expect(active.prepare()).rejects.toMatchObject({ code: "engine-exit" });
});

it("enforces the existing 30-second inference deadline with a typed timeout and kills the worker", async () => {
  const active = await readyWorker();
  const result = expect(
    active.detectSpeech({ captureId: "capture", pcm: "" }),
  ).rejects.toMatchObject({ code: "engine-timeout" });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(native.processes[0]!.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(native.processes[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});

it("keeps startup's 180-second deadline and explicit close distinct from transient failures", async () => {
  const startup = worker();
  const result = expect(startup.ready).rejects.toMatchObject({ code: "engine-timeout" });
  await vi.advanceTimersByTimeAsync(180_000);
  await result;
  const active = worker();
  const stopped = expect(active.ready).rejects.toMatchObject({ code: "stopped" });
  active.close();
  await stopped;
});

it("keeps explicit native startup/configuration errors manual rather than restarting repeatedly", async () => {
  const active = worker();
  const result = expect(active.prepare()).rejects.not.toHaveProperty("code");
  native.processes[0]!.stdout.write('{"error":"Model configuration invalid"}\n');
  native.processes[0]!.emit("exit", 1, null);
  await result;
});

it("does not classify arbitrary native/provider error strings as retryable", async () => {
  const active = await readyWorker();
  const result = active.transcribe({ utteranceId: "field", pcm: "", final: false });
  native.processes[0]!.stdout.write(
    '{"error":"CoreML configuration or unknown provider failure"}\n',
  );
  await expect(result).rejects.not.toHaveProperty("code");
  active.close();
});
