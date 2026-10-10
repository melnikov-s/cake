import { defineDoc } from "@earendil-works/pi-durable";

/** Advisory GUI metadata, not another copy of the transcript. */
export const ChatMetadataDoc = defineDoc({
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
