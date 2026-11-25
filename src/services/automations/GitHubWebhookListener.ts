import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Effect, Schema } from "effect";
import { AutomationError, AutomationId } from "../../contracts/automations/automation-data";
import { GITHUB_WEBHOOK_MAX_BODY } from "../../contracts/automations/github-webhooks";
import { acceptWebhook } from "../../domain/automations/githubWebhooks";
import type { AutomationRecords } from "./AutomationRecords";

const maxRequests = 8;
const readDeadlineMs = 5_000;
const status = {
  unauthorized: 401,
  invalid: 400,
  ignored: 200,
  duplicate: 200,
  full: 503,
  queued: 202,
};

const reply = (response: ServerResponse, code: number, outcome: string) => {
  response.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Connection: "close",
    ...(code === 503 ? { "Retry-After": "5" } : null),
  });
  response.end(JSON.stringify({ outcome }));
};

function oneHeader(request: IncomingMessage, name: string) {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

async function readBody(request: IncomingMessage) {
  const deadline = setTimeout(() => request.destroy(), readDeadlineMs);
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      if (!Buffer.isBuffer(chunk)) return undefined;
      bytes += chunk.byteLength;
      if (bytes > GITHUB_WEBHOOK_MAX_BODY) return undefined;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    clearTimeout(deadline);
  }
}

/** A separate loopback port. This server has no routing to Cake RPC, MCP, or assets. */
export const openGitHubWebhookListener = Effect.fn("GitHubWebhookListener.open")(function* (
  port: number,
) {
  const context = yield* Effect.context<AutomationRecords>();
  const execute = Effect.runPromiseWith(context);
  let inFlight = 0;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = /^\/webhooks\/github\/([0-9a-f-]+)$/.exec(request.url ?? "");
    const automationId = path?.[1];
    if (!Schema.is(AutomationId)(automationId)) return reply(response, 404, "not-found");
    if (request.method !== "POST") return reply(response, 405, "method-not-allowed");
    const event = oneHeader(request, "x-github-event");
    const id = oneHeader(request, "x-github-delivery");
    const signature = oneHeader(request, "x-hub-signature-256");
    if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature))
      return reply(response, 401, "unauthorized");
    if (!event || !/^[a-z_]{1,64}$/.test(event) || !id || id.length !== 36)
      return reply(response, 400, "invalid");
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        oneHeader(request, "content-type") ?? "",
      ) ||
      request.headers["content-encoding"] !== undefined
    )
      return reply(response, 415, "expected-uncompressed-json");
    if (Number(request.headers["content-length"]) > GITHUB_WEBHOOK_MAX_BODY)
      return reply(response, 413, "too-large");
    if (inFlight >= maxRequests) return reply(response, 503, "busy");
    inFlight++;
    try {
      const raw = await readBody(request);
      if (!raw) return reply(response, 413, "too-large");
      const outcome = await execute(acceptWebhook(automationId, { id, event, signature, raw }));
      reply(response, status[outcome], outcome);
    } finally {
      inFlight--;
    }
  }
  const server = createServer(
    {
      maxHeaderSize: 8_192,
      headersTimeout: 5_000,
      requestTimeout: readDeadlineMs,
      connectionsCheckingInterval: 1_000,
      keepAliveTimeout: 1_000,
    },
    (request, response) => {
      // No body, signatures, or storage error details in ingress responses or logs.
      void handle(request, response).catch(() => {
        if (!response.destroyed && !response.headersSent) reply(response, 503, "unavailable");
      });
    },
  );
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(10_000, (socket) => socket.destroy());
  return yield* Effect.acquireRelease(
    Effect.callback<void, AutomationError>((resume) => {
      const onError = (cause: Error) =>
        resume(
          Effect.fail(
            new AutomationError({
              operation: "webhookListen",
              code: "unavailable",
              message: cause.message,
            }),
          ),
        );
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resume(Effect.void);
      });
    }),
    () => Effect.promise<void>(() => new Promise((resolve) => server.close(() => resolve()))),
  );
});
