import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type Conversation,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";
import type { InterviewEntry } from "../../contracts/interviews/interview";
import { durableToolInterview, withDurableToolInterview } from "./durable-side-chat-interviews";
import { internalInputEntryType } from "../pi/runtime/internal-input-projection";
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

/** Live SDK details are persisted before an interview requests user input. */
export async function readDurableActiveInterviews(
  tx: Pick<Tx, "doc">,
  conversationId: ConversationId,
) {
  const live = await tx.doc(LiveDoc, conversationId);
  const interviews = new Map<string, InterviewEntry>();
  if (!live?.run) return interviews;
  for (const slot of live.tools ?? []) {
    if (slot.status === "done") continue;
    const entry = durableToolInterview(slot.details, slot.callId);
    if (entry) interviews.set(boundedProjectionKey(`tool-${slot.callId}`), entry);
  }
  return interviews;
}

/** Original-only GUI projection. Keep each disk scan bounded, including pages containing
 * only derived nodes. No lifetime SessionManager or original-message cache is constructed. */
export async function readDurableOriginalPage(
  root: Pick<Conversation, "entries">,
  cursor?: string,
  activeTools: ReadonlyMap<string, number | null> = new Map(),
  presentationOverrides: Readonly<Record<string, boolean>> = {},
  activeInterviews: ReadonlyMap<string, InterviewEntry> = new Map(),
  attributions: Readonly<Record<string, { pending: boolean; todoId: string | null }>> = {},
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
          ? (entry.model ?? []).flatMap((message) => {
              const presentation =
                message.role === "user"
                  ? durableInputPresentation(
                      typeof message.content === "string"
                        ? message.content
                        : message.content
                            .flatMap((block) => (block.type === "text" ? [block.text] : []))
                            .join("\n"),
                    )
                  : undefined;
              return message.role === "system"
                ? []
                : [
                    ...(presentation?.internal
                      ? [
                          {
                            type: "custom" as const,
                            id: `internal-${entry.id}`,
                            parentId: null,
                            timestamp: new Date(message.timestamp).toISOString(),
                            customType: internalInputEntryType,
                            data: { timestamp: message.timestamp, origin: presentation.internal },
                          },
                        ]
                      : []),
                    {
                      type: "message" as const,
                      id: String(entry.id),
                      parentId: null,
                      timestamp: new Date(message.timestamp).toISOString(),
                      message: withoutDurableInputPresentation(message, { display: true }),
                    },
                    ...(presentation?.markdown
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
                  ];
            })
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
    const interviews = new Map(activeInterviews);
    for (const entry of page.items)
      for (const message of entry.model ?? []) {
        if (message.role !== "toolResult") continue;
        const interview = durableToolInterview(Reflect.get(message, "details"), message.toolCallId);
        if (interview)
          interviews.set(boundedProjectionKey(`tool-${message.toolCallId}`), interview);
      }
    const parts = projectSessionEntries(entries).map((part) => {
      // Settled originals remain authoritative. Do not mark all history live:
      // abandoned unmatched calls must still read as interrupted during a new run.
      if (part.kind === "tool")
        return withDurableToolInterview(
          part.state === "interrupted" && activeTools.has(part.id)
            ? { ...part, state: "running" as const, startedAt: activeTools.get(part.id) }
            : part,
          interviews.get(part.id),
        );
      if (part.kind !== "text" || part.role !== "user" || !part.entryId) return part;
      const origin = origins.get(part.entryId);
      const markdown = presentationOverrides[part.entryId];
      const attribution = attributions[part.entryId];
      return {
        ...part,
        ...(attribution && !attribution.pending ? { taskTodoId: attribution.todoId } : null),
        ...(origin ? { subagentReport: origin } : null),
        renderAs:
          markdown === undefined
            ? origin
              ? ("markdown" as const)
              : part.renderAs
            : markdown
              ? ("markdown" as const)
              : undefined,
      };
    });
    next = page.next === undefined ? undefined : JSON.stringify(page.next);
    if (parts.length || next === undefined) return { parts, cursor: next };
  } while (next !== undefined);
  return { parts: [], cursor: undefined };
}
