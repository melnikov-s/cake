import { Schema } from "effect";
import { SessionLabelColor, type SessionLabel } from "../../services/storage/application-data";
import type { AppControlResult } from "./app-control-data";
import { sessionLabels } from "./control-projections";
import { bounded, trimmed, emptyArgumentsSchema } from "./control-arguments";
import { defineControl } from "./control-definition";
export const sessionLabelControls = [
  defineControl({
    command: "session-labels.list",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "List global and project-specific labels that can be assigned to Project Sessions.",
    },
    run: async (_input, { host }, command): Promise<AppControlResult> => {
      return { ok: true, command, labels: sessionLabels(host) };
    },
  }),
  defineControl({
    command: "session-labels.add",
    args: Schema.Struct({
      name: trimmed(1, 40),
      color: SessionLabelColor,
      projectPath: Schema.optionalKey(bounded(1, 4096)),
    }),
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Add a global or project-specific session label.",
      guidance: ["Omit projectPath to create a global label available in every Project."],
      examples: [
        {
          input: {
            name: "In review",
            color: "cyan",
          },
        },
        {
          input: {
            name: "Ready to deploy",
            color: "green",
            projectPath: "/path/to/project",
          },
          description: "Create a project-specific label.",
        },
      ],
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const projectPath = input.projectPath;
      if (projectPath && !host.state.projects().some((project) => project.path === projectPath))
        return { ok: false, command, error: "Cake could not find that project." };
      const label: SessionLabel = {
        id: crypto.randomUUID(),
        name: input.name,
        color: input.color,
      };
      await host.sessionLabels.mutate(projectPath ? { projectPath } : {}, {
        _tag: "AddLabel",
        label,
      });
      return {
        ok: true,
        command,
        label: projectPath
          ? { ...label, scope: "project", projectPath }
          : { ...label, scope: "global" },
      };
    },
  }),
  defineControl({
    command: "session-labels.update",
    args: Schema.Struct({
      labelId: Schema.String.check(Schema.isUUID(4)),
      name: Schema.optionalKey(trimmed(1, 40)),
      color: Schema.optionalKey(SessionLabelColor),
    }),
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Rename or recolor an existing session label.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const label = sessionLabels(host).find((item) => item.id === input.labelId);
      if (!label) return { ok: false, command, error: "Cake could not find that session label." };
      if (input.name === undefined && input.color === undefined)
        return { ok: false, command, error: "Provide a name or color to update." };
      await host.sessionLabels.mutate(
        label.scope === "project" ? { projectPath: label.projectPath } : {},
        {
          _tag: "UpdateLabel",
          labelId: label.id,
          ...(input.name ? { name: input.name } : null),
          ...(input.color ? { color: input.color } : null),
        },
      );
      return {
        ok: true,
        command,
        label: {
          ...label,
          ...(input.name ? { name: input.name } : null),
          ...(input.color ? { color: input.color } : null),
        },
      };
    },
  }),
  defineControl({
    command: "session-labels.remove",
    args: Schema.Struct({
      labelId: Schema.String.check(Schema.isUUID(4)),
    }),
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Remove a session label and clear it from every session that uses it.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const label = sessionLabels(host).find((item) => item.id === input.labelId);
      if (!label) return { ok: false, command, error: "Cake could not find that session label." };
      await host.sessionLabels.mutate(
        label.scope === "project" ? { projectPath: label.projectPath } : {},
        { _tag: "DeleteLabel", labelId: label.id },
      );
      return { ok: true, command, label };
    },
  }),
  defineControl({
    command: "session-labels.reorder",
    args: Schema.Struct({
      labelId: Schema.String.check(Schema.isUUID(4)),
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(99)),
    }),
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Move a global or project-specific label to a new zero-based position.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const label = sessionLabels(host).find((item) => item.id === input.labelId);
      if (!label) return { ok: false, command, error: "Cake could not find that session label." };
      await host.sessionLabels.mutate(
        label.scope === "project" ? { projectPath: label.projectPath } : {},
        { _tag: "MoveLabel", labelId: label.id, index: input.index },
      );
      return { ok: true, command, label };
    },
  }),
];
