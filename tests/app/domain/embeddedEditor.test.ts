import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import * as editor from "../../../src/domain/application/embeddedEditor";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../src/services/clients/ClientConnections";
import { DesktopHost } from "../../../src/services/electron/DesktopHost";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { VsCodeViews } from "../../../src/services/vscode/VsCodeViews";
import type { VsCodeLease } from "../../../src/services/vscode/VsCodeServerRuntime";

const lease = (connectionId: number): VsCodeLease => ({
  id: "a".repeat(64),
  connectionId,
  workspacePath: "/server/project",
  presentedWorkspacePath: "/server/project",
  url: "http://127.0.0.1:4321/?tkn=internal-token",
  flavor: "codeserver",
  visible: false,
  revocation: new AbortController(),
});

it.effect(
  "both IPC and socket desktops receive only lease-bound capabilities, never internal addresses or tokens",
  () =>
    Effect.gen(function* () {
      const connections = yield* ClientConnections;
      const local = connections.desktop(41);
      const remote = connections.socket();
      connections.remoteDesktop(remote);
      const request = {
        requestId: "open",
        workspacePath: "/server/project",
        theme: "dark" as const,
      };
      expect(yield* editor.acquire(local, request)).toEqual({
        id: "a".repeat(64),
        endpoint: `/editor/${local}/${"a".repeat(64)}/`,
      });
      const remoteLease = yield* editor.acquire(remote, request);
      expect(remoteLease).toEqual({
        id: "a".repeat(64),
        endpoint: `/editor/${remote}/${"a".repeat(64)}/`,
      });
      expect(JSON.stringify(remoteLease)).not.toMatch(
        /127\.0\.0\.1|internal-token|server\/project/,
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          ClientConnectionsLive,
          Layer.mock(VsCodeServer, {
            acquire: (id) => Effect.succeed(lease(id)),
            leaseFor: () => undefined,
          }),
        ),
      ),
    ),
);

it.effect(
  "remote presentation needs no backend and accepts only the configured host's bounded editor path",
  () =>
    Effect.gen(function* () {
      const open = vi.fn(() => Effect.void);
      const native = Layer.merge(
        Layer.mock(DesktopHost, {
          current: () => ({ kind: "remote" as const, url: "wss://server.example:443/rpc" }),
        }),
        Layer.mock(VsCodeViews, { open, backToAgentForWindow: () => false }),
      );
      const endpoint = {
        workspacePath: "/vm/path/never-read-locally",
        theme: "light" as const,
        url: `https://server.example/editor/52/${"a".repeat(64)}/`,
      };
      yield* editor.present(9, endpoint).pipe(Effect.provide(native));
      expect(open).toHaveBeenCalledExactlyOnceWith(9, endpoint);
      for (const url of [
        "http://127.0.0.1:1234/",
        endpoint.url.replace("server.example", "other.example"),
        "https://server.example/proxy/1234/",
        endpoint.url + "?url=http://127.0.0.1",
        endpoint.url.replace("https://", "https://user@"),
      ]) {
        const error = yield* editor
          .present(9, { ...endpoint, url })
          .pipe(Effect.provide(native), Effect.flip);
        expect(error.operation).toBe("openView");
      }
      expect(open).toHaveBeenCalledOnce();
    }),
);

it.effect(
  "local native presentation rejects arbitrary loopback ports and other owners' workspace metadata",
  () =>
    Effect.gen(function* () {
      const open = vi.fn(() => Effect.void);
      const native = Layer.mergeAll(
        Layer.mock(DesktopHost, { current: () => ({ kind: "local" as const }) }),
        Layer.mock(VsCodeViews, { open, backToAgentForWindow: () => false }),
        Layer.mock(VsCodeServer, { leaseFor: (id) => (id === 7 ? lease(7) : undefined) }),
      );
      const endpoint = {
        workspacePath: "/server/project",
        url: `/editor/7/${"a".repeat(64)}/`,
        theme: "dark" as const,
      };
      yield* editor.present(7, endpoint).pipe(Effect.provide(native));
      for (const [id, request] of [
        [8, endpoint],
        [7, { ...endpoint, workspacePath: "/other/project" }],
        [7, { ...endpoint, url: "http://127.0.0.1:9999/" }],
      ] as const) {
        expect(
          (yield* editor.present(id, request).pipe(Effect.provide(native), Effect.flip)).operation,
        ).toBe("openView");
      }
      expect(open).toHaveBeenCalledExactlyOnceWith(7, { ...endpoint, url: lease(7).url });
    }),
);
