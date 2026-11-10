import { ASSISTANT_CONTEXT_ENTRY } from "./durable-assistant-context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type Conversation,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-durable-ai";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { isAutomaticInput } from "../pi/runtime/internal-input-projection";
import type { InterviewEntry } from "../../contracts/interviews/interview";
import { durableToolInterview, withDurableToolInterview } from "./durable-side-chat-interviews";
import { internalInputEntryType } from "../pi/runtime/internal-input-projection";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { boundedProjectionKey } from "../pi/runtime/tool-projection";
import {
  projectSessionEntries,
  userMessagePresentationEntryType,
} from "../pi/runtime/session-projection";
import {
  durableInputPresentation,
  withoutDurableInputPresentation,
} from "./durable-input-presentation";

import { DURABLE_SIDE_CHAT_IMPORT, projectImportedHistory } from "./durable-side-chat-history";

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
  originalHistoryThrough?: number,
  liveResponse?: { id: string; message: AssistantMessage },
): Promise<{ parts: UiPart[]; cursor?: string }> {
  let next = cursor;
  const visited = new Set<string>();
  do {
    if (next !== undefined) visited.add(next);
    const decoded =
      next === undefined
        ? undefined
        : Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.MutableJson)),
          )(next);
    const page = await root.entries({}, 200, decoded, BACKGROUND_CONTEXT);
    next = page.next === undefined ? undefined : JSON.stringify(page.next);
    if (next !== undefined && visited.has(next))
      throw new Error("Earlier history did not advance. Retry loading earlier messages.");
    const entries: SessionEntry[] = page.items
      .slice()
      .reverse()
      .flatMap((entry): SessionEntry[] =>
        entry.kind === ASSISTANT_CONTEXT_ENTRY
          ? [
              {
                type: "custom_message" as const,
                id: String(entry.id),
                parentId: null,
                timestamp: new Date().toISOString(),
                customType: "Companion context",
                content: Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(
                  entry.data,
                ).text,
                display: true,
              },
            ]
          : entry.kind === DURABLE_SIDE_CHAT_IMPORT
            ? [
                {
                  type: "custom" as const,
                  id: String(entry.id),
                  parentId: null,
                  timestamp: new Date().toISOString(),
                  customType: DURABLE_SIDE_CHAT_IMPORT,
                  data: entry.data,
                },
              ]
            : ["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind)
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
                                data: {
                                  timestamp: message.timestamp,
                                  origin: presentation.internal,
                                },
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
    // Pi places model inputs only at generation boundaries. Attribute replies from
    // originals, not neighboring UI rows (which may be source cards or hidden inputs).
    // Look beyond a page edge without projecting or retaining the preceding history.
    const identityForInput = (message: UserMessage, entryId: string) => {
      const input = durableInputPresentation(
        typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n"),
      );
      if (
        isAutomaticInput(input.internal) ||
        input.subagentReport ||
        parseCrossSessionMessage(input.text)
      )
        return {};
      const attribution = attributions[entryId];
      return attribution?.pending || (!attribution && input.attribution)
        ? { taskAttributionPending: true as const }
        : attribution
          ? { taskTodoId: attribution.todoId }
          : {};
    };
    let responseIdentity: Pick<
      Extract<UiPart, { kind: "text" }>,
      "taskTodoId" | "taskAttributionPending"
    > = {};
    const chronological = page.items.slice().reverse();
    const firstInputOrReply = chronological.find((entry) =>
      entry.model?.some((message) => message.role === "user" || message.role === "assistant"),
    );
    if (firstInputOrReply?.model?.[0]?.role !== "user") {
      let before = page.next;
      const visited = new Set<string>();
      while (before !== undefined) {
        const key = JSON.stringify(before);
        if (visited.has(key))
          throw new Error(
            "Earlier history attribution did not advance. Retry loading earlier messages.",
          );
        visited.add(key);
        const earlier = await root.entries({}, 200, before, BACKGROUND_CONTEXT);
        const input = earlier.items.find((entry) =>
          entry.model?.some((message) => message.role === "user"),
        );
        const message = input?.model?.findLast((message) => message.role === "user");
        if (input && message) {
          responseIdentity = identityForInput(message, String(input.id));
          break;
        }
        before = earlier.next;
      }
    }
    const identities = new Map<string, typeof responseIdentity>();
    for (const entry of chronological) {
      for (const message of entry.model ?? []) {
        if (message.role === "user") responseIdentity = identityForInput(message, String(entry.id));
        if (entry.kind === "pi.user" || entry.kind === "pi.assistant")
          identities.set(String(entry.id), responseIdentity);
      }
    }
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
    const inheritedIds = new Set(
      page.items
        .filter(
          (entry) => originalHistoryThrough !== undefined && entry.id <= originalHistoryThrough,
        )
        .flatMap((entry) => [String(entry.id), `internal-${entry.id}`, `presentation-${entry.id}`]),
    );
    const projected = [];
    let chunk: SessionEntry[] = [];
    let inherited = false;
    const mark = (parts: ReturnType<typeof projectSessionEntries>) =>
      parts.map((part) => (inherited ? { ...part, originalHistory: true } : part));
    const flush = () => {
      projected.push(...mark(projectSessionEntries(chunk)));
      chunk = [];
    };
    for (const entry of entries) {
      const nextInherited = inheritedIds.has(entry.id);
      if (inherited !== nextInherited) flush();
      inherited = nextInherited;
      if (entry.type === "custom" && entry.customType === DURABLE_SIDE_CHAT_IMPORT) {
        flush();
        const original = page.items.find((item) => String(item.id) === entry.id);
        if (original) projected.push(...mark(projectImportedHistory(original)));
      } else chunk.push(entry);
    }
    flush();
    const parts = projected.map((part) => {
      // Settled originals remain authoritative. Do not mark all history live:
      // abandoned unmatched calls must still read as interrupted during a new run.
      if (part.kind === "tool")
        return withDurableToolInterview(
          part.state === "interrupted" && activeTools.has(part.id)
            ? { ...part, state: "running" as const, startedAt: activeTools.get(part.id) }
            : part,
          interviews.get(part.id),
        );
      if (part.kind !== "text" || !part.entryId) return part;
      if (part.role !== "user") return { ...part, ...identities.get(part.entryId) };
      const origin = origins.get(part.entryId);
      const markdown = presentationOverrides[part.entryId];
      return {
        ...part,
        ...identities.get(part.entryId),
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
    if (liveResponse)
      parts.push(
        ...projectSessionEntries(
          [
            {
              type: "message",
              id: liveResponse.id,
              parentId: null,
              timestamp: new Date(liveResponse.message.timestamp).toISOString(),
              message: liveResponse.message,
            },
          ],
          undefined,
          { live: true },
        ).map((part) =>
          part.kind === "text"
            ? { ...part, ...responseIdentity, status: "streaming" as const }
            : part,
        ),
      );
    // optionalKey(String) requires absence at exhaustion, not an own undefined key.
    // Returning cursor: undefined fails RPC encoding instead of delivering the last page.
    if (parts.length || next === undefined) {
      if (next === undefined) return { parts };
      return { parts, cursor: next };
    }
  } while (next !== undefined);
  return { parts: [] };
}
