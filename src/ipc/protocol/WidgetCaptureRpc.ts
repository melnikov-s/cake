import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../cake-rpc-contract";
import { RenderedWidgetCaptureError } from "../../services/widgets/RenderedWidgetCapture";

/** Device-local capture and separately authorized backend response. */
export const NativeWidgetCaptureRpc = RpcGroup.make(
  Rpc.make("widgets.capture-native-widget", {
    payload: cakeRpcPayloadSchemas["capture-native-widget"],
    success: cakeRpcSuccessSchemas["capture-native-widget"],
    error: RenderedWidgetCaptureError,
  }),
);

export const WidgetCaptureResponseRpc = RpcGroup.make(
  Rpc.make("widgets.respond-widget-capture", {
    payload: cakeRpcPayloadSchemas["respond-widget-capture"],
    success: cakeRpcSuccessSchemas["respond-widget-capture"],
    error: RenderedWidgetCaptureError,
  }),
);
