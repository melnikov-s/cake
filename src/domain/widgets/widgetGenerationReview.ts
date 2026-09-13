import { Effect, Schema } from "effect";
import { extractRepairedWidget } from "../../services/widgets/inline-widget-service";
import { RenderedWidgetCaptureError } from "../../services/widgets/RenderedWidgetCapture";

export interface InlineWidgetGenerationRequest {
  readonly sessionId: string;
  readonly brief: string;
  readonly data?: unknown;
  readonly fallback: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly signal?: AbortSignal;
}

export interface InlineWidgetGenerationResult {
  readonly language: "react";
  readonly source: string;
  readonly generationSessionId: string;
}

export class WidgetGenerationReviewError extends Schema.TaggedError<WidgetGenerationReviewError>()(
  "WidgetGenerationReviewError",
  {
    operation: Schema.Literals(["preflight", "generate", "compile", "repair", "capture", "review"]),
    kind: Schema.Literals(["candidate", "cancelled", "infrastructure", "model"]),
    message: Schema.String,
  },
) {}

export interface WidgetGenerationReviewDependencies {
  readonly requireVisionModel: (
    model: { readonly provider: string; readonly id: string } | undefined,
  ) => Effect.Effect<void, unknown>;
  readonly generate: () => Effect.Effect<
    { readonly sessionId: string; readonly response: string },
    unknown
  >;
  readonly compile: (source: string) => Effect.Effect<
    {
      readonly widget: { readonly token: string; readonly url: string };
      readonly release: Effect.Effect<void>;
    },
    unknown
  >;
  readonly repair: (
    source: string,
    diagnostic: string,
  ) => Effect.Effect<{ readonly response: string }, unknown>;
  readonly capture: (widget: { readonly token: string; readonly url: string }) => Effect.Effect<
    {
      readonly pngBase64: string;
      readonly diagnostics: ReadonlyArray<string>;
    },
    unknown
  >;
  readonly review: (
    source: string,
    diagnostic: string,
    pngBase64: string,
  ) => Effect.Effect<{ readonly response: string }, unknown>;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const fail = (
  operation: WidgetGenerationReviewError["operation"],
  kind: WidgetGenerationReviewError["kind"],
  cause: unknown,
) => new WidgetGenerationReviewError({ operation, kind, message: messageOf(cause) });
const mapFailure = (
  operation: WidgetGenerationReviewError["operation"],
  kind: WidgetGenerationReviewError["kind"],
) => Effect.mapError((cause: unknown) => fail(operation, kind, cause));
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
  yield* dependencies.requireVisionModel(input.model).pipe(mapFailure("preflight", "model"));
  if (!input.model)
    return yield* fail(
      "preflight",
      "model",
      "Rendered widget review requires a configured vision-capable model",
    );
  const generated = yield* dependencies.generate().pipe(mapFailure("generate", "infrastructure"));
  let source = yield* extract(generated.response, "generate");
  let replacements = 0;
  let diagnostic = "Compilation succeeded.";

  while (true) {
    if (input.signal?.aborted)
      return yield* fail("review", "cancelled", "Widget generation was cancelled");
    const compiled = yield* dependencies
      .compile(source)
      .pipe(mapFailure("compile", "candidate"), Effect.result);
    if (compiled._tag === "Failure") {
      diagnostic = `Compilation failed: ${compiled.failure.message}`.slice(0, 8_000);
      if (replacements >= 2)
        return yield* fail(
          "compile",
          "candidate",
          `Widget review exhausted its two replacements. ${diagnostic}`,
        );
      const repaired = yield* dependencies
        .repair(source, diagnostic)
        .pipe(mapFailure("repair", "infrastructure"));
      source = yield* extract(repaired.response, "repair");
      replacements += 1;
      continue;
    }

    const candidate = compiled.success;
    const outcome = yield* Effect.gen(function* () {
      const capture = yield* dependencies
        .capture(candidate.widget)
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof RenderedWidgetCaptureError
              ? fail("capture", cause.kind === "widget" ? "candidate" : cause.kind, cause.message)
              : fail("capture", "infrastructure", cause),
          ),
        );
      diagnostic = [diagnostic, ...capture.diagnostics].join("\n").slice(0, 8_000);
      return yield* dependencies
        .review(source, diagnostic, capture.pngBase64)
        .pipe(mapFailure("review", "infrastructure"));
    }).pipe(Effect.ensuring(candidate.release), Effect.result);

    if (outcome._tag === "Failure") {
      if (input.signal?.aborted || outcome.failure.kind === "cancelled")
        return yield* fail("review", "cancelled", "Widget generation was cancelled");
      if (outcome.failure.kind !== "candidate") return yield* outcome.failure;
      if (replacements >= 2) return yield* outcome.failure;
      const repaired = yield* dependencies
        .repair(source, `Rendered preview failed: ${outcome.failure.message}`)
        .pipe(mapFailure("repair", "infrastructure"));
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
