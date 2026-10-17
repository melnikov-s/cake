import { randomUUID } from "node:crypto";
import { Effect, Exit, Layer, RcMap, Scope } from "effect";
import type { cakeRpcPayloadSchemas } from "../../contracts/application/cake-rpc-contract";
import { InlineWidgetError } from "../../contracts/widgets/inline-widgets-errors";
import { ClientConnections } from "../clients/ClientConnections";
import { InlineWidgets } from "./InlineWidgets";
import { WidgetBrowserOutputs } from "./WidgetBrowserOutputs";
import { WidgetPackages } from "./WidgetPackages";
import { compileInlineWidget, type CompiledInlineWidgetDocument } from "./inline-widget-service";

type CompilePayload = (typeof cakeRpcPayloadSchemas)["compile-inline-widget"]["Type"];

export interface InlineWidgetsLiveOptions {
  readonly publish: (compiled: CompiledInlineWidgetDocument) => {
    readonly token: string;
    readonly url: string;
  };
  readonly revoke: (token: string) => void;
}

export const makeInlineWidgetsLive = (options: InlineWidgetsLiveOptions) =>
  Layer.effect(
    InlineWidgets,
    Effect.gen(function* () {
      const packages = yield* WidgetPackages;
      const browserOutputs = yield* WidgetBrowserOutputs;
      const connections = yield* ClientConnections;
      // Share immutable bytes only while publications reference them; never expire live mounts.
      const outputs = yield* RcMap.make({
        lookup: (digest: string) => browserOutputs.open({ digest }),
      });
      // Capability inventory, not a cache: each mount has a distinct token and release scope.
      const active = new Map<string, { owner: number; scope: Scope.Closeable }>();
      const dispose = Effect.fn("InlineWidgets.dispose")(function* (token: string) {
        const entry = active.get(token);
        if (!entry) return;
        active.delete(token);
        options.revoke(token);
        yield* Scope.close(entry.scope, Exit.void);
      });
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...active.keys()], dispose, { discard: true }),
      );
      const publish = Effect.fn("InlineWidgets.publish")(
        (
          owner: number,
          acquire: Effect.Effect<CompiledInlineWidgetDocument, InlineWidgetError, Scope.Scope>,
        ) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const result = yield* Effect.gen(function* () {
                const compiled = yield* restore(acquire.pipe(Scope.provide(scope)));
                // Disconnect can win while compilation or a disk read is in flight.
                if (!connections.kind(owner))
                  return yield* new InlineWidgetError({
                    operation: "publish",
                    message: "Widget connection is closed",
                  });
                const widget = options.publish(compiled);
                active.set(widget.token, { owner, scope });
                return { widget };
              }).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
                ),
              );
              return result;
            }),
          ),
      );
      return InlineWidgets.of({
        compile: Effect.fn("InlineWidgets.compile")((owner: number, request: CompilePayload) =>
          publish(
            owner,
            Effect.tryPromise({
              try: () =>
                compileInlineWidget(request.language, request.source, request.capability, {
                  packageDirectory: packages.directory,
                }),
              catch: (cause) =>
                new InlineWidgetError({
                  operation: "compile",
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            }),
          ),
        ),
        open: Effect.fn("InlineWidgets.open")((owner, request) =>
          publish(
            owner,
            Effect.gen(function* () {
              const shared = yield* RcMap.get(outputs, request.browser.digest);
              const token = randomUUID();
              return {
                ...shared,
                token,
                document: shared.document.replaceAll(shared.token, token),
              };
            }),
          ),
        ),
        release: Effect.fn("InlineWidgets.release")(
          (owner, token) => (active.get(token)?.owner === owner ? dispose(token) : Effect.void),
          Effect.uninterruptible,
        ),
        releaseConnection: Effect.fn("InlineWidgets.releaseConnection")(
          (owner) =>
            Effect.forEach(
              [...active].filter(([, entry]) => entry.owner === owner),
              ([token]) => dispose(token),
              { discard: true },
            ),
          Effect.uninterruptible,
        ),
      });
    }),
  );
