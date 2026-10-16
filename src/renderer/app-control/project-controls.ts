import { Effect, Schema } from "effect";
import type { AppControlResult } from "./app-control-data";
import { bounded } from "./control-arguments";
import { defineControl } from "./control-definition";

/** Cake Chat advertises projects.* itself; this window-side step reuses sidebar removal. */
export const projectControls = [
  defineControl({
    command: "projects.remove",
    args: Schema.Struct({
      path: bounded(1, 4096),
      deleteSessions: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }),
    scope: "internal",
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const project = host.state.projects().find((candidate) => candidate.path === input.path);
      if (!project)
        return {
          ok: false,
          command,
          error: `No registered Project has the exact path ${input.path}`,
        };
      if (!(await host.projects.remove(input.path, input.deleteSessions)))
        return { ok: false, command, error: `Cake could not remove the Project ${input.path}` };
      return {
        ok: true,
        command,
        path: input.path,
        name: project.name,
        deleteSessions: input.deleteSessions,
      };
    },
  }),
];
