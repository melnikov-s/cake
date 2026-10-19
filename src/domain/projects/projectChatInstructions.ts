import { Effect, Schema } from "effect";
import { defaultProjectSettings } from "../../contracts/application/application-data";
import { ProjectError } from "../../contracts/projects/project-error";
import {
  ProjectChatInstructionsGet,
  ProjectChatInstructionsUpdate,
} from "../../contracts/projects/project-chat-instructions";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ProjectAccess } from "../../services/projects/ProjectAccess";

/** Explicit identity must be registered, and a Project Chat may only target itself. */
const requireProject = (path: string, scope: string | undefined) => {
  if (scope !== undefined && path !== scope)
    return new ProjectError({
      operation: "projectChatInstructions",
      message:
        "Project Chat instructions can only target the calling conversation’s registered project.",
    });
  return undefined;
};

export const get = Effect.fn("ProjectChatInstructions.get")(function* (
  request: ProjectChatInstructionsGet,
  scope?: string,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectChatInstructionsGet)(request);
  const scopeError = requireProject(input.projectPath, scope);
  if (scopeError) return yield* scopeError;
  const owner = yield* ApplicationState;
  const project = (yield* owner.current()).projects.find((item) => item.path === input.projectPath);
  if (!project)
    return yield* new ProjectError({
      operation: "projectChatInstructions",
      message: "No registered Project has that exact path.",
    });
  return {
    projectPath: project.path,
    instructions: project.settings?.projectChatInstructions ?? "",
  };
});

/** Coding-session writes retain the existing selected-project authorization boundary. */
export const updateFromProjectSession = Effect.fn(
  "ProjectChatInstructions.updateFromProjectSession",
)(function* (request: ProjectChatInstructionsUpdate, projectPath: string) {
  const access = yield* ProjectAccess;
  if (!(yield* access.isAllowed(projectPath)))
    return yield* new ProjectError({
      operation: "projectChatInstructions",
      message: "Project path was not selected by the user.",
    });
  return yield* update(request, projectPath);
});

export const update = Effect.fn("ProjectChatInstructions.update")(function* (
  request: ProjectChatInstructionsUpdate,
  scope?: string,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectChatInstructionsUpdate)(request);
  const scopeError = requireProject(input.projectPath, scope);
  if (scopeError) return yield* scopeError;
  const owner = yield* ApplicationState;
  const state = yield* owner.transact((current) => {
    const project = current.projects.find((item) => item.path === input.projectPath);
    if (!project)
      return Effect.fail(
        new ProjectError({
          operation: "projectChatInstructions",
          message: "No registered Project has that exact path.",
        }),
      );
    const settings = project.settings ?? defaultProjectSettings();
    if (settings.projectChatInstructions !== input.expectedInstructions)
      return Effect.fail(
        new ProjectError({
          operation: "projectChatInstructions",
          message: "Project Chat instructions changed. Read again, merge your changes, and retry.",
        }),
      );
    return Effect.succeed({
      ...current,
      projects: current.projects.map((item) =>
        item.path === project.path
          ? { ...item, settings: { ...settings, projectChatInstructions: input.instructions } }
          : item,
      ),
    });
  });
  return {
    projectPath: input.projectPath,
    instructions:
      state.projects.find((item) => item.path === input.projectPath)?.settings
        ?.projectChatInstructions ?? "",
  };
});
