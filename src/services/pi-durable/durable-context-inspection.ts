import type { Message } from "@earendil-works/pi-durable-ai";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-durable-ai/utils/transcript";
import type {
  ContextInspection,
  ContextInspectionNode,
} from "../../contracts/conversations/context-inspection";
import { contextMessage, contextSources } from "../pi/runtime/context-outline";
import { withoutDurableInputPresentation } from "./durable-input-presentation";

/** Read the committed active head. Never synchronize/recompress memory or prepare a model request. */
export function durableContextInspection(
  messages: readonly Message[],
  cwd: string,
  memoryHandoff: Message | undefined,
): ContextInspection {
  const sources = contextSources(getCurrentSystemPrompt(messages), getCurrentTools(messages), cwd);
  const originals: ContextInspectionNode[] = [];
  const memories: ContextInspectionNode[] = [];
  let handoffRead = false;
  for (const [index, raw] of messages.entries()) {
    if (raw.role === "system") continue;
    const message = withoutDurableInputPresentation(raw);
    const remembered =
      !handoffRead &&
      memoryHandoff &&
      raw.timestamp === memoryHandoff.timestamp &&
      raw.content === memoryHandoff.content &&
      message.role === "user" &&
      typeof message.content === "string"
        ? message.content.match(
            /^<chat>\n([\s\S]*?)\n<\/chat>\n\n(<current-time>Backend clock \(UTC\):[^<]*<\/current-time>)$/,
          )
        : null;
    if (remembered) {
      handoffRead = true;
      for (const line of remembered[1]!.split("\n")) {
        const range = line.match(/^(\d+)\+(\d+)\|([\s\S]*)$/);
        if (!range) continue;
        memories.push({
          id: `memory-${range[1]}+${range[2]}`,
          title: range[3]!,
          kind: "summary",
          source: `Pi Durable summary ${range[1]}+${range[2]}`,
          detail: { memoryId: Number(range[1]), memoryCount: Number(range[2]) },
        });
      }
      sources.push({ id: `clock-${index}`, title: "Clock", text: remembered[2]! });
    } else {
      originals.push(contextMessage(`message-${index}`, message.role, message.content));
    }
  }
  if (originals.length) sources.push({ id: "messages", title: "Messages", children: originals });
  if (memories.length) sources.push({ id: "memory", title: "Memory", children: memories });
  return { sources };
}
