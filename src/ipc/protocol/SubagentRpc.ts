import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  SubagentError,
  SubagentHandleId,
  SubagentParent,
  SubagentUpdate,
} from "../../domain/subagents/subagent-data";

export const SubagentRpc = RpcGroup.make(
  Rpc.make("subagents.observe", {
    payload: SubagentParent,
    success: SubagentUpdate,
    error: SubagentError,
    stream: true,
  }),
  Rpc.make("subagents.prompt", {
    payload: {
      ...SubagentParent.fields,
      handleId: SubagentHandleId,
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
    },
    error: SubagentError,
  }),
  Rpc.make("subagents.steer", {
    payload: {
      ...SubagentParent.fields,
      handleId: SubagentHandleId,
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
    },
    error: SubagentError,
  }),
  Rpc.make("subagents.abort", {
    payload: { ...SubagentParent.fields, handleId: SubagentHandleId },
    error: SubagentError,
  }),
  Rpc.make("subagents.close", {
    payload: { ...SubagentParent.fields, handleId: SubagentHandleId },
    error: SubagentError,
  }),
);
