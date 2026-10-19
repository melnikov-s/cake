import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type Conversation,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  boundedProjectionKey,
  projectSessionEntries,
  userMessagePresentationEntryType,
} from "../pi/runtime/session-projection";
import {
  durableInputPresentation,
  withoutDurableInputPresentation,
} from "./durable-input-presentation";

/** Read only the current run's unfinished slots in the same transaction as history.
 * A missing start is authoritative: a sequential sibling is still waiting. */
export async function readDurableActiveTools(
  tx: Pick<Tx, "doc" | "task">,
  conversationId: ConversationId,
) {
  const live = await tx.doc(LiveDoc, conversationId);
  const active = new Map<string, number | null>();
  if (!live?.run) return active;
  for (const slot of live.tools ?? []) {
    if (slot.status === "done") continue;
    const task = slot.status === "running" && slot.taskId ? await tx.task(slot.taskId) : undefined;
    active.set(boundedProjectionKey(`tool-${slot.callId}`), task?.startedAt ?? null);
  }
  return active;
}

/** Original-only GUI projection. Keep each disk scan bounded, including pages containing
 * only derived nodes. No lifetime SessionManager or original-message cache is constructed. */
export async function readDurableOriginalPage(
  root: Pick<Conversation, "entries">,
  cursor?: string,
  activeTools: ReadonlyMap<string, number | null> = new Map(),
) {
  let next = cursor;
  do {
    const decoded =
      next === undefined
        ? undefined
        : Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
          )(next);
    const page = await root.entries({}, 200, decoded, BACKGROUND_CONTEXT);
    const entries: SessionEntry[] = page.items
      .slice()
      .reverse()
      .flatMap((entry) =>
        ["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind)
          ? (entry.model ?? []).flatMap((message) =>
              message.role === "system"
                ? []
                : [
                    {
                      type: "message" as const,
                      id: String(entry.id),
                      parentId: null,
                      timestamp: new Date(message.timestamp).toISOString(),
                      message: withoutDurableInputPresentation(message, { display: true }),
                    },
                    ...(message.role === "user" &&
                    durableInputPresentation(
                      typeof message.content === "string"
                        ? message.content
                        : message.content
                            .flatMap((block) => (block.type === "text" ? [block.text] : []))
                            .join("\n"),
                    ).markdown
                      ? [
                          {
                            type: "custom" as const,
                            id: `presentation-${entry.id}`,
                            parentId: null,
                            timestamp: new Date(message.timestamp).toISOString(),
                            customType: userMessagePresentationEntryType,
                            data: { targetId: String(entry.id), renderAs: "markdown" },
                          },
                        ]
                      : []),
                  ],
            )
          : [],
      );
    const origins = new Map(
      page.items.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) => {
          if (entry.kind !== "pi.user" || message.role !== "user") return [];
          const input = durableInputPresentation(
            typeof message.content === "string"
              ? message.content
              : message.content
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join("\n"),
          );
          return input.subagentReport ? [[String(entry.id), input.subagentReport] as const] : [];
        }),
      ),
    );
    const parts = projectSessionEntries(entries).map((part) => {
      // Settled originals remain authoritative. Do not mark all history live:
      // abandoned unmatched calls must still read as interrupted during a new run.
      if (part.kind === "tool" && part.state === "interrupted" && activeTools.has(part.id))
        return { ...part, state: "running" as const, startedAt: activeTools.get(part.id) };
      return part.kind === "text" &&
        part.role === "user" &&
        part.entryId &&
        origins.has(part.entryId)
        ? { ...part, subagentReport: origins.get(part.entryId), renderAs: "markdown" as const }
        : part;
    });
    next = page.next === undefined ? undefined : JSON.stringify(page.next);
    if (parts.length || next === undefined) return { parts, cursor: next };
  } while (next !== undefined);
  return { parts: [], cursor: undefined };
}
