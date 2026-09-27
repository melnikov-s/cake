import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { PiProviderAuthError } from "../../services/pi/model-data";
import { SessionChatError, SessionChatTarget } from "../../domain/conversations/conversation-data";

/** Pi authentication is server-owned; interactive prompts target the initiating desktop client. */
export const ProviderAuthRpc = RpcGroup.make(
  Rpc.make("models.login", {
    payload: {
      provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      authType: Schema.Literals(["api_key", "oauth"]),
    },
    error: PiProviderAuthError,
  }),
  Rpc.make("models.logout", {
    payload: { provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)) },
    error: PiProviderAuthError,
  }),
  Rpc.make("sessionChats.login", {
    payload: {
      ...SessionChatTarget.fields,
      provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      authType: Schema.Literals(["api_key", "oauth"]),
    },
    error: SessionChatError,
  }),
  Rpc.make("sessionChats.logout", {
    payload: {
      ...SessionChatTarget.fields,
      provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    },
    error: SessionChatError,
  }),
);
