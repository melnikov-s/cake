import { windowControlDefinitions } from "../../contracts/application/window-control-definitions";
import { Schema } from "effect";
import type { AppControlResult } from "./app-control-data";
import { getAppState } from "./control-projections";
import { trimmed } from "./control-arguments";
import { defineControl } from "./control-definition";
export const applicationControls = [
  defineControl({
    ...windowControlDefinitions["app.state"],
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      return { ok: true, command, state: getAppState(host, source) };
    },
  }),
  defineControl({
    ...windowControlDefinitions["app.user-selection"],
    run: async (_input, { host }, command): Promise<AppControlResult> => {
      return { ok: true, command, text: host.state.userSelection() };
    },
  }),
  defineControl({
    ...windowControlDefinitions["app.split"],
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (!source)
        return {
          ok: false,
          command,
          error: "Cake can only split a pane for a calling conversation.",
        };
      const split = host.presentation.splitView(source, input.direction);
      if (!split)
        return { ok: false, command, error: "Cake could not split that conversation pane." };
      return {
        ok: true,
        command,
        direction: input.direction,
        ...split,
      };
    },
  }),
  defineControl({
    ...windowControlDefinitions["notifications.send"],
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      await host.presentation.showNotification({
        title: input.title,
        body: input.body,
        level: input.level,
        source,
      });
      return { ok: true, command, status: "queued" };
    },
  }),
  defineControl({
    command: "agent.action",
    args: Schema.Struct({
      action: Schema.Literals(["compact", "rename", "resolve", "restore", "set-model"]),
      detail: Schema.optionalKey(trimmed(1, 500)),
    }),
    scope: "internal",
    run: async (input, _context, command): Promise<AppControlResult> => {
      const result: Extract<
        AppControlResult,
        {
          command: "agent.action";
        }
      > = {
        ok: true,
        command,
        action: input.action,
      };
      if (input.detail) result.detail = input.detail;
      return result;
    },
  }),
];
