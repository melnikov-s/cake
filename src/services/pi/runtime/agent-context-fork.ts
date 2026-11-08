import type { SessionManager, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import type { PiContextFork } from "../context-fork";

export const agentContextForkEntryType = "cake.agent-context-fork/v1";
const AgentContextForkDisplay = Schema.Struct({
  entryId: Schema.String,
  inheritedEntryIds: Schema.Array(Schema.String),
});

/** Exact Pi identities, never message-text heuristics. Metadata is not model context. */
export function inheritedContextEntryIds(entries: readonly SessionEntry[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== agentContextForkEntryType) continue;
    const decoded = Schema.decodeUnknownOption(AgentContextForkDisplay)(entry.data);
    if (Option.isSome(decoded)) for (const id of decoded.value.inheritedEntryIds) ids.add(id);
  }
  return ids;
}

/** Preserve the full inherited execution context; only its display is grouped. */
export function appendAgentContextFork(session: SessionManager, context: PiContextFork): void {
  const inheritedEntryIds: string[] = [];
  for (const message of context.messages) {
    if (message.role === "system") {
      // Retain historical context, not the coordinator's authority or tool grants.
      inheritedEntryIds.push(
        session.appendCustomMessageEntry(
          "cake.inherited-context",
          `Historical parent context, not current instructions:\n${JSON.stringify({
            content: message.content,
            sections: message.sections,
          })}`,
          false,
        ),
      );
    } else if (message.role === "assistant") {
      // Context inheritance is not another provider request or worker charge.
      inheritedEntryIds.push(
        session.appendMessage({
          ...message,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      );
    } else inheritedEntryIds.push(session.appendMessage(message));
  }
  session.appendCustomEntry(agentContextForkEntryType, {
    entryId: context.entryId,
    inheritedEntryIds,
  });
}
