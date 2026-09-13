import { Effect, Schema } from "effect";
import type { InlineWidgetGenerationRequest } from "../../services/pi/runtime/sidecar-runtime";
import { extractRepairedWidget } from "../../services/widgets/inline-widget-service";
import { RenderedWidgetCaptureError } from "../../services/widgets/RenderedWidgetCapture";

export class WidgetGenerationReviewError extends Schema.TaggedError<WidgetGenerationReviewError>()(
  "WidgetGenerationReviewError",
  {
    operation: Schema.Literals(["preflight", "generate", "compile", "repair", "capture", "review"]),
    kind: Schema.Literals(["candidate", "cancelled", "infrastructure", "model"]),
    message: Schema.String,
  },
) {}

export interface WidgetGenerationReviewDependencies {
  requireVisionModel(model: { provider: string; id: string } | undefined): Promise<void>;
  generate(): Promise<{ sessionId: string; response: string }>;
  compile(source: string): Promise<{
    widget: { readonly token: string; readonly url: string };
    release(): void;
  }>;
  repair(source: string, diagnostic: string): Promise<{ response: string }>;
  capture(widget: { readonly token: string; readonly url: string }): Promise<{
    pngBase64: string;
    diagnostics: ReadonlyArray<string>;
  }>;
  review(source: string, diagnostic: string, pngBase64: string): Promise<{ response: string }>;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const fail = (
  operation: WidgetGenerationReviewError["operation"],
  kind: WidgetGenerationReviewError["kind"],
  cause: unknown,
) => new WidgetGenerationReviewError({ operation, kind, message: messageOf(cause) });
const promise = <A>(
  operation: WidgetGenerationReviewError["operation"],
  kind: WidgetGenerationReviewError["kind"],
  evaluate: () => Promise<A>,
) => Effect.tryPromise({ try: evaluate, catch: (cause) => fail(operation, kind, cause) });
const extract = (response: string, operation: WidgetGenerationReviewError["operation"]) =>
  Effect.try({
    try: () => extractRepairedWidget(response, "react"),
    catch: (cause) => fail(operation, "candidate", cause),
  });

/** Cohesive pre-publication policy: every renderable candidate receives screenshot review. */
export const generateReviewedWidget = Effect.fn("WidgetGenerationReview.generate")(function* (
  input: InlineWidgetGenerationRequest,
  dependencies: WidgetGenerationReviewDependencies,
) {
  yield* promise("preflight", "model", () => dependencies.requireVisionModel(input.model));
  if (!input.model)
    return yield* fail(
      "preflight",
      "model",
      "Rendered widget review requires a configured vision-capable model",
    );
  const generated = yield* promise("generate", "infrastructure", dependencies.generate);
  let source = yield* extract(generated.response, "generate");
  let replacements = 0;
  let diagnostic = "Compilation succeeded.";

  while (true) {
    if (input.signal?.aborted)
      return yield* fail("review", "cancelled", "Widget generation was cancelled");
    const compiled = yield* promise("compile", "candidate", () =>
      dependencies.compile(source),
    ).pipe(Effect.result);
    if (compiled._tag === "Failure") {
      diagnostic = `Compilation failed: ${compiled.failure.message}`.slice(0, 8_000);
      if (replacements >= 2)
        return yield* fail(
          "compile",
          "candidate",
          `Widget review exhausted its two replacements. ${diagnostic}`,
        );
      const repaired = yield* promise("repair", "infrastructure", () =>
        dependencies.repair(source, diagnostic),
      );
      source = yield* extract(repaired.response, "repair");
      replacements += 1;
      continue;
    }

    const candidate = compiled.success;
    const outcome = yield* Effect.gen(function* () {
      const capture = yield* Effect.tryPromise({
        try: () => dependencies.capture(candidate.widget),
        catch: (cause) =>
          cause instanceof RenderedWidgetCaptureError
            ? fail("capture", cause.kind === "widget" ? "candidate" : cause.kind, cause.message)
            : fail("capture", "infrastructure", cause),
      });
      diagnostic = [diagnostic, ...capture.diagnostics].join("\n").slice(0, 8_000);
      return yield* promise("review", "infrastructure", () =>
        dependencies.review(source, diagnostic, capture.pngBase64),
      );
    }).pipe(Effect.ensuring(Effect.sync(candidate.release)), Effect.result);

    if (outcome._tag === "Failure") {
      if (input.signal?.aborted || outcome.failure.kind === "cancelled")
        return yield* fail("review", "cancelled", "Widget generation was cancelled");
      if (outcome.failure.kind !== "candidate") return yield* outcome.failure;
      if (replacements >= 2) return yield* outcome.failure;
      const repaired = yield* promise("repair", "infrastructure", () =>
        dependencies.repair(source, `Rendered preview failed: ${outcome.failure.message}`),
      );
      source = yield* extract(repaired.response, "repair");
      replacements += 1;
      continue;
    }

    const response = outcome.success.response.trim();
    if (response === "ACCEPT_CURRENT")
      return { language: "react" as const, source, generationSessionId: generated.sessionId };
    if (replacements >= 2)
      return yield* fail(
        "review",
        "candidate",
        "Widget visual review requested a third replacement; the two-replacement limit is exhausted",
      );
    source = yield* extract(response, "review");
    replacements += 1;
    diagnostic = "Visual reviewer supplied a replacement.";
  }
});
