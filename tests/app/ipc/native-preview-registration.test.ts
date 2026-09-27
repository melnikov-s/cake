import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { describe, expect } from "vitest";
import { NativePreviewInput } from "../../../src/ipc/protocol/NativePreviewTunnelRpc";
import { RendererConnection } from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import { nativePreviewTunnelHandlers } from "../../../src/ipc/server/NativePreviewTunnelHandlers";
import { NativePreviewTunnels } from "../../../src/services/browser/NativePreviewTunnels";

const input = {
  sessionId: "session-a",
  endpoint: `/preview/${"a".repeat(64)}/`,
  secret: "b".repeat(64),
};

describe("native preview registration boundary", () => {
  it.effect("uses trusted native connection identity and returns only the local endpoint", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(NativePreviewInput)({
        ...input,
        connectionId: 999,
      });
      const result = yield* nativePreviewTunnelHandlers["browser.open-native-preview"](
        decoded,
      ).pipe(
        Effect.provideService(RendererConnection, { connectionId: 11, correlationId: "preview" }),
        Effect.provide(
          Layer.mock(NativePreviewTunnels, {
            open: (connectionId, sessionId, lease) =>
              Effect.sync(() => {
                expect(connectionId).toBe(11);
                expect(sessionId).toBe(input.sessionId);
                expect(lease).toEqual({ endpoint: input.endpoint, secret: input.secret });
                return "http://preview-test.localhost:40000/";
              }),
          }),
        ),
      );
      expect(result).toEqual({ endpoint: "http://preview-test.localhost:40000/" });
    }),
  );

  it.effect("rejects arbitrary origins, paths and malformed bridge credentials", () =>
    Effect.sync(() => {
      expect(Schema.is(NativePreviewInput)(input)).toBe(true);
      for (const endpoint of [
        "http://attacker.test/",
        "/rpc",
        "/preview/../rpc",
        `${input.endpoint}?secret=value`,
      ]) {
        expect(Schema.is(NativePreviewInput)({ ...input, endpoint })).toBe(false);
      }
      for (const secret of ["", "b".repeat(63), "b".repeat(65), "g".repeat(64)]) {
        expect(Schema.is(NativePreviewInput)({ ...input, secret })).toBe(false);
      }
    }),
  );
});
