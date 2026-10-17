import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { InlineWidgetError } from "../../contracts/widgets/inline-widgets-errors";
import {
  cakeRpcPayloadSchemas,
  cakeRpcSuccessSchemas,
} from "../../contracts/application/cake-rpc-contract";

export const InlineWidgetRpc = RpcGroup.make(
  Rpc.make("widgets.release", {
    payload: Schema.Struct({ token: Schema.String }),
    success: Schema.Void,
  }),
  Rpc.make("widgets.open-widget-browser", {
    payload: cakeRpcPayloadSchemas["open-widget-browser"],
    success: cakeRpcSuccessSchemas["open-widget-browser"],
    error: InlineWidgetError,
  }),
  Rpc.make("widgets.compile-inline-widget", {
    payload: cakeRpcPayloadSchemas["compile-inline-widget"],
    success: cakeRpcSuccessSchemas["compile-inline-widget"],
    error: InlineWidgetError,
  }),
);
