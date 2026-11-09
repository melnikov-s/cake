import { randomBytes } from "node:crypto";
import { BackendRecovery } from "../../services/startup/BackendRecovery";
import { Effect, Option, Schema, type Scope } from "effect";
import { toDraft07JsonSchema, jsonObjectSchema } from "../../contracts/serialization/json-contract";
import { cakeToolDescription, cakeToolEnvelopeSchema } from "../../contracts/agent/cake-operation";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import {
  LocalMcpConfiguration,
  LocalMcpError,
  type LocalMcpSnapshot,
} from "../../contracts/mcp/local-mcp";
import { LocalMcpServer, type LocalMcpEndpoint } from "../../services/local-mcp/LocalMcpServer";
import { LocalMcpSettings, type LocalMcpDocument } from "../../services/storage/LocalMcpSettings";
import * as chatTargets from "../cake-chats/cakeChatTargets";

/** MCP invokes the canonical Cake definitions with full control, not a second API. */
const call = Effect.fn("LocalMcp.call")(function* (
  input: Schema.Schema.Type<typeof jsonObjectSchema>,
) {
  const request = yield* Schema.decodeUnknownEffect(cakeToolEnvelopeSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) => new LocalMcpError({ code: "invalid_input", message: cause.message }),
    ),
  );
  const handle = yield* chatTargets.acquireAvailable(CAKE_CHAT_SESSION_ID);
  return yield* handle.callCakeTool(request.command ?? "help", request.input ?? {});
});

const endpoint = Effect.fn("LocalMcp.endpoint")(function* () {
  const recovery = yield* Effect.serviceOption(BackendRecovery);
  const admit = Option.isSome(recovery) ? recovery.value.awaitReady() : Effect.void;
  const context =
    yield* Effect.context<Exclude<Effect.Services<ReturnType<typeof call>>, Scope.Scope>>();
  return {
    tools: [
      {
        name: "cake",
        description: cakeToolDescription,
        inputSchema: Schema.decodeUnknownSync(jsonObjectSchema)(
          toDraft07JsonSchema(cakeToolEnvelopeSchema),
        ),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
    ],
    call: async (_name, input, signal) => {
      // Enter the existing backend Context and its canonical Cake operation implementations.
      const result = await Effect.runPromiseWith(context)(
        Effect.scoped(Effect.andThen(admit, call(input))).pipe(Effect.result),
        { signal },
      );
      if (result._tag === "Failure") throw result.failure;
      return result.success;
    },
  } satisfies LocalMcpEndpoint;
});

const apply = Effect.fn("LocalMcp.apply")(function* (document: LocalMcpDocument) {
  const server = yield* LocalMcpServer;
  return yield* server.configure(
    document.configuration.enabled
      ? {
          port: document.configuration.port,
          token: document.token,
          endpoint: yield* endpoint(),
        }
      : undefined,
  );
});

export const initialize = Effect.fn("LocalMcp.initialize")(function* () {
  yield* apply(yield* (yield* LocalMcpSettings).load());
});

export const get = Effect.fn("LocalMcp.get")(function* (): Effect.fn.Return<
  LocalMcpSnapshot,
  LocalMcpError,
  LocalMcpSettings | LocalMcpServer
> {
  const document = yield* (yield* LocalMcpSettings).load();
  const runtime = yield* (yield* LocalMcpServer).get();
  const snapshot = { configuration: document.configuration, runtime };
  if (!runtime.url) return snapshot;
  return {
    ...snapshot,
    clientConfiguration: JSON.stringify(
      {
        mcpServers: {
          cake: {
            type: "http",
            url: runtime.url,
            headers: { Authorization: `Bearer ${document.token}` },
          },
        },
      },
      null,
      2,
    ),
  };
});

export const configure = Effect.fn("LocalMcp.configure")(function* (input: LocalMcpConfiguration) {
  const configuration = yield* Schema.decodeUnknownEffect(LocalMcpConfiguration)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (cause) => new LocalMcpError({ code: "invalid_input", message: cause.message }),
    ),
  );
  const storage = yield* LocalMcpSettings;
  const document = { ...(yield* storage.load()), configuration };
  yield* storage.save(document);
  yield* apply(document);
  return yield* get();
});

export const rotateToken = Effect.fn("LocalMcp.rotateToken")(function* () {
  const storage = yield* LocalMcpSettings;
  const document = { ...(yield* storage.load()), token: randomBytes(32).toString("hex") };
  yield* storage.save(document);
  yield* apply(document);
  return yield* get();
});
