import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import {
  parseCrossSessionMessage,
  projectCrossSessionMessageForAgent,
} from "../../../contracts/conversations/cross-session-message";
import type { SessionReferenceControl } from "../../../contracts/agent/cake-operation-options";

/** Pi's effective request context is a disposable projection, not the routing authority. */
export function createSessionReferenceExtension(control: SessionReferenceControl): InlineExtension {
  return (pi) => {
    pi.on("context", async (event) => {
      const containsEnvelope = event.messages.some(
        (message) =>
          message.role === "user" &&
          (Schema.is(Schema.String)(message.content)
            ? parseCrossSessionMessage(message.content) !== undefined
            : message.content.some(
                (part) => part.type === "text" && parseCrossSessionMessage(part.text) !== undefined,
              )),
      );
      if (!containsEnvelope) return;
      const ids = await control.ids(new AbortController().signal);
      return {
        messages: event.messages.map((message) => {
          if (message.role !== "user") return message;
          const content = Schema.is(Schema.String)(message.content)
            ? projectCrossSessionMessageForAgent(message.content, ids)
            : message.content.map((part) =>
                part.type === "text"
                  ? { ...part, text: projectCrossSessionMessageForAgent(part.text, ids) }
                  : part,
              );
          return { ...message, content };
        }),
      };
    });
  };
}
