import { isAbsolute } from "node:path";
import { Config, Effect, Option, Schema, type Scope } from "effect";
import { jsonObjectSchema } from "../../contracts/serialization/json-contract";
import { LocalMcpConfiguration, LocalMcpError } from "../../contracts/mcp/local-mcp";
import * as server from "../../services/local-mcp/LocalMcpServer";
import { invoke, toolsForGrant } from "./localMcpControl";

/** Startup-only host grant. Nothing exposed through MCP can change it. */
export const initialize = Effect.fn("LocalMcp.initialize")(function* () {
  const configured = yield* Config.option(Config.string("CAKE_LOCAL_MCP"));
  if (Option.isNone(configured)) return;
  const raw = yield* Effect.try({
    try: () => JSON.parse(configured.value),
    catch: () =>
      new LocalMcpError({ code: "invalid_input", message: "CAKE_LOCAL_MCP must be JSON." }),
  });
  const grant = yield* Schema.decodeUnknownEffect(LocalMcpConfiguration)(raw, {
    onExcessProperty: "error",
  });
  if (!grant.projects.every(isAbsolute))
    return yield* new LocalMcpError({
      code: "invalid_input",
      message: "MCP project paths must be absolute registered Project roots.",
    });
  const context =
    yield* Effect.context<Exclude<Effect.Services<ReturnType<typeof invoke>>, Scope.Scope>>();
  yield* server.serve(grant.directory, {
    tools: toolsForGrant(grant).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: Schema.decodeUnknownSync(jsonObjectSchema)(
        Schema.toStandardJSONSchemaV1(tool.inputSchema)["~standard"].jsonSchema.input({
          target: "draft-07",
        }),
      ),
      annotations: {
        readOnlyHint: tool.scope === "read",
        destructiveHint: tool.scope === "launch" || tool.scope === "send",
        openWorldHint: tool.scope === "launch" || tool.scope === "send",
      },
    })),
    call: async (name, input, signal) => {
      // External socket callback enters the existing backend Context, never a second runtime.
      // eslint-disable-next-line no-restricted-syntax
      const result = await Effect.runPromiseWith(context)(
        Effect.scoped(invoke(grant, name, input)).pipe(Effect.result),
        { signal },
      );
      if (result._tag === "Failure") throw result.failure;
      return result.success;
    },
  });
  yield* Effect.logInfo("Local MCP enabled with a startup-only Project grant", {
    projects: grant.projects.length,
    scopes: grant.scopes ?? ["read"],
  });
});
