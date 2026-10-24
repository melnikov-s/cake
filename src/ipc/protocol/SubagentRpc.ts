import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  SubagentError,
  SubagentHandleId,
  SubagentParent,
  SubagentUpdate,
} from "../../contracts/subagents/subagent-data";

import {
  AttachmentContent,
  AttachmentReadInput,
} from "../../contracts/conversations/attachment-reference-control";

export const SubagentRpc = RpcGroup.make(
  Rpc.make("subagents.observe", {
    payload: SubagentParent,
    success: SubagentUpdate,
    error: SubagentError,
    stream: true,
  }),
  Rpc.make("subagents.readAttachment", {
    payload: {
      ...SubagentParent.fields,
      handleId: SubagentHandleId,
      ...AttachmentReadInput.fields,
    },
    success: AttachmentContent,
    error: SubagentError,
  }),
  Rpc.make("subagents.submit", {
    payload: {
      ...SubagentParent.fields,
      handleId: SubagentHandleId,
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
      renderUserMessageAsMarkdown: Schema.Boolean,
    },
    success: Schema.Struct({ turnId: Schema.String }),
    error: SubagentError,
  }),
  Rpc.make("subagents.editQueued", {
    payload: {
      ...SubagentParent.fields,
      handleId: SubagentHandleId,
      partId: Schema.String,
      operation: Schema.Literals(["remove", "steer", "send-now", "reorder"]),
      itemId: Schema.optionalKey(Schema.String),
      position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    },
    error: SubagentError,
  }),
  Rpc.make("subagents.setUserMessageMarkdown", {
    payload: {
      ...SubagentParent.fields,
      handleId: SubagentHandleId,
      entryId: Schema.String,
      renderAsMarkdown: Schema.Boolean,
    },
    error: SubagentError,
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
