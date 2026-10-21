import { Cause, DateTime, Effect, Exit } from "effect";
import type { ResultDelivery } from "../../contracts/conversations/result-delivery";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { type SessionRequester } from "../../contracts/project-sessions/session-reporting";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { encodeCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { inheritTaskInputProtection } from "../conversations/taskInputs";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Attachment,
  type ChatConfiguration,
} from "../../contracts/conversations/session-contract";
import { ProjectSessionError } from "../../contracts/project-sessions/project-session-data";
import * as projectSessionOperations from "./projectSessionOperations";
import * as projectSessionLocations from "./projectSessionLocations";
import * as managedWorktrees from "../worktrees/managedWorktrees";

/** One backend admission for independent sessions; presentation is never part of creation. */
export const createPrompted = Effect.fn("ProjectSessions.createPrompted")(function* (input: {
  readonly projectPath: string;
  readonly sourceSessionId?: string;
  readonly attachments?: readonly Attachment[];
  readonly name: string;
  readonly initialPrompt: string;
  readonly model: ChatConfiguration;
  readonly worktreeName?: string;
  readonly requester?: SessionRequester;
  /**
   * How the initial result reaches a permanent-chat requester; defaults to notification.
   * Ignore creates no obligation. Independent local creation has no requester relationship.
   */
  readonly resultDelivery?: ResultDelivery;
  readonly markdown?: boolean;
}) {
  const locations = yield* projectSessionLocations.locations();
  if (
    !locations.some(
      (item) =>
        item.projectPath === input.projectPath && item.workingDirectory === input.projectPath,
    )
  )
    return yield* new ProjectSessionError({
      operation: "createPrompted",
      message: "The Project is not registered",
    });
  const record = input.worktreeName
    ? yield* managedWorktrees.create({
        projectPath: input.projectPath,
        worktreeName: input.worktreeName,
        backgroundSetup: true,
      })
    : undefined;
  const workingDirectory = record?.worktreePath ?? input.projectPath;
  const sessionId = crypto.randomUUID();
  if (input.sourceSessionId)
    yield* inheritTaskInputProtection(input.sourceSessionId, sessionId).pipe(
      Effect.mapError(
        (error) => new ProjectSessionError({ operation: "createPrompted", message: error.message }),
      ),
    );
  const requester =
    input.requester?.kind === "cake-chat" && isCakeChatSessionId(input.requester.sessionId)
      ? input.requester
      : undefined;
  const resultDelivery = input.resultDelivery ?? "notification";
  const expectsResponse = resultDelivery !== "ignore";
  const storage = yield* SessionFamilyStorage;
  if (requester)
    yield* storage.registerSpawn({
      sessionId,
      projectPath: input.projectPath,
      workingDirectory,
      requester,
      title: input.name,
      reportDelivered: false,
      resultDelivery,
      launchedAt: DateTime.formatIso(yield* DateTime.now),
      // Without an initial obligation there is no handoff to wait for or recover.
      handoffSettled: !expectsResponse,
    });
  const text = requester
    ? encodeCrossSessionMessage(input.initialPrompt, {
        version: 1,
        messageId: sessionId,
        threadId: sessionId,
        sequence: 1,
        expectsResponse,
        resultDelivery,
        sender: { sessionId: requester.sessionId, title: requester.title, kind: requester.kind },
      })
    : input.initialPrompt;
  yield* projectSessionOperations
    .start({
      sessionId,
      workingDirectory,
      projectPath: input.projectPath,
      text,
      attachments: [...(input.attachments ?? [])],
      renderUserMessageAsMarkdown: input.markdown !== false,
      name: input.name.slice(0, SESSION_TITLE_MAX_LENGTH),
      configuration: input.model,
    })
    .pipe(
      Effect.onExit((exit) =>
        !requester || !expectsResponse || Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              if ((yield* storage.state()).turns.some((turn) => turn.sessionId === sessionId))
                return;
              yield* storage.recordTurn({
                sessionId,
                senderSessionId: requester.sessionId,
                turnId: sessionId,
                requestMessageId: sessionId,
                threadId: sessionId,
                reported: false,
                resultDelivery,
                outcome: Cause.hasInterrupts(exit.cause) ? "aborted" : "failed",
                ...(!Cause.hasInterrupts(exit.cause)
                  ? {
                      report: {
                        outcome: "failed" as const,
                        text: Cause.pretty(exit.cause).slice(0, 100_000),
                      },
                    }
                  : null),
              });
            }),
      ),
    );
  return {
    ok: true as const,
    command: "sessions.create" as const,
    workspacePath: workingDirectory,
    sessionId,
    title: input.name,
    status: "started" as const,
    ...(record ? { managedWorktree: record } : null),
  };
});
