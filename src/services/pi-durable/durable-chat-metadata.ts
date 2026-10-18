import { defineDoc } from "@earendil-works/pi-durable";
import type { SessionContextMetadata } from "../../contracts/conversations/session-context-metadata";

type ChatMetadata = {
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  contextMetadata?: typeof SessionContextMetadata.Type;
};

/** Advisory GUI metadata, not another copy of the transcript. */
export const ChatMetadataDoc = defineDoc<ChatMetadata>({
  kind: "cake.chat-metadata",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    messageCount: 0,
  }),
});
