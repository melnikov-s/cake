import { Effect } from "effect";
import { NativePreviewTunnels } from "../../services/browser/NativePreviewTunnels";
import { NativePreviewTunnelRpc } from "../protocol/NativePreviewTunnelRpc";
import {
  RendererConnection,
  RendererConnectionMiddleware,
} from "../protocol/RendererConnectionMiddleware";

export const nativePreviewTunnelHandlers = NativePreviewTunnelRpc.middleware(
  RendererConnectionMiddleware,
).of({
  "browser.open-native-preview": ({ sessionId, endpoint, secret }) =>
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      const tunnels = yield* NativePreviewTunnels;
      const localEndpoint = yield* tunnels.open(connectionId, sessionId, { endpoint, secret });
      return { endpoint: localEndpoint };
    }),
});
