import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "../../../src/domain/application/desktop-host-data";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../src/services/clients/ClientConnections";
import { Effect } from "effect";
import { backendConnectionHandlers } from "../../../src/ipc/server/BackendConnectionHandlers";
import { RendererConnection } from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import { cakeBuildId } from "../../../src/ipc/protocol/BackendConnectionRpc";

describe("desktop server selection", () => {
  it.each([
    ["http://example.com", "ws://example.com/rpc"],
    ["https://example.com:8443/", "wss://example.com:8443/rpc"],
    ["wss://example.com/rpc", "wss://example.com/rpc"],
    ["ws://[::1]:4317", "ws://[::1]:4317/rpc"],
  ])("normalizes %s without downgrading TLS", (input, expected) =>
    expect(normalizeServerUrl(input)).toBe(expected),
  );
  it.each([
    "http://user:secret@example.com",
    "https://example.com/?token=secret",
    "ws://example.com/rpc#secret",
    "file:///tmp/socket",
    "ws://example.com/other",
    "not a url",
  ])("refuses ambiguous or credential-bearing endpoints", (input) => {
    expect(() => normalizeServerUrl(input)).toThrow();
    try {
      normalizeServerUrl(input);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
  it("requires this build before assigning remote desktop capabilities, never a native mapping", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connections = yield* ClientConnections;
          const id = connections.socket();
          const context = { connectionId: id, correlationId: "connect" };
          const mismatch = yield* backendConnectionHandlers["backendConnection.connect"]({
            buildId: "wrong",
          }).pipe(Effect.provideService(RendererConnection, context), Effect.flip);
          expect(mismatch.message).toContain("Incompatible Cake server");
          expect(connections.kind(id)).toBe("browser");
          yield* backendConnectionHandlers["backendConnection.connect"]({
            buildId: cakeBuildId,
          }).pipe(Effect.provideService(RendererConnection, context));
          expect(connections.kind(id)).toBe("desktop");
          expect(connections.nativeId(id)).toBeUndefined();
          const native = connections.desktop(1);
          connections.release(id);
          expect(connections.nativeId(native)).toBe(1);
        }),
      ).pipe(Effect.provide(ClientConnectionsLive)),
    );
  });
});
