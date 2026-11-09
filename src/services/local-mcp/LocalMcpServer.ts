import { Context, Effect, Exit, Layer, Scope, Semaphore } from "effect";
import type { JsonObject } from "../../contracts/serialization/json-contract";
import type { CakeOperationInvocation } from "../../contracts/agent/cake-operation";
import { LocalMcpError, type LocalMcpRuntime } from "../../contracts/mcp/local-mcp";

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
}
export interface LocalMcpEndpoint {
  readonly tools: readonly McpTool[];
  readonly call: (
    name: string,
    input: JsonObject,
    signal: AbortSignal,
  ) => Promise<CakeOperationInvocation>;
}
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class LocalMcpServer extends Context.Service<
  LocalMcpServer,
  {
    readonly get: () => Effect.Effect<LocalMcpRuntime>;
    readonly configure: (
      input:
        | { readonly port: number; readonly token: string; readonly endpoint: LocalMcpEndpoint }
        | undefined,
    ) => Effect.Effect<LocalMcpRuntime>;
  }
>()("cake/services/local-mcp/LocalMcpServer") {
  static readonly layer = Layer.effect(
    LocalMcpServer,
    Effect.gen(function* () {
      const owner = yield* Effect.scope;
      const lock = yield* Semaphore.make(1);
      let active: Scope.Closeable | undefined;
      let runtime: LocalMcpRuntime = { status: "disabled" };
      const configure = Effect.fn("LocalMcpServer.configure")(function* (
        input:
          | { readonly port: number; readonly token: string; readonly endpoint: LocalMcpEndpoint }
          | undefined,
      ) {
        if (active) {
          yield* Scope.close(active, Exit.void);
          active = undefined;
        }
        runtime = { status: "disabled" };
        if (!input) return runtime;
        const scope = yield* Scope.fork(owner);
        const result = yield* Effect.tryPromise({
          try: () => import("./LocalMcpListener"),
          catch: (cause) =>
            new LocalMcpError({ code: "operation_failed", message: message(cause) }),
        }).pipe(
          Effect.flatMap(({ open }) => open(input.port, input.token, input.endpoint)),
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
          Effect.result,
        );
        if (result._tag === "Failure") {
          runtime = { status: "error", error: message(result.failure) };
        } else {
          active = scope;
          runtime = { status: "serving", url: result.success };
        }
        return runtime;
      }, lock.withPermit);
      return LocalMcpServer.of({
        get: Effect.fn("LocalMcpServer.get")(() => Effect.succeed(runtime)),
        configure,
      });
    }),
  );
}
