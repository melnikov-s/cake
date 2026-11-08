import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import { generateProjectIcon } from "../../../src/domain/projects/projectIconGeneration";
import {
  defaultApplicationState,
  type ApplicationState as State,
} from "../../../src/contracts/application/application-data";
import type { CakeModelChoice } from "../../../src/contracts/model-presets/cake-model-selection";
import {
  PiModelCompletionError,
  UnavailablePiModelError,
  type BoundedCompletionInput,
} from "../../../src/contracts/pi/model-data";
import { PiModels } from "../../../src/services/pi/PiModels";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";

const artwork = {
  background: "#112233",
  paths: [{ d: "M10 10 L90 10 L50 90 Z", fill: "#abcdef" }],
};
const presetId = "00000000-0000-4000-8000-000000000001";
const state: State = {
  ...defaultApplicationState(),
  utilityModel: { provider: "fixture", modelId: "utility", thinkingLevel: "off" },
  defaultModelPresetId: presetId,
  modelPresets: [
    {
      id: presetId,
      name: "Everyday",
      provider: "fixture",
      modelId: "default",
      thinkingLevel: "low",
      fastMode: false,
    },
  ],
};
const run = <A, E>(
  effect: Effect.Effect<A, E, PiModels | ApplicationState>,
  complete: PiModels["Service"]["complete"],
  snapshot = state,
) =>
  effect.pipe(
    Effect.provide(
      Layer.merge(
        Layer.mock(ApplicationState, { snapshot: () => snapshot }),
        Layer.mock(PiModels, { complete }),
      ),
    ),
  );

describe("project icon generation", () => {
  it.effect.each([
    [{ source: "utility" }, "utility"],
    [{ source: "default" }, "default"],
    [{ source: "preset", presetId }, "default"],
    [
      {
        source: "model",
        model: { provider: "fixture", modelId: "specific", thinkingLevel: "off", fastMode: false },
      },
      "specific",
    ],
  ] satisfies Array<[CakeModelChoice, string]>)(
    "resolves the requested model choice %# and bounds a text-only request",
    ([model, modelId]) =>
      Effect.gen(function* () {
        let request: BoundedCompletionInput | undefined;
        const result = yield* run(generateProjectIcon({ name: "Atlas", model }), (input) =>
          Effect.sync(() => {
            request = input;
            return JSON.stringify(artwork);
          }),
        );
        expect(result).toEqual(artwork);
        expect(request?.selection.modelId).toBe(modelId);
        expect(request?.context).toBe(JSON.stringify({ name: "Atlas" }));
        expect(request?.maximumOutputCharacters).toBe(12_000);
        expect(request?.timeoutMs).toBe(30_000);
        expect(request?.instructions).toContain("No markup");
      }),
  );

  it.effect(
    "fails a missing configured utility/default model without invoking or substituting a provider",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const complete = () =>
          Effect.sync(() => {
            calls += 1;
            return JSON.stringify(artwork);
          });
        for (const source of ["utility", "default"] as const) {
          const error = yield* run(
            generateProjectIcon({ name: "Atlas", model: { source } }),
            complete,
            defaultApplicationState(),
          ).pipe(Effect.flip);
          expect(error._tag).toBe("ProjectError");
        }
        expect(calls).toBe(0);
      }),
  );

  it.effect.each([
    "<svg><script>alert(1)</script></svg>",
    JSON.stringify({ ...artwork, paths: [{ d: 'M0 0" onload="alert(1)', fill: "#ffffff" }] }),
    JSON.stringify({ ...artwork, background: "url(https://example.com/icon)" }),
    JSON.stringify({ ...artwork, foreignObject: "<div>HTML</div>" }),
    JSON.stringify({ ...artwork, paths: [{ ...artwork.paths[0], href: "https://example.com" }] }),
    JSON.stringify({ ...artwork, paths: [] }),
    JSON.stringify({ ...artwork, paths: Array.from({ length: 17 }, () => artwork.paths[0]) }),
    JSON.stringify({ ...artwork, paths: [{ d: "M0 0 ".repeat(500), fill: "#ffffff" }] }),
  ])("rejects invalid or unsafe model output %#", (output) =>
    Effect.gen(function* () {
      const error = yield* run(
        generateProjectIcon({ name: "Atlas", model: { source: "utility" } }),
        () => Effect.succeed(output),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("ProjectError");
      expect(error.message).toMatch(/invalid icon JSON|unsupported SVG geometry/);
    }),
  );

  it.effect("preserves unavailable-model and completion failures as visible project errors", () =>
    Effect.gen(function* () {
      const unavailable = yield* run(
        generateProjectIcon({ name: "Atlas", model: { source: "utility" } }),
        () => Effect.fail(new UnavailablePiModelError({ provider: "fixture", modelId: "utility" })),
      ).pipe(Effect.flip);
      expect(unavailable._tag).toBe("ProjectError");
      const failed = yield* run(
        generateProjectIcon({ name: "Atlas", model: { source: "utility" } }),
        () => Effect.fail(new PiModelCompletionError({ message: "Provider unavailable" })),
      ).pipe(Effect.flip);
      expect(failed.message).toBe("Provider unavailable");
    }),
  );
});
