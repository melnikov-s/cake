import { Effect, Schema } from "effect";
import type { AppControlResult } from "./app-control-data";
import { getAppState } from "./control-projections";
import { trimmed, emptyArgumentsSchema } from "./control-arguments";
import { defineControl } from "./control-definition";
export const applicationControls = [
  defineControl({
    command: "app.state",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "app",
      summary:
        "Inspect Cake's current selection, split-pane layout, directional neighbors, and project and session summaries.",
    },
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      return { ok: true, command, state: getAppState(host, source) };
    },
  }),
  defineControl({
    command: "app.user-selection",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "app",
      summary: "Read the text currently highlighted by the user in the Cake window.",
      result: "The currently selected text, or no text if nothing is highlighted in Cake.",
    },
    run: async (_input, { host }, command): Promise<AppControlResult> => {
      return { ok: true, command, text: host.state.userSelection() };
    },
  }),
  defineControl({
    command: "app.split",
    args: Schema.Struct({ direction: Schema.Literals(["right", "down"]) }),
    scope: "global",
    discovery: {
      topic: "app",
      summary:
        "Split the calling conversation pane to the right or down and open a new chat in it.",
    },
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
    command: "notifications.send",
    args: Schema.Struct({
      title: trimmed(1, 256),
      body: trimmed(1, 2000),
      level: Schema.Literals(["info", "success", "warning", "error"]).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("info" as const)),
      ),
    }),
    scope: "global",
    discovery: {
      topic: "notifications",
      summary: "Send a bounded native system notification without adding user input.",
    },
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
