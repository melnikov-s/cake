import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { InlineWidgetError } from "../../services/widgets/InlineWidgets";
import { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../cake-rpc-contract";

export const InlineWidgetRpc = RpcGroup.make(
  Rpc.make("widgets.compile-inline-widget", {
    payload: cakeRpcPayloadSchemas["compile-inline-widget"],
    success: cakeRpcSuccessSchemas["compile-inline-widget"],
    error: InlineWidgetError,
  }),
  Rpc.make("widgets.repair-inline-widget", {
    payload: cakeRpcPayloadSchemas["repair-inline-widget"],
    success: cakeRpcSuccessSchemas["repair-inline-widget"],
    error: InlineWidgetError,
  }),
);
