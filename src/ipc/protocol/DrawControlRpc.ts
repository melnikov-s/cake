import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { DrawControlResponse } from "../draw-control";
import { DrawSessionId } from "../../contracts/draw/draw-board-data";

export class DrawControlRpcError extends Schema.TaggedError<DrawControlRpcError>()(
  "DrawControlRpcError",
  { message: Schema.String },
) {}

export const DrawControlRpc = RpcGroup.make(
  Rpc.make("drawControl.respond", {
    payload: {
      sessionId: DrawSessionId,
      drawRequestId: Schema.String.check(Schema.isUUID(4)),
      response: DrawControlResponse,
    },
    error: DrawControlRpcError,
  }),
);
