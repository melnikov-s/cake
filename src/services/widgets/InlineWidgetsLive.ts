import { Effect, Layer } from "effect";
import type { CakePaths } from "../../config/CakePaths";
import type { cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import { runInlineWidgetRepair } from "../pi/runtime/sidecar-runtime";
import { ProjectAccess } from "../projects/ProjectAccess";
import { InlineWidgetError, InlineWidgets } from "./InlineWidgets";
import { compileInlineWidget, extractRepairedWidget } from "./inline-widget-service";

type CompilePayload = (typeof cakeRpcPayloadSchemas)["compile-inline-widget"]["Type"];
type RepairPayload = (typeof cakeRpcPayloadSchemas)["repair-inline-widget"]["Type"];

export interface InlineWidgetsLiveOptions {
  readonly paths: Pick<CakePaths, "piAgent" | "piWidgetSessions">;
  readonly publish: (compiled: { readonly token: string; readonly document: string }) => {
    readonly token: string;
    readonly url: string;
  };
}

export const makeInlineWidgetsLive = (
  options: InlineWidgetsLiveOptions,
): Layer.Layer<InlineWidgets, never, ProjectAccess> =>
  Layer.effect(
    InlineWidgets,
    Effect.gen(function* () {
      const access = yield* ProjectAccess;

      const compile = Effect.fn("InlineWidgets.compile")(function* (request: CompilePayload) {
        return yield* Effect.tryPromise({
          try: async () => ({
            widget: options.publish(
              await compileInlineWidget(request.language, request.source, request.capability),
            ),
          }),
          catch: (cause) =>
            new InlineWidgetError({
              operation: "compile",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      });

      const repair = Effect.fn("InlineWidgets.repair")(function* (request: RepairPayload) {
        const workingDirectory = yield* access
          .resolveSessionWorkingDirectory(request.sessionId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new InlineWidgetError({ operation: "resolve-session", message: cause.message }),
            ),
          );
        if (!(yield* access.isAllowed(workingDirectory)))
          return yield* new InlineWidgetError({
            operation: "authorize-project",
            message: "Project path was not selected by the user",
          });
        return yield* Effect.tryPromise({
          try: async () => {
            const repaired = await runInlineWidgetRepair({
              cwd: workingDirectory,
              agentDir: options.paths.piAgent,
              sessionDir: options.paths.piWidgetSessions,
              language: request.language,
              capability: request.capability,
              source: request.source,
              context: request.context,
              diagnostic: request.diagnostic,
              model: request.model,
            });
            return {
              widget: {
                source: extractRepairedWidget(repaired.response, request.language),
                repairSessionId: repaired.sessionId,
              },
            };
          },
          catch: (cause) =>
            new InlineWidgetError({
              operation: "repair",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      });

      return InlineWidgets.of({ compile, repair });
    }),
  );
