import { isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { Effect, Schema, type Scope } from "effect";
import { jsonObjectSchema } from "../../contracts/serialization/json-contract";
import {
  LocalMcpConfiguration,
  LocalMcpCall,
  LocalMcpError,
  type LocalMcpSnapshot,
} from "../../contracts/mcp/local-mcp";
import { LocalMcpServer, type LocalMcpEndpoint } from "../../services/local-mcp/LocalMcpServer";
import { LocalMcpSettings, type LocalMcpDocument } from "../../services/storage/LocalMcpSettings";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { call, commandsForGrant } from "./localMcpControl";

const endpoint = Effect.fn("LocalMcp.endpoint")(function* (grant: LocalMcpConfiguration) {
  const context =
    yield* Effect.context<Exclude<Effect.Services<ReturnType<typeof call>>, Scope.Scope>>();
  const commands = commandsForGrant(grant);
  const executes = commands.some(
    (command) => command.scope === "launch" || command.scope === "send",
  );
  return {
    tools: [
      {
        name: "cake",
        description:
          "Control allowed Cake Projects. Call without command to discover available subcommands; use <command>.help for input schemas. Launch/send return admission, not completion.",
        inputSchema: Schema.decodeUnknownSync(jsonObjectSchema)(
          Schema.toStandardJSONSchemaV1(LocalMcpCall)["~standard"].jsonSchema.input({
            target: "draft-07",
          }),
        ),
        annotations: {
          readOnlyHint: commands.every((command) => command.scope === "read"),
          destructiveHint: executes,
          openWorldHint: executes,
        },
      },
    ],
    call: async (_name, input, signal) => {
      // External MCP callback enters the existing backend Context, never a second runtime.
      // eslint-disable-next-line no-restricted-syntax
      const result = await Effect.runPromiseWith(context)(
        Effect.scoped(call(grant, input)).pipe(Effect.result),
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
          endpoint: yield* endpoint(document.configuration),
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
  LocalMcpSettings | LocalMcpServer | ApplicationState
> {
  const document = yield* (yield* LocalMcpSettings).load();
  const runtime = yield* (yield* LocalMcpServer).get();
  const projects = (yield* ApplicationState)
    .snapshot()
    .projects.map(({ path, name }) => ({ path, name }));
  const snapshot = { configuration: document.configuration, runtime, projects };
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
  const projects = (yield* ApplicationState).snapshot().projects;
  if (
    configuration.enabled &&
    (!configuration.projects.every(
      (path) => isAbsolute(path) && projects.some((project) => project.path === path),
    ) ||
      configuration.projects.length === 0)
  )
    return yield* new LocalMcpError({
      code: "invalid_input",
      message: "Select at least one registered Project before enabling the MCP server.",
    });
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
