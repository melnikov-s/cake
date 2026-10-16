import {
  CakeSettingsGetInput,
  CakeSettingsUpdateInput,
} from "../../contracts/application/cake-settings-schema";
import type { AppControlResult } from "./app-control-data";

import { defineControl } from "./control-definition";
import { toStrictJson } from "./control-json";

export const settingsControls = [
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
];
