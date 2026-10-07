import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { PocketTtsState } from "../../../src/domain/speech/pocket-tts-data";
import type { SpeechOutputAudio } from "../../../src/domain/speech/speech-output-data";
import { PocketTts } from "../../../src/services/speech/PocketTts";
import { makePocketTtsLive } from "../../../src/services/speech/PocketTtsLive";

const fixture = vi.hoisted(() => ({
  content: "fixture weights\n",
  paths: ["config.json", "model.safetensors", "tokenizer.json", "embeddings/alba.safetensors"],
  constructed: 0,
  closed: 0,
  requests: [] as string[],
  blocked: false,
  started: undefined as (() => void) | undefined,
}));
vi.mock("../../../src/services/speech/pocket-tts-manifest.json", async () => {
  const { createHash } = await import("node:crypto");
  return {
    default: {
      name: "Pocket TTS 8-bit",
      voice: "alba",
      license: "CC-BY-4.0",
      files: fixture.paths.map((path) => ({
        path,
        repository: "fixture/pocket",
        revision: "pinned",
        bytes: Buffer.byteLength(fixture.content),
        sha256: createHash("sha256").update(fixture.content).digest("hex"),
      })),
    },
  };
});
// The process is the external boundary; keep real Service locking, Scope, installer and storage.
vi.mock("../../../src/services/speech/pocket-tts-worker", () => ({
  PocketTtsWorker: class {
    ready = Promise.resolve();
    private closed = false;
    private reject: ((error: Error) => void) | undefined;
    constructor() {
      fixture.constructed++;
    }
    async synthesize(text: string, signal: AbortSignal, audio: (audio: SpeechOutputAudio) => void) {
      fixture.requests.push(text);
      fixture.started?.();
      if (fixture.blocked) {
        await new Promise<void>((_resolve, reject) => {
          this.reject = reject;
          signal.addEventListener("abort", () => this.close(), { once: true });
        });
      }
      audio({ encoding: "pcm_s16le", sampleRate: 24_000, pcm: "AAA=" });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      fixture.closed++;
      this.reject?.(new Error("Cancelled native synthesis"));
    }
  },
}));

let root: string;
let helper: string;
beforeEach(async () => {
  fixture.constructed = 0;
  fixture.closed = 0;
  fixture.requests = [];
  fixture.blocked = false;
  fixture.started = undefined;
  root = await mkdtemp(join(tmpdir(), "cake-pocket-service-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  helper = join(bin, "cake-speech");
  await writeFile(helper, "fixture executable");
  await chmod(helper, 0o700);
  await writeFile(join(bin, "mlx.metallib"), "fixture shader artifact");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(fixture.content)),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
const layer = () => makePocketTtsLive(join(root, "speech"), true, helper);

describe("native Pocket TTS Service", () => {
  it.effect(
    "is inert until explicit installation/inference, persists selection, and keeps a serial warm engine",
    () =>
      Effect.gen(function* () {
        const local = yield* PocketTts;
        expect(yield* local.getState()).toMatchObject({
          engineAvailable: true,
          installed: false,
          selected: false,
        });
        const encoded = yield* Schema.encodeEffect(PocketTtsState)(yield* local.getState()).pipe(
          Effect.result,
        );
        expect(encoded._tag).toBe("Success");
        expect(fixture.constructed).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
        yield* local.select(true);
        expect(
          JSON.parse(
            yield* Effect.promise(() => readFile(join(root, "speech", "settings.json"), "utf8")),
          ),
        ).toEqual({ selected: true });
        yield* local.install();
        expect(yield* local.getState()).toMatchObject({ installed: true, installing: false });
        yield* local.synthesize({ text: "First phrase." }).pipe(Stream.runDrain);
        yield* local.synthesize({ text: "Second phrase." }).pipe(Stream.runDrain);
        expect(fixture.constructed).toBe(1);
        expect(fixture.requests).toEqual(["First phrase.", "Second phrase."]);
        yield* local.select(false);
        expect(fixture.closed).toBe(1);
        yield* local.remove();
        expect(yield* local.getState()).toMatchObject({ installed: false, selected: false });
      }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "cancellation kills active inference without retry and the next explicit request reloads",
    () =>
      Effect.gen(function* () {
        const local = yield* PocketTts;
        yield* local.install();
        fixture.blocked = true;
        const started = yield* Queue.unbounded<void>();
        fixture.started = () => {
          Queue.offerUnsafe(started, undefined);
        };
        const request = yield* local
          .synthesize({ text: "Interrupted phrase." })
          .pipe(Stream.runDrain, Effect.forkScoped);
        yield* Queue.take(started);
        yield* Fiber.interrupt(request);
        expect(fixture.closed).toBe(1);
        expect(fixture.requests).toEqual(["Interrupted phrase."]);
        fixture.blocked = false;
        yield* local.synthesize({ text: "Fresh phrase." }).pipe(Stream.runDrain);
        expect(fixture.constructed).toBe(2);
        expect(fixture.requests).toEqual(["Interrupted phrase.", "Fresh phrase."]);
      }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "cancels a download and finishes cleanup before reporting an uninstalled state or allowing retry",
    () =>
      Effect.gen(function* () {
        const local = yield* PocketTts;
        const started = yield* Queue.unbounded<void>();
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_url: string, options: RequestInit) => {
            const signal = options.signal;
            if (!signal) throw new Error("Missing download signal");
            return new Response(
              new ReadableStream({
                start(controller) {
                  signal.addEventListener(
                    "abort",
                    () => controller.error(new Error("Cancelled download")),
                    { once: true },
                  );
                  Queue.offerUnsafe(started, undefined);
                },
              }),
            );
          }),
        );
        const install = yield* local.install().pipe(Effect.forkScoped);
        yield* Queue.take(started);
        yield* Fiber.interrupt(install);
        expect(yield* local.getState()).toMatchObject({ installed: false, installing: false });
        expect(yield* Effect.promise(() => readdir(join(root, "speech")))).toEqual([]);
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response(fixture.content)),
        );
        yield* local.install();
        expect(yield* local.getState()).toMatchObject({ installed: true, installing: false });
      }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "refuses inference/download on an unsupported host without a process or network request",
    () =>
      Effect.gen(function* () {
        const local = yield* PocketTts;
        expect((yield* local.install().pipe(Effect.result))._tag).toBe("Failure");
        expect(
          (yield* local.synthesize({ text: "No fallback." }).pipe(Stream.runDrain, Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(fixture.constructed).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
      }).pipe(Effect.provide(makePocketTtsLive(join(root, "speech"), false, helper))),
  );
});
