import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import * as artifacts from "../../../src/domain/artifacts/artifacts";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";

describe("Artifacts UI responses", () => {
  it("accepts a correlated session-less provider authentication response", async () => {
    const respondUi = vi.fn(() => Effect.void);
    const coordinator = Layer.mock(RendererRequestCoordinator, { respondUi });
    const request = {
      requestId: "00000000-0000-4000-8000-000000000001",
      uiRequestId: "00000000-0000-4000-8000-000000000002",
      sessionId: "provider-settings:17",
      cancelled: false,
      value: "browser",
    };

    await Effect.runPromise(artifacts.respondUi(17, request).pipe(Effect.provide(coordinator)));

    expect(respondUi).toHaveBeenCalledWith(17, request.sessionId, request);
  });
});
