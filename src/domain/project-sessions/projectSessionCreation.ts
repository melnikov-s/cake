import { Effect } from "effect";
import { SESSION_TITLE_MAX_LENGTH, type ChatConfiguration } from "../../ipc/session-contract";
import { ProjectSessionError } from "./project-session-data";
import * as projectSessionOperations from "./projectSessionOperations";
import * as projectSessionLocations from "./projectSessionLocations";
import * as managedWorktrees from "../worktrees/managedWorktrees";

/** One backend admission for independent sessions; presentation is never part of creation. */
export const createPrompted = Effect.fn("ProjectSessions.createPrompted")(function* (input: {
  readonly projectPath: string;
  readonly name: string;
  readonly initialPrompt: string;
  readonly model: ChatConfiguration;
  readonly worktreeName?: string;
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
  yield* projectSessionOperations.start({
    sessionId,
    workingDirectory,
    projectPath: input.projectPath,
    text: input.initialPrompt,
    attachments: [],
    renderUserMessageAsMarkdown: true,
    name: input.name.slice(0, SESSION_TITLE_MAX_LENGTH),
    configuration: input.model,
  });
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
