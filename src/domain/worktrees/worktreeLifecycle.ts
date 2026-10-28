import { Effect } from "effect";
import {
  defaultProjectSettings,
  type ProjectSettings,
} from "../../contracts/application/application-data";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { WorktreeLifecycle } from "../../services/worktrees/ManagedWorktrees";

/** The Project's configured worktree commands. Blank commands select the built-in Git ones. */
export const lifecycleFromSettings = (settings: ProjectSettings): WorktreeLifecycle => {
  const lifecycle: { -readonly [Key in keyof WorktreeLifecycle]: WorktreeLifecycle[Key] } = {};
  if (settings.worktreeCreateCommand.trim())
    lifecycle.createCommand = settings.worktreeCreateCommand;
  if (settings.worktreeSetupCommands.trim())
    lifecycle.setupCommand = settings.worktreeSetupCommands;
  if (settings.worktreeRemoveCommand.trim())
    lifecycle.removeCommand = settings.worktreeRemoveCommand;
  if (settings.worktreeCommandTimeoutSeconds > 0)
    lifecycle.timeout = `${settings.worktreeCommandTimeoutSeconds} seconds`;
  return lifecycle;
};

const projectSettings = Effect.fn("WorktreeLifecycle.projectSettings")(function* (
  projectPath: string,
) {
  const application = yield* ApplicationState;
  return (
    application.snapshot().projects.find((project) => project.path === projectPath)?.settings ??
    defaultProjectSettings()
  );
});

/** Lifecycle commands and landing policy for the Project that owns a Managed Worktree. */
export const forProject = Effect.fn("WorktreeLifecycle.forProject")(function* (
  projectPath: string,
) {
  const settings = yield* projectSettings(projectPath);
  return {
    lifecycle: lifecycleFromSettings(settings),
    landsThroughPullRequests: settings.worktreeLanding === "pull-request",
  };
});
