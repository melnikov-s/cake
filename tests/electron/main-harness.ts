import type { ElectronApplication } from "@playwright/test";
import type { CakeEvent } from "../../src/ipc/cake-rpc-contract";

/** Replace only provider HTTP, leaving secure settings, native RPC and streaming policy real. */
export function installSpeechHttpFixture(application: ElectronApplication) {
  return application.evaluate(() => {
    const original = globalThis.fetch;
    const requests: string[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    Object.assign(globalThis, { cakeSpeechFixture: { requests, streams } });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://api.elevenlabs.io/")) return original(input, init);
      if (url.endsWith("/voices"))
        return Response.json({ voices: [{ voice_id: "fixture-voice", name: "Fixture voice" }] });
      if (!url.includes("/text-to-speech/"))
        throw new Error("Unexpected speech fixture HTTP request");
      const body = JSON.parse(await new Response(init?.body).text()) as { text: string };
      requests.push(body.text);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
          },
        }),
        { headers: { "content-type": "audio/pcm" } },
      );
    };
  });
}

export function emitSpeechPcm(application: ElectronApplication, close = false) {
  return application.evaluate((_electron, close) => {
    const fixture = Reflect.get(globalThis, "cakeSpeechFixture") as {
      streams: ReadableStreamDefaultController<Uint8Array>[];
    };
    const controller = fixture.streams.at(-1);
    if (!controller) throw new Error("No provider stream opened");
    const bytes = new Uint8Array(4800);
    const samples = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length / 2; i++)
      samples.setInt16(i * 2, Math.sin(i / 20) * 8000, true);
    controller.enqueue(bytes);
    if (close) controller.close();
  }, close);
}

/** A dangling PCM sample byte exercises the real service's invalid-audio failure. */
export function emitInvalidSpeechPcm(application: ElectronApplication) {
  return application.evaluate(() => {
    const fixture = Reflect.get(globalThis, "cakeSpeechFixture") as {
      streams: ReadableStreamDefaultController<Uint8Array>[];
    };
    const controller = fixture.streams.at(-1);
    if (!controller) throw new Error("No provider stream opened");
    controller.enqueue(new Uint8Array([0]));
    controller.close();
  });
}

export function speechHttpRequests(application: ElectronApplication) {
  return application.evaluate(() =>
    (Reflect.get(globalThis, "cakeSpeechFixture") as { requests: string[] }).requests.slice(),
  );
}

/** Isolate model HTTP to one configured loopback fixture; no inherited-provider fallback. */
export function installLocalModelHttpGuard(application: ElectronApplication, origin: string) {
  return application.evaluate((_electron, allowedOrigin) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== allowedOrigin)
        throw new Error("External HTTP disabled in slash smoke fixture");
      return original(input, init);
    };
    return { allowedOrigin, installed: true as const };
  }, origin);
}

/** Sends a validated native event through Cake's smoke-only main-process event source. */
export function emitRendererEvent(application: ElectronApplication, event: CakeEvent) {
  return application.evaluate((_electron, input) => {
    const emit = (
      globalThis as typeof globalThis & {
        cakeSmokeEmitRendererEvent?: (event: CakeEvent) => void;
      }
    ).cakeSmokeEmitRendererEvent;
    if (!emit) throw new Error("Cake smoke event source is unavailable");
    emit(input);
  }, event);
}
