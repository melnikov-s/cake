import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  applyArtifactExitTransition,
  artifactTargetFromReminder,
} from "../../../contracts/artifacts/artifact-presentation-context";
import type { InternalInput } from "../../../contracts/conversations/internal-input";
import type { Attachment, UiPart } from "../../../contracts/conversations/session-contract";
import type { ProjectSessionPresentationMode } from "../../../contracts/project-sessions/project-session-presentation";
import {
  addResponseModeReminder,
  responseModeFromReminder,
  stripResponseModeReminder,
  type ConversationResponseMode,
} from "../../../contracts/conversations/response-mode-reminders";
import {
  addPresentationModeReminder,
  presentationModeFromReminder,
  stripPresentationModeReminder,
} from "../../../contracts/conversations/presentation-mode-reminders";
import {
  internalInputOrigins,
  isAutomaticInput,
  admittedIncomingParts,
  queuedAutomaticInputPart,
} from "./internal-input-projection";
import { promptText } from "./user-message-transport";
import { projectQueuedMessages, queuedMessageIds } from "./queued-message-projection";

export type QueuedInputPayload = {
  itemId: string;
  turnId?: string;
  text: string;
  content: string;
  attachments: Attachment[];
  renderUserMessageAsMarkdown: boolean;
  command?: string;
};

export function turnInputContent(input: {
  readonly session: Pick<
    AgentSession,
    "sessionManager" | "isStreaming" | "getSteeringMessages" | "getFollowUpMessages"
  >;
  readonly heldInputs: readonly {
    readonly content: string;
    readonly delivery: "steer" | "follow-up";
  }[];
  readonly busy: boolean;
  readonly internalInput: (content: string) => InternalInput | undefined;
  readonly text: string;
  readonly attachments: Attachment[];
  readonly delivery: "prompt" | "steer" | "follow-up";
  readonly presentationMode?: ProjectSessionPresentationMode;
  readonly responseMode?: ConversationResponseMode;
  readonly internal?: InternalInput;
}) {
  const {
    session,
    text,
    attachments,
    delivery,
    presentationMode,
    responseMode = "text",
    internal,
  } = input;
  // Pi's active branch is the authority, so reload, editing, branching and Tool
  // Compact naturally recover (or reset) the modes without a second persisted flag.
  const previousModes = (delivery: "prompt" | "steer" | "follow-up") => {
    let presentation: ProjectSessionPresentationMode = "normal";
    let response: ConversationResponseMode = "text";
    let artifactTarget = false;
    const consume = (
      messages: readonly string[],
      origin?: (message: string) => InternalInput | undefined,
    ) => {
      for (const message of messages) {
        presentation = presentationModeFromReminder(message) ?? presentation;
        response = responseModeFromReminder(message) ?? response;
        artifactTarget =
          artifactTargetFromReminder(
            stripPresentationModeReminder(stripResponseModeReminder(message)),
            origin?.(message),
          ) ?? artifactTarget;
      }
    };
    const branch = session.sessionManager.getBranch();
    const origins = internalInputOrigins(branch);
    for (const entry of branch) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const content =
        typeof entry.message.content === "string"
          ? entry.message.content
          : entry.message.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
      consume([content], () => origins.get(entry.id));
    }
    if (delivery !== "prompt") {
      consume(session.getSteeringMessages(), (content) => input.internalInput(content));
      consume(
        input.heldInputs.filter((item) => item.delivery === "steer").map((item) => item.content),
        (content) => input.internalInput(content),
      );
    }
    if (delivery === "follow-up") {
      consume(session.getFollowUpMessages(), (content) => input.internalInput(content));
      consume(
        input.heldInputs
          .filter((item) => item.delivery === "follow-up")
          .map((item) => item.content),
        (content) => input.internalInput(content),
      );
    }
    return { presentation, response, artifactTarget };
  };

  if (text.startsWith("/")) return promptText(text, attachments);
  const previous = previousModes(
    delivery === "prompt" && (session.isStreaming || input.busy || input.heldInputs.length > 0)
      ? "follow-up"
      : delivery,
  );
  const content = promptText(
    applyArtifactExitTransition(text, previous.artifactTarget, internal),
    attachments,
  );
  const presented =
    presentationMode === undefined
      ? content
      : addPresentationModeReminder(content, previous.presentation, presentationMode);
  return responseMode === previous.response
    ? presented
    : addResponseModeReminder(presented, responseMode);
}

export function projectPendingInputParts(
  queues: {
    readonly steering: readonly QueuedInputPayload[];
    readonly "follow-up": readonly QueuedInputPayload[];
  },
  internalInputById: (turnId: string) => InternalInput | undefined,
): UiPart[] {
  const parts = projectQueuedMessages(
    queues.steering.map((item) => item.content),
    queues["follow-up"].map((item) => item.content),
  );
  const payloads = new Map<string, QueuedInputPayload>();
  for (const [lane, items] of [
    ["steering", queues.steering],
    ["queued", queues["follow-up"]],
  ] as const) {
    const ids = queuedMessageIds(
      lane === "steering" ? "queued-steering" : "queued-follow-up",
      lane,
      items.map((item) => item.content),
    );
    items.forEach((item, index) => {
      const id = ids[index];
      if (id) payloads.set(id, item);
    });
  }
  return parts.flatMap((part) => {
    const item = payloads.get(part.id);
    const internal = item?.turnId ? internalInputById(item.turnId) : undefined;
    const notices = admittedIncomingParts(internal, item?.text ?? "");
    const row: UiPart =
      part.kind === "text" && item
        ? {
            ...part,
            text:
              part.crossSession || part.scheduled
                ? part.text
                : internal?._tag === "UserWithReminders"
                  ? (internal.userText ?? internal.text)
                  : item.text,
            renderAs: item.renderUserMessageAsMarkdown ? ("markdown" as const) : part.renderAs,
            queuedInput: {
              itemId: item.itemId,
              ...(item.turnId ? { turnId: item.turnId } : null),
              ...(item.command ? { command: item.command } : null),
              text:
                internal?._tag === "UserWithReminders"
                  ? (internal.userText ?? internal.text)
                  : item.text,
              attachments: item.attachments,
              renderUserMessageAsMarkdown: item.renderUserMessageAsMarkdown,
            },
          }
        : part;
    return [
      ...notices,
      isAutomaticInput(internal) && row.kind === "text"
        ? queuedAutomaticInputPart(internal, row)
        : row,
    ];
  });
}
