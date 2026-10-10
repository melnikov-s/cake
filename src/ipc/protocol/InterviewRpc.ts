import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { InterviewError, InterviewResponse } from "../../contracts/interviews/interview";

export const InterviewRpc = RpcGroup.make(
  Rpc.make("interviews.respond", {
    payload: InterviewResponse,
    success: Schema.Void,
    error: InterviewError,
  }),
);
