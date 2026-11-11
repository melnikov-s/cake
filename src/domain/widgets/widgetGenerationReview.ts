import { Effect, Schema } from "effect";
import type { InlineWidgetLanguage } from "../../contracts/widgets/inline-widget-contract";
import type { WidgetBrowserOutput } from "../../contracts/widgets/widget-browser-output";
import type { WidgetPreview } from "../../contracts/widgets/widget-preview";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type { WidgetGenerationProgress } from "../../contracts/widgets/widget-generation";
import { RenderedWidgetCaptureError } from "../../contracts/widgets/rendered-widget-capture-errors";

export interface InlineWidgetGenerationRequest {
  readonly sessionId: string;
  readonly brief: string;
  readonly language?: InlineWidgetLanguage;
  readonly data?: unknown;
  readonly initialState?: JsonValue;
  readonly fallback: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WidgetGenerationProgress) => void;
}

export interface InlineWidgetGenerationResult {
  readonly language: InlineWidgetLanguage;
  readonly source: string;
  readonly generationSessionId: string;
  readonly preview: WidgetPreview;
  readonly browser: WidgetBrowserOutput;
  readonly state?: JsonValue;
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
  /** Runs the first side-chat turn, which writes the widget files. */
  readonly generate: () => Effect.Effect<{ readonly sessionId: string }, unknown>;
  /** Assembles the current widget files into source and compiles it. */
  readonly compile: () => Effect.Effect<
    {
      readonly source: string;
      readonly widget: { readonly token: string; readonly url: string };
      readonly release: Effect.Effect<void>;
      /** Retain only the accepted compiled output, never rejected candidates. */
      readonly retain: () => Effect.Effect<WidgetBrowserOutput, unknown>;
    },
    unknown
  >;
  /** Sends a diagnostic to the side chat, which fixes the widget files. */
  readonly repair: (diagnostic: string) => Effect.Effect<unknown, unknown>;
  readonly capture: (widget: { readonly token: string; readonly url: string }) => Effect.Effect<
    {
      readonly pngBase64: string;
      readonly diagnostics: ReadonlyArray<string>;
    },
    unknown
  >;
  /** Shows the side chat its rendered screenshot; it accepts or changes the files. */
  readonly review: (
    diagnostic: string,
    pngBase64: string,
  ) => Effect.Effect<{ readonly accepted: boolean; readonly changed: boolean }, unknown>;
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
  const language = input.language ?? "react";
  let replacements = 0;
  let diagnostic = "Compilation succeeded.";

  while (true) {
    if (input.signal?.aborted)
      return yield* fail("review", "cancelled", "Widget generation was cancelled");
    const compiled = yield* dependencies
      .compile()
      .pipe(mapFailure("compile", "candidate"), Effect.result);
    if (compiled._tag === "Failure") {
      diagnostic = `Compilation failed: ${compiled.failure.message}`.slice(0, 8_000);
      if (replacements >= 2)
        return yield* fail(
          "compile",
          "candidate",
          `Widget review exhausted its two replacements. ${diagnostic}`,
        );
      yield* dependencies.repair(diagnostic).pipe(mapFailure("repair", "infrastructure"));
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
      const review = yield* dependencies
        .review(diagnostic, capture.pngBase64)
        .pipe(mapFailure("review", "infrastructure"));
      const browser = review.accepted
        ? yield* candidate.retain().pipe(mapFailure("compile", "infrastructure"))
        : undefined;
      return { review, pngBase64: capture.pngBase64, browser };
    }).pipe(Effect.ensuring(candidate.release), Effect.result);

    if (outcome._tag === "Failure") {
      if (input.signal?.aborted || outcome.failure.kind === "cancelled")
        return yield* fail("review", "cancelled", "Widget generation was cancelled");
      if (outcome.failure.kind !== "candidate") return yield* outcome.failure;
      if (replacements >= 2) return yield* outcome.failure;
      yield* dependencies
        .repair(`Rendered preview failed: ${outcome.failure.message}`)
        .pipe(mapFailure("repair", "infrastructure"));
      replacements += 1;
      continue;
    }

    if (outcome.success.review.accepted) {
      if (!outcome.success.browser)
        return yield* fail(
          "compile",
          "infrastructure",
          "Accepted widget is missing retained browser output",
        );
      return {
        language,
        source: candidate.source,
        generationSessionId: generated.sessionId,
        preview: { mimeType: "image/png" as const, data: outcome.success.pngBase64 },
        browser: outcome.success.browser,
      };
    }
    if (!outcome.success.review.changed)
      return yield* fail(
        "review",
        "candidate",
        "The widget visual review neither accepted the widget nor changed its files",
      );
    if (replacements >= 2)
      return yield* fail(
        "review",
        "candidate",
        "Widget visual review requested a third replacement; the two-replacement limit is exhausted",
      );
    replacements += 1;
    diagnostic = "Visual review changed the widget files.";
  }
});
