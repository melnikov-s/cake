import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { WebContents } from "electron";
import { expect, vi } from "vitest";
import { captureWidgetView } from "../../../../src/services/electron/capture-widget-view";

it.effect(
  "reports a window that stops painting without hanging or substituting initial pixels",
  () =>
    Effect.gen(function* () {
      const executeJavaScript = vi.fn<WebContents["executeJavaScript"]>(
        () => new Promise(() => {}),
      );
      const capturePage = vi.fn<WebContents["capturePage"]>();
      const pending = yield* captureWidgetView({ executeJavaScript, capturePage }, "view").pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { message: expect.stringContaining("timed out") },
      });
      expect(capturePage).not.toHaveBeenCalled();
    }),
);

it.effect.each([
  "Current widget view is unavailable or not ready. Open the widget first.",
  "Widget view is clipped or covered. Scroll it fully into view or use fullscreen, then retry.",
])("reports %s without capturing or substituting initial pixels", (message) =>
  Effect.gen(function* () {
    const executeJavaScript = vi
      .fn<WebContents["executeJavaScript"]>()
      .mockResolvedValue({ error: message });
    const capturePage = vi.fn<WebContents["capturePage"]>();
    const result = yield* Effect.result(
      captureWidgetView({ executeJavaScript, capturePage }, "missing-view"),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ElectronError", message } });
    expect(capturePage).not.toHaveBeenCalled();
  }),
);
