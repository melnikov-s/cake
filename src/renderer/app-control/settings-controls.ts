import { windowControlDefinitions } from "../../contracts/application/window-control-definitions";
import type { AppControlResult } from "./app-control-data";

import { defineControl } from "./control-definition";
import { toStrictJson } from "./control-json";

export const settingsControls = [
  defineControl({
    ...windowControlDefinitions["settings.window.get"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const view = host.settings.get(input.section);
      return toStrictJson({ ok: true, command, scope: "window", ...view });
    },
  }),
  defineControl({
    ...windowControlDefinitions["settings.window.update"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const view = await host.settings.update(input);
      return toStrictJson({ ok: true, command, scope: "window", ...view });
    },
  }),
];
