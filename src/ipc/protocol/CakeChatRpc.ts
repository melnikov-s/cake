import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  CakeChatCatalogQuery,
  CakeChatError,
  CakeChatPreview,
  CakeChatStartInput,
  CakeChatTarget,
  CakeChatControlUpdate,
} from "../cake-chat-data";
import { CakeChatCatalogUpdate } from "../../domain/application/catalog-data";
import { TurnId } from "../conversation-data";
import { RendererConnectionMiddleware } from "./RendererConnectionMiddleware";

export const CakeChatRpc = RpcGroup.make(
  Rpc.make("cakeChats.observeCatalog", {
    payload: CakeChatCatalogQuery,
    success: CakeChatCatalogUpdate,
    error: CakeChatError,
    stream: true,
  }),
  Rpc.make("cakeChats.inspect", {
    payload: { sessionId: CakeChatTarget.fields.sessionId },
    success: CakeChatPreview,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.open", {
    payload: CakeChatTarget,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.observeControls", {
    payload: CakeChatTarget,
    success: CakeChatControlUpdate,
    error: CakeChatError,
    stream: true,
  }),
  Rpc.make("cakeChats.start", {
    payload: CakeChatStartInput,
    success: TurnId,
    error: CakeChatError,
  }),
  Rpc.make("cakeChats.respondControl", {
    payload: {
      controlRequestId: Schema.String.check(Schema.isUUID(4)),
      result: Schema.Json,
    },
    error: CakeChatError,
  }),
).middleware(RendererConnectionMiddleware);
