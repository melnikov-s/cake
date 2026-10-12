import { agentSettingsSections } from "../../contracts/application/agent-settings-schema";
import {
  CakeSettingsGetInput,
  CakeSettingsUpdateInput,
} from "../../contracts/application/cake-settings-schema";
import {
  CurrentProjectSettingsGetInput,
  CurrentProjectSettingsUpdateInput,
  ProjectSettingsGetInput,
  ProjectSettingsUpdateInput,
  type ProjectSettingsChanges,
} from "../../contracts/projects/project-settings-schema";
import type { AppControlHost, AppControlResult } from "./app-control-data";
import { emptyArgumentsSchema } from "./control-arguments";
import { defineControl } from "./control-definition";
import { toStrictJson } from "./control-json";

async function projectSettingsResult(
  host: AppControlHost,
  command:
    | "project.settings.get"
    | "project.settings.update"
    | "projects.settings.get"
    | "projects.settings.update",
  projectPath: string,
  changes?: ProjectSettingsChanges,
): Promise<AppControlResult> {
  if (!host.state.projects().some((project) => project.path === projectPath))
    return { ok: false, command, error: "Cake could not find that Project." };
  const settings = changes
    ? await host.projectSettings.update(projectPath, changes)
    : host.projectSettings.get(projectPath);
  if (!settings) return { ok: false, command, error: "Cake could not find that Project." };
  return { ok: true, command, scope: "project", projectPath, settings };
}
export const settingsControls = [
  defineControl({
    command: "settings.sections",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "settings",
      summary:
        "List the Cake settings sections available to agents, including scope and writability.",
    },
    run: async (_input, _context, command): Promise<AppControlResult> => {
      return { ok: true, command, sections: agentSettingsSections };
    },
  }),
  defineControl({
    command: "settings.get",
    args: CakeSettingsGetInput,
    scope: "global",
    discovery: {
      topic: "settings",
      summary: "Read the effective settings for one Cake settings section in the invoking window.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const view = host.settings.get(input.section);
      return toStrictJson({ ok: true, command, scope: "window", ...view });
    },
  }),
  defineControl({
    command: "settings.update",
    args: CakeSettingsUpdateInput,
    scope: "global",
    discovery: {
      topic: "settings",
      summary:
        "Patch one Cake settings section in the invoking window and return its committed effective settings.",
      guidance: [
        "Call settings.get before updating a section. Unspecified fields remain unchanged.",
        "For hotkeys, null restores the default binding and an empty string disables the shortcut.",
      ],
      examples: [
        {
          input: {
            section: "appearance",
            changes: {
              theme: "dark",
            },
          },
          description: "Use Cake's dark appearance in this window.",
        },
      ],
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const view = await host.settings.update(input);
      return toStrictJson({ ok: true, command, scope: "window", ...view });
    },
  }),
  defineControl({
    command: "project.settings.get",
    args: CurrentProjectSettingsGetInput,
    scope: "internal",
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      const projectPath = source?.kind === "project-session" ? source.projectPath : undefined;
      if (!projectPath)
        return { ok: false, command, error: "Cake could not find the calling Project." };
      return projectSettingsResult(host, command, projectPath);
    },
  }),
  defineControl({
    command: "project.settings.update",
    args: CurrentProjectSettingsUpdateInput,
    scope: "internal",
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      const projectPath = source?.kind === "project-session" ? source.projectPath : undefined;
      if (!projectPath)
        return { ok: false, command, error: "Cake could not find the calling Project." };
      return projectSettingsResult(host, command, projectPath, input.changes);
    },
  }),
  defineControl({
    command: "projects.settings.get",
    args: ProjectSettingsGetInput,
    scope: "global",
    discovery: {
      topic: "projects",
      summary: "Read every setting for one explicitly targeted Cake Project.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return projectSettingsResult(host, command, input.projectPath);
    },
  }),
  defineControl({
    command: "projects.settings.update",
    args: ProjectSettingsUpdateInput,
    scope: "global",
    discovery: {
      topic: "projects",
      summary:
        "Patch any setting for one explicitly targeted Cake Project and return all committed settings.",
      guidance: [
        "Call projects.settings.get before updating the Project. Unspecified settings remain unchanged.",
      ],
      examples: [
        {
          input: {
            projectPath: "/path/to/project",
            changes: {
              worktreeSetupCommands: "ln -s /path/to/project/node_modules node_modules",
            },
          },
        },
      ],
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return projectSettingsResult(host, command, input.projectPath, input.changes);
    },
  }),
];
