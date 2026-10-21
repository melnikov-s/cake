import { windowControlDefinitions } from "../../contracts/application/window-control-definitions";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import type { TurnStop } from "../../contracts/conversations/turn-stop";
import { isActiveSessionActivity } from "../lib/session-activity";
import type { AppControlResult } from "./app-control-data";

import { defineControl, defineSessionControl } from "./control-definition";
import { toStrictJson } from "./control-json";

export const sessionLifecycleControls = [
  defineControl({
    ...windowControlDefinitions["sessions.create"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      if (!host.state.projects().some((project) => project.path === input.workspacePath))
        return { ok: false, command, error: "Cake could not find that project." };
      const created = await host.sessions.create(input);
      const result: Extract<
        AppControlResult,
        {
          ok: true;
          command: "sessions.create";
        }
      > = {
        ok: true,
        command,
        workspacePath: created.workspacePath,
        sessionId: created.sessionId,
        title: input.name,
        status: "started",
      };
      if (created.managedWorktree) result.managedWorktree = created.managedWorktree;
      return result;
    },
  }),
  defineControl({
    ...windowControlDefinitions["sessions.create-draft"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      if (!host.state.projects().some((project) => project.path === input.workspacePath))
        return { ok: false, command, error: "Cake could not find that project." };
      const created = await host.sessions.createDraft(input);
      return {
        ok: true,
        command,
        workspacePath: created.workspacePath,
        sessionId: created.sessionId,
        title: input.name,
        status: "saved-draft",
      };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.abort"],
    run: async (input, { host, source }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;
      const reason = input.reason ? { reason: input.reason } : null;
      const stop: TurnStop = source
        ? { by: "session", sessionId: source.sessionId, title: source.title, ...reason }
        : { by: "user", ...reason };

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      if (!isActiveSessionActivity(host.state.sessionActivity(sessionId)))
        return { ok: false, command, error: "That session is not currently running." };
      await host.sessions.abort(sessionId, stop);
      return { ok: true, command, target, status: "stopping" };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.rename"],
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      await host.sessions.rename(sessionId, input.title);
      return { ok: true, command, target, title: input.title };
    },
  }),

  defineControl({
    ...windowControlDefinitions["sessions.resolve"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const ids = host.state.sessions().map((session) => session.sessionId);
      const projectIds: string[] = [];
      for (const target of input.targets) {
        const resolved = resolveSessionReference(target.sessionId, ids);
        if (!resolved.ok) return { ok: false, command, error: resolved.error };
        projectIds.push(resolved.sessionId);
      }
      const projectCount = projectIds.length
        ? await host.sessions.setProjectSessionsResolved([...new Set(projectIds)], input.resolved)
        : 0;
      return toStrictJson({
        ok: true,
        command,
        targets: projectIds.map((sessionId) => ({ kind: "project", sessionId })),
        resolved: input.resolved,
        sessionCount: projectCount,
      });
    },
  }),
];
