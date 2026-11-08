import { Effect } from "effect";
import { agentListPage, type AgentListInput } from "../../contracts/agent/agent-list-data";
import { isReferenceNotification } from "../../contracts/conversations/reference-notification";
import type {
  CompletionInboxItem,
  CompletionInboxUpdate,
} from "../../contracts/conversations/completion-inbox";
import type { CakeChatLaunchStatus } from "../../contracts/project-sessions/session-reporting";
import type { BoardEntry } from "../../contracts/artifacts/message-board";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { type SessionFamily } from "../../contracts/session-families/session-family-document";

/** One durable notice plus a separately retained decision record. Delivery never authorizes an action. */
export const queue = Effect.fn("CompletionInbox.queue")(function* (
  input: Omit<CompletionInboxItem, "state" | "decisions"> & {
    readonly status: CakeChatLaunchStatus;
    readonly isolated?: boolean;
    readonly notify?: boolean;
  },
) {
  const storage = yield* SessionFamilyStorage;
  const { status, isolated, notify, ...item } = input;
  const summary = isReferenceNotification(item.summary)
    ? "Result available in the linked message."
    : item.summary;
  yield* storage.recordCompletion(
    {
      ...item,
      summary,
      state: "pending",
      decisions:
        item.kind === "blocked"
          ? ["next-step"]
          : [
              "review",
              ...(isolated && item.kind === "ready" ? ["merge" as const] : []),
              "resolve",
              "next-step",
            ],
    },
    notify === false ? undefined : { ...item, summary, status },
  );
});

export const list = Effect.fn("CompletionInbox.list")(function* (
  sessionId: string,
  input: AgentListInput = {},
) {
  const document = yield* (yield* SessionFamilyStorage).state();
  const items = (document.completionInbox ?? [])
    .map((item) => {
      const autoMerge = [...(document.autoMergeRequests ?? [])]
        .reverse()
        .find((request) => request.sessionId === item.sessionId);
      return autoMerge ? { ...item, autoMerge } : item;
    })
    .filter(
      (item) =>
        item.coordinatorSessionId === sessionId &&
        (item.state === "pending" || item.state === "deferred"),
    );
  const query = input.query?.toLowerCase();
  return agentListPage(
    query
      ? items.filter((item) =>
          `${item.title} ${item.summary} ${item.sessionId}`.toLowerCase().includes(query),
        )
      : items,
    input,
  );
});
export const update = Effect.fn("CompletionInbox.update")(function* (
  sessionId: string,
  input: CompletionInboxUpdate,
) {
  yield* (yield* SessionFamilyStorage).updateCompletion(sessionId, input.id, input.state);
  return yield* list(sessionId);
});

export const queueBoardResult = Effect.fn("CompletionInbox.queueBoardResult")(function* (
  family: SessionFamily,
  boardId: string,
  entry: BoardEntry,
) {
  if ((entry.event !== "completion" && entry.event !== "blocker") || entry.audience === "workgroup")
    return;
  const child = family.children.find((member) => member.sessionId === entry.authorSessionId);
  if (!child || !entry.audience.includes(child.parentSessionId)) return;
  yield* queue({
    id: `board:${boardId}:${entry.sequence}`,
    coordinatorSessionId: child.parentSessionId,
    sessionId: child.sessionId,
    title: `Session ${child.sessionId}`,
    summary: entry.description.slice(0, 500),
    reportedAt: entry.createdAt,
    status: entry.event === "blocker" ? "blocked" : "completed",
    kind: entry.event === "blocker" ? "blocked" : (entry.resultKind ?? "ready"),
    isolated:
      child.workingDirectory !==
      (family.children.find((member) => member.sessionId === child.parentSessionId)
        ?.workingDirectory ?? family.workingDirectory),
  });
});
