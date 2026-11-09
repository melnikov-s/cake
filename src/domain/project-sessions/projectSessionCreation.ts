import { Cause, DateTime, Effect, Exit } from "effect";
import { snapshotPromptFiles } from "../../services/filesystem/prompt-files";
import type { ResultDelivery } from "../../contracts/conversations/result-delivery";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { CAKE_CHAT_TODO_SCOPE } from "../../contracts/projects/project-todos";
import {
  ensureAdmittedSession as ensureSessionTodo,
  existingTaskScope,
  attachExisting,
  detachAdmission,
} from "../projects/projectTodos";
import { type SessionRequester } from "../../contracts/project-sessions/session-reporting";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import {
  encodeCrossSessionMessage,
  type CrossSessionMessageMetadata,
} from "../../contracts/conversations/cross-session-message";
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
  readonly todoId?: string;
  readonly source?: CrossSessionMessageMetadata["sender"];
  readonly attachments?: readonly Attachment[];
  readonly name: string;
  readonly initialPrompt: string;
  readonly promptFiles?: readonly string[];
  readonly senderWorkingDirectory?: string;
  readonly model: ChatConfiguration;
  readonly worktreeName?: string;
  readonly requester?: SessionRequester;
  /**
   * How the initial result reaches its creator; defaults to notification.
   * Ignore creates no obligation. Local user/UI creation without a source owes nothing.
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
  const initialPrompt =
    input.promptFiles === undefined
      ? input.initialPrompt
      : yield* snapshotPromptFiles({
          text: input.initialPrompt,
          promptFiles: input.promptFiles,
          senderSessionId: input.source?.sessionId ?? "user",
          workingDirectory: input.senderWorkingDirectory,
        }).pipe(
          Effect.mapError(
            (error) =>
              new ProjectSessionError({ operation: "createPrompted", message: error.message }),
          ),
        );
  const sessionId = crypto.randomUUID();
  const todoScope = input.todoId
    ? yield* existingTaskScope(
        input.projectPath,
        input.todoId,
        input.source?.sessionId ?? input.requester?.sessionId,
      ).pipe(
        Effect.mapError(
          (error) =>
            new ProjectSessionError({ operation: "createPrompted", message: error.message }),
        ),
      )
    : undefined;
  const association = { kind: "session" as const, sessionId, title: input.name };
  let started = false;
  let attached = false;
  return yield* Effect.gen(function* () {
    if (todoScope && input.todoId)
      attached = yield* attachExisting(todoScope, input.todoId, association).pipe(
        Effect.mapError(
          (error) =>
            new ProjectSessionError({ operation: "createPrompted", message: error.message }),
        ),
      );
    const record = input.worktreeName
      ? yield* managedWorktrees.create({
          projectPath: input.projectPath,
          worktreeName: input.worktreeName,
          backgroundSetup: true,
        })
      : undefined;
    const workingDirectory = record?.worktreePath ?? input.projectPath;
    if (input.source)
      yield* inheritTaskInputProtection(input.source.sessionId, sessionId).pipe(
        Effect.mapError(
          (error) =>
            new ProjectSessionError({ operation: "createPrompted", message: error.message }),
        ),
      );
    const requester =
      input.requester?.kind === "cake-chat" && isCakeChatSessionId(input.requester.sessionId)
        ? input.requester
        : undefined;
    const sender = requester ?? input.source;
    const resultDelivery = input.resultDelivery ?? "notification";
    const expectsResponse = resultDelivery !== "ignore";
    const storage = yield* SessionFamilyStorage;
    const parentSessionId = input.source?.sessionId ?? requester?.sessionId;
    if (parentSessionId)
      yield* storage.registerParent({ sessionId, parentSessionId, projectPath: input.projectPath });
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
    const text = sender
      ? encodeCrossSessionMessage(initialPrompt, {
          version: 1,
          messageId: sessionId,
          threadId: sessionId,
          sequence: 1,
          expectsResponse,
          resultDelivery,
          sender: { sessionId: sender.sessionId, title: sender.title, kind: sender.kind },
        })
      : initialPrompt;
    yield* projectSessionOperations
      .start(
        {
          sessionId,
          workingDirectory,
          projectPath: input.projectPath,
          text,
          attachments: [...(input.attachments ?? [])],
          renderUserMessageAsMarkdown: input.markdown !== false,
          name: input.name.slice(0, SESSION_TITLE_MAX_LENGTH),
          configuration: input.model,
        },
        () => {
          started = true;
        },
      )
      .pipe(
        Effect.onExit((exit) =>
          !sender || !expectsResponse || Exit.isSuccess(exit)
            ? Effect.void
            : Effect.gen(function* () {
                if ((yield* storage.state()).turns.some((turn) => turn.sessionId === sessionId))
                  return;
                yield* storage.recordTurn({
                  sessionId,
                  senderSessionId: sender.sessionId,
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
    // Reuse the Project's automatic owner (or an explicit owner that won admission).
    // Global fallback bookkeeping must never create a second owner for the same session.
    if (requester?.sessionId === CAKE_CHAT_SESSION_ID)
      yield* ensureSessionTodo(CAKE_CHAT_TODO_SCOPE, sessionId, input.name, input.initialPrompt);
    return {
      ok: true as const,
      command: "sessions.create" as const,
      workspacePath: workingDirectory,
      sessionId,
      title: input.name,
      status: "started" as const,
      ...(record ? { managedWorktree: record } : null),
      ...(input.todoId ? { todoId: input.todoId } : null),
    };
  }).pipe(
    Effect.onExit((exit) =>
      !started && attached && Exit.isFailure(exit) && todoScope && input.todoId
        ? detachAdmission(todoScope, input.todoId, association).pipe(Effect.orDie)
        : Effect.void,
    ),
  );
});
