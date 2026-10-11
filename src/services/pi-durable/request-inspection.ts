import { randomUUID } from "node:crypto";
import type { StreamOptions } from "@earendil-works/pi-ai";
import { Predicate } from "effect";
import type {
  RequestInspectionEntry,
  RequestInspectionHistory,
  RequestInspectionPayload,
} from "../../contracts/conversations/request-inspection";

type CapturedEntry = { -readonly [K in keyof RequestInspectionEntry]: RequestInspectionEntry[K] };
type CapturedPayload = {
  -readonly [K in keyof RequestInspectionPayload]: RequestInspectionPayload[K];
};

const PAYLOAD_LIMITATION =
  "Provider onPayload object, NOT an exact serialized outbound body. WebSocket/Bedrock/custom transports and their internal retries are not observable through Pi's fetch hook. Binary values are represented as base64. Provider-internal context is not observable.";

/** Backend-lifetime, local-only diagnostic history, not a transcript. Whole immutable bodies
 * are evicted oldest-first, never truncated. No URLs, headers, credentials or error bodies.
 * Synchronous SDK callbacks serialize mutations; Clear also invalidates in-flight callbacks. */
export function createRequestInspectionHistory(maxEntries = 40, maxBytes = 64 * 1024 * 1024) {
  let records: RequestInspectionPayload[] = [];
  let evicted = 0;
  let generation = 0;
  const list = (): RequestInspectionHistory => ({
    entries: records.map(({ entry }) => ({ ...entry })),
    evicted,
    maxEntries,
    maxBytes,
  });
  const get = (id: string) => {
    const record = records.find(({ entry }) => entry.id === id);
    return record ? { ...record, entry: { ...record.entry } } : undefined;
  };
  const clear = () => {
    records = [];
    evicted = 0;
    generation += 1;
  };
  const begin = (
    sessionId: string,
    model: { provider: string; id: string; api: string },
    options?: StreamOptions,
    fastMode = false,
    purpose: RequestInspectionEntry["purpose"] = "coordinator",
  ) => {
    const callId = randomUUID();
    const epoch = generation;
    let attempt = 0;
    const ids: string[] = [];
    const settings = JSON.stringify({
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      transport: options?.transport,
      cacheRetention: options?.cacheRetention,
      timeoutMs: options?.timeoutMs,
      maxRetries: options?.maxRetries,
      fastMode,
      // Settings are a whitelist; never serialize options containing auth/headers/env.
      reasoning: options && "reasoning" in options ? options.reasoning : undefined,
    });
    const add = (
      boundary: RequestInspectionEntry["boundary"],
      raw: string | undefined,
      limitation?: string,
    ) => {
      const id = randomUUID();
      if (epoch !== generation) return id;
      const byteSize = raw === undefined ? 0 : Buffer.byteLength(raw);
      if (byteSize > maxBytes) {
        raw = undefined;
        limitation =
          `${limitation ?? ""} Full body exceeds the ${maxBytes}-byte local retention limit and was not retained. This record cannot be exported as an exact body.`.trim();
      }
      const entry: CapturedEntry = {
        id,
        callId,
        sessionId,
        capturedAt: new Date().toISOString(),
        provider: model.provider,
        modelId: model.id,
        api: model.api,
        purpose,
        boundary,
        state: boundary === "http-body" ? "sent" : "assembled",
        attempt: boundary === "http-body" ? ++attempt : 0,
        byteSize,
        settings,
      };
      const record: CapturedPayload = { entry };
      if (limitation !== undefined) entry.limitation = limitation;
      if (raw !== undefined) record.raw = raw;
      records.push(record);
      ids.push(id);
      while (
        records.length > maxEntries ||
        records.reduce(
          (sum, record) => sum + (record.raw === undefined ? 0 : record.entry.byteSize),
          0,
        ) > maxBytes
      ) {
        records.shift();
        evicted += 1;
      }
      return id;
    };
    const update = (id: string, state: RequestInspectionEntry["state"], status?: number) => {
      if (epoch !== generation) return;
      records = records.map((record) => {
        if (record.entry.id !== id) return record;
        const entry: CapturedEntry = { ...record.entry, state };
        if (status !== undefined) entry.status = status;
        return { ...record, entry };
      });
    };
    return {
      payload(payload: unknown) {
        try {
          const raw = JSON.stringify(payload, (_key, value: unknown) =>
            value instanceof Uint8Array
              ? { encoding: "base64", data: Buffer.from(value).toString("base64") }
              : value,
          );
          add("provider-payload", raw, PAYLOAD_LIMITATION);
        } catch {
          add(
            "provider-payload",
            undefined,
            "Provider payload could not be serialized; context is unavailable.",
          );
        }
      },
      fetch(delegate: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
        // These pinned Pi adapters explicitly reject non-global fetch implementations.
        // Leave their transport unchanged and retain only the labelled onPayload capture.
        if (["google-generative-ai", "google-vertex"].includes(model.api)) return delegate;
        return async (input, init) => {
          // Read a clone only. Never consume, replace or reserialize the request sent to the SDK.
          let raw: string | undefined;
          let limitation: string | undefined =
            delegate === globalThis.fetch
              ? undefined
              : "HTTP body entering a supplied custom fetch delegate. Any downstream transformations by that delegate are not observable; this is not certified as the final provider body.";
          try {
            if (Predicate.isString(init?.body)) raw = init.body;
            else if (input instanceof Request && init?.body === undefined)
              raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                await input.clone().arrayBuffer(),
              );
            else
              limitation =
                "Non-text HTTP body is not inspectable by this adapter; exact raw export unavailable.";
          } catch {
            limitation = "HTTP body could not be read; exact raw export unavailable.";
          }
          const id = add("http-body", raw, limitation);
          try {
            const response = await delegate(input, init);
            update(id, response.ok ? "sent" : "failed", response.status);
            return response;
          } catch (error) {
            update(id, "failed");
            throw error;
          }
        };
      },
      settle(failed: boolean) {
        if (ids.length === 0)
          add(
            "provider-payload",
            undefined,
            "This Pi provider did not invoke payload or fetch observation hooks. No outbound context was captured; its requests and retries are unavailable.",
          );
        for (const id of ids) {
          const record = records.find((record) => record.entry.id === id);
          if (record?.entry.state !== "failed") update(id, failed ? "failed" : "completed");
        }
      },
    };
  };
  return { list, get, clear, begin };
}
export type RequestInspection = ReturnType<typeof createRequestInspectionHistory>;
